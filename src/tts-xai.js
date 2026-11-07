// xAI streaming TTS (Atlas) over the bidirectional WebSocket.
// Same queue/PCM contract as EdgeVoice: start(), stop(), speak(text), speaking, raw PCM.
//
// POST /v1/tts takes voice_id in the JSON body. The WebSocket takes voice= in the query
// string (wss://api.x.ai/v1/tts). with_timestamps stays off: the alignment pass adds
// latency, and the mouth follows playback RMS instead of packet arrival.
// audio.done means synthesis finished, not that the speaker has finished playing.
//
// A FIRST_PCM stall cancels the socket once (text.clear) and speaks that line on the
// Edge Andrew fallback. Speech tags are stripped before Edge so it does not read them.
import { spawn } from 'node:child_process';
import { log } from './log.js';
import { bin } from './config.js';
import { chunkText } from './tts.js';

const CONNECT_TIMEOUT_MS = 8000;
const LINE_TIMEOUT_MS = 8000;
const DECODE_TIMEOUT_MS = 5000;
const FIRST_PCM_TIMEOUT_MS = 2500;
const CLEAR_TIMEOUT_MS = 2000;
const PCM_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);

// Inline + wrapping tags the TTS API actually performs. Anything else is stripped so
// the model does not read the brackets aloud. Edge never receives these.
const INLINE_TAGS = new Set([
  'pause', 'long-pause', 'hum-tune', 'laugh', 'chuckle', 'giggle', 'cry',
  'tsk', 'tongue-click', 'lip-smack', 'breath', 'inhale', 'exhale', 'sigh',
]);
const WRAP_TAGS = new Set([
  'soft', 'whisper', 'loud', 'build-intensity', 'decrease-intensity',
  'higher-pitch', 'lower-pitch', 'slow', 'fast', 'sing-song', 'singing', 'emphasis',
]);

const WIN_RE = /\b(win|winner|won|nice pop|let's go|lets go|jackpot)\b/i;
const HYPE_RE = /\b(hype|locked in|huge|insane|crazy|on fire|big one)\b/i;

function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1.08;
  return Math.min(1.5, Math.max(0.7, n));
}

function clampLatency(value) {
  const n = Number(value);
  if (n === 0 || n === 2) return n;
  return 1;
}

function pcmRate(value) {
  const n = Number(value);
  return PCM_RATES.has(n) ? n : 24000;
}

// Allowlisted expression for the canvas. Heuristic only: no extra LLM round-trip.
export function expressionHint(kind, text) {
  const k = String(kind || '');
  const t = String(text || '');
  if (/^react:win/i.test(k) || WIN_RE.test(t)) return 'win';
  if (/\[(?:laugh|chuckle|giggle)\]/i.test(t)) return 'laugh';
  if (/^react:lose/i.test(k)) return 'chill';
  if (HYPE_RE.test(t) || /^react:hype/i.test(k)) return 'hype';
  return null;
}

export function stripSpeechTags(text) {
  return String(text || '')
    .replace(/<\/?([a-z][a-z0-9-]*)>/gi, (m, tag) => (WRAP_TAGS.has(String(tag).toLowerCase()) ? '' : m))
    .replace(/\[([a-z][a-z0-9-]*)\]/gi, (m, tag) => (INLINE_TAGS.has(String(tag).toLowerCase()) ? '' : m))
    .replace(/\s+/g, ' ')
    .trim();
}

