// Desktop capture for Windows RDP: ffmpeg gdigrab → 1280x720 RGBA frames.
// Clicks stay in the DOM (Puppeteer); this module only supplies pixels for the renderer.
import { spawn } from 'node:child_process';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { bin } from './config.js';

export const WIDTH = 1280;
export const HEIGHT = 720;
const FRAME_BYTES = WIDTH * HEIGHT * 4;
const FRESH_MS = 2000;
const BLACK_LIMIT = 20;
const FIRST_FRAME_MS = 5000;

export class DesktopGrab {
  constructor({ fps = 10, onFirstFrame = null, onFallback = null } = {}) {
    this.fps = fps;
    this.onFirstFrame = onFirstFrame;
    this.onFallback = onFallback;
    this.canvas = createCanvas(WIDTH, HEIGHT);
    this.ctx = this.canvas.getContext('2d');
    // Reuse one frame buffer + ImageData: the pipe delivers fixed-size RGBA frames, so
    // copying into a preallocated buffer avoids a Buffer.concat per read.
    this.pending = Buffer.allocUnsafe(FRAME_BYTES);
    this.pixels = new Uint8ClampedArray(this.pending.buffer, this.pending.byteOffset, FRAME_BYTES);
    this.imageData = new ImageData(this.pixels, WIDTH, HEIGHT);
    this.filled = 0;
    this.frame = null;
    this.frameAt = 0;
    this.blackRun = 0;
    this.proc = null;
    this.timer = null;
    this.stopped = false;
    this.failed = false;
    this.firstLogged = false;
    this.lastStderr = '';
  }

  start() {
    if (this.proc || this.stopped) return this;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', String(this.fps), '-draw_mouse', '1', '-i', 'desktop',
      '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-an', 'pipe:1',
    ];
    try {
      this.proc = spawn(bin('ffmpeg'), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this.#fail(`spawn failed: ${err.message}`);
      return this;
    }
    this.proc.on('error', (err) => this.#fail(`spawn failed: ${err.message}`));
    this.proc.stdout.on('data', (chunk) => this.#onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) this.lastStderr = line.slice(0, 200);
    });
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      if (this.stopped || this.failed) return;
      this.#fail(`ffmpeg exited ${code ?? signal}`);
    });
    // gdigrab can hang on a disconnected RDP session without ever emitting a frame.
    this.timer = setTimeout(() => {
      if (!this.frameAt && !this.failed && !this.stopped) this.#fail('no frames (5 s)');
    }, FIRST_FRAME_MS);
    this.timer.unref?.();
    return this;
  }

  // Latest frame, but only while it is fresh; a stale desktop frame must never pin the
  // panel after gdigrab stalls, so the caller falls back to the screencast frame.
  getFrame() {
    if (!this.frame || this.failed || this.stopped) return null;
    return Date.now() - this.frameAt < FRESH_MS ? this.frame : null;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.frame = null;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try { proc.kill(); } catch { /* already gone */ }
  }

  #onData(chunk) {
    if (this.failed || this.stopped) return;
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(FRAME_BYTES - this.filled, chunk.length - offset);
      chunk.copy(this.pending, this.filled, offset, offset + take);
      this.filled += take;
      offset += take;
      if (this.filled === FRAME_BYTES) {
        this.filled = 0;
        this.#emit();
      }
    }
  }

  #emit() {
    if (this.failed || this.stopped) return;
    this.ctx.putImageData(this.imageData, 0, 0);
    if (this.#isBlack()) {
      if (++this.blackRun >= BLACK_LIMIT) {
        this.#fail('black frames');
        return;
      }
    } else {
      this.blackRun = 0;
    }
    this.frame = this.canvas;
    this.frameAt = Date.now();
    if (!this.firstLogged) {
      this.firstLogged = true;
      clearTimeout(this.timer);
      this.timer = null;
      try { this.onFirstFrame?.(); } catch { /* logging must not break capture */ }
    }
  }

  // A fully black output is the usual RDP "capture blocked / session locked" signal.
  // Sampled sparsely so the check stays cheap at 10 fps.
  #isBlack() {
    const data = this.pixels;
    for (let i = 0; i < data.length; i += 4096) {
      if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) return false;
    }
    return true;
  }

  #fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.frame = null;
    this.stop();
    try { this.onFallback?.(reason); } catch { /* fallback handler is best-effort */ }
  }
}
