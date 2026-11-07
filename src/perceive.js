// Screen perception: turn the live page (DOM first, occasional cheap screenshot)
// into one small state object. A bad read returns the last good state or an empty
// one. It must never throw into the play loop.
import { normalizeGame } from './play-queue.js';

const PROMO = /meet the house|made by|originals\b.*more|mini player|play .+ in the|in the mini/i;
const GAME_START = /^(dice|mines?|crash|limbo|plinko|blackjack|black\s*jack|keno|wheel|hilo|dragon\s*tower|tower|max\s*win)\b/i;
const LOBBY_TTL_MS = 90 * 60 * 1000;
const URL_GAME = {
  dice: 'Dice',
  mines: 'Mines',
  limbo: 'Limbo',
  plinko: 'Plinko',
  blackjack: 'Blackjack',
  keno: 'Keno',
  wheel: 'Wheel',
  hilo: 'Hilo',
  tower: 'Tower',
  'dragon-tower': 'Tower',
  'max-win': 'Max Win',
};

export function emptyState(at = 0) {
  return {
    ok: false,
    source: 'none',
    game: null,
    balance: null,
    lastResult: null,
    multiplier: null,
    round: 'unknown',
    lobby: [],
    streak: { kind: null, count: 0 },
    sufficient: false,
    at,
  };
}

// Crash becomes Limbo on purpose: housegames-crash 404s, same as the chat queue.
export function canonicalGame(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/dragon\s*tower/i.test(s)) s = 'tower';
  return normalizeGame(s);
}

function sameGame(a, b) {
  const left = canonicalGame(a) || String(a || '');
  const right = canonicalGame(b) || String(b || '');
  return left.toLowerCase().replace(/\s+/g, '') === right.toLowerCase().replace(/\s+/g, '');
}

export function dedupeGames(names) {
  const out = [];
  const seen = new Set();
  for (const name of names || []) {
    const game = canonicalGame(name);
    if (!game) continue;
    const key = game.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(game);
  }
  return out;
}

function num(value) {
  const n = Number(String(value ?? '').replace(/,/g, '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function gameFromUrl(url) {
  const match = String(url || '').match(/housegames-([a-z0-9-]+)/i);
  if (!match) return null;
  return URL_GAME[match[1].toLowerCase()] || null;
}

function gameFromText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40 || PROMO.test(t)) return null;
  const match = t.match(GAME_START);
  if (!match) return null;
  return canonicalGame(match[0]);
}

function lobbyFrom(clickables) {
  const names = [];
  for (const entry of clickables || []) {
    const text = String(entry?.text ?? entry ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 40 || PROMO.test(text)) continue;
    const game = gameFromText(text);
    if (game) names.push(game);
  }
  return dedupeGames(names);
}

