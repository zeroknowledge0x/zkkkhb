// One shared Chrome/Edge instance for both jobs: game capture and Kick chat.
// Launching twice doubles memory for no gain on a small RDP.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from './config.js';
import { log } from './log.js';

let browser = null;
let launching = null;

export async function getBrowser() {
  if (browser && browser.connected) return browser;
  if (launching) return launching;
  launching = (async () => {
    const exe = chromePath();
    if (!exe) {
      log('browser: no chrome/edge found (set CHROME_PATH) — capture and Kick chat disabled');
      return null;
    }
    try {
      const puppeteer = (await import('puppeteer-core')).default;
      // fileURLToPath: Windows needs C:\... not /C:/... from URL.pathname
      const profile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'chrome-profile');
      const headed = process.env.HUBIE_HEADED !== '0';
      browser = await puppeteer.launch({
        executablePath: exe,
        headless: headed ? false : 'new',
        userDataDir: profile,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--use-gl=swiftshader',
          '--mute-audio',
          '--window-size=1280,697',
          '--disable-blink-features=AutomationControlled',
          // RDP/session-0 friendly: avoid GPU sandbox crashes
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--remote-debugging-port=9222',
          '--hide-crash-restore-bubble',
          '--disable-session-crashed-bubble',
        ],
      });
      browser.on('disconnected', () => { browser = null; });
      log(`browser: launched ${exe} (headless=${headed ? 'false' : 'new'})`);
      return browser;
    } catch (err) {
      log(`browser: launch failed: ${err.message}`);
      return null;
    }
  })();
  try { return await launching; } finally { launching = null; }
}

export async function closeBrowser() {
  try { await browser?.close(); } catch { /* already closed */ }
  browser = null;
}

export function browserStatus() {
  const launched = !!(browser && browser.connected);
  const headed = process.env.HUBIE_HEADED !== '0';
  return {
    launched,
    headed,
    hint: launched ? (headed ? 'headed' : 'headless') : 'not launched',
  };
}
