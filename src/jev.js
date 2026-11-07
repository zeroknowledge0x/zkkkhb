// Jev decision model over Command Code HTTP (typesafe/jev). No CLI, no TypeSafe key:
// it authenticates with the same Command Code key the brain already uses. The model only
// classifies choices — it never writes files, touches the browser or speaks.
import { log } from './log.js';

export const DEFAULT_URL = 'https://api.commandcode.ai/provider/v1/systemone';
export const DEFAULT_MODEL = 'typesafe/jev';

// Per-action confidence floors. click/navigate are never applied automatically: the LLM
// owns targets, so Jev only signals intent and the agent loop defers to the brain.
const ACTION_CONF = { wait: 0.65, silence: 0.65, speak: 0.72, reload: 0.85 };
export const AUTO_ACTIONS = new Set(Object.keys(ACTION_CONF));
export const REPLY_CONF = 0.7;

export const ACTIONS = ['wait', 'reload', 'speak', 'silence', 'click', 'navigate'];

const ACTION_INSTRUCTIONS = `You are the operator of a 24/7 demo-casino stream. Read the stream report and choose ONE action.
Demo play only; never imply real money, wins, deposits or links.`;

const ACTION_CRITERIA = {
  wait: 'Only when already inside an Original game view (URL carries a game slug) that is ready with a frame, the bet is already 0, and nothing needs doing; Hubie should stay quiet. Never wait in the lobby when short game labels are available.',
  silence: 'No frame is available, the page is loading or blocked, or Hubie should not speak right now.',
  speak: 'Game is ready with a frame, Hubie is not currently speaking, and it has been at least 30 seconds since the last line; one short idle line helps the stream.',
  reload: 'The game page is blocked (Cloudflare/captcha), stuck loading, or showing an error, and a reload is the only way to recover it.',
  click: 'The lobby is showing short Originals game titles, a "Play Demo" control is visible, a queued viewer request needs its game opened, or an in-game control (hit/stand/roll/payout/win chance) should be used. Click that matching short label.',
  navigate: 'The page is on a non-Original URL (slot or third-party provider) and must return to https://www.housebets.com/casino. Never navigate to a non-Original.',
};

export class Jev {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.url = cfg.jevUrl || DEFAULT_URL;
    this.model = cfg.jevModel || DEFAULT_MODEL;
    this.key = cfg.jevKey || '';
    this.timeoutMs = Number(cfg.jevTimeoutMs) > 0 ? Number(cfg.jevTimeoutMs) : 4000;
    this.minConfidence = numOr(cfg.jevConfidence, 0.72);
    this.enabled = cfg.jevEnabled !== false && !!this.key;
    this.reason = cfg.jevEnabled === false
      ? 'JEV_ENABLED=0'
      : !this.key
        ? 'no key (LLM_API_KEY / COMMAND_CODE_API_KEY / JEV_API_KEY)'
        : '';
  }

  acceptsAction(action, confidence) {
    if (!AUTO_ACTIONS.has(action)) return false;
    const need = Math.max(ACTION_CONF[action] ?? this.minConfidence, this.minConfidence);
    return Number(confidence) >= need;
  }

  acceptsReply(choice, confidence) {
    if (!choice || choice === 'none') return false;
    return Number(confidence) >= Math.max(REPLY_CONF, this.minConfidence);
  }

  // One tick -> one action choice. Returns null on any failure so the loop can defer.
  async chooseAction(report, { secondsSinceSpeak = null } = {}) {
    const answer = await this.#ask('action', {
      state: describeReport(report, { secondsSinceSpeak }),
      instructions: ACTION_INSTRUCTIONS,
      criteria: ACTION_CRITERIA,
    });
    if (!answer || !ACTIONS.includes(answer.choice)) return null;
    return answer;
  }

  // Chat message -> the best knowledge-base entry, or null when free text is needed.
  async chooseReply(chatText, kbEntries = []) {
    const entries = (kbEntries || []).filter((e) => e && e.id);
    if (!entries.length) return null;
    const criteria = { none: 'No knowledge-base entry clearly answers this; Hubie should write a free reply.' };
    for (const e of entries) {
      criteria[e.id] = `${clip(e.title || e.id, 80)}: ${clip(e.text, 160)}`;
    }
    const answer = await this.#ask('reply', {
      state: `Viewer chat message: "${clip(chatText, 300)}"`,
      instructions: 'Pick the single knowledge-base entry that best answers the viewer, or "none" when the message is small talk, unclear, or no entry fits.',
      criteria,
    });
    if (!answer) return null;
    if (!entries.some((e) => e.id === answer.choice)) return null;
    if (!this.acceptsReply(answer.choice, answer.confidence)) {
      log(`jev: reply defer kb=${answer.choice} conf=${answer.confidence.toFixed(2)}`);
      return null;
    }
    return { id: answer.choice, conf: answer.confidence };
  }

  async #ask(name, { state, instructions, criteria }) {
    if (!this.enabled) return null;
    const body = { model: this.model, state, questions: { [name]: { type: 'choice', instructions, criteria } } };
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const why = err?.name === 'TimeoutError' ? `timeout ${this.timeoutMs} ms` : err?.message || err;
      log(`jev: ${name} request failed: ${why}`);
      return null;
    }
    if (!res.ok) {
      log(`jev: ${name} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      log(`jev: ${name} invalid JSON`);
      return null;
    }
    const answer = data?.answers?.[name];
    if (!answer || typeof answer.choice !== 'string') {
      log(`jev: ${name} missing answer`);
      return null;
    }
    return {
      choice: answer.choice,
      confidence: Number(answer.confidence) || 0,
      probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {},
    };
  }
}

function describeReport(report, { secondsSinceSpeak = null } = {}) {
  const g = report?.game || {};
  const b = report?.browser || {};
  const s = report?.stream || {};
  const chat = report?.chat || {};
  const lines = [
    `game ready=${!!g.ready} hasFrame=${!!g.hasFrame} blocked=${!!g.blocked} loading=${!!g.loading}`,
  ];
  if (g.url) lines.push(`url=${clip(g.url, 160)}`);
  if (g.title) lines.push(`title=${clip(g.title, 80)}`);
  if (g.lastError) lines.push(`lastError=${clip(g.lastError, 120)}`);
  lines.push(`browser launched=${!!b.launched}`);
  let stream = `stream frames=${Number(s.frames) || 0} speaking=${!!s.speaking} round=${Number(s.round) || 0}`;
  if (secondsSinceSpeak != null) stream += ` secondsSinceSpeak=${Math.round(secondsSinceSpeak)}`;
  lines.push(stream);
  const q = report?.queue;
  if (q && Number(q.count) > 0) {
    const items = Array.isArray(q.items) ? q.items.slice(0, 3) : [];
    lines.push(`queue count=${Number(q.count)} next=${items.map((i) => `${i.game}(${i.name})`).join(', ')}`);
  }
  const last = Array.isArray(chat.last) ? chat.last.slice(-6) : [];
  lines.push(`chat count=${Number(chat.count) || last.length}`);
  for (const line of last) lines.push(`chat ${clip(line, 160)}`);
  return lines.join('\n');
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function numOr(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}
