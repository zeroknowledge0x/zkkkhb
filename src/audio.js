// Audio bus: TTS pushes PCM in, the render loop pulls exactly 1/fps worth per frame.
// Keeping the pull rate tied to the video clock is what keeps A/V in sync.
export class AudioBus {
  constructor(sampleRate, maxSeconds = 20) {
    this.sr = sampleRate;
    this.chunks = [];
    this.bytes = 0;
    this.maxBytes = sampleRate * 2 * maxSeconds;
    this.dropped = 0;
    // Absolute bytes already handed to the render clock. Cues fire when playback
    // reaches them, not when a synth packet is pushed.
    this.played = 0;
    this.cues = [];
    // Playback-end is the take() that consumes the last queued sample, not synth done.
    this.endListeners = [];
    this.endToken = null;
    this.endSaw = false;
  }

  onPlaybackEnd(fn) {
    if (typeof fn === 'function') this.endListeners.push(fn);
  }

  // The next drain belongs to this spoken line. A drain before any of its samples
  // arrive (the previous line finishing) does not count.
  armPlayback(token) {
    this.endToken = token;
    this.endSaw = false;
  }

  // onStart runs on the take() that first pulls this buffer, i.e. the playback clock.
  push(buf, onStart) {
    if (!buf?.length) return;
    if (this.bytes + buf.length > this.maxBytes) { this.dropped += buf.length; return; }
    if (this.endToken != null) this.endSaw = true;
    if (typeof onStart === 'function') {
      this.cues.push({ at: this.played + this.bytes, fn: onStart });
    }
    this.chunks.push(buf);
    this.bytes += buf.length;
  }

  take(samples) {
    const need = samples * 2;
    const out = Buffer.alloc(need);
    let off = 0;
    while (off < need && this.chunks.length) {
      const head = this.chunks[0];
      const want = need - off;
      if (head.length <= want) {
        head.copy(out, off); off += head.length; this.bytes -= head.length; this.chunks.shift();
      } else {
        head.copy(out, off, 0, want); this.chunks[0] = head.subarray(want); off += want; this.bytes -= want;
      }
    }
    if (off) {
      this.played += off;
      this.#flushCues();
    }
    // Empty bus after a real pull is playback end for the samples just consumed.
    if (off > 0 && this.bytes === 0 && this.endToken != null && this.endSaw) {
      const token = this.endToken;
      this.endSaw = false;
      for (const fn of this.endListeners) {
        try { fn(token); } catch { /* caption must not stall the clock */ }
      }
    }
    if (!this.bytes && !this.cues.length) this.played = 0;
    return out; // rest is silence, which is what an idle stream sounds like
  }

  #flushCues() {
    while (this.cues.length && this.cues[0].at <= this.played) {
      const cue = this.cues.shift();
      try { cue.fn(); } catch { /* gesture/expression must not stall the clock */ }
    }
  }

  rms(buf) {
    let sum = 0;
    const n = buf.length >> 1;
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    return n ? Math.sqrt(sum / n) : 0;
  }

  get seconds() { return this.bytes / 2 / this.sr; }
  clear() { this.chunks = []; this.bytes = 0; }
}
