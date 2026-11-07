// Piper TTS over a long-lived child process: one process, many lines, raw PCM out.
// Measured on 4 vCPU: ~0.9 s wall for 4.5 s of speech, ~0.3 s once warm.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';
import { VENDOR } from './config.js';

const IDLE_MS = 250;

// Soft knee limiter for the int16 PCM piper streams out. Most of the signal passes
// through untouched; only peaks above the knee get rounded off, which stops the
// harsh clipping that reads as "robotic" without adding a compressor or dependency.
const LIMIT_KNEE = 0.9;
function softLimit(buf) {
  for (let i = 0; i < buf.length; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    const a = Math.abs(v);
    if (a <= LIMIT_KNEE) continue;
    const y = LIMIT_KNEE + Math.tanh((a - LIMIT_KNEE) / (1 - LIMIT_KNEE)) * (1 - LIMIT_KNEE);
    buf.writeInt16LE(Math.round((v < 0 ? -y : y) * 32767), i);
  }
  return buf;
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Long replies are split clause by clause: the first chunk starts speaking sooner and
// the pauses land where the punctuation is, instead of one flat block. Shared by every
// voice engine so Piper and Edge read a line the same way.
export function chunkText(text, max = 140) {
  const parts = String(text || '').split(/(?<=[.!?;:])\s+|,\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const part of parts) {
    if ((cur ? `${cur} ${part}` : part).length <= max) cur = cur ? `${cur} ${part}` : part;
    else { if (cur) out.push(cur); cur = part; }
  }
  if (cur) out.push(cur);
  return out;
}

export class PiperVoice {
  constructor({
    binPath,
    voiceName,
    // 704 is the calm male libritts speaker we picked (109 Hz, unhurried). Owners can
    // swap it with TTS_SPEAKER for any of the model's 0-903 speakers.
    speaker = null,
    onAudio,
    onIdle,
    // Slightly slower, a little more variation and a longer beat between sentences:
    // these are what make the default piper read sound like a person thinking.
    lengthScale = 1.08,
    noiseScale = 0.75,
    noiseW = 0.85,
    sentenceSilence = 0.32,
  }) {
    this.binPath = binPath;
    this.modelPath = path.join(VENDOR, 'voices', `${voiceName}.onnx`);
    this.speaker = Number.isFinite(speaker) ? speaker : null;
    this.lengthScale = numOr(lengthScale, 1.08);
    this.noiseScale = numOr(noiseScale, 0.75);
    this.noiseW = numOr(noiseW, 0.85);
    this.sentenceSilence = numOr(sentenceSilence, 0.32);
    // Passing --speaker to a single-speaker voice is a hard error in piper, so read the
    // model card and only use it when the model actually has multiple speakers.
    try {
      const meta = JSON.parse(fs.readFileSync(`${this.modelPath}.json`, 'utf8'));
      if (!(Number(meta.num_speakers) > 1)) this.speaker = null;
    } catch { this.speaker = null; }
    this.onAudio = onAudio;
    this.onIdle = onIdle;
    this.queue = [];
    this.speaking = false;
    this.proc = null;
    this.backoff = 2000;
    this.ready = fs.existsSync(this.binPath) && fs.existsSync(this.modelPath);
    if (!this.ready) log(`tts: piper or voice model missing (${this.binPath} | ${this.modelPath}) — running silent`);
  }

  start() {
    if (!this.ready || this.proc) return this;
    const args = ['--model', this.modelPath, '--output-raw'];
    if (this.speaker !== null) args.push('--speaker', String(this.speaker));
    // Expressive knobs (see piper --help): slower phonemes + more sampling variation
    // + a longer sentence tail is what separates a person from a screen reader.
    args.push(
      '--length_scale', String(this.lengthScale),
      '--noise_scale', String(this.noiseScale),
      '--noise_w', String(this.noiseW),
      '--sentence_silence', String(this.sentenceSilence),
    );
    this.proc = spawn(this.binPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.on('error', (err) => log(`tts: spawn failed: ${err.message}`));
    this.proc.on('exit', (code) => {
      this.proc = null;
      this.speaking = false;
      if (code === 0) return;
      log(`tts: piper exited (${code}); respawning in ${this.backoff} ms`);
      setTimeout(() => this.start(), this.backoff);
    });
    this.proc.stdout.on('data', (pcm) => {
      this.lastAudioAt = Date.now();
      if (this.chunkSentAt) {
        log(`tts: first audio in ${Date.now() - this.chunkSentAt} ms for "${String(this.pendingChunk).slice(0, 48)}"`);
        this.chunkSentAt = 0;
      }
      this.speaking = true;
      this.onAudio(softLimit(pcm));
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.#idle(), IDLE_MS);
    });
    this.proc.stderr.on('data', (b) => {
      const s = b.toString().trim();
      if (s && !/Waiting for audio|Loaded voice|Initialized/.test(s)) log(`tts: ${s.slice(0, 200)}`);
    });
    return this;
  }

  #idle() {
    this.speaking = false;
    // Chunk boundary: let a preempting greet/reply clear anything still queued.
    if (this.shouldDrop?.()) {
      if (this.queue.length) log(`tts: piper yield ${this.queue.length} chunk(s)`);
      this.queue = [];
      this.onIdle?.();
      return;
    }
    this.onIdle?.();
    this.#pump();
  }

  #pump() {
    if (!this.proc || this.speaking || !this.queue.length) return;
    this.speaking = true;
    this.pendingChunk = this.queue.shift();
    this.chunkSentAt = Date.now();
    this.proc.stdin.write(this.pendingChunk + '\n');
  }

  speak(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean || !this.ready) return;
    for (const chunk of chunkText(clean)) this.queue.push(chunk);
    const overflow = this.queue.length - 3;
    if (overflow > 0) this.queue.splice(0, overflow);
    this.#pump();
  }

  get pending() { return this.queue.length + (this.speaking ? 1 : 0); }

  stop() {
    clearTimeout(this.idleTimer);
    try { this.proc?.stdin.end(); } catch { /* already gone */ }
    try { this.proc?.kill(); } catch { /* already gone */ }
  }
}
