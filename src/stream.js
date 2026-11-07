// ffmpeg output stage: rawvideo on fd 3, s16le audio on fd 4, one encode, tee to
// RTMP + a local MP4 so the VOD survives even if the platform drops the stream.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';
import { bin, RECORD_DIR } from './config.js';

function pump(stream, buf) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed) return reject(new Error('output closed'));
    const ok = stream.write(buf, (err) => (err ? reject(err) : null));
    if (ok) resolve(); else stream.once('drain', resolve);
  });
}

export class Encoder {
  constructor(cfg) {
    this.cfg = cfg;
    this.frameBytes = cfg.width * cfg.height * 4;
    this.proc = null;
    this.onExit = null;
    // Speech chain: piper output is quiet and dull, which reads as "mumbling" on a stream.
    // High-pass the rumble, dip 250 Hz mud, lift 1.8 kHz body and 3.5 kHz presence,
    // compress, then limit. Clarity first: no loudnorm, which stalls a live pipe.
    this.audioFilter = process.env.AUDIO_FILTER || [
      'highpass=f=90',
      'equalizer=f=250:t=q:w=1.0:g=-3',
      'equalizer=f=1800:t=q:w=1.0:g=2',
      'equalizer=f=3500:t=q:w=1.1:g=4',
      'volume=1.05',
      'acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=4',
      'alimiter=limit=0.85:level=false',
    ].join(',');
    this.recordPath = null;
    this.frames = 0;
    this.dead = false;
  }

  start() {
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.recordPath = path.join(RECORD_DIR, `hubie-${stamp}.mp4`);

    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${this.cfg.width}x${this.cfg.height}`,
      '-r', String(this.cfg.fps), '-i', 'pipe:3',
      '-f', 's16le', '-ar', String(this.cfg.sampleRate), '-ac', '1', '-i', 'pipe:4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-b:v', this.cfg.bitrate, '-maxrate', this.cfg.bitrate, '-bufsize', '7000k',
      '-g', String(this.cfg.fps * 2), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-af', this.audioFilter,
    ];

    const target = this.cfg.rtmpUrl && this.cfg.streamKey
      ? `${this.cfg.rtmpUrl.replace(/\/$/, '')}/${this.cfg.streamKey}`
      : null;

    if (target) {
      // tee treats ':' as option separator — escape rtmps:// and paths
      const esc = (s) => String(s).replaceAll(String.fromCharCode(92), String.fromCharCode(92,92)).replaceAll(':', String.fromCharCode(92) + ':');
      args.push(
        '-map', '0:v:0', '-map', '1:a:0',
        '-f', 'tee',
        `[f=flv]${esc(target)}|[f=mp4:onfail=ignore:movflags=+frag_keyframe+empty_moov]${esc(this.recordPath)}`,
      );
    } else {
      // Fragmented MP4: a hard kill (or a power cut) still leaves a playable file,
      // instead of an mp4 whose moov atom was never written.
      args.push('-movflags', '+frag_keyframe+empty_moov', '-f', 'mp4', this.recordPath);
    }

    this.dead = false;
    log(`encoder: ${target ? 'rtmp + local mp4' : 'local mp4 only'} -> ${this.recordPath}`);
    this.proc = spawn(bin('ffmpeg'), args, { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] });
    this.video = this.proc.stdio[3];
    this.audio = this.proc.stdio[4];
    this.video.on('error', () => {});
    this.audio.on('error', () => {});
    this.proc.on('exit', (code, signal) => {
      log(`encoder: ffmpeg exited (${code ?? signal})`);
      this.dead = true;
      this.proc = null;
      this.onExit?.(code);
    });
    return this;
  }

  async pushVideo(buf) {
    if (this.dead) return;
    if (buf.length !== this.frameBytes) throw new Error(`bad frame size ${buf.length}`);
    this.frames++;
    try { await pump(this.video, buf); } catch { this.dead = true; }
  }

  async pushAudio(buf) {
    if (this.dead) return;
    try { await pump(this.audio, buf); } catch { this.dead = true; }
  }

  stop() {
    try { this.video?.end(); } catch { /* closed */ }
    try { this.audio?.end(); } catch { /* closed */ }
  }
}
