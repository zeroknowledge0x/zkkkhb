// Chat intake: who gets a spoken reply, who is skipped, and why.
// Kick DOM rows are parsed here so a virtualized row that only exposes innerText
// still becomes a real viewer message. Self is an exact handle (hubie / hubiezk),
// never a prefix — LiveHubi is a viewer.
import { parseGameRequest } from './play-queue.js';

export const REPLY_BRAIN_TIMEOUT_MS = 3500;
export const REPLY_PENDING_MAX = 30;

const ALWAYS_SELF = ['hubie', 'hubiezk'];
const BOTS = new Set([
  'nightbot', 'streamelements', 'streamlabs', 'fossabot', 'moobot', 'botrix',
  'kickbot', 'kicksbot', 'serybot', 'soundalerts', 'wizebot',
]);
const PROMO = /bot\s*liva|!noads|\bno\s*ads\b|our\s+ai\s+service|make your stream fire|chat stays online|t\.me\/|discord\.gg|\bhttps?:\/\/|\bwww\.|bit\.ly|promo code/i;
const EMOTE = /^(?:lol+|lmao+|lmfao+|kekw?|pog+|omg+|haha+|hehe+|gg+|wp|ez|rip|oof|bruh|lul|xd+|ayy+|f|w+|l+)$/i;
const PURE_GREET = /^(?:hi+|hello+|hey+|yo+|gm|good\s*morning|halo|hai|bye+|goodbye|good\s*night|gn|later|cya|see\s*ya)[!.,\s]*$/i;

export const TUNE_BAND = Object.freeze({
  target: { lo: 1.5, hi: 5 },
  multiplier: { lo: 1.5, hi: 5 },
  chance: { lo: 5, hi: 95 },
});

export function normHandle(name) {
  return String(name || '').toLowerCase().replace(/[\s_-]+/g, '').slice(0, 40);
}

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function isSelfName(name, selfNames = []) {
  const n = normHandle(name);
  if (!n) return false;
  const set = new Set(ALWAYS_SELF);
  for (const raw of selfNames) {
    const s = normHandle(raw);
    if (s) set.add(s);
  }
  return set.has(n);
}

export function isBotName(name) {
  const n = normHandle(name);
  if (!n || n.includes('hubi')) return false;
  if (BOTS.has(n)) return true;
  return n.endsWith('bot') && n.length >= 6;
}

export function isPromoText(text) {
  const t = clean(text);
  if (!t) return false;
  if (/^!/.test(t) && !parseGameRequest(t.replace(/^!+/, ''))) return true;
  return PROMO.test(t);
}

export function isEmoteOnly(text) {
  let raw = String(text || '');
  raw = raw.replace(/\[[^\]]{0,48}\]/g, ' ');
  raw = raw.replace(/:[a-z0-9_]{2,32}:/gi, ' ');
  raw = raw.replace(/\p{Extended_Pictographic}+/gu, ' ');
  raw = raw.replace(/[\p{P}\p{S}]+/gu, ' ');
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return true;
  return parts.every((part) => EMOTE.test(part));
}

export function isFloodText(text) {
  const t = String(text || '');
  if (/(.)\1{9,}/u.test(t)) return true;
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length >= 8 && new Set(words).size === 1;
}

export function isPureGreet(text) {
  return PURE_GREET.test(clean(text));
}

