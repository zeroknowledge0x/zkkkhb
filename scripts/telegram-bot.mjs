// Telegram control bot for the Hubie stream. Long-polls the Bot API, no dependencies.
//
//   TELEGRAM_BOT_TOKEN=... node scripts/telegram-bot.mjs
//
// First /start from any chat claims ownership (stored in data/telegram.json). After that
// only that chat is answered. Every command is listed in /help.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, 'data', 'telegram.json');
const ENV_PATH = path.join(ROOT, '.env');
const LOG_DIR = path.join(ROOT, 'logs');
const FRAME = path.join(LOG_DIR, 'live-frame.jpg');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = `https://api.telegram.org/bot${TOKEN}`;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : { owner: null };
function save() { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

async function api(method, payload, isForm = false) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    body: isForm ? payload : JSON.stringify(payload || {}),
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(40000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || res.status}`);
  return j.result;
}

const say = (chatId, text, extra = {}) => api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const sendPhoto = async (chatId, file, caption) => {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption || '');
  form.append('photo', new Blob([fs.readFileSync(file)]), path.basename(file));
  return api('sendPhoto', form, true);
};

// ---- process + stream facts -------------------------------------------------------
function ps(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }); } catch (e) { return e.stdout || ''; }
}
function appPids() {
  const out = ps('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src.index' } | Select-Object -ExpandProperty ProcessId"]);
  return String(out).split(/\s+/).filter(Boolean).map(Number);
}
function ffmpegRunning() {
  const out = ps('powershell.exe', ['-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ffmpeg.exe' } | Measure-Object).Count"]);
  return Number(String(out).trim()) > 0;
}
function logFile() {
  const files = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter((f) => /^hubie-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort() : [];
  return files.length ? path.join(LOG_DIR, files[files.length - 1]) : null;
}
function tail(n = 12) {
  const f = logFile();
  if (!f) return '(no log yet)';
  return fs.readFileSync(f, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
}
function lastSupervisor() {
  const f = logFile();
  if (!f) return null;
  const lines = fs.readFileSync(f, 'utf8').trimEnd().split('\n').reverse();
  const line = lines.find((l) => l.includes('supervisor: node='));
  if (!line) return null;
  const pick = (k) => (line.match(new RegExp(`${k}=([^\\s]+)`)) || [])[1];
  return { raw: line, frameAge: Number(pick('frame_age_s')), chatAge: Number(pick('chat_age_s')), shots: pick('shots'), capMs: pick('cap_ms'), errors: pick('poll_errors') };
}
function envValue(key) {
  const m = fs.readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}
function setEnv(key, value) {
  let text = fs.readFileSync(ENV_PATH, 'utf8');
  if (new RegExp(`^${key}=`, 'm').test(text)) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  else text = `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
  fs.writeFileSync(ENV_PATH, text);
}
function runPowerShell(script) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('exit', (code) => resolve({ code, out: out.trim() }));
    p.on('error', (e) => resolve({ code: -1, out: e.message }));
  });
}

