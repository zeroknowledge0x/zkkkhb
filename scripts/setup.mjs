// Preflight for a fresh machine: says exactly what is missing before Hubie can stream.
//
//   npm run setup
//
// Exit 0 = ready to start. Exit 1 = at least one blocker (listed with the command that
// fixes it). Nothing here needs the network except the optional table probe.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const rows = [];
const add = (state, name, detail) => rows.push({ state, name, detail });

const ok = (n, d = '') => add('PASS', n, d);
const warn = (n, d) => add('WARN', n, d);
const fail = (n, d) => add('FAIL', n, d);

function sh(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// ---- node + deps ------------------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
(major >= 20 ? ok : fail)('node >= 20', process.versions.node);
if (fs.existsSync(path.join(ROOT, 'node_modules'))) ok('dependencies installed');
else fail('dependencies installed', 'run: npm install');

// ---- browser ----------------------------------------------------------------------
const candidates = [
  process.env.CHROME_PATH,
  process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.platform === 'win32' && 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.platform === 'win32' && 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.platform !== 'win32' && sh('which', ['google-chrome']),
  process.platform !== 'win32' && sh('which', ['chromium']),
].filter(Boolean);
const chrome = candidates.find((p) => fs.existsSync(p));
(chrome ? ok : fail)('browser', chrome || 'install Chrome or set CHROME_PATH');

// ---- ffmpeg -----------------------------------------------------------------------
const ffmpeg = sh('ffmpeg', ['-version']).split('\n')[0];
(ffmpeg ? ok : fail)('ffmpeg', ffmpeg || 'install ffmpeg and put it on PATH');

// ---- env --------------------------------------------------------------------------
const envPath = path.join(ROOT, '.env');
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const envKey = (k) => (envText.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() || '';
if (!fs.existsSync(envPath)) {
  fail('.env', 'cp .env.example .env  (then fill the keys below)');
} else {
  ok('.env');
  const engine = (envKey('TTS_ENGINE') || 'edge').toLowerCase();
  const need = [
    ['STREAM_KEY', 'stream key from the RTMP target (Kick dashboard)'],
    ['LLM_API_KEY', 'the host brain needs a key unless LLM_OFFLINE=1'],
  ];
  if (engine === 'xai') need.push(['XAI_API_KEY', 'required by TTS_ENGINE=xai']);
  for (const [k, why] of need) {
    if (envKey(k)) ok(k, 'set');
    else fail(k, why);
  }
  const target = envKey('RTMP_URL') || envKey('KICK_RTMP_URL');
  if (target) ok('rtmp target', target.replace(/\/\/[^/]+\//, '//…/'));
  else warn('rtmp target', 'empty → record-only mode (still useful for a smoke test)');
}

// ---- browser profile (the table session) ------------------------------------------
const profileDirs = ['data/chrome-profile', 'data/profile', '.chrome-profile']
  .map((p) => path.join(ROOT, p))
  .filter((p) => fs.existsSync(p));
if (!profileDirs.length) {
  fail('table login profile', 'missing data/chrome-profile — copy it from the streaming box, or log in once with: npm run start (headed) and then keep the profile');
} else {
  const size = profileDirs.reduce((n, d) => n + dirSize(d), 0);
  (size > 5e6 ? ok : warn)('table login profile', `${profileDirs[0]} (${(size / 1e6).toFixed(0)} MB)`);
  if (size <= 5e6) warn('profile looks empty', 'a logged-out profile fails at the table');
}

// ---- local TTS assets, only when the chosen engine needs them ---------------------
const engine = (envKey('TTS_ENGINE') || 'edge').toLowerCase();
if (engine === 'piper' || engine === 'kokoro') {
  const has = fs.existsSync(path.join(ROOT, 'vendor'));
  (has ? ok : fail)(`${engine} assets`, has ? 'vendor/ present' : 'run: npm run bootstrap');
} else {
  ok(`tts engine ${engine}`, 'no local assets needed');
}

// ---- optional live probe ----------------------------------------------------------
if (process.argv.includes('--probe') && chrome) {
  const url = envKey('HOUSEBETS_URL') || 'https://www.housebets.com/casino';
  const code = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', url]);
  (code === '200' ? ok : warn)('table reachable', `${url} → HTTP ${code || 'no response'} (a blocked egress country returns a challenge)`);
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    }
  } catch { /* locked file */ }
  return total;
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.state.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail ?? ''}`);
const blockers = rows.filter((r) => r.state === 'FAIL');
console.log('');
if (!blockers.length) {
  console.log('READY — npm run start');
  process.exit(0);
}
console.log(`NOT READY — ${blockers.length} blocker(s)`);
for (const b of blockers) console.log(`  • ${b.name}: ${b.detail}`);
process.exit(1);
