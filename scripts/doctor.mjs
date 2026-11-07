// Pre-flight check. Prints PASS / WARN / FAIL for every dependency the show needs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv, cfg, bin, chromePath, VENDOR } from '../src/config.js';

loadEnv();
const c = cfg();
const rows = [];

function add(level, name, detail) { rows.push({ level, name, detail }); }

add(Number(process.versions.node.split('.')[0]) >= 20 ? 'PASS' : 'FAIL', 'node >= 20', process.versions.node);
add(fs.existsSync('node_modules/@napi-rs/canvas') ? 'PASS' : 'FAIL', 'dependency @napi-rs/canvas', 'npm install');
add(fs.existsSync('node_modules/puppeteer-core') ? 'PASS' : 'WARN', 'dependency puppeteer-core', 'needed only for the game feed');
const artFiles = ['portrait.webp', 'portrait.png', 'portrait.jpg'].map((f) => path.join('assets', 'hubie', f));
add(artFiles.some((f) => fs.existsSync(f)) ? 'PASS' : 'WARN', 'hubie art', artFiles.find((f) => fs.existsSync(f)) || 'run: npm run art');

for (const [label, cmd, args] of [
  ['ffmpeg', bin('ffmpeg'), ['-version']],
  ['piper', path.join(VENDOR, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper'), ['--help']],
]) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 15000 });
    add('PASS', label, cmd);
  } catch {
    add('FAIL', label, 'run: npm run bootstrap');
  }
}

const voice = path.join(VENDOR, 'voices', `${c.ttsVoice}.onnx`);
add(fs.existsSync(voice) ? 'PASS' : 'FAIL', 'voice model', c.ttsVoice);

const chrome = chromePath();
add(chrome ? 'PASS' : 'WARN', 'chrome / edge', chrome || 'not found: set CHROME_PATH');

add(c.rtmpUrl && c.streamKey ? 'PASS' : 'WARN', 'stream target', c.rtmpUrl ? 'configured' : 'record-only mode');
add(c.llmKey ? 'PASS' : 'WARN', 'brain api key', c.llmKey ? 'configured' : 'offline canned lines');
const chatHost = (c.chatHost || c.streamHost || 'twitch').toLowerCase();
const chatName = chatHost === 'kick' ? c.kickChannel : c.twitchChannel;
add(chatName ? 'PASS' : 'WARN', `chat channel (${chatHost})`, chatName || `${chatHost === 'kick' ? 'KICK_CHANNEL' : 'TWITCH_CHANNEL'} empty`);

if (c.gamesUrl) {
  try {
    const res = await fetch(c.gamesUrl, { method: 'GET', redirect: 'follow' });
    add(res.ok ? 'PASS' : 'FAIL', 'game feed reachability', `${res.status} ${c.gamesUrl}`);
  } catch (err) {
    add('FAIL', 'game feed reachability', err.message);
  }
}

try {
  const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) });
  const geo = await res.json();
  add('INFO', 'egress region', `${geo.country} / ${geo.city}`);
} catch { add('INFO', 'egress region', 'unknown'); }

// chat brain inputs: knowledge base + remember store
try {
  const kb = JSON.parse(fs.readFileSync('data/kb.json', 'utf8'));
  add(kb.entries?.length >= 5 ? 'PASS' : 'WARN', 'knowledge base', `${kb.entries?.length || 0} entries in data/kb.json`);
} catch { add('WARN', 'knowledge base', 'data/kb.json missing'); }
try {
  const mem = JSON.parse(fs.readFileSync('data/viewers.json', 'utf8'));
  add('INFO', 'viewer memory', `${Object.keys(mem.viewers || {}).length} viewers remembered`);
} catch { add('INFO', 'viewer memory', 'empty (first run)'); }

const free = fs.statfsSync ? fs.statfsSync('.') : null;
if (free) add(free.bavail * free.bsize > 8e9 ? 'PASS' : 'WARN', 'free disk', `${(free.bavail * free.bsize / 1e9).toFixed(1)} GB`);

for (const r of rows) console.log(`${r.level.padEnd(5)} ${r.name.padEnd(26)} ${r.detail}`);
const failed = rows.filter((r) => r.level === 'FAIL');
console.log(`\n${failed.length ? 'NOT READY' : 'READY'} — ${rows.filter((r) => r.level === 'PASS').length} pass, ${rows.filter((r) => r.level === 'WARN').length} warn, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
