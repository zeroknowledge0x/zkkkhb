// Minimal logger: callable (log('msg')) plus leveled helpers (log.warn(...)).
// Writes to console and to logs/hubie-YYYY-MM-DD.log; never throws.
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';

fs.mkdirSync(LOG_DIR, { recursive: true });

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, msg) {
  const line = `${stamp()} ${level} ${msg}`;
  console.log(line);
  try {
    const file = path.join(LOG_DIR, `hubie-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line + '\n');
  } catch { /* logging must never crash the show */ }
}

function logFn(msg) { write('INFO', msg); }
logFn.info = (m) => write('INFO', m);
logFn.warn = (m) => write('WARN', m);
logFn.error = (m) => write('ERR ', m);

export const log = logFn;