// The synth reads symbols literally: "14.9x" becomes "fourteen point nine ex" or worse,
// "$1,240" loses the unit. Normalise the shapes the host actually says before chunking.
export function speakable(text) {
  return String(text || '')
    .replace(/\b(\d+(?:[.,]\d+)?)\s*[x×]\b/gi, (m, n) => `${n} times`)
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\$\s?([\d,]+(?:\.\d+)?)/g, '$1 dollars')
    .replace(/\bRp\.?\s?([\d.,]+)/gi, '$1 rupiah')
    .replace(/\s*\/\s*/g, ' or ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain text in, one decorated chunk per clause. Win/hype get a wrapping tag; a win or
// an explicit laugh also gets [laugh] on the last clause. A breath opens long lines and
// a beat sits before the last clause of a three-clause line, which is what stops the
// read sounding like one flat sentence read off a card.
export function prepareLine(text, expression) {
  const raw = String(text || '');
  const wantPause = /\[(?:pause|long-pause)\]/i.test(raw);
  const wantLaugh = /\[(?:laugh|chuckle|giggle)\]/i.test(raw) || expression === 'win' || expression === 'laugh';
  const plain = speakable(stripSpeechTags(raw));
  const chunks = chunkText(plain);
  const words = plain.split(/\s+/).filter(Boolean).length;
  return chunks.map((chunk, i) => {
    let t = chunk;
    if (i === 0 && (wantPause || words > 12)) t = `[breath] ${t}`;
    else if (i === chunks.length - 1 && chunks.length >= 3 && !wantPause) t = `[pause] ${t}`;
    if (wantLaugh && i === chunks.length - 1) t = `${t} [laugh]`;
    if (expression === 'win') t = `<loud>${t}</loud>`;
    else if (expression === 'hype') t = `<build-intensity>${t}</build-intensity>`;
    else if (expression === 'laugh') t = `<emphasis>${t}</emphasis>`;
    return t;
  });
}

// WS query uses `voice`. Do not send `voice_id` here; that field belongs to POST /v1/tts.
export function buildXaiTtsUrl({ voice = 'atlas', language = 'en', sampleRate = 24000, speed = 1.08, latency = 1 } = {}) {
  const params = new URLSearchParams({
    language: String(language || 'en'),
    voice: String(voice || 'atlas'),
    codec: 'pcm',
    sample_rate: String(pcmRate(sampleRate)),
    speed: String(clampSpeed(speed)),
    optimize_streaming_latency: String(clampLatency(latency)),
  });
  return `wss://api.x.ai/v1/tts?${params}`;
}

function defaultWebSocket(url, options) {
  return new WebSocket(url, options);
}

export class XaiVoice {
  constructor({
    apiKey = '',
    voice = 'atlas',
    language = 'en',
    sampleRate = 24000,
    speed = 1.08,
    latency = 1,
    outRate = 22050,
    timeoutMs = LINE_TIMEOUT_MS,
    firstPcmMs = FIRST_PCM_TIMEOUT_MS,
    fallback = null,
    onAudio,
    onIdle,
    webSocketFactory = defaultWebSocket,
  } = {}) {
    this.apiKey = String(apiKey || '');
    this.voice = voice || 'atlas';
    this.language = language || 'en';
    this.sampleRate = pcmRate(sampleRate);
    this.speed = clampSpeed(speed);
    this.latency = clampLatency(latency);
    this.outRate = Number(outRate) || 22050;
    this.timeoutMs = Number(timeoutMs) || LINE_TIMEOUT_MS;
    this.firstPcmMs = Number(firstPcmMs) || FIRST_PCM_TIMEOUT_MS;
    this.fallback = fallback || null;
    this.onAudio = onAudio;
    this.onIdle = onIdle;
    this.webSocketFactory = webSocketFactory;
    this.queue = [];
    this._speaking = false;
    this.ws = null;
    this.ready = false;
    this.stopped = false;
    this.connecting = false;
    this.clearing = false;
    this.backoff = 2000;
    this.failures = 0;
    this.gen = 0;
    this.connGen = 0;
    this.active = null;
    this.decoder = null;
  }

  // Report the fallback too: index.js drives the voice meter and mouth from this flag.
  get speaking() { return this._speaking || !!this.fallback?.speaking; }
  get pending() { return this.queue.length + (this._speaking ? 1 : 0); }

  start() {
    if (this.stopped) return this;
    this.fallback?.start?.();
    if (!this.apiKey) {
      log('tts: xai missing XAI_API_KEY — edge failover');
      return this;
    }
    this.#connect();
    return this;
  }

  #url() {
    return buildXaiTtsUrl({
      voice: this.voice,
      language: this.language,
      sampleRate: this.sampleRate,
      speed: this.speed,
      latency: this.latency,
    });
  }

  #socketOpen() {
    return !!(this.ready && this.ws && this.ws.readyState === 1);
  }

  #connect() {
    if (this.stopped || this.connecting || this.#socketOpen() || !this.apiKey) return;
    this.connecting = true;
    const conn = ++this.connGen;
    let ws;
    try {
      ws = this.webSocketFactory(this.#url(), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      this.connecting = false;
      log(`tts: xai connect failed (${err.message}) — edge failover`);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    try { ws.binaryType = 'arraybuffer'; } catch { /* older sockets */ }
    ws.addEventListener('open', () => {
      if (conn !== this.connGen) return;
      this.connecting = false;
      this.ready = true;
      this.backoff = 2000;
      log(`tts: xai ready (${this.voice}, ${this.sampleRate} Hz pcm, speed ${this.speed})`);
      this.#pump();
    });
    ws.addEventListener('message', (ev) => {
      if (conn !== this.connGen) return;
      this.#onMessage(ev);
    });
    ws.addEventListener('error', () => {
      if (conn !== this.connGen) return;
      // close follows; that path failovers an in-flight line and reconnects
    });
    ws.addEventListener('close', () => {
      if (conn !== this.connGen) return;
      this.connecting = false;
      this.ready = false;
      if (this.ws === ws) this.ws = null;
      this.active?.({ type: 'socket.close' });
      if (!this.stopped) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.stopped || !this.apiKey) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }

  #dropSocket() {
    this.connGen += 1;
    this.ready = false;
    this.connecting = false;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already gone */ }
  }

  speak(text, hint = null) {
    const expression = hint && typeof hint === 'object' ? hint.expression : null;
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean || this.stopped) return;
    const chunks = prepareLine(clean, expression);
    for (const chunk of chunks) this.queue.push(chunk);
    const overflow = this.queue.length - 3;
    if (overflow > 0) this.queue.splice(0, overflow);
    this.#pump();
  }

  #pump() {
    if (this.stopped || this._speaking || !this.queue.length) return;
    const chunk = this.queue.shift();
    // Handshake still in flight: keep the chunk. A dead socket or a cancelled turn
    // (waiting on audio.clear) speaks on Edge so the line is not dropped.
    if (!this.clearing && this.connecting && !this.#socketOpen()) {
      this.queue.unshift(chunk);
      return;
    }
    if (this.clearing || !this.#socketOpen()) {
      if (!this.clearing && !this.connecting && this.apiKey) this.#connect();
      this.#failover(chunk);
      return;
    }
    this._speaking = true;
    this.pendingChunk = chunk;
    this.chunkSentAt = Date.now();
    this.#synth(chunk);
  }

  #onMessage(ev) {
    let raw = ev?.data;
    if (raw == null) return;
    if (typeof raw !== 'string') {
      try { raw = Buffer.from(raw).toString('utf8'); } catch { return; }
    }
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'audio.clear') {
      this.clearing = false;
      clearTimeout(this.clearTimer);
      this.#pump();
      return;
    }
    if (event.type === 'error' && !this.active) {
      const message = String(event.message || 'error').slice(0, 180);
      log(`tts: xai ${message}`);
      return;
    }
    this.active?.(event);
  }

  #cancelRemote() {
    if (this.clearing) return;
    this.clearing = true;
    try {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: 'text.clear' }));
      }
    } catch { /* socket already gone */ }
    clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => {
      if (!this.clearing || this.stopped) return;
      log('tts: xai clear timed out — reconnect');
      this.clearing = false;
      this.#dropSocket();
      this.#connect();
      this.#pump();
    }, CLEAR_TIMEOUT_MS);
  }

  #synth(text) {
    const gen = ++this.gen;
    // probesize/analyzeduration match the Edge decoder: raw PCM still flushes as it
    // arrives. `-fflags nobuffer` drops this input on ffmpeg 6 (zero-byte close).
    const decoder = spawn(bin('ffmpeg'), [
      '-hide_banner', '-loglevel', 'error',
      '-probesize', '32', '-analyzeduration', '0',
      '-f', 's16le', '-ar', String(this.sampleRate), '-ac', '1', '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(this.outRate),
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.decoder = decoder;
    let settled = false;
    let pcmBytes = 0;
    let firstPcm = false;
    let firstWall = 0;
    const errors = [];

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (this.gen === gen) this.gen += 1;
      if (this.activeGen === gen) {
        this.active = null;
        this.activeGen = 0;
      }
      clearTimeout(timer);
      clearTimeout(firstPcmTimer);
      if (this.decoder === decoder) this.decoder = null;
      try { decoder.stdin.end(); } catch { /* already closed */ }

      // Partial audio already reached the bus. Replaying the line on Edge would
      // double-speak it. Late packets are ignored because gen has moved on.
      if (err && pcmBytes === 0) {
        try { decoder.kill('SIGKILL'); } catch { /* already exited */ }
        this.#failover(text, err);
        return;
      }
      if (err) log(`tts: xai stream ended partially (${err.message}); keeping emitted PCM`);
      if (pcmBytes === 0) {
        this.#failover(text, new Error('empty decoded audio'));
        return;
      }

      // audio.done (or ffmpeg close) is synth/decode done, not playback done.
      // Hold `speaking` for the unplayed tail so the next chunk waits the line out.
      const totalMs = Math.max(250, Math.round((pcmBytes / 2) / this.outRate * 1000));
      const elapsed = firstWall ? (Date.now() - firstWall) : 0;
      const remainMs = Math.max(250, totalMs - elapsed);
      this.playTimer = setTimeout(() => {
        this._speaking = false;
        if (this.shouldDrop?.()) {
          if (this.queue.length) log(`tts: xai yield ${this.queue.length} chunk(s)`);
          this.queue = [];
          this.onIdle?.();
          return;
        }
        this.onIdle?.();
        this.#pump();
      }, remainMs);
    };

    const timer = setTimeout(() => {
      const err = new Error('xai synthesis/decode timeout');
      this.#cancelRemote();
      try { decoder.kill('SIGKILL'); } catch { /* already gone */ }
      finish(err);
    }, this.timeoutMs + DECODE_TIMEOUT_MS);

    const firstPcmTimer = setTimeout(() => {
      if (settled || firstPcm) return;
      log('tts: xai first_pcm timeout');
      const err = new Error('xai first_pcm timeout');
      this.#cancelRemote();
      try { decoder.kill('SIGKILL'); } catch { /* already gone */ }
      finish(err);
    }, this.firstPcmMs);

    const writePcm = (pcm) => {
      if (this.stopped || settled || gen !== this.gen || !pcm?.length) return;
      pcmBytes += pcm.length;
      if (!firstPcm) {
        firstPcm = true;
        firstWall = Date.now();
        clearTimeout(firstPcmTimer);
        if (this.chunkSentAt) {
          log(`tts: xai first_pcm in ${Date.now() - this.chunkSentAt} ms for "${stripSpeechTags(text).slice(0, 48)}"`);
          this.chunkSentAt = 0;
        }
      }
      this.lastAudioAt = Date.now();
      this.onAudio?.(pcm);
    };

    decoder.stdout.on('data', writePcm);
    decoder.stderr.on('data', (b) => {
      if (errors.length < 20) errors.push(b);
    });
    decoder.on('error', (err) => finish(err));
    decoder.on('close', (code) => {
      if (settled) return;
      if (code === 0) finish(null);
      else finish(new Error(`ffmpeg decode exited ${code}: ${Buffer.concat(errors).toString().slice(0, 160)}`));
    });
    decoder.stdin.on('error', (err) => {
      if (!settled) finish(err);
    });

    const onEvent = (event) => {
      if (settled || gen !== this.gen) return;
      if (event.type === 'audio.delta') {
        const raw = Buffer.from(String(event.delta || ''), 'base64');
        const even = raw.length - (raw.length % 2);
        if (even <= 0) return;
        const bytes = even === raw.length ? raw : raw.subarray(0, even);
        try { decoder.stdin.write(bytes); } catch (err) { finish(err); }
        return;
      }
      if (event.type === 'audio.done') {
        // Synth finished. Playback continues from the bus; do not drop `speaking` here.
        try { decoder.stdin.end(); } catch { /* already closed */ }
        return;
      }
      if (event.type === 'error' || event.type === 'socket.close') {
        const message = event.type === 'socket.close'
          ? 'socket closed'
          : String(event.message || 'error').slice(0, 180);
        if (event.type === 'error') this.#cancelRemote();
        try { decoder.stdin.end(); } catch { /* already closed */ }
        if (pcmBytes === 0) {
          try { decoder.kill('SIGKILL'); } catch { /* already gone */ }
          finish(new Error(message));
        }
      }
    };

    this.active = onEvent;
    this.activeGen = gen;

    try {
      this.ws.send(JSON.stringify({ type: 'text.delta', delta: text }));
      this.ws.send(JSON.stringify({ type: 'text.done' }));
    } catch (err) {
      this.#cancelRemote();
      try { decoder.kill('SIGKILL'); } catch { /* already gone */ }
      finish(err);
    }
  }

  #failover(text, err) {
    if (err) log(`tts: xai failed (${err.message}) — edge line "${stripSpeechTags(text).slice(0, 48)}"`);
    this.failures++;
    this._speaking = false;
    // Edge reads the words. Tags such as [laugh] and <loud> would be spoken literally.
    const plain = stripSpeechTags(text);
    if (plain) this.fallback?.speak?.(plain);
    this.onIdle?.();
    this.#pump();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.playTimer);
    clearTimeout(this.clearTimer);
    this.active = null;
    this.gen += 1;
    try { this.decoder?.kill('SIGKILL'); } catch { /* already gone */ }
    this.decoder = null;
    this.#dropSocket();
    this.fallback?.stop?.();
  }
}
