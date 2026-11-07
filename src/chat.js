// Chat facade: Twitch over IRC-TLS, or Kick by watching the chat page in the browser.
// Pick with CHAT_HOST=kick|twitch; defaults to the streaming host.
import tls from 'node:tls';
import { log } from './log.js';
import { KickChat } from './chat-kick.js';

export class TwitchChat {
  constructor({ channel, oauth, onMessage }) {
    this.channel = (channel || '').toLowerCase().replace(/^#/, '');
    this.oauth = oauth;
    this.onMessage = onMessage;
    this.sock = null;
    this.backoff = 3000;
    this.nick = `justinfan${Math.floor(Math.random() * 90000) + 10000}`;
  }

  start() {
    if (!this.channel) { log('chat: TWITCH_CHANNEL empty — no chat input'); return this; }
    this.#connect();
    return this;
  }

  #connect() {
    this.sock = tls.connect({ host: 'irc.chat.twitch.tv', port: 6697, servername: 'irc.chat.twitch.tv' }, () => {
      log(`chat: connected to #${this.channel}`);
      this.backoff = 3000;
      this.sock.write('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
      if (this.oauth) this.sock.write(`PASS oauth:${this.oauth}\r\n`);
      this.sock.write(`NICK ${this.oauth ? 'hubie' : this.nick}\r\n`);
      this.sock.write(`JOIN #${this.channel}\r\n`);
    });

    let buffer = '';
    this.sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';
      for (const line of lines) this.#handle(line);
    });

    this.sock.on('error', (err) => log(`chat: ${err.message}`));
    this.sock.on('close', () => {
      log(`chat: disconnected, reconnect in ${this.backoff} ms`);
      setTimeout(() => this.#connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
    });
  }

  #handle(line) {
    if (!line) return;
    if (line.startsWith('PING')) { this.sock.write('PONG :tmi.twitch.tv\r\n'); return; }
    const msg = line.match(/^@([^ ]*) :(\w+)!\S+ PRIVMSG #\S+ :(.*)$/);
    if (!msg) return;
    const tags = Object.fromEntries(msg[1].split(';').map((kv) => kv.split('=')));
    const name = tags['display-name'] || msg[2];
    const text = msg[3].trim();
    if (!text || text.startsWith('!')) return;
    this.onMessage?.({ name, text: text.slice(0, 300) });
  }

  say(text) {
    if (!this.oauth || !this.sock) return false;
    this.sock.write(`PRIVMSG #${this.channel} :${text.replace(/[\r\n]/g, ' ')}\r\n`);
    return true;
  }

  stop() { try { this.sock?.end(); } catch { /* closed */ } }
}

export function createChat(cfg, { onMessage } = {}) {
  const host = (cfg.chatHost || cfg.streamHost || 'twitch').toLowerCase();
  if (host === 'kick') return new KickChat({ channel: cfg.kickChannel, onMessage });
  return new TwitchChat({ channel: cfg.twitchChannel, oauth: cfg.twitchOauth, onMessage });
}
