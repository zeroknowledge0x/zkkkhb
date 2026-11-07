// Kick chat reader. Primary source is the public channel messages API
// (GET /api/v2/channels/<numericId>/messages). The headed Kick /chat DOM tab
// virtualises rows and often freezes on old messages while poll_errors stays 0,
// so new viewer lines never reach Hubie. DOM scrape stays as a fallback only.
import { log } from './log.js';
import { getBrowser } from './browser.js';
import {
  createKickApiDedupe,
  createKickDedupe,
  formatChatSkip,
  ingestKickApiMessages,
  ingestKickRows,
  parseKickRow,
} from './chat-reply.js';

const API_POLL_MS = 1200;
const DOM_POLL_MS = 900;
const HEARTBEAT_MS = 60 * 1000;
const API_FAIL_DOM_AFTER = 4;
const EMPTY_RELOAD_MS = 90 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class KickChat {
  constructor({ channel, onMessage }) {
    this.channel = (channel || '').toLowerCase().replace(/^#/, '');
    this.onMessage = onMessage;
    this.channelId = null;
    this.chatroomId = null;
    this.apiDedupe = createKickApiDedupe();
    this.domDedupe = createKickDedupe();
    this.page = null;
    this.timer = null;
    this.stopped = false;
    this.backoff = 5000;
    this.pollErrors = 0;
    this.apiFails = 0;
    this.lastRowAt = 0;
    this.lastHeartbeatAt = 0;
    this.emptySince = 0;
    this.mode = 'api'; // api | dom
    this.domArmed = false;
  }

  start() {
    if (!this.channel) { log('chat(kick): KICK_CHANNEL empty - no chat input'); return this; }
    this.#boot();
    return this;
  }

  async #boot() {
    if (this.stopped) return;
    try {
      await this.#resolveChannel();
      log(`chat(kick): api #${this.channel} id=${this.channelId} chatroom=${this.chatroomId || '?'}`);
      this.#pollApi();
    } catch (err) {
      log(`chat(kick): api resolve failed (${err.message}) — arming DOM fallback`);
      this.#armDom('resolve-failed');
    }
  }

  async #resolveChannel() {
    const url = `https://kick.com/api/v2/channels/${encodeURIComponent(this.channel)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`channel ${res.status}`);
    const data = await res.json();
    const id = Number(data?.id);
    if (!Number.isFinite(id) || id <= 0) throw new Error('channel id missing');
    this.channelId = id;
    this.chatroomId = Number(data?.chatroom?.id) || null;
  }

  #pollApi() {
    clearInterval(this.timer);
    this.mode = 'api';
    this.timer = setInterval(() => { this.#tickApi().catch(() => {}); }, API_POLL_MS);
    this.#tickApi().catch(() => {});
  }

  async #tickApi() {
    if (this.stopped) return;
    if (!this.channelId) {
      try { await this.#resolveChannel(); } catch (err) {
        this.apiFails += 1;
        this.pollErrors = this.apiFails;
        if (this.apiFails === 1 || this.apiFails % 10 === 0) {
          log(`chat(kick): api resolve err ${err.message}`);
        }
        if (this.apiFails >= API_FAIL_DOM_AFTER) this.#armDom('api-resolve');
        return;
      }
    }
    const now = Date.now();
    try {
      const url = `https://kick.com/api/v2/channels/${this.channelId}/messages`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`messages ${res.status}`);
      const body = await res.json();
      const messages = body?.data?.messages || body?.messages || [];
      this.apiFails = 0;
      this.pollErrors = 0;
      const batch = ingestKickApiMessages(this.apiDedupe, messages, now);
      if (batch.primed) {
        log(`chat(kick): api primed n=${messages.length} (backlog ignored)`);
        this.lastRowAt = now;
        return;
      }
      for (const row of batch.fresh) {
        this.lastRowAt = now;
        try {
          this.onMessage?.({ name: row.name.slice(0, 40), text: row.text.slice(0, 300), id: row.id });
        } catch (handlerErr) {
          log(`chat(kick): onMessage err ${handlerErr.message || handlerErr}`);
        }
      }
      if (batch.fresh.length > 0) log(`chat(kick): api +${batch.fresh.length} msg`);
      else if (now - (this.lastHeartbeatAt || 0) > HEARTBEAT_MS) {
        this.lastHeartbeatAt = now;
        const age = this.lastRowAt ? Math.round((now - this.lastRowAt) / 1000) : -1;
        log(`chat(kick): api alive silent_s=${age}`);
      }
    } catch (err) {
      this.apiFails += 1;
      this.pollErrors = this.apiFails;
      if (this.apiFails === 1 || this.apiFails % 8 === 0) {
        log(`chat(kick): api poll err ${err.message || err}`);
      }
      if (this.apiFails >= API_FAIL_DOM_AFTER) this.#armDom('api-poll');
    }
  }

  #armDom(reason) {
    if (this.stopped || this.domArmed) return;
    this.domArmed = true;
    this.mode = 'dom';
    clearInterval(this.timer);
    this.timer = null;
    log(`chat(kick): DOM fallback (${reason})`);
    this.#openDom();
  }

  async #openDom() {
    if (this.stopped) return;
    const browser = await getBrowser();
    if (!browser) { log('chat(kick): no browser available - chat disabled'); return; }
    try {
      if (this.page) {
        try { await this.page.close(); } catch { /* already gone */ }
        this.page = null;
      }
      this.page = await browser.newPage();
      await this.page.setUserAgent(UA);
      await this.page.goto(`https://kick.com/${this.channel}/chat`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try {
        const pages = await browser.pages();
        const game = pages.find((p) => /housebets\.com/i.test(p.url()));
        if (game) await game.bringToFront();
      } catch { /* game page may still be launching */ }
      log(`chat(kick): opened #${this.channel} (DOM fallback)`);
      this.backoff = 5000;
      this.emptySince = 0;
      this.pollErrors = 0;
      this.lastRowAt = Date.now();
      this.#pollDom();
      this.page.on('close', () => this.#recoverDom('page-close'));
      // Keep trying API in background; flip back when it works again.
      this.#watchApiRecovery();
    } catch (err) {
      log(`chat(kick): open failed: ${err.message}`);
      this.#recoverDom('open-failed');
    }
  }

  #watchApiRecovery() {
    const tick = async () => {
      if (this.stopped || this.mode !== 'dom') return;
      try {
        if (!this.channelId) await this.#resolveChannel();
        const url = `https://kick.com/api/v2/channels/${this.channelId}/messages`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': UA },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(String(res.status));
        log('chat(kick): api recovered — leaving DOM fallback');
        this.domArmed = false;
        this.apiFails = 0;
        try { await this.page?.close(); } catch { /* ignore */ }
        this.page = null;
        clearInterval(this.timer);
        this.#pollApi();
        return;
      } catch { /* still broken */ }
      setTimeout(tick, 20000);
    };
    setTimeout(tick, 15000);
  }

  #recoverDom(reason = 'unknown') {
    if (this.stopped) return;
    clearInterval(this.timer);
    this.timer = null;
    log(`chat(kick): recovering DOM (${reason}) in ${this.backoff} ms`);
    setTimeout(() => this.#openDom(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 120000);
  }

  #pollDom() {
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (this.stopped || !this.page) return;
      const now = Date.now();
      try {
        await this.#pinLatest();
        const rows = await this.#scrape();
        if (!rows || rows.ok === false) {
          this.pollErrors += 1;
          if (this.pollErrors === 1 || this.pollErrors % 20 === 0) {
            log(`chat(kick): poll no-box errors=${this.pollErrors}`);
          }
          if (!this.emptySince) this.emptySince = now;
          if (now - this.emptySince > EMPTY_RELOAD_MS) {
            this.emptySince = 0;
            this.#recoverDom('no-box');
          }
          return;
        }
        this.pollErrors = 0;
        if (!rows.rows.length) {
          if (!this.emptySince) this.emptySince = now;
          if (now - (this.lastHeartbeatAt || 0) > HEARTBEAT_MS) {
            this.lastHeartbeatAt = now;
            log(`chat(kick): alive empty box=${rows.boxId} silent_s=${Math.round((now - (this.lastRowAt || now)) / 1000)}`);
          }
          if (this.lastRowAt && now - this.lastRowAt > EMPTY_RELOAD_MS && now - this.emptySince > EMPTY_RELOAD_MS) {
            this.emptySince = 0;
            this.#recoverDom('empty-too-long');
          }
          return;
        }
        this.emptySince = 0;
        const parsed = [];
        for (const raw of rows.rows) {
          const row = parseKickRow(raw);
          if (row) parsed.push(row);
        }
        const batch = ingestKickRows(this.domDedupe, parsed, now);
        for (const row of batch.skipped) log(formatChatSkip(row));
        for (const row of batch.fresh) {
          this.lastRowAt = now;
          try {
            this.onMessage?.({ name: row.name.slice(0, 40), text: row.text.slice(0, 300) });
          } catch (handlerErr) {
            log(`chat(kick): onMessage err ${handlerErr.message || handlerErr}`);
          }
        }
        if (batch.fresh.length > 0) log(`chat(kick): +${batch.fresh.length} msg`);
      } catch (err) {
        this.pollErrors += 1;
        if (this.pollErrors === 1 || this.pollErrors % 15 === 0) {
          log(`chat(kick): poll err ${err.message || err}`);
        }
        if (this.pollErrors >= 8) {
          this.pollErrors = 0;
          this.#recoverDom('poll-errors');
        }
      }
    }, DOM_POLL_MS);
  }

  async #scrape() {
    return this.page.evaluate(() => {
      const box =
        document.getElementById('chatroom-messages') ||
        document.querySelector('[data-testid="chatroom-messages"]') ||
        document.querySelector('#chatroom') ||
        document.querySelector('[class*="chatroom"]');
      if (!box) return { ok: false, reason: 'no-box', rows: [] };
      const nodes = [
        ...box.querySelectorAll('[data-index]'),
        ...box.querySelectorAll('[data-chat-entry]'),
        ...box.querySelectorAll('div[class*="chat"] div[class*="message"]'),
      ];
      const uniq = [];
      const seenEl = new Set();
      for (const el of nodes) {
        if (seenEl.has(el)) continue;
        seenEl.add(el);
        const nameEl =
          el.querySelector('button[title]') ||
          el.querySelector('[class*="username"]') ||
          el.querySelector('button');
        const msgEl =
          el.querySelector('[class*="chat-entry-content"]') ||
          el.querySelector('span.font-normal') ||
          el.querySelector('[class*="break-words"]') ||
          el.querySelector('[class*="message"] span');
        const name = (nameEl?.getAttribute('title') || nameEl?.textContent || '').trim();
        const text = (msgEl?.innerText || '').replace(/\s+/g, ' ').trim();
        const innerText = (el.innerText || '').slice(0, 500);
        if (!name && !text && !innerText) continue;
        uniq.push({ name, text, innerText });
      }
      return { ok: true, reason: 'ok', rows: uniq, n: uniq.length, boxId: box.id || box.className?.slice?.(0, 40) || 'box' };
    });
  }

  async #pinLatest() {
    await this.page.evaluate(() => {
      const box =
        document.getElementById('chatroom-messages') ||
        document.querySelector('[data-testid="chatroom-messages"]') ||
        document.querySelector('#chatroom');
      const nodes = [box, box?.parentElement, box?.parentElement?.parentElement].filter(Boolean);
      for (const el of nodes) {
        try {
          if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight;
        } catch { /* not a scroller */ }
      }
      for (const b of document.querySelectorAll('button, [role="button"]')) {
        const label = (b.innerText || b.getAttribute('aria-label') || '').trim();
        if (label.length > 48) continue;
        if (/paus|new message|jump to|latest|resume chat/i.test(label)) {
          try { b.click(); } catch { /* overlay button */ }
        }
      }
    });
    await this.page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    })).catch(() => {});
  }

  say() { return false; }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.page?.close().catch(() => {});
  }
}
