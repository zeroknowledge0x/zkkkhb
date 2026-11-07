// Host cue: a tiny allowlisted JSON blob the brain may put before or after a spoken
// line. It never reaches TTS. expressionHint still decides the face when the cue is
// missing or the value is not on the list.
import { expressionHint } from './tts-xai.js';

export const EMOTIONS = new Set(['win', 'hype', 'laugh', 'chill', 'neutral']);

const GESTURE_CANON = new Map([
  ['nod', 'nod'],
  ['shrug', 'shrug'],
  ['lookchat', 'lookChat'],
  ['none', 'none'],
]);

// Same durations the talk queue already uses for nod / shrug / lookChat.
export const GESTURE_MS = Object.freeze({ nod: 1100, shrug: 1400, lookChat: 1300 });

const CUE_KEYS = new Set(['emotion', 'gesture']);

function parseJsonObject(blob) {
  const s = String(blob || '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  if (s.length > 240) return null;
  const attempts = [s, s.replace(/,\s*([}\]])/g, '$1')];
  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch { /* try the comma-stripped form */ }
  }
  return null;
}

function cueFromObject(obj) {
  if (!obj) return null;
  const keys = Object.keys(obj);
  if (!keys.length || keys.length > 2) return null;
  if (!keys.every((k) => CUE_KEYS.has(k))) return null;
  return obj;
}

// Models sometimes emit {emotion: "win", gesture: "nod"} without quoted keys.
function looseCueObject(blob) {
  const s = String(blob || '');
  if (s.length > 240 || !s.includes('{')) return null;
  if (!/["']?emotion["']?\s*[:=]/i.test(s) && !/["']?gesture["']?\s*[:=]/i.test(s)) return null;
  const emotion = s.match(/emotion["']?\s*[:=]\s*["']?(win|hype|laugh|chill|neutral)\b/i);
  const gesture = s.match(/gesture["']?\s*[:=]\s*["']?(nod|shrug|lookchat|none)\b/i);
  const obj = {};
  if (emotion) obj.emotion = emotion[1].toLowerCase();
  else if (/emotion["']?\s*[:=]/i.test(s)) obj.emotion = '';
  if (gesture) obj.gesture = gesture[1];
  else if (/gesture["']?\s*[:=]/i.test(s)) obj.gesture = '';
  return obj;
}

function takeFields(obj, state) {
  if (!obj || typeof obj !== 'object') return;
  if (!state.emotionSeen && Object.prototype.hasOwnProperty.call(obj, 'emotion')) {
    state.emotionSeen = true;
    const e = String(obj.emotion ?? '').trim().toLowerCase();
    if (EMOTIONS.has(e)) state.emotion = e;
  }
  if (!state.gestureSeen && Object.prototype.hasOwnProperty.call(obj, 'gesture')) {
    state.gestureSeen = true;
    const g = GESTURE_CANON.get(String(obj.gesture ?? '').trim().toLowerCase());
    if (g) state.gesture = g;
  }
}

function absorbBlob(blob, state) {
  const parsed = parseJsonObject(blob);
  const cue = cueFromObject(parsed);
  if (cue) {
    takeFields(cue, state);
    return true;
  }
  const loose = looseCueObject(blob);
  if (loose) {
    takeFields(loose, state);
    return true;
  }
  // Any other small JSON object is not speech either.
  return !!parsed;
}

function matchBrace(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Pull emotion + gesture off a model line and return only what should be spoken.
// emotion is null when absent or not allowlisted (caller falls back to expressionHint).
// gesture is null when absent, or 'none' when the model explicitly asked for no gesture.
export function takeHostCue(raw) {
  let text = String(raw ?? '').replace(/^\uFEFF/, '');
  const state = { emotion: null, gesture: null, emotionSeen: false, gestureSeen: false };

  text = text.replace(/```(?:json|js|javascript)?\s*([\s\S]*?)```/gi, (full, inner) => {
    const body = String(inner || '').trim();
    if (absorbBlob(body, state)) return ' ';
    const parsed = parseJsonObject(body);
    if (parsed) return ' ';
    return full;
  });

  // Leading cue, including when the whole line is only the object.
  for (let i = 0; i < 3; i++) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) break;
    const end = matchBrace(trimmed, 0);
    if (end < 0) break;
    const blob = trimmed.slice(0, end + 1);
    if (!absorbBlob(blob, state) && !(end === trimmed.length - 1 && parseJsonObject(blob))) break;
    text = trimmed.slice(end + 1);
  }

  text = text.replace(/\{[^{}]{0,240}\}/g, (blob) => (absorbBlob(blob, state) ? ' ' : blob));

  // A word-cap can slice the trailer. Drop a dangling cue so the tail is not spoken.
  text = text.replace(/\{[^}]{0,240}$/g, (blob) => {
    if (!/emotion|gesture/i.test(blob)) return blob;
    const loose = looseCueObject(`${blob}}`);
    if (loose) takeFields(loose, state);
    return ' ';
  });
  text = text.replace(/\{\s*["']?(?:emotion|gesture)\b[^}]{0,200}\}?/gi, ' ');
  text = text.replace(/(?:^|\s)cue\s*:\s*/gi, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\s+([,.;!?])/g, '$1');
  return { text, emotion: state.emotion, gesture: state.gesture };
}

// explicit (model cue or caller) wins. Otherwise the existing keyword/kind heuristic.
export function resolveExpression(explicit, kind, text) {
  if (explicit) return explicit;
  return expressionHint(kind, text) || null;
}

export function gestureFromCue(gesture) {
  if (gesture == null || gesture === '') return { set: false, gesture: null };
  if (gesture === 'none') return { set: true, gesture: null };
  const ms = GESTURE_MS[gesture];
  if (!ms) return { set: false, gesture: null };
  return { set: true, gesture: { kind: gesture, ms } };
}
