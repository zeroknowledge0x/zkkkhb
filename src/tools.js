// Sensor/report tools: plain functions that return JSON snapshots of what is actually
// happening (game page, browser, stream, chat). The agent loop calls reportAll() every
// second and hands that report to the LLM; nothing here invents game state.
import { browserStatus } from './browser.js';

const CHAT_LINES = 8;

function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export function createTools({ game = null, stream = {}, chat = {}, playQueue = null } = {}) {
  function reportGame() {
    const r = safe(() => game?.getReport?.(), null) || {};
    const bodySnippet = String(r.bodySnippet || '').slice(0, 400);
    const notFound = !!r.notFound || /404|page not found|return to home/i.test(`${r.title || ''} ${bodySnippet}`);
    return {
      ready: !!r.ready && !notFound,
      hasFrame: !!r.hasFrame,
      url: r.url || game?.url || null,
      title: r.title || '',
      blocked: !!r.blocked,
      notFound,
      loading: !!r.loading,
      lastError: r.lastError || null,
      bodySnippet,
      clickables: Array.isArray(r.clickables) ? r.clickables.slice(0, 20) : [],
      lastPointer: r.lastPointer || null,
      outcome: r.outcome || null,
      ts: Date.now(),
    };
  }

  function reportBrowser() {
    const b = safe(() => browserStatus(), null) || {};
    return {
      launched: !!b.launched,
      headed: !!b.headed,
      hint: b.hint || (b.launched ? 'launched' : 'not launched'),
      ts: Date.now(),
    };
  }

  function reportStream() {
    return {
      frames: Number(safe(() => stream.frames?.(), 0)) || 0,
      speaking: !!safe(() => stream.speaking?.(), false),
      round: Number(safe(() => stream.round?.(), 0)) || 0,
      ts: Date.now(),
    };
  }

  function reportChat() {
    const lines = safe(() => chat.recent?.(CHAT_LINES), []) || [];
    return {
      count: lines.length,
      last: lines.map((m) => `${m.name}: ${m.text}`),
      ts: Date.now(),
    };
  }

  function reportQueue() {
    const items = safe(() => playQueue?.toJSON?.(), []) || [];
    return {
      count: items.length,
      items: items.slice(0, 5),
      ts: Date.now(),
    };
  }

  function reportAll() {
    return {
      game: reportGame(),
      browser: reportBrowser(),
      stream: reportStream(),
      chat: reportChat(),
      queue: reportQueue(),
      ts: Date.now(),
    };
  }

  return { reportGame, reportBrowser, reportStream, reportChat, reportQueue, reportAll };
}
