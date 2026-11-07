// VOD bookmarks: one JSON line every few hours so the unedited recording can be traced
// back to a game/segment/commit without scrubbing the mp4. Append-only, never throws.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

let lastBookmarkAt = 0;
let seeded = false;

function lastLineTs(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (Number.isFinite(Number(row?.ts))) return Number(row.ts);
      } catch { /* skip a torn tail line */ }
    }
  } catch { /* first run or unreadable file */ }
  return 0;
}

export function maybeBookmark({ file, getMeta, intervalMs = 3 * 3600 * 1000, now = Date.now() } = {}) {
  if (!file) return null;
  if (!seeded) {
    seeded = true;
    // Seed from the last line so a restart does not write a burst of bookmarks.
    // With no history, wait a full interval from start instead of writing at 60 s.
    // 0 = no history yet, so the first scheduled tick may write immediately.
    lastBookmarkAt = lastLineTs(file) || 0;
  }
  if (now - lastBookmarkAt < intervalMs) return null;
  let meta = {};
  try {
    meta = getMeta?.() || {};
  } catch (err) {
    log(`vod: metadata failed: ${err.message}`);
  }
  const entry = {
    ts: now,
    iso: new Date(now).toISOString(),
    game: meta.game || null,
    uptimeH: Number.isFinite(Number(meta.uptimeH)) ? Number(meta.uptimeH) : 0,
    segment: meta.segment || null,
    commit: meta.commit || null,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    log(`vod: bookmark write failed: ${err.message}`);
    return null;
  }
  lastBookmarkAt = now;
  log(`vod: bookmark uptime=${entry.uptimeH}h game=${entry.game || 'unknown'}`);
  return entry;
}
