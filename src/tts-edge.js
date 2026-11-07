// Edge TTS (free Microsoft neural "Read Aloud" voices) as the primary voice.
// Same interface as PiperVoice: start(), stop(), speak(text), speaking, raw PCM out.
// Any init failure or per-line timeout falls back to Piper for that line.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { spawn } from 'node:child_process';
import { log } from './log.js';
import { bin } from './config.js';
import { chunkText } from './tts.js';

// The Read Aloud endpoint only accepts the enumerated mp3/opus formats, so ask for mp3
// and decode it to the AudioBus format (22050 Hz mono s16le) with the bundled ffmpeg.
const OUTPUT_FORMAT_EDGE = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const SAMPLE_RATE = 22050;
const CONNECT_TIMEOUT_MS = 8000;
const LINE_TIMEOUT_MS = 8000;
const DECODE_TIMEOUT_MS = 5000;
const FIRST_PCM_TIMEOUT_MS = 2500;

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
function escapeXml(text) {
  return String(text || '').replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);
}

export class EdgeVoice {
  constructor({
    voice = 'en-US-GuyNeural',
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    timeoutMs = LINE_TIMEOUT_MS,
    fallback = null,
    onAudio,
    onIdle,
  } = {}) {
    this.voice = voice || 'en-US-GuyNeural';
    this.rate = rate;
    this.pitch = pitch;
    this.volume = volume;
    this.timeoutMs = Number(timeoutMs) || LINE_TIMEOUT_MS;
    this.fallback = fallback || null;
    this.onAudio = onAudio;
    this.onIdle = onIdle;
    this.queue = [];
    this._speaking = false;
    this.stream = null;
    this.tts = null;
    this.ready = false;
    this.stopped = false;
    this.backoff = 2000;
    this.failures = 0;
  }

  // Report the fallback too: index.js drives the voice meter and mouth from this flag.
  get speaking() { return this._speaking || !!this.fallback?.speaking; }
  get pending() { return this.queue.length + (this._speaking ? 1 : 0); }

  start() {
    if (this.stopped) return this;
    // Keep Piper warm so a dropped Edge line is spoken, not dropped.
    this.fallback?.start?.();
    this.#connect().catch(() => {});
    return this;
  }

