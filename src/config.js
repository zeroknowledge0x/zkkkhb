// Config + tiny .env loader. No dependencies: Node 20+ only.
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

export const ROOT = process.cwd();
export const VENDOR = path.join(ROOT, 'vendor');
export const RECORD_DIR = path.resolve(process.env.RECORD_DIR || 'records');
export const LOG_DIR = path.join(ROOT, 'logs');

export function cfg() {
  const recordOnly = process.argv.includes('--record');
  // CAPTURE_MODE (or MODE) picks what fills the game panel: CDP screencast (default) or
  // the whole Windows desktop via ffmpeg gdigrab. Desktop requires headed Chrome.
  const captureMode = String(process.env.CAPTURE_MODE || process.env.MODE || '').trim().toLowerCase() === 'desktop'
    ? 'desktop'
    : 'screencast';
  const headed = process.env.HUBIE_HEADED !== '0';
  return {
    recordOnly,
    captureMode,
    headed,
    recordSeconds: Number(argValue('--seconds') || 0),
    width: 1280,
    height: 720,
    fps: 30,
    // Debug mirror of what viewers see: write the composited frame to logs/ every N ms.
    // 0 = off. Cheap enough to leave on during a contest run.
    frameDumpMs: Number(process.env.FRAME_DUMP_MS) || 0,
    sampleRate: 22050,
    bitrate: process.env.VIDEO_BITRATE || '3500k',
    rtmpUrl: process.env.RTMP_URL || '',
    streamKey: process.env.STREAM_KEY || '',
    twitchChannel: (process.env.TWITCH_CHANNEL || '').trim().replace(/^#/, ''),
    kickChannel: (process.env.KICK_CHANNEL || '').trim().replace(/^#/, ''),
    twitchOauth: process.env.TWITCH_OAUTH || '',
    chatBotToken: process.env.CHAT_BOT_TOKEN || '',
    gamesUrl: process.env.HOUSEBETS_GAMES_URL || '',
    llmUrl: process.env.LLM_BASE_URL || 'https://api.commandcode.ai/provider/v1/chat/completions',
    llmKey: process.env.LLM_API_KEY || '',
    llmModel: process.env.LLM_MODEL || 'deepseek/deepseek-v4.1-flash',
    // Jev: cheap choice model over HTTP, called before the LLM. Reuses the Command Code key.
    jevEnabled: !['0', 'false', 'off', 'no'].includes(String(process.env.JEV_ENABLED ?? '1').toLowerCase()),
    jevUrl: process.env.JEV_URL || 'https://api.commandcode.ai/provider/v1/systemone',
    jevModel: process.env.JEV_MODEL || 'typesafe/jev',
    jevConfidence: num(process.env.JEV_CONFIDENCE, 0.72),
    jevKey: process.env.JEV_API_KEY || process.env.COMMAND_CODE_API_KEY || process.env.LLM_API_KEY || '',
    jevTimeoutMs: num(process.env.JEV_TIMEOUT_MS, 4000),
    // Screen perception. On by default. DOM poll is cheap; the screenshot fallback
    // cannot run faster than 20s and only fires when the DOM read is not enough.
    gamePerception: !['0', 'false', 'off', 'no'].includes(String(process.env.GAME_PERCEPTION ?? '1').toLowerCase()),
    gamePerceptionMs: Math.max(1000, num(process.env.GAME_PERCEPTION_MS, 5000)),
    gamePerceptionVisionMs: Math.max(20000, num(process.env.GAME_PERCEPTION_VISION_MS, 20000)),
    ttsVoice: process.env.TTS_VOICE || 'en_US-lessac-medium',
    // Voice engine: Kokoro ONNX via a local Python sidecar is the default; Piper is the
    // fallback. `edge` is the no-key rollback. `xai` is Atlas over the streaming socket,
    // with Edge Andrew as its failover. Edge is never an automatic fallback for Kokoro.
    ttsEngine: ['kokoro', 'piper', 'edge', 'xai'].includes(String(process.env.TTS_ENGINE || '').toLowerCase())
      ? String(process.env.TTS_ENGINE).toLowerCase()
      : 'kokoro',
    ttsKokoroUrl: process.env.KOKORO_URL || `http://127.0.0.1:${process.env.KOKORO_PORT || '7860'}`,
    ttsKokoroVoice: process.env.KOKORO_VOICE || 'am_fenrir',
    // Explicit KOKORO_VOICE means "never auto-upgrade from /voices".
    ttsKokoroVoiceExplicit: !!String(process.env.KOKORO_VOICE || '').trim(),
    // Blend is applied by the sidecar when the requested voice is its default; the client
    // only sends am_fenrir. Unset = am_michael; empty/off disables the blend.
    ttsKokoroBlendVoice: normalizeBlend(process.env.KOKORO_BLEND_VOICE),
    ttsKokoroBlendWeight: num(process.env.KOKORO_BLEND_WEIGHT, 0.62),
    // 0.94 reads a touch slower and less robotic than 1.0; the sidecar env also reads it.
    ttsKokoroSpeed: num(process.env.KOKORO_SPEED, 0.94),
    // Breath between sentence chunks (120–180 ms is the human range).
    ttsKokoroPauseMs: num(process.env.KOKORO_SENTENCE_PAUSE_MS, 150),
    ttsKokoroTimeoutMs: num(process.env.KOKORO_TIMEOUT_MS, 12000),
    ttsEdgeVoice: process.env.TTS_EDGE_VOICE || 'en-US-GuyNeural',
    ttsEdgeRate: process.env.TTS_EDGE_RATE || '+0%',
    ttsEdgePitch: process.env.TTS_EDGE_PITCH || '+0Hz',
    ttsEdgeVolume: process.env.TTS_EDGE_VOLUME || '+0%',
    ttsEdgeTimeoutMs: num(process.env.TTS_EDGE_TIMEOUT_MS, 8000),
    // xAI streaming TTS. XAI_API_KEY is required only when TTS_ENGINE=xai. Never log it.
    // WS query is voice= (not voice_id). POST /v1/tts is a different shape and is unused.
    ttsXaiKey: process.env.XAI_API_KEY || '',
    ttsXaiVoice: process.env.XAI_VOICE || 'atlas',
    ttsXaiLanguage: process.env.XAI_LANGUAGE || 'en',
    ttsXaiSampleRate: num(process.env.XAI_SAMPLE_RATE, 24000),
    ttsXaiSpeed: num(process.env.XAI_SPEED, 1.08),
    ttsXaiLatency: num(process.env.XAI_LATENCY, 1),
    ttsXaiTimeoutMs: num(process.env.XAI_TIMEOUT_MS, 8000),
    // Failover voice when Atlas stalls. TTS_ENGINE=edge still uses TTS_EDGE_VOICE.
    ttsXaiFailoverVoice: process.env.XAI_FAILOVER_VOICE || 'en-US-AndrewNeural',
    // libritts has 904 speakers (0-903); 704 is the calm male default.
    ttsSpeaker: process.env.TTS_SPEAKER ? Number(process.env.TTS_SPEAKER) : (process.env.TTS_VOICE || 'en_US-lessac-medium').includes('libritts') ? 704 : null,
    // Human-feel piper knobs: slower delivery, more variation, longer sentence tails.
    ttsLengthScale: num(process.env.TTS_LENGTH_SCALE, 1.0),
    ttsNoiseScale: num(process.env.TTS_NOISE_SCALE, 0.45),
    ttsNoiseW: num(process.env.TTS_NOISE_W, 0.55),
    ttsSentenceSilence: num(process.env.TTS_SENTENCE_SILENCE, 0.2),
    host: process.env.STREAM_HOST || 'twitch',
    streamHost: (process.env.STREAM_HOST || 'twitch').toLowerCase(),
    chatHost: (process.env.CHAT_HOST || process.env.STREAM_HOST || 'twitch').toLowerCase(),
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

// Unset blend = am_michael; empty/off/none = disabled ('' so logs do not claim a blend).
function normalizeBlend(value) {
  if (value === undefined) return 'am_michael';
  const v = String(value).trim();
  return ['', 'off', 'none', '0', 'false', 'no'].includes(v.toLowerCase()) ? '' : v;
}

export function bin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const local = path.join(VENDOR, name, exe);
  return fs.existsSync(local) ? local : name;
}

export function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    process.platform === 'win32' && 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.platform === 'win32' && 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    process.platform === 'win32' && 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.platform === 'darwin' && '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Bundled builds (containers, agent images, portable installs) live a few levels
  // deeper than the usual paths; walk a bounded depth instead of guessing paths.
  for (const root of ['/opt', path.join(process.env.HOME || '', '.cache', 'ms-playwright')]) {
    const found = findBinary(root, ['chrome', 'headless_shell', 'msedge'], 4);
    if (found) return found;
  }
  return null;
}

function findBinary(dir, names, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() && names.includes(e.name)) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const hit = findBinary(path.join(dir, e.name), names, depth - 1);
    if (hit) return hit;
  }
  return null;
}