// "target 100" / "multi change to 100" are tune asks. A game switch
// ("change limbo", "limbo", "other game") is not — that stays on the queue path.
export function parseTuneRequest(text) {
  const t = clean(text);
  if (!t || parseGameRequest(t)) return null;
  const match = t.match(/\b(?:win\s*chance|multiplier|multi|target|payout)\b[^\d]{0,32}(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  let kind = 'target';
  if (/chance/i.test(t)) kind = 'chance';
  else if (/multi/i.test(t)) kind = 'multiplier';
  return { kind, value };
}

// Refuse anything outside the demo band. Callers must also skip bet/stake fields.
export function safeTuneValue(kind, requested) {
  const band = TUNE_BAND[kind] || TUNE_BAND.target;
  const n = Number(requested);
  if (!Number.isFinite(n)) return { ok: false, reason: 'nan', lo: band.lo, hi: band.hi };
  if (n < band.lo || n > band.hi) return { ok: false, reason: 'out_of_band', lo: band.lo, hi: band.hi };
  return { ok: true, value: String(Number(n.toFixed(2))), reason: null, lo: band.lo, hi: band.hi };
}

export function planChat({ text = '', greeted = false, queueAnnounced = false } = {}) {
  if (queueAnnounced) return { action: 'queue' };
  if (greeted && isPureGreet(text)) return { action: 'greet' };
  return { action: 'reply' };
}

export function offerReply(queue, message, max = REPLY_PENDING_MAX) {
  if (!Array.isArray(queue) || queue.length >= max) return { ok: false, reason: 'queue_full' };
  queue.push(message);
  return { ok: true };
}

const ACKS = [
  (name) => `Heard you, ${name}.`,
  (name) => `${name}, I caught that.`,
  (name) => `Yeah ${name}, I'm with you.`,
  (name) => `Got it, ${name}.`,
];

export function cannedAck(name) {
  const short = clean(name).slice(0, 16) || 'chat';
  return ACKS[Math.floor(Math.random() * ACKS.length)](short);
}

export async function composeChatReply(m, { brain, jevReply, timeoutMs = REPLY_BRAIN_TIMEOUT_MS } = {}) {
  const ack = () => cannedAck(m?.name);
  if (brain && !brain.offline && typeof brain.say === 'function') {
    const shaped = await brain.say('reply', m, { timeoutMs });
    if (shaped?.timeout) {
      return { text: ack(), emotion: null, gesture: null, source: 'canned', reason: 'timeout' };
    }
    if (shaped?.text && !shaped.fallback) return { ...shaped, source: 'brain' };
    const entry = typeof jevReply === 'function' ? await jevReply(m) : null;
    if (entry?.text) return { text: clean(entry.text), emotion: null, gesture: null, source: 'kb' };
    return { text: shaped?.text || ack(), emotion: null, gesture: null, source: 'canned' };
  }
  const entry = typeof jevReply === 'function' ? await jevReply(m) : null;
  if (entry?.text) return { text: clean(entry.text), emotion: null, gesture: null, source: 'kb' };
  const shaped = brain && typeof brain.say === 'function' ? await brain.say('reply', m) : null;
  return { text: shaped?.text || ack(), emotion: null, gesture: null, source: 'canned' };
}

function wrapLines(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars) {
      if (line) lines.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// Latest messages that fit the chat column. Newest is kept when older lines are long.
export function visibleChatMessages(chat, { maxPx = 210, linePx = 20, pad = 22, maxChars = 40 } = {}) {
  const list = Array.isArray(chat) ? chat : [];
  const picked = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    const textLines = Math.min(2, wrapLines(message?.text, maxChars).length);
    const h = (1 + textLines) * linePx + pad;
    if (picked.length && used + h > maxPx) break;
    picked.push(message);
    used += h;
    if (used >= maxPx) break;
  }
  return picked.reverse();
}

export function formatChatSkip({ reason, n, name } = {}) {
  const who = name ? ` name=${clean(name).slice(0, 40)}` : '';
  return `chat_skip reason=${reason} n=${n}${who}`;
}

export function createChatIntake({ selfNames = [] } = {}) {
  const counts = new Map();
  const promo = new Set();

  function bump(reason) {
    const n = (counts.get(reason) || 0) + 1;
    counts.set(reason, n);
    return n;
  }

  function screen(message) {
    const name = clean(message?.name);
    const text = clean(message?.text);
    if (!name || !text) return { action: 'skip', reason: 'empty', n: bump('empty'), name };
    const key = normHandle(name);
    if (isSelfName(name, selfNames)) return { action: 'skip', reason: 'self', n: bump('self'), name };
    if (isBotName(name)) return { action: 'skip', reason: 'bot', n: bump('bot'), name };
    if (promo.has(key) || isPromoText(text)) {
      promo.add(key);
      return { action: 'skip', reason: 'promo', n: bump('promo'), name, purge: true };
    }
    if (isEmoteOnly(text)) return { action: 'skip', reason: 'emote', n: bump('emote'), name };
    if (isFloodText(text)) return { action: 'skip', reason: 'spam', n: bump('spam'), name };
    return { action: 'ok', name, text };
  }

  function summary() {
    if (!counts.size) return 'none';
    return [...counts.entries()].map(([key, n]) => `${key}=${n}`).join(',');
  }

  function isPromoSender(name) {
    return promo.has(normHandle(name));
  }

  return { screen, summary, bump, counts, isPromoSender };
}

// Kick row: the message span is often missing or equal to the username. innerText
// still has the handle on one line and the message on the next.
export function parseKickRow(raw = {}) {
  const lines = String(raw.innerText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (/^\d{1,2}:\d{2}(\s?[AP]M)?$/.test(lines[0] || '')) lines.shift();

  let name = clean(raw.name);
  let text = clean(raw.text);
  const collapsed = clean(raw.innerText);
  const untrusted = !name || name === text || name === collapsed || name.length > 32;
  if (untrusted && lines.length) {
    name = clean(lines[0]).slice(0, 40);
    if (!text || text === collapsed || text === name || text === clean(lines[0])) {
      text = clean(lines.slice(1).join(' '));
    }
  }
  if (!text && lines.length >= 2) text = clean(lines.slice(1).join(' '));
  if (name && text.toLowerCase().startsWith(`${name.toLowerCase()}:`)) {
    text = text.slice(name.length + 1).trim();
  } else if (name && text.toLowerCase().startsWith(name.toLowerCase()) && text.length > name.length + 1) {
    const stripped = text.slice(name.length).replace(/^[\s:.\-]+/, '').trim();
    if (stripped && stripped !== text) text = stripped;
  }
  name = name.replace(/[:\s]+$/, '').slice(0, 40);
  text = text.slice(0, 300);
  if (!name || !text || normHandle(name) === normHandle(text)) return null;
  return { name, text };
}

function rowKey(row) {
  return `${clean(row.name)}|${clean(row.text)}`;
}

function pruneDedupe(state, now) {
  for (const [key, at] of state.emittedAt) {
    if (now - at > state.dedupeMs * 4 && !state.live.has(key)) state.emittedAt.delete(key);
  }
}

export function createKickDedupe({ dedupeMs = 20000 } = {}) {
  return { live: new Set(), emittedAt: new Map(), dedupeMs, skips: 0, primed: false };
}

function packRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row?.name || !row?.text) continue;
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: clean(row.name).slice(0, 40), text: clean(row.text).slice(0, 300), key });
  }
  return out;
}