// Balance parsing has to survive the real page: "IDR 278 Wallet Weekly Prize $50,000.00
// $100,000.00 ...". The wallet is the first IDR figure, the dollar amounts are prize
// pools, and the bet field prints "IDR 0" right next to controls. Picking "the biggest
// number" read BAL 100,000; picking the first number read BAL 0. So: wallet-neighbour
// first, then the first non-zero IDR, and only then anything dollar-denominated.
export function parseBalance(balanceText, body) {
  const toNum = (raw) => {
    let t = String(raw || '').replace(/\s/g, '');
    if (!t) return null;
    if (/,\d{1,2}$/.test(t) && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const grab = (src) => {
    let t = String(src || '');
    t = t.replace(/(?:IDR|Rp\.?)\s*([0-9][0-9.,]*)/gi, (m, n) => ` ${n} `);
    return toNum(t);
  };
  const labelled = (src) => {
    const m = String(src || '').match(/(?:balance|wallet|saldo|bankroll|credits?)[^0-9]{0,14}([0-9][0-9.,]*)/i);
    return m ? toNum(m[1]) : null;
  };
  const balanceTextNum = (src) => {
    const t = String(src || '').trim();
    if (!t) return null;
    const idr = t.match(/(?:IDR|Rp\.?)\s*([0-9][0-9.,]*)/i);
    if (idr) return toNum(idr[1]);
    const bare = t.match(/^\$?\s*([0-9][0-9.,]*)$/);
    return bare ? toNum(bare[1]) : null;
  };
  // "IDR 278 Wallet" or "Wallet ... IDR 278"
  const walletNear = (src) => {
    const b = String(src || '');
    let m = b.match(/(?:IDR|Rp\.?)\s*([0-9][0-9.,]*)\s*wallet/i);
    if (m) return toNum(m[1]);
    m = b.match(/wallet[^0-9]{0,12}(?:IDR|Rp\.?)\s*([0-9][0-9.,]*)/i);
    return m ? toNum(m[1]) : null;
  };
  const idrAll = (src) => [...String(src || '').matchAll(/(?:IDR|Rp\.?)\s*([0-9][0-9.,]*)/gi)]
    .map((m) => toNum(m[1]))
    .filter((v) => v != null);
  const firstAny = (src) => {
    const m = String(src || '').match(/(?:IDR|Rp\.?|USD|USDT|\$|BTC|BNB|ETH|POL)\s*([0-9][0-9.,]*)/i)
      || String(src || '').match(/([0-9]+(?:\.[0-9]+)?)\s*(?:BTC|BNB|ETH|POL)/i);
    return m ? toNum(m[1]) : null;
  };

  const fromNode = labelled(balanceText) ?? balanceTextNum(balanceText);
  if (fromNode != null && fromNode > 0) return fromNode;
  for (const v of [walletNear(body), labelled(body)]) {
    if (v != null && v > 0) return v;
  }
  const idr = idrAll(body).find((v) => v > 0);
  if (idr != null) return idr;
  const any = firstAny(body);
  if (any != null && any > 0) return any;
  // Nothing bigger anywhere: a zero is a real empty wallet (or a "$0.00" balance line).
  const zero = [fromNode, walletNear(body), labelled(body), firstAny(body)].some((v) => v === 0);
  return zero ? 0 : null;
}

function parseMultiplier(multiplierText, body, outcome) {
  if (outcome?.source === 'keno-payhit' && Number.isFinite(Number(outcome.result))) {
    return Number(outcome.result);
  }
  const node = String(multiplierText || '').trim();
  if (node && node.length <= 24) {
    const cleaned = node.replace(/multiplier|payout|target/ig, '').trim();
    if (cleaned.length <= 12) {
      const m = node.match(/([0-9]+(?:[.,][0-9]+)?)/);
      const n = m ? num(m[1]) : null;
      if (n != null) return n;
    }
  }
  const labeled = String(body || '').match(/(?:multiplier|payout)\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?)/i);
  return labeled ? num(labeled[1]) : null;
}

function parseLastResult(raw, blob) {
  const outcome = raw?.outcome;
  if (outcome && Number.isFinite(Number(outcome.result))) {
    const won = outcome.won === true ? true : outcome.won === false ? false : null;
    return { value: Number(outcome.result), won };
  }
  const win = /\byou win\b|\byou won\b|\bwinner\b/i.test(blob);
  const lose = /\byou lose\b|\byou lost\b|\bbust(?:ed)?\b/i.test(blob);
  const rolled = String(blob).match(/(?:result|rolled|roll)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/i);
  if (!rolled && !win && !lose) return null;
  return {
    value: rolled ? num(rolled[1]) : null,
    won: win ? true : lose ? false : null,
  };
}

function parseRound(raw, blob, lastResult, clickables) {
  const hint = String(raw?.round || raw?.roundText || '').toLowerCase().trim();
  if (hint === 'idle' || hint === 'live' || hint === 'settled') return hint;
  const text = `${hint}\n${blob}`.toLowerCase();
  if (/rolling|spinning|in progress|in play|\bflying\b|\brunning\b/.test(text)) return 'live';
  if (lastResult?.won != null || /cashed out|\bsettled\b/.test(text)) return 'settled';
  const labels = (clickables || []).map((c) => String(c?.text || '').trim());
  if (labels.some((t) => /^(?:place\s*)?bet$|^roll$|^deal$/i.test(t))) return 'idle';
  return 'unknown';
}

// DOM text/selectors → compact state. Never throws.
export function parseDomState(raw) {
  try {
    const url = String(raw?.url || '');
    const title = String(raw?.title || '');
    const body = String(raw?.body || raw?.bodySnippet || '');
    const blob = [title, body, raw?.balanceText, raw?.multiplierText, raw?.roundText]
      .filter(Boolean)
      .join('\n');
    const clickables = Array.isArray(raw?.clickables) ? raw.clickables : [];
    const titleHead = title.split(/[|\-–—]/)[0];
    const game = gameFromUrl(url) || gameFromText(titleHead);
    const balance = parseBalance(raw?.balanceText, body);
    const multiplier = parseMultiplier(raw?.multiplierText, body, raw?.outcome);
    const lastResult = parseLastResult(raw, blob);
    const round = parseRound(raw, blob, lastResult, clickables);
    let lobby = lobbyFrom(clickables);
    if (!lobby.length) lobby = lobbyFrom(raw?.lobbySnapshot?.clickables);
    const state = {
      ok: false,
      source: raw?.fromVision ? 'vision' : 'dom',
      game,
      balance,
      lastResult,
      multiplier,
      round,
      lobby,
      streak: { kind: null, count: 0 },
      sufficient: false,
      at: 0,
    };
    state.sufficient = isDomSufficient(state);
    state.ok = !!(game || lobby.length || lastResult || multiplier != null || balance != null);
    return state;
  } catch {
    return emptyState(0);
  }
}

// A lobby list is enough when no table is open. Inside a game, a name alone is not
// enough: commentary needs a result, a multiplier, a balance, or a round.
export function isDomSufficient(state) {
  if (!state) return false;
  if (state.game) {
    if (state.round && state.round !== 'unknown') return true;
    if (state.lastResult && (state.lastResult.value != null || state.lastResult.won != null)) return true;
    if (state.multiplier != null) return true;
    if (state.balance != null) return true;
    return false;
  }
  return !!state.lobby?.length;
}

function extractJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// LLM screenshot summary → the same state shape, or null when it isn't usable.
export function parseVisionSummary(text) {
  try {
    const obj = extractJson(text);
    if (!obj || typeof obj !== 'object') return null;
    const won = obj.won === true ? true : obj.won === false ? false : null;
    const round = ['idle', 'live', 'settled'].includes(String(obj.round || '').toLowerCase())
      ? String(obj.round).toLowerCase()
      : '';
    const lobby = Array.isArray(obj.lobby) ? obj.lobby : [];
    const state = parseDomState({
      url: '',
      title: obj.game ? String(obj.game) : '',
      body: [
        obj.balance != null && obj.balance !== '' ? `Balance ${obj.balance}` : '',
        obj.multiplier != null && obj.multiplier !== '' ? `multiplier ${obj.multiplier}` : '',
        obj.lastResult != null && obj.lastResult !== '' ? `result ${obj.lastResult}` : '',
        won === true ? 'you win' : won === false ? 'you lose' : '',
      ].filter(Boolean).join('\n'),
      round,
      clickables: lobby.map((name) => ({ text: String(name) })),
      fromVision: true,
    });
    return state?.ok ? state : null;
  } catch {
    return null;
  }
}

// Vision fills holes only. A DOM value always wins over a model guess.
export function mergeState(dom, vision, at = 0) {
  const base = dom ? { ...dom } : emptyState(at);
  if (!vision) return { ...base, at: at || base.at || 0 };
  const next = {
    ...base,
    source: 'vision',
    game: base.game || vision.game || null,
    balance: base.balance != null ? base.balance : (vision.balance ?? null),
    multiplier: base.multiplier != null ? base.multiplier : (vision.multiplier ?? null),
    lastResult: base.lastResult || vision.lastResult || null,
    round: base.round && base.round !== 'unknown' ? base.round : (vision.round || 'unknown'),
    lobby: base.lobby?.length ? base.lobby.slice() : (vision.lobby || []).slice(),
    at,
  };
  next.sufficient = isDomSufficient(next);
  next.ok = !!(next.game || next.lobby.length || next.lastResult || next.multiplier != null || next.balance != null);
  return next;
}

export function formatScreen(state) {
  if (!state?.ok) return '';
  const bits = [];
  if (state.game) bits.push(`game=${state.game}`);
  if (state.balance != null) bits.push(`balance=${state.balance}`);
  if (state.lastResult) {
    const value = state.lastResult.value == null ? '?' : state.lastResult.value;
    const won = state.lastResult.won == null ? '?' : state.lastResult.won;
    bits.push(`lastResult=${value} won=${won}`);
  }
  if (state.multiplier != null) bits.push(`multiplier=${state.multiplier}`);
  if (state.round && state.round !== 'unknown') bits.push(`round=${state.round}`);
  if (state.streak?.count) bits.push(`streak=${state.streak.kind} count=${state.streak.count}`);
  if (state.lobby?.length) bits.push(`lobby=${state.lobby.join(',')}`);
  return bits.join(' ');
}

function trimNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

function capWords(line) {
  const words = String(line || '').replace(/\s+/g, ' ').trim().split(' ');
  if (words.length <= 18) return words.join(' ');
  return words.slice(0, 18).join(' ');
}

// Spoken colour from measured numbers. Null means "no measurement, use the scripted pool".
export function groundReaction({ tag, state } = {}) {
  if (!state?.ok) return null;
  if (tag !== 'win' && tag !== 'lose') return null;
  const game = state.game ? String(state.game) : '';
  const mult = Number(state.multiplier);
  const hasMult = Number.isFinite(mult);
  const result = state.lastResult;
  const sameMult = hasMult && result?.value != null && Math.abs(Number(result.value) - mult) < 1e-6;
  const streak = Number(state.streak?.count) || 0;
  let line = '';
  if (tag === 'win' && sameMult && result?.won === true) {
    line = `${trimNum(mult)} times${game ? ` on ${game}` : ''}. I'll take that pop.`;
  } else if (tag === 'win' && result?.value != null) {
    line = `${game ? `${game} landed ` : ''}${trimNum(result.value)}. I'll take that pop.`;
  } else if (tag === 'win' && hasMult && !result) {
    line = `${trimNum(mult)} times${game ? ` on ${game}` : ''}. I'll take that pop.`;
  } else if (tag === 'lose' && state.streak?.kind === 'lose' && streak >= 2) {
    line = `${streak} misses in a row${game ? ` on ${game}` : ''}. Still nothing on the line.`;
  } else if (tag === 'lose' && result?.value != null) {
    line = `${game ? `${game} missed at ` : 'Missed at '}${trimNum(result.value)}. We laugh and move.`;
  } else if (tag === 'lose' && hasMult && !result) {
    line = `${trimNum(mult)} times and it still missed${game ? ` on ${game}` : ''}.`;
  }
  return line ? capWords(line) : null;
}

// Next Originals title. Brain pick wins only when it is on the observed lobby list
// and it is not the game already open. Otherwise random from that list, then the
// old scripted slug list. Chat priority is the caller's job (it runs first).
export function chooseRotateGame({
  observed = [],
  brainPick = null,
  scripted = [],
  current = '',
  random = Math.random,
} = {}) {
  const allowed = dedupeGames(observed);
  const scriptedPool = dedupeGames(scripted.map((name) => canonicalGame(name) || name));
  const other = (name) => !current || !sameGame(name, current);
  const wanted = canonicalGame(brainPick);
  if (wanted && allowed.some((g) => sameGame(g, wanted)) && other(wanted)) {
    return { game: allowed.find((g) => sameGame(g, wanted)), source: 'brain' };
  }
  const fromObserved = allowed.filter(other);
  if (fromObserved.length) {
    return { game: fromObserved[Math.floor(random() * fromObserved.length)], source: 'observed' };
  }
  const fromScript = scriptedPool.filter(other);
  if (!fromScript.length) return null;
  return { game: fromScript[Math.floor(random() * fromScript.length)], source: 'scripted' };
}

export class GamePerception {
  constructor({
    enabled = true,
    intervalMs = 5000,
    visionMs = 20000,
    readDom = async () => null,
    captureFrame = async () => null,
    summarize = async () => null,
    now = () => Date.now(),
    log = () => {},
  } = {}) {
    this.enabled = enabled !== false;
    this.intervalMs = Math.max(1000, Number(intervalMs) || 5000);
    this.visionMs = Math.max(20000, Number(visionMs) || 20000);
    this.readDom = readDom;
    this.captureFrame = captureFrame;
    this.summarize = summarize;
    this.now = now;
    this.log = log;
    this.state = emptyState(0);
    this.lastDomAt = 0;
    this.lastVisionAt = 0;
    this.visionInFlight = false;
    this.visionGen = 0;
    this.lastLobby = [];
    this.lastLobbyAt = 0;
    this.lastResultKey = '';
    this.streak = { kind: null, count: 0 };
  }

  // DOM on the interval. Screenshot only when that DOM is not enough, in the
  // background, never faster than visionMs. Failures keep the previous state.
  async sample() {
    if (!this.enabled) return this.state;
    const now = this.now();
    try {
      if (now - this.lastDomAt < this.intervalMs) return this.state;
      this.lastDomAt = now;
      let timer;
      const raw = await Promise.race([
        Promise.resolve().then(() => this.readDom()).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
      ]);
      clearTimeout(timer);
      if (raw == null) return this.state;
      const parsed = this.#remember(parseDomState(raw), now);
      parsed.source = 'dom';
      parsed.at = now;
      this.state = parsed;
      if (!parsed.sufficient) this.#maybeVision(now);
      return this.state;
    } catch (err) {
      try { this.log(`perceive: ${err?.message || err} — scripted fallback`); } catch { /* ignore */ }
      return this.state;
    }
  }

  #remember(parsed, now) {
    const state = parsed || emptyState(now);
    const lobby = Array.isArray(state.lobby) ? state.lobby : [];
    if (lobby.length) {
      this.lastLobby = lobby.slice();
      this.lastLobbyAt = now;
    } else if (this.lastLobby.length && now - this.lastLobbyAt < LOBBY_TTL_MS) {
      state.lobby = this.lastLobby.slice();
    }
    const result = state.lastResult;
    if (result && (result.won === true || result.won === false)) {
      const key = `${result.value}:${result.won}`;
      if (key !== this.lastResultKey) {
        this.lastResultKey = key;
        if (result.won) {
          this.streak = { kind: 'win', count: this.streak.kind === 'win' ? this.streak.count + 1 : 1 };
        } else {
          this.streak = { kind: 'lose', count: this.streak.kind === 'lose' ? this.streak.count + 1 : 1 };
        }
      }
    }
    state.streak = { kind: this.streak.kind, count: this.streak.count };
    state.sufficient = isDomSufficient(state);
    state.ok = !!(state.game || state.lobby.length || state.lastResult || state.multiplier != null || state.balance != null);
    return state;
  }

  #maybeVision(now) {
    if (this.visionInFlight) return;
    if (now - this.lastVisionAt < this.visionMs) return;
    this.lastVisionAt = now;
    this.visionInFlight = true;
    const gen = ++this.visionGen;
    Promise.resolve()
      .then(async () => {
        const frame = await this.captureFrame();
        if (!frame || gen !== this.visionGen) return;
        const text = await this.summarize(frame);
        if (!text || gen !== this.visionGen) return;
        const vision = parseVisionSummary(text);
        if (!vision || gen !== this.visionGen) return;
        this.state = this.#remember(mergeState(this.state, vision, this.now()), this.now());
        this.state.source = 'vision';
      })
      .catch((err) => {
        try { this.log(`perceive: vision skipped (${err?.message || err})`); } catch { /* ignore */ }
      })
      .finally(() => { this.visionInFlight = false; });
  }
}
