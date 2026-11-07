// Per-viewer session memory: who said what, when, how often - so replies are consistent
// across restarts. Stored as one JSON file, written atomically, capped in size.
//
// Deliberately stores no more than the platform already shows publicly: the handle, the
// messages in the channel, and timestamps. No IPs, no profiles, no scraping beyond chat.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

const MAX_VIEWERS = 4000;
const MAX_LINES = 6;
const MAX_NOTE = 120;
const MAX_TOPICS = 4;
const MAX_TOPIC = 48;
const MAX_REACTIONS = 3;
const MAX_BIT = 80;
const DEFAULT_MAX_BYTES = 1_200_000;
// A "meaningful" snippet is something a returning line can quote without sounding
// like it is reading a hello back: skip pure greetings, noise, and one-word fillers.
const MEANINGFUL_MIN = 4;
const MEANINGFUL_MAX = 120;
const FILLER_ONLY = /^(?:hi+|hey+|hello+|yo+|gm|gn|good\s*(?:morning|evening|night)|bye+|cya|lol|lmao|ok(?:ay)?|k+|yes|no|yep|nope|cool|nice|sup|welcome|hru|howdy)[\p{P}\p{S}\s]*$/iu;
const GREET_GAP_MS = 45 * 60 * 1000;
// A viewer who types "hi" gets a wave on its own cadence, independent of the 45 min
// welcome-back gap: 13 min stops a chatty regular being greeted on every message.
const GREET_SIGNAL_MS = 13 * 60 * 1000;

export class ViewerMemory {
  constructor(file, { ttlDays = 30, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.file = file;
    this.ttlMs = ttlDays * 24 * 3600 * 1000;
    this.maxBytes = Math.max(256, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.viewers = new Map();
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [name, v] of Object.entries(raw.viewers || {})) this.viewers.set(name, clipViewer(v));
      log(`memory: loaded ${this.viewers.size} viewers from ${path.basename(this.file)}`);
    } catch { /* first run */ }
  }

