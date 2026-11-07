// Supervisor: one Node process owns the encoder, the render clock, the voice and the
// chat client. Anything that dies is restarted in place - no human action on the stream.
import path from 'node:path';
import fs from 'node:fs';
import { loadEnv, cfg, VENDOR } from './config.js';
import { log } from './log.js';
import { AudioBus } from './audio.js';
import { PiperVoice } from './tts.js';
import { EdgeVoice } from './tts-edge.js';
import { KokoroVoice } from './tts-kokoro.js';
import { XaiVoice } from './tts-xai.js';
import { Renderer } from './render.js';
import { Encoder } from './stream.js';
import { Brain, sanitize, demoDiet } from './brain.js';
import { takeHostCue, resolveExpression, gestureFromCue } from './host-cue.js';
import { createChat } from './chat.js';
import { classify, pickGreetLine } from './intent.js';
import { closeBrowser } from './browser.js';
import { GameFeed } from './game.js';
import { GamePerception } from './perceive.js';
import { ViewerMemory } from './memory.js';
import { Knowledge } from './kb.js';
import { createTools } from './tools.js';
import { AgentLoop, talkPriority, TALK_WIN } from './agent.js';
import { Jev } from './jev.js';
import { PlayQueue, parseGameRequest, pickRandomGame, isPlayable, GAMES } from './play-queue.js';
import { maybeBookmark } from './vod-bookmark.js';
import {
  cannedAck,
  composeChatReply,
  createChatIntake,
  formatChatSkip,
  normHandle,
  offerReply,
  parseTuneRequest,
  planChat,
  REPLY_BRAIN_TIMEOUT_MS,
  safeTuneValue,
} from './chat-reply.js';

loadEnv();
const c = cfg();
const samplePerFrame = Math.round(c.sampleRate / c.fps);

const audio = new AudioBus(c.sampleRate);
const renderer = new Renderer({
  width: c.width,
  height: c.height,
  artDir: path.join(process.cwd(), 'assets', 'hubie'),
});