  async #connect() {
    if (this.stopped) return;
    try {
      const tts = new MsEdgeTTS({
        connectionTimeoutMs: CONNECT_TIMEOUT_MS,
        synthesisTimeoutMs: this.timeoutMs,
      });
      await tts.setMetadata(this.voice, OUTPUT_FORMAT_EDGE);
      this.tts = tts;
      this.ready = true;
      this.backoff = 2000;
      log(`tts: edge ready (${this.voice})`);
      this.#pump();
    } catch (err) {
      this.ready = false;
      this.tts = null;
      log(`tts: edge init failed (${err.message}) — piper fallback, retry in ${this.backoff} ms`);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.#connect().catch(() => {}), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
      // Queued lines should still be heard: hand them to Piper now.
      this.#pump();
    }
  }

  speak(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean || this.stopped) return;
    for (const chunk of chunkText(clean)) this.queue.push(chunk);
    const overflow = this.queue.length - 3;
    if (overflow > 0) this.queue.splice(0, overflow);
    this.#pump();
  }

  #pump() {
    if (this.stopped || this._speaking || !this.queue.length) return;
    const chunk = this.queue.shift();
    if (!this.ready || !this.tts) { this.#failover(chunk); return; }
    this._speaking = true;
    this.pendingChunk = chunk;
    this.chunkSentAt = Date.now();
    this.#synth(chunk);
  }

  #synth(text) {
    let stream;
    try {
      ({ audioStream: stream } = this.tts.toStream(escapeXml(text), {
        rate: this.rate,
        pitch: this.pitch,
        volume: this.volume,
      }));
    } catch (err) {
      this.#failover(text, err);
      return;
    }

    // Decode the incoming MP3 stream continuously. The old path buffered the entire
    // sentence, then spawned ffmpeg, then emitted one PCM buffer: first audio could not
    // reach AudioBus until synthesis had completely finished.
    const decoder = spawn(bin('ffmpeg'), [
      '-hide_banner', '-loglevel', 'error',
      '-probesize', '32k', '-analyzeduration', '0',
      '-f', 'mp3', '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(SAMPLE_RATE),
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.stream = stream;
    this.decoder = decoder;
    let settled = false;
    let pcmBytes = 0;
    let firstPcm = false;
    let firstWall = 0;
    const errors = [];
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(firstPcmTimer);
      if (this.stream === stream) this.stream = null;
      if (this.decoder === decoder) this.decoder = null;

      // If some audio already reached the live bus, replaying the whole line through
      // Piper would double-speak it. Only use fallback when no PCM was emitted.
      if (err && pcmBytes === 0) {
        try { decoder.kill('SIGKILL'); } catch { /* already exited */ }
        this.#failover(text, err);
        return;
      }
      if (err) log(`tts: edge stream ended partially (${err.message}); keeping emitted PCM`);
      if (pcmBytes === 0) {
        this.#failover(text, new Error('empty decoded audio'));
        return;
      }

      const totalMs = Math.max(250, Math.round((pcmBytes / 2) / SAMPLE_RATE * 1000));
      const elapsed = firstWall ? (Date.now() - firstWall) : 0;
      const remainMs = Math.max(250, totalMs - elapsed);
      this.playTimer = setTimeout(() => {
        this._speaking = false;
        if (this.shouldDrop?.()) {
          if (this.queue.length) log(`tts: edge yield ${this.queue.length} chunk(s)`);
          this.queue = [];
          this.onIdle?.();
          return;
        }
        this.onIdle?.();
        this.#pump();
      }, remainMs);
    };

    const timer = setTimeout(() => {
      const err = new Error('edge synthesis/decode timeout');
      try { stream.destroy(err); } catch { /* already gone */ }
      try { decoder.kill('SIGKILL'); } catch { /* already gone */ }
      finish(err);
    }, this.timeoutMs + DECODE_TIMEOUT_MS);

    // Fail over early if Edge/ffmpeg never produces audible PCM (stall before first byte).
    const firstPcmTimer = setTimeout(() => {
      if (settled || firstPcm) return;
      log('tts: edge first_pcm timeout');
      const err = new Error('edge first_pcm timeout');
      try { stream.destroy(err); } catch { /* already gone */ }
      try { decoder.kill('SIGKILL'); } catch { /* already gone */ }
      finish(err);
    }, FIRST_PCM_TIMEOUT_MS);

    decoder.stdout.on('data', (pcm) => {
      if (this.stopped || settled || !pcm?.length) return;
      pcmBytes += pcm.length;
      if (!firstPcm) {
        firstPcm = true;
        firstWall = Date.now();
        clearTimeout(firstPcmTimer);
        if (this.chunkSentAt) {
          log(`tts: edge first_pcm in ${Date.now() - this.chunkSentAt} ms for "${text.slice(0, 48)}"`);
          this.chunkSentAt = 0;
        }
      }
      this.lastAudioAt = Date.now();
      this.onAudio?.(pcm);
    });
    decoder.stderr.on('data', (b) => {
      if (errors.length < 20) errors.push(b);
    });
    decoder.on('error', (err) => finish(err));
    decoder.on('close', (code) => {
      if (code === 0) finish(null);
      else finish(new Error(`ffmpeg decode exited ${code}: ${Buffer.concat(errors).toString().slice(0, 160)}`));
    });
    decoder.stdin.on('error', (err) => {
      if (!settled) finish(err);
    });
    stream.on('error', (err) => {
      if (!settled) {
        try { decoder.stdin.end(); } catch { /* closed */ }
        finish(err);
      }
    });
    stream.on('end', () => {
      try { decoder.stdin.end(); } catch { /* already closed */ }
    });
    stream.pipe(decoder.stdin);
  }

  #failover(text, err) {
    if (err) log(`tts: edge failed (${err.message}) — piper line "${String(text).slice(0, 48)}"`);
    this.failures++;
    this._speaking = false;
    this.fallback?.speak?.(text);
    this.onIdle?.();
    this.#pump();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.playTimer);
    try { this.stream?.destroy(); } catch { /* already gone */ }
    try { this.decoder?.kill('SIGKILL'); } catch { /* already gone */ }
    this.decoder = null;
    try { this.tts?.close?.(); } catch { /* already gone */ }
    this.tts = null;
    this.ready = false;
    this.fallback?.stop?.();
  }
}