async function kickStatus() {
  try {
    const r = await fetch('https://kick.com/api/v2/channels/HubieZK', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const live = !!j.livestream;
    return { live, viewers: j.livestream?.viewer_count ?? 0, title: j.livestream?.session_title || '' };
  } catch (e) { return { error: e.message }; }
}

// ---- commands ---------------------------------------------------------------------
const HELP = [
  '<b>HUBIE control</b>',
  '/status — proses, frame, chat, kick, memori',
  '/frame — kirim frame live terakhir',
  '/log [n] — n baris log terakhir',
  '/errors — error hari ini',
  '/start_stream — nyalakan siaran',
  '/stop_stream — matikan siaran',
  '/restart — restart (jam "tanpa manusia" mulai ulang)',
  '/say &lt;teks&gt; — Hubie mengucapkan baris ini',
  '/game &lt;name&gt; — queue a table (if allowed)',
  '/games — list allowed tables',
  '/allow &lt;nama&gt; — tambah ke whitelist',
  '/deny &lt;nama&gt; — hapus dari whitelist',
  '/stake [nilai] — lihat/ubah BET_STAKE (default 0 = demo)',
  '/kick — status channel Kick',
  '/help — daftar ini',
].join('\n');

async function handle(chatId, text) {
  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@\w+$/, '');
  const arg = rest.join(' ').trim();

  if (cmd === '/start' && !state.owner) {
    state.owner = chatId;
    save();
    return say(chatId, `Owner registered: <code>${chatId}</code>\n\n${HELP}`);
  }
  if (state.owner && chatId !== state.owner) return say(chatId, 'This bot serves its owner only.');
  if (!state.owner) return say(chatId, 'Send /start to claim this bot.');

  if (cmd === '/help' || cmd === '/start') return say(chatId, HELP);

  if (cmd === '/status') {
    const pids = appPids();
    const sup = lastSupervisor();
    const k = await kickStatus();
    const mem = Math.round(os.totalmem() / 1e9);
    const free = Math.round(os.freemem() / 1e9);
    return say(chatId, [
      `<b>App</b>: ${pids.length ? `running (pid ${pids.join(',')})` : 'DOWN'}`,
      `<b>Encoder</b>: ${ffmpegRunning() ? 'running' : 'down'}`,
      sup ? `<b>Frame</b>: ${sup.frameAge}s ago · shots ${sup.shots} · cap ${sup.capMs} ms` : '<b>Frame</b>: none yet',
      sup ? `<b>Chat</b>: ${sup.chatAge < 0 ? 'no messages yet' : sup.chatAge + 's ago'} · poll_errors ${sup.errors}` : '',
      k.error ? `<b>Kick</b>: error ${k.error}` : `<b>Kick</b>: ${k.live ? `LIVE · ${k.viewers} viewer` : 'offline'}`,
      `<b>RAM</b>: ${free}GB bebas / ${mem}GB`,
    ].filter(Boolean).join('\n'));
  }

  if (cmd === '/frame') {
    if (!fs.existsSync(FRAME)) return say(chatId, 'No frame yet. Check the stream is running and FRAME_DUMP_MS is set.');
    const age = Math.round((Date.now() - fs.statSync(FRAME).mtimeMs) / 1000);
    return sendPhoto(chatId, FRAME, `Live frame, ${age}s ago`);
  }

  if (cmd === '/log') {
    const n = Math.min(60, Math.max(1, Number(arg) || 15));
    return say(chatId, `<pre>${tail(n).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre>`);
  }

  if (cmd === '/errors') {
    const f = logFile();
    if (!f) return say(chatId, 'No log yet.');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes(' ERROR '));
    return say(chatId, lines.length ? `<pre>${lines.slice(-10).join('\n')}</pre>` : '0 ERROR hari ini.');
  }

  if (cmd === '/start_stream' || cmd === '/restart') {
    await say(chatId, 'Running soft restart…');
    const r = await runPowerShell(path.join(ROOT, 'scripts', 'soft-restart.ps1'));
    return say(chatId, `<pre>${(r.out || '').slice(-800)}</pre>\n<b>exit</b> ${r.code}`);
  }

  if (cmd === '/stop_stream') {
    await say(chatId, 'Stopping…');
    const r = await runPowerShell(path.join(ROOT, 'scripts', 'stop-hubie.ps1'));
    return say(chatId, `<pre>${(r.out || '').slice(-600)}</pre>\n<b>exit</b> ${r.code}`);
  }

  if (cmd === '/say') {
    if (!arg) return say(chatId, 'Usage: /say text to speak');
    fs.writeFileSync(path.join(ROOT, 'say-inject.json'), JSON.stringify({ text: arg, at: Date.now() }));
    return say(chatId, `Injected: “${arg}”`);
  }

  if (cmd === '/game') {
    if (!arg) return say(chatId, 'Usage: /game Dice');
    fs.writeFileSync(path.join(ROOT, 'queue-inject.json'), JSON.stringify({ game: arg, name: 'telegram' }));
    return say(chatId, `Queued table: ${arg}`);
  }

  if (cmd === '/games') {
    return say(chatId, `<b>Diizinkan</b>: ${envValue('PLAYABLE_GAMES') || 'Dice'}\n<b>Stake</b>: ${envValue('BET_STAKE') || '0'}`);
  }

  if (cmd === '/allow' || cmd === '/deny') {
    if (!arg) return say(chatId, `Usage: ${cmd} Mines`);
    const current = (envValue('PLAYABLE_GAMES') || 'Dice').split(',').map((s) => s.trim()).filter(Boolean);
    const name = arg.split(/\s+/)[0];
    const next = cmd === '/allow'
      ? [...new Set([...current, name])]
      : current.filter((g) => g.toLowerCase() !== name.toLowerCase());
    setEnv('PLAYABLE_GAMES', next.join(',') || 'Dice');
    return say(chatId, `PLAYABLE_GAMES = ${next.join(',') || 'Dice'}\n(butuh /restart supaya agent membacanya ulang)`);
  }

  if (cmd === '/stake') {
    if (!arg) return say(chatId, `BET_STAKE is ${envValue('BET_STAKE') || '0'}`);
    if (!/^\d+(\.\d+)?$/.test(arg)) return say(chatId, 'Number only, e.g. 0 or 0.0977');
    setEnv('BET_STAKE', arg);
    return say(chatId, `BET_STAKE = ${arg}\n(butuh /restart). Ingat: kolom taruhan di game memakai POL, bukan IDR.`);
  }

  if (cmd === '/kick') {
    const k = await kickStatus();
    return say(chatId, k.error ? `Kick error: ${k.error}` : k.live
      ? `<b>LIVE</b> · ${k.viewers} viewer\n${k.title}`
      : 'Kick: offline');
  }

  return say(chatId, `Unknown command: ${cmd}\n\n${HELP}`);
}

// ---- long poll --------------------------------------------------------------------
let offset = 0;
console.log('telegram bot started');
for (;;) {
  try {
    const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text) continue;
      await handle(msg.chat.id, msg.text).catch((e) => console.error('handler', e.message));
    }
  } catch (e) {
    console.error('poll', e.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
