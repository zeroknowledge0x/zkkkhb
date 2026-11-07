// Fetch the official Hubie art that Housebets publishes on its own site.
// The contest asks for "animated Hubie, from official art" — there is no downloadable
// art pack in the public rules, so the source is the mascot art on housebets.com.
// Keep these files out of git: they are Housebets' artwork, not ours to redistribute.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'assets', 'hubie');
const BASE = 'https://www.housebets.com/_next/static/media';

const FILES = {
  'portrait.webp': 'hubie-welcome-portrait.0yc5yuw2xny-t.webp',
  'labs.webp': 'hubie-labs.0eelrgr6yy6j1.webp',
  'hero.webp': 'contest-hubie-streamer.0zol0s02dr-tt.webp',
  'welcome-row.webp': 'hubie-welcome-row.2jfi9g9vujzmt.webp',
  'gamble-responsibly.webp': 'gamble-responsibly.37a5-fltm4xs3.webp',
};

fs.mkdirSync(DIR, { recursive: true });

for (const [name, remote] of Object.entries(FILES)) {
  const dest = path.join(DIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    console.log(`[art] keep ${name} (${fs.statSync(dest).size} B)`);
    continue;
  }
  const url = `${BASE}/${remote}?__next_w=1920&__next_q=82`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0' } });
  if (!res.ok) { console.log(`[art] FAIL ${name} HTTP ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`[art] ${name} ${buf.length} B`);
}

console.log(`[art] done -> ${DIR}`);