// First successful poll: rows that were only visible before we pinned the scroller
// to the bottom are the stuck cursor. Rows that appear after the pin are new.
export function ingestAfterScroll(state, beforeRows, afterRows, now) {
  const before = new Set(packRows(beforeRows).map((row) => row.key));
  const after = packRows(afterRows);
  const fresh = [];
  const skipped = [];
  const nextLive = new Set();
  for (const row of after) {
    nextLive.add(row.key);
    if (before.has(row.key)) {
      state.emittedAt.set(row.key, now);
      continue;
    }
    const prev = state.emittedAt.get(row.key) || 0;
    if (prev && now - prev < state.dedupeMs) {
      state.skips += 1;
      skipped.push({ name: row.name, text: row.text, reason: 'dedupe', n: state.skips });
      continue;
    }
    state.emittedAt.set(row.key, now);
    fresh.push({ name: row.name, text: row.text });
  }
  state.live = nextLive;
  state.primed = true;
  pruneDedupe(state, now);
  return { fresh, skipped };
}

export function ingestKickRows(state, rows, now) {
  const fresh = [];
  const skipped = [];
  const nextLive = new Set();
  for (const row of packRows(rows)) {
    nextLive.add(row.key);
    // Still on screen from the previous poll. The first poll has an empty live set,
    // so the rows visible after we pin the scroller to the bottom are delivered.
    if (state.primed && state.live.has(row.key)) continue;
    const prev = state.emittedAt.get(row.key) || 0;
    if (prev && now - prev < state.dedupeMs) {
      state.skips += 1;
      skipped.push({ name: row.name, text: row.text, reason: 'dedupe', n: state.skips });
      continue;
    }
    state.emittedAt.set(row.key, now);
    fresh.push({ name: row.name, text: row.text });
  }
  state.live = nextLive;
  state.primed = true;
  pruneDedupe(state, now);
  return { fresh, skipped };
}


// Kick public channel messages API (numeric channel id). Prefer this over DOM —
// Kick virtualizes #chatroom-messages and the headed tab often freezes on old rows.
export function parseKickApiMessage(raw = {}) {
  const id = String(raw.id || raw.message_id || '').trim();
  const sender = raw.sender || raw.user || {};
  const name = clean(sender.username || sender.slug || sender.display_name || raw.username || '');
  const text = clean(raw.content || raw.message || raw.text || '');
  if (!id || !name || !text) return null;
  return { id, name: name.slice(0, 40), text: text.slice(0, 300), createdAt: raw.created_at || raw.createdAt || null };
}

export function createKickApiDedupe() {
  return { seen: new Set(), primed: false };
}

// First successful poll primes ids (backlog ignored). Later polls emit only new ids,
// oldest-first so FIFO replies match Kick order.
export function ingestKickApiMessages(state, messages, now = Date.now()) {
  const parsed = [];
  for (const raw of messages || []) {
    const row = parseKickApiMessage(raw);
    if (row) parsed.push(row);
  }
  parsed.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  if (!state.primed) {
    for (const row of parsed) state.seen.add(row.id);
    state.primed = true;
    return { fresh: [], skipped: [], primed: true, at: now };
  }
  const fresh = [];
  for (const row of parsed) {
    if (state.seen.has(row.id)) continue;
    state.seen.add(row.id);
    fresh.push({ id: row.id, name: row.name, text: row.text, createdAt: row.createdAt });
  }
  // Cap memory of seen ids
  if (state.seen.size > 2000) {
    const keep = parsed.map((row) => row.id);
    state.seen = new Set([...keep, ...fresh.map((row) => row.id)]);
  }
  return { fresh, skipped: [], primed: false, at: now };
}