// Utterance trace: every TTS line gets a short id. The FIRST PCM packet that reaches the
// AudioBus stamps latency (recv -> first_pcm). Gestures and expression wait until that
// audio is pulled for a frame, so a buffered packet cannot nod or open the mouth early.
// Synth audio.done is not playback done.
let utterSeq = 0;
let lastFirstPcmMs = null;
const utterQueue = [];
function newUtterance(kind, meta = {}) {
  const rec = {
    id: `${kind === 'greet' ? 'g' : 'u'}${++utterSeq}`,
    kind,
    t0: Date.now(),
    logged: false,
    dropped: false,
    chatId: meta.chatId || null,
    gesture: meta.gesture || null,
    expression: meta.expression || null,
    playbackArmed: false,
  };
  utterQueue.push(rec);
  while (utterQueue.length > 12) utterQueue.shift();
  return rec;
}
// A line that never reached the bus (dropped/preempted/overflowed) must not swallow
// the next line's gesture or latency log. When the voice is idle, unlogged records
// are by definition silent: retire them and cancel their pending gesture.
function retireSilentUtterances() {
  for (const u of utterQueue) {
    if (u.logged || u.dropped) continue;
    u.dropped = true;
    log(`talk: dropped_before_pcm id=${u.id}${u.chatId ? ` chat=${u.chatId}` : ''}`);
  }
}
const pushAudio = (pcm) => {
  const now = Date.now();
  // More samples of this line arrived — playback has not ended.
  state.captionEndedAt = null;
  for (const u of utterQueue) {
    if (!u.logged && !u.dropped && now - u.t0 > 15000) {
      u.dropped = true;
      log(`talk: dropped_before_pcm id=${u.id}${u.chatId ? ` chat=${u.chatId}` : ''}`);
    }
  }
  const rec = utterQueue.find((u) => !u.logged && !u.dropped);
  let onPlayback = null;
  if (rec) {
    rec.logged = true;
    const dt = now - rec.t0;
    lastFirstPcmMs = dt;
    const tag = rec.kind === 'greet' ? 'greet' : 'chat';
    log(`${tag}: first_pcm id=${rec.id}${rec.chatId ? ` chat=${rec.chatId}` : ''} dt_ms=${dt}`);
    if (!rec.playbackArmed) {
      rec.playbackArmed = true;
      const gesture = rec.gesture;
      const expression = rec.expression;
      // Fires inside AudioBus.take, before this frame is drawn.
      onPlayback = () => {
        if (rec.dropped) return;
        state.expression = expression || null;
        if (gesture && !gesture.fired) {
          gesture.fired = true;
          try { setGesture(gesture.kind, gesture.ms); } catch { /* render state not ready */ }
        }
      };
    }
  }
  audio.push(pcm, onPlayback);
};
const piper = new PiperVoice({
  binPath: path.join(VENDOR, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper'),
  voiceName: c.ttsVoice,
  speaker: c.ttsSpeaker,
  lengthScale: c.ttsLengthScale,
  noiseScale: c.ttsNoiseScale,
  noiseW: c.ttsNoiseW,
  sentenceSilence: c.ttsSentenceSilence,
  onAudio: pushAudio,
});
// Kokoro is the default when TTS_ENGINE is unset. Piper stays warm under Kokoro and Edge.
// TTS_ENGINE=edge is the no-key rollback. TTS_ENGINE=xai speaks as Atlas and fails over to
// Edge Andrew (which still has Piper behind it). Edge is never an automatic Kokoro fallback.
function makeEdge(voiceName) {
  return new EdgeVoice({
    voice: voiceName,
    rate: c.ttsEdgeRate,
    pitch: c.ttsEdgePitch,
    volume: c.ttsEdgeVolume,
    timeoutMs: c.ttsEdgeTimeoutMs,
    fallback: piper,
    onAudio: pushAudio,
  });
}
const voice = c.ttsEngine === 'piper'
  ? piper
  : c.ttsEngine === 'edge'
    ? makeEdge(c.ttsEdgeVoice)
    : c.ttsEngine === 'xai'
      ? new XaiVoice({
        apiKey: c.ttsXaiKey,
        voice: c.ttsXaiVoice,
        language: c.ttsXaiLanguage,
        sampleRate: c.ttsXaiSampleRate,
        speed: c.ttsXaiSpeed,
        latency: c.ttsXaiLatency,
        outRate: c.sampleRate,
        timeoutMs: c.ttsXaiTimeoutMs,
        fallback: makeEdge(c.ttsXaiFailoverVoice),
        onAudio: pushAudio,
      })
      : new KokoroVoice({
        url: c.ttsKokoroUrl,
        voice: c.ttsKokoroVoice,
        speed: c.ttsKokoroSpeed,
        sampleRate: c.sampleRate,
        timeoutMs: c.ttsKokoroTimeoutMs,
        pauseMs: c.ttsKokoroPauseMs,
        voiceExplicit: c.ttsKokoroVoiceExplicit,
        fallback: piper,
        onAudio: pushAudio,
      });

// Chunk-boundary preemption: a greet/reply arriving while a win/lose/idle line is
// sounding asks the voice to finish the current chunk and then clear the rest. This is
// how a low-priority in-flight line yields without slicing audio mid-word.
const voiceCtl = { priority: 99, urgent: false, rec: null };
voice.shouldDrop = () => {
  if (!voiceCtl.urgent) return false;
  const mayYield = voiceCtl.priority >= TALK_WIN;
  voiceCtl.urgent = false;
  if (mayYield) log(`talk: yield id=${voiceCtl.rec?.id || '?'} priority=${voiceCtl.priority}`);
  return mayYield;
};
for (let hop = voice; hop?.fallback; hop = hop.fallback) {
  hop.fallback.shouldDrop = voice.shouldDrop;
}

const memory = new ViewerMemory(path.join(process.cwd(), 'data', 'viewers.json'));
const kb = new Knowledge(path.join(process.cwd(), 'data', 'kb.json'));
const brain = new Brain(c, { memory, kb });
const jev = new Jev(c);
log(jev.enabled
  ? `jev: enabled (${jev.model} @ ${jev.url}, ${jev.timeoutMs} ms, conf ${jev.minConfidence})`
  : `jev: disabled - ${jev.reason}`);
const state = {
  chat: [],
  caption: '',
  captionEndedAt: null,
  capToken: 0,
  captionArmedAt: 0,
  round: 1,
  mouth: 0,
  speaking: false,
  waveUntil: 0,
  gesture: { kind: null, until: 0 },
  expression: null,
  segment: 'play',
  segmentUntil: 0,
};
const playQueue = new PlayQueue();

// Soft segments rotate play -> chill -> chatPick on their own clock. They only bias idle
// chatter and the caption; the game rotation timer stays untouched.
const SEGMENTS = ['play', 'chill', 'chatPick'];
const SEGMENT_MIN_MS = 8 * 60 * 1000;
const SEGMENT_MAX_MS = 12 * 60 * 1000;
const SEGMENT_CAPTION = { play: 'locked in', chill: 'chill mode', chatPick: 'your pick' };
function randSegmentMs() {
  return SEGMENT_MIN_MS + Math.floor(Math.random() * (SEGMENT_MAX_MS - SEGMENT_MIN_MS + 1));
}
function nextSegment(name) {
  const i = SEGMENTS.indexOf(name);
  return SEGMENTS[(i + 1) % SEGMENTS.length];
}
function tickSegment(now = Date.now()) {
  if (now < state.segmentUntil) return;
  state.segment = nextSegment(state.segment);
  state.segmentUntil = now + randSegmentMs();
  log(`segment: ${state.segment}`);
  // Caption only, never TTS, and only while Hubie is quiet so a live line is not cut.
  if (!state.speaking && !voice.speaking) {
    state.caption = SEGMENT_CAPTION[state.segment] || state.segment;
    state.captionEndedAt = null;
  }
}
state.segmentUntil = Date.now() + randSegmentMs();
setInterval(() => tickSegment(Date.now()), 30000).unref?.();

let capSeq = 0;
audio.onPlaybackEnd((token) => {
  if (token !== state.capToken) return;
  state.captionEndedAt = Date.now();
});

// Presence gestures ride on top of the wave: win -> nod, lose -> shrug, reply -> lookChat.
// A higher-priority gesture is never overwritten by a lower one while it is still running.
function setGesture(kind, ms) {
  const dur = Number(ms) || 1200;
  const rank = { shrug: 3, nod: 2, lookChat: 1 };
  const now = Date.now();
  const cur = state.gesture?.kind;
  if (cur && state.gesture.until > now && (rank[cur] || 0) > (rank[kind] || 0)) return;
  state.gesture = { kind, until: now + dur };
  log(`gesture: ${kind} ${dur}ms`);
}

function currentGameName() {
  const raw = String(game.currentUrl || game.url || '');
  const title = String(game.title || '');
  let slug = raw;
  try {
    const u = new URL(raw);
    slug = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
  } catch { /* keep the raw string */ }
  const hay = `${slug} ${title}`.toLowerCase();
  return GAMES.find((g) => hay.includes(g.toLowerCase())) || null;
}

// Returning viewers get their own pool so a comeback does not read like a first hello.
const BACK_LINES = [
  'Hey {name}, back again',
  '{name} slides back in',
  'Look who wandered back, {name}',
  '{name} returns. Chat is not surprised.',
  'Back for more, {name}?',
  '{name} again. The table never sleeps.',
  'Well look at that, {name} is back',
  'Hey {name}, we kept your seat warm',
  '{name} reconnects. Zero dollars, full vibes.',
  'Back on the couch, {name}',
];
// Regulars who type a greeting get a nod, not another full welcome.
const FAMILIAR_LINES = [
  'yo {name}',
  '{name} again',
  'hey {name}, still here',
];
const recentBackLines = [];
const recentFamiliarLines = [];

function pickFromPool(pool, recent, name) {
  const short = String(name || 'friend').replace(/\s+/g, ' ').trim().slice(0, 16) || 'friend';
  const fresh = pool.filter((line) => !recent.includes(line));
  const source = fresh.length ? fresh : pool;
  const line = source[Math.floor(Math.random() * source.length)];
  recent.push(line);
  while (recent.length > 5) recent.shift();
  return line.replace('{name}', short);
}

function pickBackLine(name) {
  return pickFromPool(BACK_LINES, recentBackLines, name);
}

function pickFamiliarLine(name) {
  return pickFromPool(FAMILIAR_LINES, recentFamiliarLines, name);
}

// Short, human queue announces (<=14 words, contractions, no repeated compliance phrase).
// Rotated with an anti-repeat window of the last 3 so the voice does not chant one shape.
const QUEUE_LINES = [
  '{game} locked for {name} \u2014 still free.',
  'Got it {name}, {game} is next.',
  "{name} queued {game}. We're playing free.",
  '{name} picked {game}. Small stake, we ride.',
  'Locked {game} for {name}. No money involved.',
  '{game} is up next for {name}. Still free play.',
];
const recentQueueLines = [];
function pickQueueLine(name, game) {
  const short = String(name || 'friend').replace(/\s+/g, ' ').trim().slice(0, 16) || 'friend';
  const g = String(game || 'a game').replace(/\s+/g, ' ').trim().slice(0, 24) || 'a game';
  const fresh = QUEUE_LINES.filter((line) => !recentQueueLines.includes(line));
  const source = fresh.length ? fresh : QUEUE_LINES;
  const tpl = source[Math.floor(Math.random() * source.length)];
  recentQueueLines.push(tpl);
  while (recentQueueLines.length > 3) recentQueueLines.shift();
  return tpl.replace('{game}', g).replace('{name}', short);
}

let chatSeq = 0;
let lastChatAt = 0;
let lastLookChatAt = 0;
// Exact handles only. LiveHubi is a viewer; hubiezk is the owner account.
const intake = createChatIntake({
  selfNames: [c.kickChannel, c.twitchChannel, 'hubie', 'hubiezk'],
});

function purgeSender(name) {
  const key = normHandle(name);
  for (let i = state.chat.length - 1; i >= 0; i--) {
    if (normHandle(state.chat[i].name) === key) state.chat.splice(i, 1);
  }
  for (let i = replyQueue.length - 1; i >= 0; i--) {
    if (normHandle(replyQueue[i].name) === key) replyQueue.splice(i, 1);
  }
}

function handleChat(m) {
  if (!m?.name || !m.text) return;
  // Short id at ingest so every later log (queue, first PCM, stale drop) can be tied
  // back to one chat message even when TTS is seconds behind.
  if (!m.id) m.id = `c${(++chatSeq).toString(36)}`;
  lastChatAt = Date.now();
  log(`chat: recv id=${m.id} name=${m.name} t=${lastChatAt}`);
  const screened = intake.screen(m);
  if (screened.action === 'skip') {
    log(formatChatSkip(screened));
    if (screened.purge) purgeSender(m.name);
    return;
  }
  // Presence: one chat-ward glance on ingest (throttled) so a Kick DOM batch of 10
  // messages does not spam lookChat. First-PCM nod/shrug/lookChat still fire on audio.
  if (lastChatAt - lastLookChatAt > 1600) {
    lastLookChatAt = lastChatAt;
    setGesture('lookChat', 900);
  }
  // Intent decides whether a plain "hi" earns a wave. Peek before remember(): 'new' only
  // when there is no record at all, 'back' when the last visit is over 45 min old. The
  // two greet cooldowns are independent (13 min signal vs 45 min welcome-back).
  const intent = classify(m.text);
  const back = memory.shouldGreet(m.name);
  const signal = intent === 'greet_signal' && memory.shouldGreetSignal(m.name);
  // A number on target/multiplier is a tune, not a game switch. Game requests still queue.
  const tune = parseTuneRequest(m.text);
  const request = tune ? null : parseGameRequest(m.text);
  // Continuity: remember the last meaningful line and the last game mention.
  memory.remember(m.name, m.text, {
    game: request && request !== '__random__' ? request : null,
  });
  state.chat.push(m);
  if (state.chat.length > 24) state.chat.shift();
  const greeted = !!(back || signal);
  if (greeted) {
    const kind = back === 'back' ? 'back' : back === 'new' ? 'new' : 'signal';
    if (back) memory.markGreeted(m.name);
    if (signal) memory.markGreetSignaled(m.name);
    // Wave always rides a greet, signal or welcome-back.
    state.waveUntil = Date.now() + 2200;
    log(`chat: greet ${kind} name=${m.name} intent=${intent}`);
    const short = String(m.name).trim().slice(0, 16);
    // Familiar regulars on a typed hi get a short nod now and then instead of a full hello.
    const familiar = kind === 'signal' && memory.isRegular(m.name, 5) && Math.random() < 0.3;
    let line = kind === 'back'
      ? pickBackLine(short)
      : familiar ? pickFamiliarLine(short) : pickGreetLine(short);
    // A returning line may quote the last real thing they said (once, if short), which
    // makes "back again" land as continuity instead of a canned hello.
    if (kind === 'back') {
      const ref = memory.lastMeaningful(m.name);
      const lastGame = memory.lastGame(m.name);
      const bits = [];
      if (ref && ref.length <= 60) bits.push(`last you said "${ref}"`);
      if (lastGame) bits.push(`still on ${lastGame}`);
      if (bits.length && Math.random() < 0.7) line += ` \u2014 ${bits.join(', ')}`;
    }
    // Greet is TalkQ priority 0: queued, never dropped, spoken before idle/replies.
    // The chatId lets the first-PCM log point back at the message that caused it.
    if (agent) agent.enqueue(line, `greet:${kind}`, { chatId: m.id });
    else speak(line, 'greet', { chatId: m.id });
  }
  if (tune) {
    const safe = safeTuneValue(tune.kind, tune.value);
    if (safe.ok) {
      game.applyViewerTune?.(tune).catch((err) => log(`chat: tune failed ${err?.message || err}`));
    } else {
      log(`chat: tune held name=${m.name} kind=${tune.kind} value=${tune.value} reason=${safe.reason}`);
    }
  }
  let queueAnnounced = false;
  if (request) {
    // "other/next/random game" asks for a fresh pick that is not the current one.
    const gameName = request === '__random__'
      ? pickRandomGame(currentGameName() || '')
      : request;
    // Only tables we have proven playable are offered. Declining out loud beats opening
    // a table that never resolves.
    if (!isPlayable(gameName)) {
      const line = `No ${gameName} on the menu yet, ${m.name}. Dice it is.`;
      speak(line, 'reply', { chatId: m.id, name: m.name });
      log(`chat: queue refused name=${m.name} game=${gameName} (not proven playable)`);
      return;
    }
    const item = playQueue.enqueue({ name: m.name, game: gameName, from: 'chat' });
    if (item) {
      const line = pickQueueLine(item.name, item.game);
      // Every accepted game ask is spoken. The old 20s silence dropped "limbo" /
      // "change game" / "other game" when a previous ack was still warm.
      // Queue is TalkQ priority 1: behind greet, ahead of reply.
      log(`chat: queue ack name=${item.name} game=${item.game}`);
      const queued = agent ? agent.enqueue(line, 'queue', { chatId: m.id }) : true;
      if (agent && queued === false) {
        log(formatChatSkip({ reason: 'queue_full', n: intake.bump('queue_full'), name: m.name }));
      } else if (!agent) {
        speak(line, 'queue', { chatId: m.id });
      }
      queueAnnounced = queued !== false;
    }
  }
  // A pure "hi" is answered by the greet. Anything else — including a tune, a second
  // hello, or a question that started with hi — still gets a reply. The queue ack is
  // the reply for a game switch, so it does not also call the brain.
  const route = planChat({ text: m.text, greeted, queueAnnounced });
  if (route.action !== 'reply') return;
  const offered = offerReply(replyQueue, m);
  if (!offered.ok) {
    log(formatChatSkip({ reason: 'queue_full', n: intake.bump('queue_full'), name: m.name }));
  }
}

const chat = createChat(c, { onMessage: handleChat });
const game = new GameFeed({
  url: c.gamesUrl,
  captureMode: c.captureMode,
  headed: c.headed,
});

let encoder = null;
let frames = 0;
const startedAt = Date.now();
let lastFrameDumpAt = 0;
let stopping = false;
const replyQueue = [];
let nextAt = Date.now();
// Keeps the speaking badge across a short inter-syllable dip without holding it
// after the bus has drained. Mouth RMS still closes on the silent frames.
let audibleUntil = 0;
const SPEAK_HANG_MS = 180;

const tools = createTools({
  game,
  stream: {
    frames: () => frames,
    // Busy covers synth pre-roll (voice.speaking) and audio still sitting in the bus
    // (state.speaking). The on-screen flag itself follows playback, not packet arrival.
    speaking: () => !!(state.speaking || voice.speaking),
    round: () => state.round,
  },
  chat: {
    recent: (n = 8) => state.chat.slice(-n),
  },
  playQueue,
});

const perception = new GamePerception({
  enabled: c.gamePerception,
  intervalMs: c.gamePerceptionMs,
  visionMs: c.gamePerceptionVisionMs,
  log,
  readDom: async () => {
    let report = {};
    try { report = game.getReport?.() || {}; } catch { report = {}; }
    let extra = null;
    try { extra = await game.readPerceptionDom?.(); } catch { extra = null; }
    return {
      url: extra?.url || report.url,
      title: extra?.title || report.title,
      body: extra?.body || report.bodySnippet,
      bodySnippet: report.bodySnippet,
      clickables: report.clickables,
      outcome: report.outcome,
      balanceText: extra?.balanceText || null,
      multiplierText: extra?.multiplierText || null,
      roundText: extra?.roundText || null,
      lobbySnapshot: game.lobbySnapshot || null,
    };
  },
  captureFrame: () => game.captureLowRes?.(),
  summarize: (buf) => brain.summarizeFrame?.(buf),
});
log(c.gamePerception
  ? `perceive: on (dom ${c.gamePerceptionMs} ms, vision >= ${c.gamePerceptionVisionMs} ms)`
  : 'perceive: off — scripted bet-0 loop');

let agent = null;
agent = new AgentLoop({
  brain,
  tools,
  game,
  jev,
  perception,
  playQueue,
  speak: (text, kind, meta) => speak(text, kind || 'agent', meta || {}),
  setGesture,
  getSegment: () => state.segment,
  // A greet/reply that arrives while a low-priority line is sounding asks the voice to
  // yield after its current chunk instead of making chat wait out the whole sentence.
  onUrgent: () => {
    if (voice.speaking && voiceCtl.priority >= TALK_WIN) voiceCtl.urgent = true;
  },
});

// VOD bookmarks: one line every 3 h so a long recording can be traced to game/segment/commit.
const COMMIT_PATH = path.join(process.cwd(), 'COMMIT.txt');
const VOD_BOOKMARK_PATH = path.join(process.cwd(), 'logs', 'vod-bookmarks.jsonl');

function vodMeta() {
  let commit = null;
  try {
    const raw = fs.readFileSync(COMMIT_PATH, 'utf8').trim();
    if (raw) commit = raw.slice(0, 40);
  } catch { /* no COMMIT.txt */ }
  return {
    game: currentGameName() || String(game.title || '').slice(0, 40) || null,
    uptimeH: Number(((Date.now() - startedAt) / 3600000).toFixed(2)),
    segment: state.segment,
    commit,
  };
}

setInterval(() => maybeBookmark({
  file: VOD_BOOKMARK_PATH,
  getMeta: vodMeta,
}), 60000).unref?.();

// Telegram /say drops a line here; the host speaks it in the next tick.
const SAY_INJECT_PATH = path.join(process.cwd(), 'say-inject.json');
setInterval(() => {
  try {
    if (!fs.existsSync(SAY_INJECT_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(SAY_INJECT_PATH, 'utf8'));
    fs.unlinkSync(SAY_INJECT_PATH);
    const text = String(raw?.text || '').trim();
    if (!text) return;
    log(`ops: say inject "${text.slice(0, 60)}"`);
    speak(sanitize(text), 'reply', { chatId: null, name: 'ops' });
  } catch (err) {
    log(`ops: say inject failed: ${err.message}`);
  }
}, 1000).unref?.();

const INJECT_PATH = path.join(process.cwd(), 'queue-inject.json');
setInterval(() => {
  try {
    if (!fs.existsSync(INJECT_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(INJECT_PATH, 'utf8'));
    fs.unlinkSync(INJECT_PATH);
    const gameName = raw?.game === '__random__'
      ? pickRandomGame(currentGameName() || '')
      : (raw?.game || null);
    if (gameName && !isPlayable(gameName)) {
      log(`ops: inject refused ${gameName} (not proven playable)`);
      return;
    }
    const item = playQueue.enqueue({
      name: String(raw?.name || 'ops'),
      game: gameName,
      from: 'inject',
      front: true,
    });
    if (item) {
      // Ops jumps the line; drop the chat hold so navigate can fire next tick.
      if (agent) agent.queueHoldUntil = 0;
      log(`ops: inject queue ${item.game} for ${item.name} (front)`);
      const line = pickQueueLine(item.name, item.game);
      if (agent) agent.enqueue(line, 'queue');
      else speak(line, 'queue');
    }
  } catch (err) {
    log(`ops: inject failed: ${err.message}`);
  }
}, 2000);

function startEncoder() {
  encoder = new Encoder(c);
  encoder.onExit = () => {
    if (stopping) return;
    log('supervisor: encoder down, restarting in 2 s');
    setTimeout(() => { if (!stopping) startEncoder(); }, 2000);
  };
  encoder.start();
}

async function speak(text, kind = 'idle', meta = {}) {
  const hint = meta && typeof meta === 'object' ? meta : {};
  // Strip a host cue before sanitize so a truncated JSON tail cannot be spoken.
  const cue = takeHostCue(text);
  text = sanitize(cue.text);
  if (!text) return;
  // Pre-TTS demo diet: if "demo" was spoken in the last five minutes, rewrite this line
  // to free-play phrasing; drop it when the rewrite collapses.
  text = demoDiet(text);
  if (!text) {
    log(`speak: demo-diet dropped ${kind} line`);
    return;
  }
  // Register the utterance before any PCM can arrive, so pushAudio can stamp latency
  // on the first packet. The gesture waits until those samples are pulled for a frame.
  const wasSpeaking = !!voice.speaking;
  if (!wasSpeaking && audio.seconds < 0.05) retireSilentUtterances();
  // Model cue wins. expressionHint is the fallback when the line had no allowlisted emotion.
  const expression = resolveExpression(hint.expression || cue.emotion, kind, text);
  let gesture = hint.gesture || null;
  if (hint.gestureSet) gesture = hint.gesture || null;
  else if (!gesture && cue.gesture) {
    const fromCue = gestureFromCue(cue.gesture);
    if (fromCue.set) gesture = fromCue.gesture;
  }
  const rec = newUtterance(String(kind).startsWith('greet') ? 'greet' : 'chat', { ...hint, expression, gesture });
  if (!wasSpeaking) {
    voiceCtl.priority = talkPriority(kind);
    voiceCtl.urgent = false;
    voiceCtl.rec = rec;
  }
  state.caption = text;
  state.captionEndedAt = null;
  state.capToken = ++capSeq;
  state.captionArmedAt = Date.now();
  audio.armPlayback(state.capToken);
  if (String(kind).startsWith('react:')) state.round += 1;
  const gestureName = gesture?.kind || (hint.gestureSet ? 'none' : '-');
  log(`speak: id=${rec.id} kind=${kind || 'speak'}${hint.chatId ? ` chat=${hint.chatId}` : ''} expr=${expression || '-'} gesture=${gestureName}`);
  brain.noteSpoken(text, kind);
  voice.speak(text, { expression });
  if (kind === 'reply') chat.say(text);
}

async function tick() {
  if (stopping) return;
  // No PCM ever arrived for this line: start the caption hold so it cannot sit forever.
  if (state.caption && state.captionEndedAt == null && state.captionArmedAt
    && !voice.speaking && audio.seconds < 0.02 && !audio.endSaw
    && Date.now() - state.captionArmedAt > 8000) {
    state.captionEndedAt = Date.now();
  }
  const t0 = process.hrtime.bigint();
  const pcm = audio.take(samplePerFrame);
  // Mouth follows the samples this frame will play. Packet arrival must not open it.
  const rms = audio.rms(pcm);
  const target = Math.min(1, rms * 10);
  const heard = target > 0.08;
  if (heard) audibleUntil = Date.now() + SPEAK_HANG_MS;
  const queued = audio.seconds > 0.02;
  const playing = heard || queued || Date.now() < audibleUntil;
  const blend = target > state.mouth ? 0.72 : 0.5;
  state.mouth = Math.min(1, state.mouth * (1 - blend) + target * blend);
  state.speaking = playing;
  if (!playing && !voice.speaking) state.expression = null;

  const frame = renderer.draw({
    ...state,
    gameFrame: game.frame,
    pointer: game.lastPointer,
    viewport: game.viewport,
    // Live table stats for the chip row. Optional: the renderer skips anything missing.
    stats: perception?.state || null,
  });
  // Eyes on the real output: FRAME_DUMP_MS=10000 leaves logs/live-frame.jpg ~10 s old, so
  // "the panel is a stand-in" can be confirmed without pulling the stream.
  if (c.frameDumpMs && Date.now() - lastFrameDumpAt >= c.frameDumpMs) {
    lastFrameDumpAt = Date.now();
    renderer.canvas.encode('jpeg', 82)
      .then((buf) => fs.writeFileSync(path.join('logs', 'live-frame.jpg'), buf))
      .catch(() => {});
  }
  try {
    // Audio first: ffmpeg's demuxer services inputs in order, and a starved audio
    // pipe blocks video reads (measured: 2.5 s stalls when the order is reversed).
    await encoder.pushAudio(pcm);
    await encoder.pushVideo(frame);
    frames++;
  } catch (err) {
    log(`supervisor: write failed: ${err.message}`);
  }

  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  if (elapsed > 40) log(`supervisor: slow frame ${elapsed.toFixed(0)} ms`);
  schedule();
}

function schedule() {
  nextAt += 1000 / c.fps;
  const delay = Math.max(0, nextAt - Date.now());
  if (Date.now() - nextAt > 1000) nextAt = Date.now(); // recover from a long stall
  setTimeout(tick, delay);
}

// Jev picks a grounded knowledge-base entry when one clearly fits; otherwise the brain writes.
async function jevReply(m) {
  if (!jev.enabled || !kb.size) return null;
  const searched = kb.search(m.text, 5);
  const pool = searched.length ? searched : kb.entries;
  const hit = await jev.chooseReply(m.text, pool);
  const entry = hit ? pool.find((e) => e.id === hit.id) : null;
  if (!entry) {
    log(`chat: jev kb=none name=${m.name}`);
    return null;
  }
  log(`chat: jev kb=${entry.id} conf=${hit.conf.toFixed(2)} name=${m.name}`);
  return entry;
}

// Brain first, with a short budget. A hung call used to block the whole FIFO for 20s
// and the quiet gate then dropped everyone behind it. Timeout speaks a canned ack.

function replyMeta(m, shaped) {
  const g = gestureFromCue(shaped?.gesture);
  return {
    chatId: m.id,
    expression: shaped?.emotion || null,
    gesture: g.set ? g.gesture : { kind: 'lookChat', ms: 1300 },
    gestureSet: true,
  };
}

let replyBusy = false;

async function deliverReply(m) {
  if (intake.isPromoSender(m.name)) return;
  let shaped;
  try {
    shaped = await composeChatReply(m, { brain, jevReply, timeoutMs: REPLY_BRAIN_TIMEOUT_MS });
  } catch (err) {
    log(`chat: reply failed name=${m.name} (${err?.message || err})`);
    shaped = { text: cannedAck(m.name), source: 'canned', reason: 'error' };
  }
  if (intake.isPromoSender(m.name)) return;
  const line = String(shaped?.text || '').trim();
  if (!line) {
    log(formatChatSkip({ reason: 'empty', n: intake.bump('empty'), name: m.name }));
    return;
  }
  const why = shaped.reason ? ` reason=${shaped.reason}` : '';
  log(`chat: reply source=${shaped.source || 'brain'} name=${m.name}${why}`);
  // Reply is TalkQ priority 2: behind greet/queue, ahead of react/idle. lookChat is
  // the default gesture; an allowlisted cue can replace it. It fires on first PCM.
  const meta = replyMeta(m, shaped);
  const queued = agent ? agent.enqueue(line, 'reply', meta) : true;
  if (agent && queued === false) {
    log(formatChatSkip({ reason: 'queue_full', n: intake.bump('queue_full'), name: m.name }));
    return;
  }
  if (!agent) await speak(line, 'reply', meta);
}

// Chat replies stay on their own path; game commentary is decided by AgentLoop.
// Compose immediately (don't wait for 4s of silence). Speech itself waits until
// the mouth is free, in FIFO order.
async function chatReplyLoop() {
  if (stopping) return;
  if (!replyBusy && replyQueue.length) {
    replyBusy = true;
    const m = replyQueue.shift();
    try {
      await deliverReply(m);
    } finally {
      replyBusy = false;
    }
    if (!stopping) setTimeout(chatReplyLoop, 0);
    return;
  }
  setTimeout(chatReplyLoop, replyQueue.length > 0 ? 40 : 400);
}

setInterval(() => memory.save(), 30000).unref?.();

// Supervisor signal: one line a minute so a stale chat feed, a polling fault or a slow
// voice path is visible in the log without reading every chat line. node=1 flags the
// single-instance process; chat-kick's own recovery stays in place.
setInterval(() => {
  const chatAge = lastChatAt ? Math.round((Date.now() - lastChatAt) / 1000) : -1;
  const pollErrors = Number(chat?.pollErrors) || 0;
  const skips = intake.summary();
  const dedupe = Number(chat?.dedupe?.skips) || 0;
  const skipLog = [skips !== 'none' ? skips : '', dedupe ? `dedupe=${dedupe}` : ''].filter(Boolean).join(',') || 'none';
  const tick = game.takeTickStats ? game.takeTickStats() : { n: 0, avg: 0 };
  const frameAge = game.frameAgeMs;
  const frameAgeS = frameAge < 0 ? -1 : Math.round(frameAge / 1000);
  log(`supervisor: node=1 chat_age_s=${chatAge} poll_errors=${pollErrors} last_first_pcm_ms=${lastFirstPcmMs ?? -1} frame_age_s=${frameAgeS} shots=${game.shotCount || 0} cap_n=${tick.n} cap_ms=${tick.avg} chat_skip=${skipLog}`);
}, 60000).unref?.();

async function main() {
  log(`hubie: starting ${c.recordOnly ? '(record mode)' : '(live mode)'} ${c.width}x${c.height}@${c.fps}`);
  log(c.ttsEngine === 'xai'
    ? `voice: xai ${c.ttsXaiVoice} (edge failover ${c.ttsXaiFailoverVoice})`
    : c.ttsEngine === 'edge'
      ? `voice: edge ${c.ttsEdgeVoice} (piper fallback ${c.ttsVoice})`
      : c.ttsEngine === 'piper'
        ? `voice: piper ${c.ttsVoice}`
        : `voice: kokoro ${c.ttsKokoroVoice}${c.ttsKokoroBlendVoice ? `+${c.ttsKokoroBlendVoice}@${c.ttsKokoroBlendWeight}` : ''} @ ${c.ttsKokoroUrl} (piper fallback ${c.ttsVoice})`);
  await renderer.warmArt();
  voice.start();
  await game.start();
  startEncoder();
  chat.start();
  if (process.env.SIM_CHAT === '1') startSimChat();
  nextAt = Date.now();
  setTimeout(tick, 1000 / c.fps);
  setTimeout(chatReplyLoop, 1200);
  agent.start();

  const limit = c.recordOnly ? (c.recordSeconds || 25) : 0;
  if (limit) {
    setTimeout(() => shutdown(`record limit ${limit}s reached`), limit * 1000);
  } else {
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`hubie: stopping - ${reason}`);
  agent.stop();
  chat.stop();
  voice.stop();
  game.stop().catch(() => {});
  closeBrowser().catch(() => {});
  memory.save();
  encoder?.stop();
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  setTimeout(() => {
    log(`hubie: summary frames=${frames} seconds=${secs} record=${encoder?.recordPath || 'none'}`);
    process.exit(0);
  }, 2500);
}

function startSimChat() {
  const lines = [
    ['tester_ana', 'hubie you are up late again'],
    ['tester_ben', 'does this thing pay real money or what'],
    ['tester_ana', 'second time asking, any tip for the next round?'],
    ['tester_ben', 'ok but what is this game called'],
    ['tester_ana', 'respect for staying live this long'],
  ];
  let i = 0;
  log('supervisor: SIM_CHAT on - injecting test viewers');
  setInterval(() => {
    const [name, text] = lines[i % lines.length];
    i++;
    handleChat({ name, text });
  }, 3000);
}

process.on('unhandledRejection', (err) => log(`hubie: unhandled rejection: ${err?.message || err}`));
process.on('uncaughtException', (err) => log(`hubie: uncaught exception: ${err?.message || err}`));

await main();
