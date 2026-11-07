// Chat intent classifier + greet pool. Dependency-free so the chat path can call it on
// every message without touching the network. Categories are deliberately coarse: the
// greeting path only needs to know whether to wave, the rest is handled elsewhere.
import { parseGameRequest } from './play-queue.js';

// Spec greet signal: a message that starts with a greeting word still earns a wave even
// when the viewer is not new and did not come back after the 45 min welcome-back gap.
export const GREET_SIGNAL = /^(hi|hii+|hello|hey|yo|gm|good\s*morning|halo|hai)\b/i;
const FAREWELL = /^(bye|byee+|goodbye|good\s*night|gn|later|laterz|see\s*ya|cya|see\s*you|take\s*care)\b/i;
const QUESTION = /(\?|\b(what|why|how|when|where|who|which|can you|could you|would you|do you|does it|is it|are you|will you|should i|any tip|tip for)\b)/i;
const SYMBOLS_ONLY = /^[\p{P}\p{S}\s]+$/u;

export function classify(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'noise';
  // Greeting first: "hi, play dice" should still wave *and* the game request is picked
  // up separately by parseGameRequest in the chat handler.
  if (GREET_SIGNAL.test(t)) return 'greet_signal';
  if (parseGameRequest(t)) return 'game_req';
  if (FAREWELL.test(t)) return 'farewell';
  if (QUESTION.test(t)) return 'question';
  if (SYMBOLS_ONLY.test(t)) return 'noise';
  return 'noise';
}

// Eight to ten short English variants; the {name} slot is filled with the handle.
export const GREET_LINES = [
  'Hey {name}, welcome in!',
  'Yo {name}, good to see you in chat.',
  '{name}! There you are — welcome.',
  'Hey hey {name}, chat just got better.',
  '{name} in the house. Let us go.',
  'Hello {name}, pull up a chair.',
  'Good to see you, {name}. Stick around.',
  'Hey {name}, thanks for dropping in.',
  '{name}! Welcome to the table.',
  'Hey {name}, glad you hopped in.',
];

const recentGreets = [];

// Pick a greet variant that was not used in the last five greetings.
export function pickGreetLine(name) {
  const short = String(name || 'friend').replace(/\s+/g, ' ').trim().slice(0, 16) || 'friend';
  const fresh = GREET_LINES.filter((line) => !recentGreets.includes(line));
  const source = fresh.length ? fresh : GREET_LINES;
  const line = source[Math.floor(Math.random() * source.length)];
  recentGreets.push(line);
  while (recentGreets.length > 5) recentGreets.shift();
  return line.replace('{name}', short);
}
