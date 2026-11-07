// Grab the live game page from the agent's own Chrome (CDP :9222) and render one
// overlay frame on top of it, so the preview matches the stream exactly.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { loadEnv, cfg } from '../src/config.js';
import { Renderer } from '../src/render.js';

loadEnv();
const c = cfg();

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => /housebets/i.test(p.url())) || pages[0];
console.log('page:', page.url());
const shot = await page.screenshot({ type: 'png' });
browser.disconnect();

fs.mkdirSync('logs/live', { recursive: true });
fs.writeFileSync('logs/live/game.png', shot);
console.log('game shot bytes', shot.length);