  save() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const savedAt = new Date().toISOString();
      let body = JSON.stringify({ savedAt, viewers: Object.fromEntries(this.viewers) });
      if (body.length > this.maxBytes) {
        const oldest = [...this.viewers.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
        let guard = 0;
        while (body.length > this.maxBytes && this.viewers.size > 1 && oldest.length && guard < 30) {
          guard++;
          const drop = Math.max(1, Math.ceil(this.viewers.size * 0.15));
          for (let i = 0; i < drop && oldest.length && this.viewers.size > 1; i++) {
            const [name] = oldest.shift();
            this.viewers.delete(name);
          }
          body = JSON.stringify({ savedAt, viewers: Object.fromEntries(this.viewers) });
        }
        log(`memory: capped at ${this.viewers.size} viewers (${body.length} bytes)`);
      }
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      log(`memory: save failed: ${err.message}`);
    }
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [name, v] of this.viewers) {
      if ((v.lastSeen || 0) < cutoff) this.viewers.delete(name);
    }
    if (this.viewers.size > MAX_VIEWERS) {
      const oldest = [...this.viewers.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
      for (const [name] of oldest.slice(0, this.viewers.size - MAX_VIEWERS)) this.viewers.delete(name);
    }
  }

  peek(name) {
    const key = String(name || '').trim().slice(0, 40);
    return key ? this.viewers.get(key) || null : null;
  }

  // Decide whether a message earns a wave. Call BEFORE remember(): the record still
  // shows the pre-message lastSeen, so no record means a first-ever visit ('new') and
  // a gap over 45 min after a prior visit means 'back'. Anything else stays quiet, and
  // the same 45 min cooldown stops a viewer being greeted on every message.
  shouldGreet(name, { gapMs = GREET_GAP_MS, now = Date.now() } = {}) {
    const v = this.peek(name);
    if (!v || !v.messages) return 'new';
    if (v.lastGreetedAt && now - v.lastGreetedAt < gapMs) return null;
    return now - (v.lastSeen || 0) > gapMs ? 'back' : null;
  }

  markGreeted(name, now = Date.now()) {
    const v = this.peek(name);
    if (!v) return false;
    v.lastGreetedAt = now;
    this.dirty = true;
    return true;
  }

  // Greet-on-signal ("hi", "gm", "hello"): separate cooldown from the welcome-back gap.
  shouldGreetSignal(name, { gapMs = GREET_SIGNAL_MS, now = Date.now() } = {}) {
    const v = this.peek(name);
    if (!v) return true;
    return !(v.lastSignalGreetedAt && now - v.lastSignalGreetedAt < gapMs);
  }

  markGreetSignaled(name, now = Date.now()) {
    const v = this.peek(name);
    if (!v) return false;
    v.lastSignalGreetedAt = now;
    this.dirty = true;
    return true;
  }

  // A familiar regular: enough messages that a full welcome-back reads wrong.
  isRegular(name, min = 5) {
    const v = this.peek(name);
    return !!v && Number(v.messages || 0) >= min;
  }

  remember(name, text, { game = null } = {}) {
    const key = String(name || '').trim().slice(0, 40);
    if (!key) return null;
    const now = Date.now();
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    const v = this.viewers.get(key) || { firstSeen: now, messages: 0, lines: [], notes: [] };
    v.lastSeen = now;
    v.messages += 1;
    const stored = clipStore(raw, 160);
    v.lines.push({ t: now, text: stored });
    if (v.lines.length > MAX_LINES) v.lines = v.lines.slice(-MAX_LINES);
    // Continuity: keep the last thing they actually said (not a bare "hi"), so a
    // returning line can reference it once. Cap it so it stays a snippet.
    if (raw.length >= MEANINGFUL_MIN && !FILLER_ONLY.test(raw)) {
      v.lastMeaningful = { t: now, text: clipStore(raw, MEANINGFUL_MAX) };
    }
    // Last game the viewer asked for / mentioned, used by the returning line.
    if (game) v.lastGame = { t: now, game: String(game).slice(0, 24) };
    const topic = topicFrom(raw, game);
    if (topic) pushTopic(v, topic, now);
    const bit = bitFrom(raw);
    if (bit) v.lastBit = { t: now, kind: bit.kind, text: bit.text };
    const reaction = reactionFrom(raw);
    if (reaction) pushReaction(v, reaction, clipStore(raw, MAX_BIT), now);
    clipViewer(v);
    this.viewers.set(key, v);
    this.dirty = true;
    if (this.viewers.size % 50 === 0) this.prune();
    return v;
  }

  // Short snippet of the last non-greeting message, or null when it is stale/absent.
  lastMeaningful(name, maxAgeMs = 6 * 3600 * 1000) {
    const v = this.peek(name);
    const m = v?.lastMeaningful;
    if (!m?.text) return null;
    if (maxAgeMs && Date.now() - (m.t || 0) > maxAgeMs) return null;
    return String(m.text).trim() || null;
  }

  lastGame(name, maxAgeMs = 24 * 3600 * 1000) {
    const v = this.peek(name);
    const g = v?.lastGame;
    if (!g?.game) return null;
    if (maxAgeMs && Date.now() - (g.t || 0) > maxAgeMs) return null;
    return g.game;
  }

  // One or two short facts for a returning chatter. First visit (messages < 2) gets none.
  // Lexical overlap wins; with no overlap, only the single newest fact is returned.
  factsFor(name, query, limit = 2) {
    const v = this.peek(name);
    if (!v || Number(v.messages || 0) < 2) return [];
    const n = Math.max(1, Math.min(2, Number(limit) || 2));
    const q = contentWords(query);
    const now = Date.now();
    const candidates = [];
    const seen = new Set();
    const push = (label, text, t) => {
      const s = clipStore(text, 100);
      if (!s) return;
      const norm = s.toLowerCase();
      if (seen.has(norm)) return;
      seen.add(norm);
      const overlap = q.reduce((acc, w) => acc + (norm.includes(w) ? 1 : 0), 0);
      const ageH = Math.max(0, (now - (t || now)) / 3600000);
      const recency = Math.max(0, 1.5 - ageH / 8);
      candidates.push({
        line: `${label}: ${s}`.slice(0, 140),
        overlap,
        score: overlap * 3 + recency,
        t: t || 0,
      });
    };
    for (const topic of v.topics || []) push('topic', topic.text, topic.t);
    if (v.lastBit?.text) push(v.lastBit.kind === 'joke' ? 'joke' : 'reference', v.lastBit.text, v.lastBit.t);
    for (const r of v.reactions || []) {
      push(r.kind === 'win' ? 'cheered a win' : 'groaned a loss', r.text, r.t);
    }
    if (v.lastGame?.game) push('asked to play', v.lastGame.game, v.lastGame.t);
    if (v.lastMeaningful?.text) push('said', v.lastMeaningful.text, v.lastMeaningful.t);
    if (!candidates.length) return [];
    const ranked = candidates.slice().sort((a, b) => b.score - a.score || b.t - a.t);
    const overlapping = ranked.filter((c) => c.overlap > 0);
    const pool = overlapping.length ? overlapping : ranked.slice(0, 1);
    return pool.slice(0, n).map((c) => c.line);
  }

  // A short, prompt-ready summary. Never includes anything the channel wouldn't show.
  card(name) {
    const v = this.viewers.get(String(name || '').trim());
    if (!v) return '';
    const mins = Math.max(1, Math.round((Date.now() - (v.firstSeen || Date.now())) / 60000));
    const seen = mins > 90 ? `${Math.round(mins / 60)}h` : `${mins}m`;
    const last = v.lines?.at(-1)?.text || '';
    const topic = v.topics?.at(-1)?.text || '';
    const bit = v.lastBit?.text || '';
    const notes = (v.notes || []).slice(-2).join('; ');
    return [
      `returning viewer, ${v.messages} message(s) over ${seen}${v.messages === 1 ? ' (first time today)' : ''}`,
      topic ? `topic: ${topic}` : '',
      bit ? `${v.lastBit.kind}: "${bit.slice(0, 60)}"` : '',
      last ? `last said: "${last.slice(0, 90)}"` : '',
      notes ? `notes: ${notes}` : '',
    ].filter(Boolean).join('; ');
  }

  note(name, text) {
    const v = this.viewers.get(String(name || '').trim());
    if (!v || !text) return;
    v.notes = [...(v.notes || []), String(text).slice(0, MAX_NOTE)].slice(-4);
    this.dirty = true;
  }

  get size() { return this.viewers.size; }
}

