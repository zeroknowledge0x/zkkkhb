// Kokoro ONNX voice: a thin client for the local Python sidecar (scripts/kokoro_server.py).
// Same interface as PiperVoice/EdgeVoice: start(), stop(), speak(text), speaking, raw PCM
// out at the AudioBus sample rate. Live lines use POST /tts/stream so the first chunk is
// audible before the full utterance is synthesized; anywhere a single buffer is needed
// (prefetch, warmup, older sidecars) it falls back to /tts. Any failure hands that line
// to Piper — Edge is never used implicitly.
import { log } from './log.js';
import { chunkText } from './tts.js';

const DEFAULT_URL = 'http://127.0.0.1:7860';
const DEFAULT_TIMEOUT_MS = 12000;
// A short breath between sentence chunks; one flat block is what reads as robotic.
const DEFAULT_PAUSE_MS = 150;
// Male voices in preference order. am_fenrir is the LIVE pin; the sidecar blends it with
// am_michael by default, so the client only sends the primary name.
const PREFERRED_MALE = ['am_fenrir', 'am_puck', 'am_michael'];
const DEFAULT_VOICE = 'am_fenrir';
const SILENCE_CACHE = new Map();

export class KokoroVoice {
  constructor({
    url = DEFAULT_URL,
    voice = DEFAULT_VOICE,
    speed = 0.94,
    sampleRate = 22050,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pauseMs = DEFAULT_PAUSE_MS,
    voiceExplicit = false,
    fallback = null,
    onAudio,
    onIdle,
  } = {}) {
    this.url = String(url || DEFAULT_URL).replace(/\/+$/, '');
    this.voice = voice || DEFAULT_VOICE;
    this.speed = Number(speed) || 1;
    this.sampleRate = Number(sampleRate) || 22050;
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.pauseMs = Number.isFinite(Number(pauseMs)) ? Math.max(0, Number(pauseMs)) : DEFAULT_PAUSE_MS;
    // KOKORO_VOICE explicitly set by the operator: never auto-upgrade it.
    this.voiceExplicit = !!voiceExplicit;
    this.fallback = fallback || null;
    this.onAudio = onAudio;
    this.onIdle = onIdle;
    this.queue = [];
    this._speaking = false;
    this.stopped = false;
    this.failures = 0;
    this.downUntil = 0;
    this.lastErrorAt = 0;
    this.playTimer = null;
    this.keepWarmTimer = null;
    // Next chunk synthesized while the current PCM plays: { text, pcm, promise }.
    this.prefetch = null;
    // In-flight discarded warmup (AbortController) and its state flag.
    this.warmAbort = null;
    this._warming = false;
    // Wall-clock of the last speak() call; the keep-warm timer stays out of its way.
    this.lastSpeakAt = 0;
  }

  // Report the fallback too: index.js drives the voice meter and mouth from this flag.
  get speaking() { return this._speaking || !!this.fallback?.speaking; }
  get pending() { return this.queue.length + (this._speaking ? 1 : 0); }

  start() {
    if (this.stopped) return this;
    // Keep Piper warm so a sidecar miss is spoken, not dropped.
    this.fallback?.start?.();
    log(`tts: kokoro → ${this.url} (voice ${this.voice}, ${this.sampleRate} Hz, speed ${this.speed}, stream on)`);
    this.#initSidecar();
    return this;
  }

