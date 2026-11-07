// One-command vendor bootstrap: ffmpeg + piper + a voice model.
// Uses plain HTTPS + the OS tar (bsdtar on Windows/macOS) so npm lifecycle
// scripts are never required — npm 11/12 blocks them by default.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VENDOR, cfg, loadEnv } from '../src/config.js';

const checkOnly = process.argv.includes('--check');
const platform = process.platform; // win32 | linux | darwin

const PIPER = {
  win32: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
  linux: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz',
  darwin: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_x64.tar.gz',
};

const FFMPEG = {
  win32: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  linux: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
};

const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

function log(m) { console.log(`[bootstrap] ${m}`); }

function exists(p) { return fs.existsSync(p); }

function exeName(n) { return platform === 'win32' ? `${n}.exe` : n; }

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const file = fs.createWriteStream(dest);
  let got = 0, lastTick = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
    if (total && Date.now() - lastTick > 3000) {
      lastTick = Date.now();
      log(`  ${path.basename(dest)} ${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(0)} MB`);
    }
  }
  await new Promise((r) => file.end(r));
  return dest;
}

function untar(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // bsdtar (Windows 10+, macOS) and GNU tar both accept -xf for their own formats.
  execFileSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' });
}

function moveDirContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, entry);
    const to = path.join(destDir, entry);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
  }
}

async function ensurePiper() {
  const dir = path.join(VENDOR, 'piper');
  const bin = path.join(dir, exeName('piper'));
  if (exists(bin)) return bin;
  const url = PIPER[platform];
  if (!url) throw new Error(`No piper build for ${platform}; put the binary in vendor/piper/`);
  log(`piper: downloading ${platform} build`);
  const archive = path.join(VENDOR, 'downloads', `piper${platform === 'win32' ? '.zip' : '.tar.gz'}`);
  await download(url, archive);
  // Extract to a scratch dir first: the archive's top-level folder is also named
  // "piper", so extracting straight into vendor/piper collides with the binary name.
  const tmp = path.join(VENDOR, 'piper-extract');
  fs.rmSync(tmp, { recursive: true, force: true });
  untar(archive, tmp);
  const found = findFile(tmp, exeName('piper'));
  if (!found) throw new Error('piper binary not found in archive');
  moveDirContents(path.dirname(found), dir);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!exists(bin)) throw new Error('piper binary missing after extract');
  if (platform !== 'win32') fs.chmodSync(bin, 0o755);
  return bin;
}

async function ensureFfmpeg() {
  const dir = path.join(VENDOR, 'ffmpeg');
  const bin = path.join(dir, exeName('ffmpeg'));
  if (exists(bin)) return bin;
  const url = FFMPEG[platform];
  if (!url) {
    // macOS: rely on a system ffmpeg (brew install ffmpeg).
    log('ffmpeg: no bundled build for this platform, using system ffmpeg');
    return null;
  }
  log(`ffmpeg: downloading ${platform} build`);
  const ext = platform === 'win32' ? '.zip' : '.tar.xz';
  const archive = path.join(VENDOR, 'downloads', `ffmpeg${ext}`);
  await download(url, archive);
  const tmp = path.join(VENDOR, 'ffmpeg-extract');
  untar(archive, tmp);
  // Find the ffmpeg binary inside the archive and move bin/ + its DLLs to vendor/ffmpeg.
  const found = findFile(tmp, exeName('ffmpeg'));
  if (!found) throw new Error('ffmpeg binary not found in archive');
  fs.mkdirSync(dir, { recursive: true });
  const keep = platform === 'win32'
    ? null // Windows builds ship required DLLs next to the exe
    : new Set(['ffmpeg', 'ffprobe']);
  for (const f of fs.readdirSync(path.dirname(found))) {
    if (keep && !keep.has(f)) continue;
    fs.copyFileSync(path.join(path.dirname(found), f), path.join(dir, f));
  }
  if (platform !== 'win32') fs.chmodSync(bin, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  return bin;
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

async function ensureVoice(name) {
  const dir = path.join(VENDOR, 'voices');
  const model = path.join(dir, `${name}.onnx`);
  const meta = path.join(dir, `${name}.onnx.json`);
  if (exists(model) && exists(meta)) return model;
  const [lang, speaker, quality] = name.split('-'); // en_US-lessac-medium
  const url = `${VOICE_BASE}/${lang.slice(0, 2)}/${lang}/${speaker}/${quality}/${name}`;
  log(`voice: downloading ${name}`);
  await download(`${url}.onnx`, model);
  await download(`${url}.onnx.json`, meta);
  return model;
}

async function main() {
  loadEnv();
  // Same default as the runtime: asking config avoids "bootstrap fetched medium while the
  // app wanted libritts-high", which is exactly how a fresh clone ended up NOT READY.
  const c = cfg();
  const voice = c.ttsVoice;
  const piper = path.join(VENDOR, 'piper', exeName('piper'));
  const ffmpeg = path.join(VENDOR, 'ffmpeg', exeName('ffmpeg'));
  const voiceFile = path.join(VENDOR, 'voices', `${voice}.onnx`);

  if (checkOnly) {
    const missing = [piper, ffmpeg, voiceFile].filter((p) => !exists(p));
    if (missing.length) {
      console.error('[bootstrap] missing vendor files:\n  ' + missing.join('\n  '));
      console.error('[bootstrap] run: npm run bootstrap');
      process.exit(2);
    }
    console.log('[bootstrap] vendor ready');
    return;
  }

  fs.mkdirSync(VENDOR, { recursive: true });
  await ensurePiper();
  const ff = await ensureFfmpeg();
  await ensureVoice(voice);
  if (c.ttsSpeaker !== null) {
    try {
      const meta = JSON.parse(fs.readFileSync(`${voiceFile}.json`, 'utf8'));
      const n = Number(meta.num_speakers || 1);
      log(`speaker: ${c.ttsSpeaker} requested, model has ${n} speaker(s)${n > 1 ? '' : ' — flag will be ignored'}`);
    } catch { /* model card unreadable */ }
  }
  log(`done — piper: ${fs.existsSync(piper) ? 'ok' : 'MISSING'}, ffmpeg: ${ff || 'system'}, voice: ${c.ttsVoice} ${fs.existsSync(voiceFile) ? 'ok' : 'MISSING'}`);
}

main().catch((err) => {
  console.error('[bootstrap] failed:', err.message);
  process.exit(1);
});