const TOPIC_STOP = new Set('the a an and or but if then than that this these those is are was were be been being to of in on for with at by from as it its you your i me my we they he she them do does did what who how why when where can could should would will just about like have has had not for the this that with you your are was were been play playing game games round still gonna want need really very here there just'.split(' '));

function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TOPIC_STOP.has(w));
}

function clipStore(text, max) {
  return String(text || '')
    .replace(/\{[^{}]{0,180}\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function topicFrom(text, game) {
  if (game) {
    const g = String(game).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, MAX_TOPIC);
    if (g) return g;
  }
  const named = String(text || '').match(/\b(dice|mines|crash|limbo|plinko|blackjack|keno|wheel|hilo|tower)\b/i);
  if (named) return named[1].toLowerCase();
  if (FILLER_ONLY.test(String(text || '').trim())) return null;
  const words = contentWords(text);
  if (words.length < 2) return null;
  const phrase = words.slice(0, 4).join(' ');
  return phrase.length >= 4 ? phrase.slice(0, MAX_TOPIC) : null;
}

function pushTopic(v, topic, now) {
  const text = clipStore(topic, MAX_TOPIC);
  if (!text) return;
  const prev = v.topics?.[v.topics.length - 1];
  if (prev && prev.text === text) {
    prev.t = now;
    return;
  }
  v.topics = [...(v.topics || []), { t: now, text }];
  if (v.topics.length > MAX_TOPICS) v.topics = v.topics.slice(-MAX_TOPICS);
}

function bitFrom(text) {
  const t = clipStore(text, MAX_BIT);
  if (t.length < 8 || FILLER_ONLY.test(t)) return null;
  if (/\b(lmao|lmfao|haha|hahaha|lol|joke|kidding|pun)\b/i.test(t) && t.length >= 12) {
    return { kind: 'joke', text: t };
  }
  if (/\b(remember when|you said|last time|that time|callback|reference)\b/i.test(t)) {
    return { kind: 'reference', text: t };
  }
  return null;
}

function reactionFrom(text) {
  const t = String(text || '');
  const win = /\b(nice win|you won|we won|winner|let's go|lets go|clutch|pog|huge hit|gg)\b/i.test(t);
  const lose = /\b(you lose|you lost|we lost|rip|unlucky|bust|oof|missed it)\b/i.test(t);
  if (win === lose) return null;
  return win ? 'win' : 'lose';
}

function pushReaction(v, kind, text, now) {
  const snippet = clipStore(text, MAX_BIT);
  if (!snippet) return;
  const prev = v.reactions?.[v.reactions.length - 1];
  if (prev && prev.kind === kind && prev.text === snippet) {
    prev.t = now;
    return;
  }
  v.reactions = [...(v.reactions || []), { t: now, kind, text: snippet }];
  if (v.reactions.length > MAX_REACTIONS) v.reactions = v.reactions.slice(-MAX_REACTIONS);
}

function clipViewer(v) {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v.lines) && v.lines.length > MAX_LINES) v.lines = v.lines.slice(-MAX_LINES);
  if (Array.isArray(v.topics) && v.topics.length > MAX_TOPICS) v.topics = v.topics.slice(-MAX_TOPICS);
  if (Array.isArray(v.reactions) && v.reactions.length > MAX_REACTIONS) v.reactions = v.reactions.slice(-MAX_REACTIONS);
  if (Array.isArray(v.notes) && v.notes.length > 4) v.notes = v.notes.slice(-4);
  if (v.lastBit?.text) v.lastBit.text = clipStore(v.lastBit.text, MAX_BIT);
  if (v.lastMeaningful?.text) v.lastMeaningful.text = clipStore(v.lastMeaningful.text, MEANINGFUL_MAX);
  for (const topic of v.topics || []) {
    if (topic?.text) topic.text = clipStore(topic.text, MAX_TOPIC);
  }
  for (const r of v.reactions || []) {
    if (r?.text) r.text = clipStore(r.text, MAX_BIT);
  }
  return v;
}