  // Health first, then discover voices and pay the model-load cost once so the first
  // real line is not a cold 5 s wait.
  async #initSidecar() {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) {
        log(`tts: kokoro health HTTP ${res.status} — piper fallback until it is up`);
        return;
      }
      log('tts: kokoro sidecar ready');
    } catch (err) {
      log(`tts: kokoro sidecar unreachable (${err.message}) — piper fallback until it is up`);
      return;
    }
    await this.#discoverVoice();
    this.#warmup();
    this.#startKeepWarm();
  }

  // /voices lists the names inside voices-v1.0.bin. Only auto-pick when the default is
  // absent; an explicit KOKORO_VOICE always wins.
  async #discoverVoice() {
    if (this.voiceExplicit) {
      log(`tts: kokoro voice ${this.voice} (explicit KOKORO_VOICE)`);
      return;
    }
    try {
      const res = await fetch(`${this.url}/voices`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) {
        log(`tts: kokoro /voices HTTP ${res.status} — keeping ${this.voice}`);
        return;
      }
      const data = await res.json();
      const list = Array.isArray(data?.voices) ? data.voices : [];
      if (list.includes(this.voice)) {
        log(`tts: kokoro voices=${list.length || '?'}; keeping ${this.voice}`);
        return;
      }
      const pick = PREFERRED_MALE.find((v) => list.includes(v));
      if (pick) {
        log(`tts: kokoro voice upgrade ${this.voice} → ${pick} (present in voices bin)`);
        this.voice = pick;
      } else {
        log(`tts: kokoro voices=${list.length || '?'}; keeping ${this.voice}`);
      }
    } catch (err) {
      log(`tts: kokoro /voices unavailable (${err.message}) — keeping ${this.voice}`);
    }
  }

  // One discarded word so the ONNX model + voices bin are loaded before the first line.
  // It holds the sidecar's synthesis lock, so a real line aborts it instead of queueing.
  #warmup() {
    if (this.stopped || this._warming) return;
    this.#cancelWarmup();
    const controller = new AbortController();
    this.warmAbort = controller;
    this._warming = true;
    this.#synthRawWarm('yo')
      .catch((err) => log(`tts: kokoro warmup failed (${err.message})`))
      .finally(() => {
        if (this.warmAbort === controller) this._warming = false;
      });
  }

  // Drop the in-flight warmup so it stops holding the sidecar's synthesis lock.
  #cancelWarmup() {
    if (this.warmAbort) {
      this.warmAbort.abort();
      this.warmAbort = null;
    }
    this._warming = false;
  }

  // Abortable one-shot POST /tts for the warmup only: same payload as #synthFull, but
  // an abort is a normal outcome (returns null) and never counts against the sidecar.
  async #synthRawWarm(text) {
    const controller = this.warmAbort;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeout, controller.signal])
      : controller.signal;
    try {
      const res = await fetch(`${this.url}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: this.voice,
          speed: this.speed,
          sample_rate: this.sampleRate,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`kokoro warmup HTTP ${res.status}`);
      const pcm = Buffer.from(await res.arrayBuffer());
      if (!pcm.length) throw new Error('kokoro warmup empty audio');
      log(`tts: kokoro warmup spoken for "${text.slice(0, 48)}"`);
      return pcm;
    } catch (err) {
      if (this.warmAbort !== controller || err?.name === 'AbortError') {
        if (!this.stopped) log('tts: kokoro warmup aborted');
        return null;
      }
      throw err;
    }
  }

  // Re-run the discarded warmup on an idle timer so a line after a quiet stretch
  // does not pay the cold ONNX cost. Skipped while speaking, queued, warming, backing
  // off, or within a minute of the last speak() — a warmup must never race a real line.
  #startKeepWarm() {
    if (this.keepWarmTimer) return;
    log('tts: kokoro keep-warm every 90s');
    this.keepWarmTimer = setInterval(() => {
      const now = Date.now();
      if (this.stopped || this._speaking || this.queue.length) return;
      if (this._warming || now < this.downUntil) return;
      if (now - (this.lastSpeakAt || 0) <= 60000) return;
      this.#warmup();
    }, 90000);
  }

  speak(text) {
    this.#cancelWarmup();
    this.lastSpeakAt = Date.now();
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean || this.stopped) return;
    for (const chunk of chunkText(clean)) this.queue.push(chunk);
    const overflow = this.queue.length - 3;
    if (overflow > 0) {
      const removed = this.queue.splice(0, overflow);
      // A prefetch whose text was just dropped is stale; let the consume check miss.
      if (this.prefetch && removed.includes(this.prefetch.text)) this.prefetch = null;
    }
    this.#pump();
    // Chunks added mid-playback (a greet/reply) still get their parallel synth.
    if (this._speaking) this.#prefetchNext();
  }

  #pump() {
    if (this.stopped || this._speaking || !this.queue.length) return;
    if (Date.now() < this.downUntil) {
      // Sidecar is cooling down: hand everything queued to Piper in one pass.
      this.#drainToFallback();
      return;
    }
    const chunk = this.queue.shift();
    this._speaking = true;
    this.pendingChunk = chunk;
    this.#playChunk(chunk).catch((err) => this.#failover(chunk, err));
  }

  async #playChunk(chunk) {
    const pf = this.prefetch;
    this.prefetch = null;
    let pcm = null;
    if (pf && pf.text === chunk) {
      try {
        pcm = pf.pcm || await pf.promise;
        log(`tts: prefetch hit "${chunk.slice(0, 48)}"`);
      } catch (err) {
        log(`tts: prefetch miss "${chunk.slice(0, 48)}" (${err.message})`);
        pcm = null;
      }
    } else {
      log(`tts: prefetch miss "${chunk.slice(0, 48)}" (${pf ? 'stale' : 'none'})`);
    }
    if (pcm) {
      this.#play(chunk, pcm);
      return;
    }
    // Live path: start playing the first stream chunk, then keep filling the bus.
    try {
      await this.#playStreamed(chunk);
    } catch (err) {
      if (err?.emitted) {
        // Part of the line already sounds; re-synthesizing would repeat it.
        log(`tts: kokoro stream cut after first chunk (${err.message})`);
        this.#scheduleEnd(250);
        this.#prefetchNext();
        return;
      }
      if (err?.status === 404 || err?.status === 501) {
        log('tts: kokoro stream unavailable — full /tts');
      } else {
        log(`tts: kokoro stream failed (${err.message}) — full /tts`);
      }
      const full = await this.#synthFull(chunk, 'audio in');
      this.#play(chunk, full);
    }
  }

  // Stream a full utterance into the AudioBus. The first chunk is pushed the moment it
  // arrives (that is what first_pcm measures); the rest follow as they are synthesized.
  async #playStreamed(text) {
    let bytes = 0;
    let firstWall = 0;
    const onPart = (buf) => {
      if (!firstWall) firstWall = Date.now();
      bytes += buf.length;
      this.lastAudioAt = Date.now();
      if (!this.stopped) this.onAudio?.(buf);
    };
    await this.#synthStream(text, 'audio in', onPart);
    const hasMore = this.queue.length > 0 && this.pauseMs > 0;
    let totalMs = Math.round((bytes / 2) / this.sampleRate * 1000);
    if (hasMore) {
      this.onAudio?.(this.#silence(this.pauseMs));
      totalMs += this.pauseMs;
    }
    // The first chunk began playing as soon as it arrived, so only the remaining
    // wall-clock tail still needs to hold `speaking` for the mouth/meter.
    const elapsed = firstWall ? Date.now() - firstWall : 0;
    this.#scheduleEnd(Math.max(250, totalMs - elapsed));
    this.#prefetchNext();
  }

  // POST /tts/stream, chunk by chunk. onPart fires for every PCM chunk as it arrives.
  async #synthStream(text, label = 'audio in', onPart) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${this.url}/tts/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: this.voice,
          speed: this.speed,
          sample_rate: this.sampleRate,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      err.streamFallback = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`kokoro stream HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (!res.body) throw new Error('kokoro stream empty body');
    const reader = res.body.getReader();
    let bytes = 0;
    let firstMs = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        const buf = Buffer.from(value);
        const first = bytes === 0;
        bytes += buf.length;
        if (first) {
          firstMs = Date.now() - t0;
          log(`tts: kokoro stream first in ${firstMs} ms (${buf.length} bytes)`);
        }
        onPart?.(buf, first);
      }
    } catch (err) {
      if (bytes) err.emitted = true;
      throw err;
    }
    if (!bytes) throw new Error('kokoro empty audio');
    this.failures = 0;
    this.downUntil = 0;
    log(`tts: kokoro ${label} ${Date.now() - t0} ms (stream, ${bytes} bytes) for "${text.slice(0, 48)}"`);
    return { bytes, firstMs };
  }

  // One complete PCM body when a buffer is all the caller needs.
  async #synthRaw(text, label = 'audio in') {
    try {
      const parts = [];
      await this.#synthStream(text, label, (buf) => parts.push(buf));
      return Buffer.concat(parts);
    } catch (err) {
      if (err?.status === 404 || err?.status === 501) {
        log('tts: kokoro stream unavailable — full /tts');
      } else {
        log(`tts: kokoro stream failed (${err.message}) — full /tts`);
      }
      return this.#synthFull(text, label);
    }
  }

  // POST /tts: the original whole-utterance path (prefetch, warmup, older sidecars).
  async #synthFull(text, label = 'audio in') {
    const t0 = Date.now();
    const res = await fetch(`${this.url}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: this.voice,
        speed: this.speed,
        sample_rate: this.sampleRate,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`kokoro HTTP ${res.status}`);
    const pcm = Buffer.from(await res.arrayBuffer());
    if (!pcm.length) throw new Error('kokoro empty audio');
    this.failures = 0;
    this.downUntil = 0;
    log(`tts: kokoro ${label} ${Date.now() - t0} ms for "${text.slice(0, 48)}"`);
    return pcm;
  }

  #play(text, pcm) {
    this.lastAudioAt = Date.now();
    // Micro-pause only between chunks, never after the final one: sounds like breaths.
    const hasMore = this.queue.length > 0 && this.pauseMs > 0;
    const out = hasMore ? Buffer.concat([pcm, this.#silence(this.pauseMs)]) : pcm;
    this.onAudio?.(out);
    // Hold speaking for the wall-clock length of the PCM so mouth/meter track playback.
    const ms = Math.max(250, Math.round((out.length / 2) / this.sampleRate * 1000));
    this.#scheduleEnd(ms);
    // Synthesize the next chunk in parallel with this one playing.
    this.#prefetchNext();
  }

  // End-of-playback bookkeeping, shared by the full-buffer and streamed paths.
  #scheduleEnd(ms) {
    clearTimeout(this.playTimer);
    this.playTimer = setTimeout(() => {
      this._speaking = false;
      // Chunk boundary: a queued greet/reply can preempt the rest of a low-priority
      // line here without cutting a word mid-sentence.
      if (this.shouldDrop?.()) {
        if (this.queue.length) log(`tts: kokoro yield ${this.queue.length} chunk(s)`);
        this.queue = [];
        this.prefetch = null;
        this.onIdle?.();
        return;
      }
      this.onIdle?.();
      this.#pump();
    }, Math.max(0, ms));
  }

  // Kick off the next chunk now; #playChunk consumes it (hit) or synthesizes (miss).
  #prefetchNext() {
    if (this.stopped) return;
    const next = this.queue[0];
    if (!next) { this.prefetch = null; return; }
    if (this.prefetch?.text === next) return;
    if (Date.now() < this.downUntil) return;
    const rec = { text: next, pcm: null, promise: null };
    rec.promise = this.#synthRaw(next, 'prefetch in').then((pcm) => {
      rec.pcm = pcm;
      return pcm;
    });
    rec.promise.catch(() => { /* consumed at #playChunk, reported as a miss */ });
    this.prefetch = rec;
  }

  #silence(ms) {
    const samples = Math.max(0, Math.round(this.sampleRate * ms / 1000));
    const key = `${this.sampleRate}:${samples}`;
    let buf = SILENCE_CACHE.get(key);
    if (!buf) {
      buf = Buffer.alloc(samples * 2);
      SILENCE_CACHE.set(key, buf);
    }
    return buf;
  }

  #failover(text, err) {
    this.failures++;
    this._speaking = false;
    this.prefetch = null;
    const now = Date.now();
    if (err && now - this.lastErrorAt > 10000) {
      this.lastErrorAt = now;
      log(`tts: kokoro failed (${err.message}) — piper line "${String(text).slice(0, 48)}"`);
    }
    // Back off the sidecar after a miss; the fallback covers this line and the rest.
    this.downUntil = now + Math.min(30000, 2000 * Math.max(1, this.failures));
    this.fallback?.speak?.(text);
    this.#drainToFallback();
    this.onIdle?.();
  }

  #drainToFallback() {
    this.prefetch = null;
    if (!this.fallback) { this.queue = []; return; }
    while (this.queue.length) this.fallback.speak?.(this.queue.shift());
  }

  stop() {
    this.stopped = true;
    this.#cancelWarmup();
    clearTimeout(this.playTimer);
    clearInterval(this.keepWarmTimer);
    this.keepWarmTimer = null;
    this.queue = [];
    this.prefetch = null;
    this._speaking = false;
    this.fallback?.stop?.();
  }
}
