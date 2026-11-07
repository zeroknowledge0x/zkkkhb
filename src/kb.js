// Tiny knowledge base: keyword-scored facts the brain may use. No embeddings, no network.
import fs from 'node:fs';

const STOP = new Set('the a an and or but if then than that this these those is are was were be been being to of in on for with at by from as it its you your i me my we they he she them do does did what who how why when where can could should would will just about like'.split(' '));

function terms(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export class Knowledge {
  constructor(file) {
    this.entries = [];
    this.file = file;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.entries = (raw.entries || []).map((e, i) => ({
        id: e.id || `kb-${i}`,
        title: e.title || '',
        text: e.text || '',
        tags: (e.tags || []).map((t) => t.toLowerCase()),
      }));
    } catch { /* no kb → brain just answers from its rules */ }
  }

  get size() { return this.entries.length; }

  search(query, k = 2) {
    const q = terms(query);
    if (!q.length) return [];
    const scored = this.entries.map((e) => {
      const hay = terms(`${e.title} ${e.text} ${e.tags.join(' ')}`);
      const set = new Set(hay);
      let score = 0;
      for (const w of q) {
        if (set.has(w)) score += 1;
        if (e.tags.some((t) => t.includes(w))) score += 0.5;
      }
      return { entry: e, score };
    }).filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.entry);
  }

  titles() { return this.entries.map((e) => e.title).join('; '); }
}
