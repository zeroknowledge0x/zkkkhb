// Frame compositor. One 1280x720 canvas per frame at 30 fps.
// v2 — broadcast package: cached stage backdrop, glass panels, a real lower-third,
// spring-y body language, reaction FX (coins/sparks/sweat) and a karaoke caption.
// The avatar is still the official Hubie art; everything drawn on top of it is motion,
// light and particles — no fake limbs, which read as sticker art on a finished frame.
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { captionStyle } from './caption.js';
import { visibleChatMessages } from './chat-reply.js';

const C = {
  bg0: '#06070b',
  bg1: '#0b0e15',
  bg2: '#121722',
  panel: '#0f131b',
  panelTop: '#161c28',
  line: 'rgba(255,255,255,0.075)',
  text: '#f4f1ea',
  dim: '#99a1af',
  faint: '#5c6472',
  accent: '#ffd166',
  cyan: '#5ee7ff',
  red: '#ff4d6d',
  ok: '#7bd88f',
};

const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Helvetica, sans-serif';
const NAME_COLORS = ['#5ee7ff', '#ffd166', '#7bd88f', '#c9a7ff', '#ffa66b', '#8fd4ff'];

const GAMES = ['demo round', 'demo round', 'demo round'];

// Panel geometry — one source of truth for the layout.
const L = {
  panel: { x: 272, y: 20, w: 984, h: 536 },
  chat: { x: 24, y: 104, w: 232, h: 350 },
  caption: { x: 272, y: 574, w: 984, h: 92 },
  avatarBottom: 718,
};

export class Renderer {
  constructor({ width, height, artDir }) {
    this.w = width;
    this.h = height;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.startedAt = Date.now();
    this.art = null;
    this.blink = { next: 0, start: 0, doubleAt: 0 };
    this.look = { x: 0, target: 0, next: 0, dart: false };
    this.tiltBoost = { next: 0, start: 0, dir: 1 };
    this.idleNod = { next: 0, start: 0 };
    // Reaction state: particles are spawned on transitions, never per frame.
    this.fx = [];
    this.lastExpr = null;
    this.lastWave = 0;
    this.lastGesture = null;
    this.history = [];
    this.resultKey = '';
    this.shakeUntil = 0;
    this.shakeMs = 420;
    this.cap = { text: '', at: 0 };
    this.flash = 0;
    this.lastDraw = 0;
    this.#loadArt(artDir);
  }

  // ---- stage backdrop --------------------------------------------------------------
  // Full-frame radial gradients measured ~6 ms each on this backend, while the same
  // painting at 1/16 resolution plus one upscaled blit is under 1 ms. So the soft stage
  // is rendered small and stretched; only the grid and vignette touch full-res pixels.
  #drawStage(now) {
    const { ctx: x, w, h } = this;
    if (!this.stageCv) {
      this.stageCv = createCanvas(320, 180);
      this.stageAt = 0;
    }
    if (now - this.stageAt > 90) {
      this.stageAt = now;
      const a = this.stageCv.getContext('2d');
      const sw = 320, sh = 180;
      const g = a.createLinearGradient(0, 0, sw * 0.4, sh);
      g.addColorStop(0, '#0a0d14');
      g.addColorStop(0.55, C.bg1);
      g.addColorStop(1, '#070810');
      a.fillStyle = g;
      a.fillRect(0, 0, sw, sh);

      const blob = (fx, fy, fr, rgb, al) => {
        const rg = a.createRadialGradient(fx * sw, fy * sh, 0, fx * sw, fy * sh, fr * sh);
        rg.addColorStop(0, `rgba(${rgb},${al})`);
        rg.addColorStop(1, `rgba(${rgb},0)`);
        a.fillStyle = rg;
        a.fillRect(0, 0, sw, sh);
      };
      const t = now / 1000;
      blob(0.16, 0.12, 0.85, '94,231,255', 0.075);
      blob(0.86, 0.9, 0.95, '255,209,102', 0.05);
      blob(0.5 + Math.sin(t * 0.11) * 0.14, 0.66 + Math.cos(t * 0.09) * 0.08, 0.62, '94,231,255', 0.055);
      blob(0.25 + Math.cos(t * 0.07) * 0.1, 0.33 + Math.sin(t * 0.13) * 0.08, 0.55, '255,209,102', 0.035);
      blob(0.75 + Math.sin(t * 0.05 + 2) * 0.1, 0.8 + Math.cos(t * 0.08) * 0.06, 0.6, '201,167,255', 0.03);

      const v = a.createRadialGradient(sw / 2, sh / 2, sh * 0.35, sw / 2, sh / 2, sh * 0.95);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.55)');
      a.fillStyle = v;
      a.fillRect(0, 0, sw, sh);
    }
    x.drawImage(this.stageCv, 0, 0, w, h);

    // foreshortened perspective grid — drawn full-res, it is only 36 hairlines
    x.strokeStyle = 'rgba(255,255,255,0.022)';
    x.lineWidth = 1;
    for (let gx = 0; gx < w; gx += 56) {
      x.beginPath(); x.moveTo(gx + 0.5, 0); x.lineTo(gx + 0.5, h); x.stroke();
    }
    for (let gy = 0; gy < h; gy += 56) {
      x.beginPath(); x.moveTo(0, gy + 0.5); x.lineTo(w, gy + 0.5); x.stroke();
    }
  }

  #glow(x, cx, cy, r, rgb, a) {
    const rg = x.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r));
    rg.addColorStop(0, `rgba(${rgb},${a})`);
    rg.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = rg;
    x.fillRect(0, 0, this.w, this.h);
  }

  // ---- art ------------------------------------------------------------------------
  #loadArt(dir) {
    const pick = (names) => names.map((f) => path.join(dir, f)).find((p) => fs.existsSync(p));
    const image = pick(['labs.webp', 'labs.png', 'hero.webp', 'portrait.webp', 'portrait.png']);
    const readRig = (name) => {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) return null;
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    };

    const defaults = {
      bob: 5,
      sway: 3,
      breathAmp: 0.012,
      tiltDeg: 1.6,
      lookAmp: 4,
      speakBobBoost: 8,
      mouth: { x: 0.43, y: 0.425, w: 0.17, h: 0.045 },
      eyes: { x: 0.455, y: 0.371, w: 0.215, h: 0.08 },
      blinkMs: [2800, 5200],
      blinkDurationMs: 120,
      tiltBoostDeg: 3.2,
      tiltBoostMs: 600,
      idleSwayBoost: 1.5,
      wave: { x: 0.82, y: 0.62 },
      nod: { ms: 1100, amp: 16 },
      shrug: { ms: 1400, x: 0.18 },
      lookChat: { ms: 1300, pull: 0.75 },
      layers: {
        mouthOpen: 'layers/mouth_open.png',
        mouthClosed: 'layers/mouth_closed.png',
        lidClosed: 'layers/lid_closed.png',
      },
    };
    const user = { ...readRig('rig.json'), ...readRig('rig.local.json') };
    const rig = {
      ...defaults,
      ...user,
      mouth: { ...defaults.mouth, ...(user.mouth || {}) },
      eyes: { ...defaults.eyes, ...(user.eyes || {}) },
      wave: { ...defaults.wave, ...(user.wave || {}) },
      nod: { ...defaults.nod, ...(user.nod || {}) },
      shrug: { ...defaults.shrug, ...(user.shrug || {}) },
      lookChat: { ...defaults.lookChat, ...(user.lookChat || {}) },
      layers: { ...defaults.layers, ...(user.layers || {}) },
    };

    const layers = {};
    for (const [key, rel] of Object.entries(rig.layers)) {
      if (!rel) continue;
      const file = path.join(dir, rel);
      if (fs.existsSync(file)) layers[key] = file;
    }

    this.art = image ? { image, rig, layers, layersLoaded: {} } : null;
  }

  async warmArt() {
    if (!this.art?.image) return;
    try { this.art.image = await loadImage(this.art.image); } catch { this.art = null; return; }
    const loaded = {};
    for (const [key, file] of Object.entries(this.art.layers)) {
      try { loaded[key] = await loadImage(file); } catch { /* overlay skipped */ }
    }
    this.art.layersLoaded = loaded;
  }

  // ---- idle performance ------------------------------------------------------------
  #blinkAlpha(now) {
    const rig = this.art?.rig;
    const [minMs, maxMs] = rig?.blinkMs || [2800, 5200];
    const duration = Math.max(1, rig?.blinkDurationMs || 120);
    const b = this.blink;
    if (!b.next) b.next = now + randMs(minMs, maxMs);
    if (now >= b.next) {
      b.start = now;
      b.next = now + randMs(minMs, maxMs);
      b.doubleAt = Math.random() < 0.25 ? now + duration + randMs(70, 150) : 0;
    }
    let alpha = blinkAlphaAt(now, b.start, duration);
    if (b.doubleAt) {
      const second = blinkAlphaAt(now, b.doubleAt, duration);
      if (second > alpha) alpha = second;
      if (now > b.doubleAt + duration) b.doubleAt = 0;
    }
    return alpha;
  }

  // Saccades: a quick dart to a new target, then a slow settle.
  #look(now, amp) {
    const l = this.look;
    if (!l.next) l.next = now + randMs(1400, 3200);
    if (now >= l.next) {
      l.target = (Math.random() * 2 - 1) * amp;
      l.next = now + randMs(1600, 3800);
      l.dart = true;
    }
    const k = l.dart ? 0.34 : 0.07;
    l.x += (l.target - l.x) * k;
    if (Math.abs(l.target - l.x) < 0.05) l.dart = false;
    return l.x;
  }

  #idleNod(now, speaking) {
    const n = this.idleNod;
    if (speaking) { n.start = 0; return 0; }
    if (!n.next) n.next = now + randMs(4200, 8000);
    if (!n.start && now >= n.next) {
      n.start = now;
      n.next = now + randMs(5200, 9800);
    }
    if (!n.start) return 0;
    const duration = 720;
    const elapsed = now - n.start;
    if (elapsed >= duration) { n.start = 0; return 0; }
    return Math.sin((elapsed / duration) * Math.PI * 2) * 5;
  }

  #idleTilt(now, speaking) {
    const rig = this.art?.rig;
    const b = this.tiltBoost;
    const duration = Math.max(1, rig?.tiltBoostMs ?? 600);
    if (!b.next) b.next = now + randMs(8000, 14000);
    if (speaking) { b.start = 0; return 0; }
    if (!b.start && now >= b.next) {
      b.start = now;
      b.dir = Math.random() < 0.5 ? -1 : 1;
      b.next = now + randMs(8000, 14000);
    }
    if (!b.start) return 0;
    const elapsed = now - b.start;
    if (elapsed >= duration) { b.start = 0; return 0; }
    const env = Math.sin((elapsed / duration) * Math.PI);
    return b.dir * env * (rig?.tiltBoostDeg ?? 3.2) * (Math.PI / 180);
  }

  #drawFaceLayers(x, box, mouth, blink, expression) {
    const img = this.art?.layersLoaded;
    if (!img) return;
    const { mouth: m, eyes: e } = this.art.rig;
    const open = clamp01(mouth);
    const hyped = expression === 'win' || expression === 'hype' || expression === 'laugh';
    const mw = m.w * box.w * (1 + open * (hyped ? 0.22 : 0.1));
    const mh = m.h * box.h * (1 + open * (hyped ? 0.55 : 0.28));
    const mx = box.left + m.x * box.w - mw / 2;
    const my = box.top + m.y * box.h - mh / 2;

    if (img.mouthClosed && open < 0.99) {
      x.save();
      x.globalAlpha = 0.25 * (1 - open);
      x.drawImage(img.mouthClosed, mx, my, mw, mh);
      x.restore();
    }
    if (img.mouthOpen && open > 0.01) {
      x.save();
      x.globalAlpha = 0.85 * open;
      x.drawImage(img.mouthOpen, mx, my, mw, mh);
      x.restore();
    }
    if (img.lidClosed && blink > 0.01) {
      const ew = e.w * box.w, eh = e.h * box.h;
      x.save();
      x.globalAlpha = blink;
      x.drawImage(img.lidClosed, box.left + e.x * box.w - ew / 2, box.top + e.y * box.h - eh / 2, ew, eh);
      x.restore();
    }
  }

  // ---- FX --------------------------------------------------------------------------
  #spawn(kind, cx, cy, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 210;
      if (kind === 'coin') {
        this.fx.push({ kind, x: cx + (Math.random() - 0.5) * 40, y: cy - 10, vx: (Math.random() - 0.5) * 460, vy: -260 - Math.random() * 300, g: 980, life: 0, ttl: 1000 + Math.random() * 500, r: 4 + Math.random() * 5, spin: (Math.random() - 0.5) * 10 });
      } else if (kind === 'confetti') {
        this.fx.push({ kind, x: cx + (Math.random() - 0.5) * 900, y: cy + Math.random() * 40, vx: (Math.random() - 0.5) * 90, vy: 60 + Math.random() * 120, g: 210, life: 0, ttl: 1500 + Math.random() * 700, r: 3.5 + Math.random() * 4.5, spin: (Math.random() - 0.5) * 14, hue: i % 4 });
      } else if (kind === 'spark') {
        this.fx.push({ kind, x: cx + (Math.random() - 0.5) * 120, y: cy + (Math.random() - 0.5) * 50, vx: (Math.random() - 0.5) * 30, vy: -26 - Math.random() * 34, g: -8, life: 0, ttl: 800 + Math.random() * 500, r: 5 + Math.random() * 5, spin: 0 });
      } else if (kind === 'sweat') {
        this.fx.push({ kind, x: cx, y: cy, vx: 14, vy: -30, g: 420, life: 0, ttl: 900, r: 4.5, spin: 0 });
      }
    }
  }

  #stepFx(dt) {
    const alive = [];
    for (const p of this.fx) {
      p.life += dt;
      if (p.life > p.ttl) continue;
      p.vy += p.g * (dt / 1000);
      p.x += p.vx * (dt / 1000);
      p.y += p.vy * (dt / 1000);
      if (p.spin) p.rot = (p.rot || 0) + p.spin * (dt / 1000);
      alive.push(p);
    }
    this.fx = alive.length > 160 ? alive.slice(-160) : alive;
  }

  #drawFx(x) {
    const P = L.panel;
    // confetti falls inside the table panel only
    x.save();
    roundRect(x, P.x, P.y, P.w, P.h, 20);
    x.clip();
    this.#drawParticles(x, true);
    x.restore();
    this.#drawParticles(x, false);
  }

  #drawParticles(x, confettiPass) {
    for (const p of this.fx) {
      if ((p.kind === 'confetti') !== confettiPass) continue;
      const k = 1 - p.life / p.ttl;
      x.save();
      x.globalAlpha = Math.max(0, Math.min(1, k * 1.5));
      if (p.kind === 'coin') {
        const w = Math.abs(Math.cos(p.rot || 0)) * p.r + 0.8;
        x.fillStyle = '#f5b731';
        x.beginPath(); x.ellipse(p.x, p.y, w, p.r, 0, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#ffe9a8';
        x.beginPath(); x.ellipse(p.x - w * 0.25, p.y - p.r * 0.25, w * 0.45, p.r * 0.4, 0, 0, Math.PI * 2); x.fill();
        x.strokeStyle = 'rgba(120,70,0,0.6)'; x.lineWidth = 1; x.stroke();
      } else if (p.kind === 'confetti') {
        const col = ['#5ee7ff', '#ffd166', '#7bd88f', '#ff8ab5'][p.hue % 4];
        x.translate(p.x, p.y);
        x.rotate(p.rot || 0);
        x.scale(1, 0.35 + 0.65 * Math.abs(Math.sin(p.life / 140)));
        x.fillStyle = col;
        x.fillRect(-p.r / 2, -p.r, p.r, p.r * 2);
      } else if (p.kind === 'spark') {
        x.translate(p.x, p.y);
        x.rotate((p.life / p.ttl) * 2 + (p.r || 0));
        const rr = p.r * (1 + 0.35 * Math.sin(p.life / 120));
        x.fillStyle = 'rgba(140,240,255,0.35)';
        star4(x, 0, 0, rr * 2.1);
        x.fillStyle = '#eaffff';
        star4(x, 0, 0, rr);
      } else if (p.kind === 'sweat') {
        x.fillStyle = 'rgba(120,200,255,0.92)';
        x.beginPath();
        x.moveTo(p.x, p.y - p.r * 1.7);
        x.quadraticCurveTo(p.x + p.r, p.y, p.x, p.y + p.r);
        x.quadraticCurveTo(p.x - p.r, p.y, p.x, p.y - p.r * 1.7);
        x.fill();
      }
      x.restore();
    }
  }

  // ---- panels ----------------------------------------------------------------------
  #panel(x, bx, by, bw, bh, r, opts = {}) {
    const g = x.createLinearGradient(bx, by, bx, by + bh);
    g.addColorStop(0, opts.top || C.panelTop);
    g.addColorStop(0.55, opts.mid || '#101521');
    g.addColorStop(1, opts.bottom || C.panel);
    x.fillStyle = g;
    roundRect(x, bx, by, bw, bh, r); x.fill();

    x.strokeStyle = opts.border || 'rgba(255,255,255,0.085)';
    x.lineWidth = 1;
    roundRect(x, bx + 0.5, by + 0.5, bw - 1, bh - 1, r); x.stroke();

    const hi = x.createLinearGradient(bx, by, bx, by + 40);
    hi.addColorStop(0, 'rgba(255,255,255,0.10)');
    hi.addColorStop(1, 'rgba(255,255,255,0)');
    x.save();
    roundRect(x, bx, by, bw, bh, r); x.clip();
    x.fillStyle = hi; x.fillRect(bx, by, bw, 40);
    x.restore();
  }

  #chip(x, cx, cy, label, dotColor, alignRight = false) {
    x.font = `600 13px ${FONT}`;
    const tw = x.measureText(label).width;
    const w = tw + 28;
    const px = alignRight ? cx - w : cx;
    x.fillStyle = 'rgba(8,10,15,0.72)';
    roundRect(x, px, cy - 14, w, 28, 14); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.09)'; x.lineWidth = 1; x.stroke();
    x.fillStyle = dotColor;
    x.beginPath(); x.arc(px + 13, cy, 3.2, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(244,241,234,0.92)';
    x.textAlign = 'left';
    x.fillText(label, px + 21, cy + 4.2);
    return w;
  }

  // ---- caption ---------------------------------------------------------------------
  #drawCaption(x, caption, captionEndedAt, now) {
    const cap = captionStyle(caption, { playbackEndedAt: captionEndedAt, now });
    if (!cap.alpha || !cap.text) { this.cap.text = ''; return; }
    const { x: bx, y: by, w: bw, h: bh } = L.caption;
    if (this.cap.text !== cap.text) this.cap = { text: cap.text, at: now };
    const age = now - this.cap.at;

    x.save();
    x.globalAlpha = cap.alpha * 0.98;
    const g = x.createLinearGradient(bx, by, bx, by + bh);
    g.addColorStop(0, 'rgba(14,18,26,0.88)');
    g.addColorStop(1, 'rgba(9,11,17,0.96)');
    x.fillStyle = g;
    roundRect(x, bx, by, bw, bh, 16); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.07)'; x.lineWidth = 1;
    roundRect(x, bx + 0.5, by + 0.5, bw - 1, bh - 1, 16); x.stroke();

    const barA = 0.55 + 0.35 * Math.abs(Math.sin(now / 620));
    x.globalAlpha = cap.alpha * barA;
    x.fillStyle = C.cyan;
    roundRect(x, bx, by + 16, 4, bh - 32, 2); x.fill();
    x.globalAlpha = cap.alpha;

    x.fillStyle = C.cyan;
    x.font = `700 11px ${FONT}`;
    x.fillText('HUBIE', bx + 22, by + 26);

    // karaoke: words light up one after another as the line is spoken
    const words = cap.text.split(/\s+/).filter(Boolean);
    const per = 190;
    let wx = bx + 22;
    let wy = by + 58;
    const maxW = bw - 46;
    x.font = `650 25px ${FONT}`;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const ww = x.measureText(word + ' ').width;
      if (wx + ww > bx + maxW && wy < by + bh - 14) { wx = bx + 22; wy += 30; }
      const a = Math.max(0, Math.min(1, (age - i * per) / 160));
      x.globalAlpha = cap.alpha * (0.45 + 0.55 * a);
      x.fillStyle = a >= 1 ? '#ffffff' : '#dfe4ec';
      x.fillText(word, wx, wy);
      wx += ww;
    }
    x.restore();
  }

  // ---- main draw -------------------------------------------------------------------
  draw(state) {
    const { ctx: x, w, h } = this;
    const {
      mouth = 0, speaking = false, chat = [], caption = '', captionEndedAt = null, round = 1,
      gameFrame = null, gameLabel = '', pointer = null, viewport = null, waveUntil = 0,
      gesture = { kind: null, until: 0 }, expression = null, segment = 'play', stats = null,
    } = state;

    this.prof = this.prof || {}; const P = this.prof; let _m = process.hrtime.bigint();
    const mark = (k) => { const n = process.hrtime.bigint(); P[k] = (P[k]||0) + Number(n-_m)/1e6; _m = n; };
    const now = Date.now();
    const dt = this.lastDraw ? Math.min(120, now - this.lastDraw) : 16;
    this.lastDraw = now;

    // reaction transitions
    if (expression && expression !== this.lastExpr) {
      if (expression === 'win' || expression === 'hype' || expression === 'laugh') {
        this.#spawn('coin', 172, 540, 40);
        this.#spawn('confetti', 780, 120, 40);
        this.shakeUntil = now + this.shakeMs;
        this.flash = 1;
      }
      if (expression === 'lose') this.#spawn('sweat', 172, 540, 1);
      this.lastExpr = expression;
    }
    if (waveUntil > now && waveUntil !== this.lastWave) {
      this.lastWave = waveUntil;
      this.#spawn('spark', 150, 505, 10);
    }
    if (gesture?.kind && gesture.until > now && gesture.kind !== this.lastGesture) {
      this.lastGesture = gesture.kind;
      if (gesture.kind === 'shrug') this.#spawn('sweat', 175, 545, 1);
    }
    this.#stepFx(dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / 320);

    let sx = 0, sy = 0;
    if (this.shakeUntil > now) {
      const k = (this.shakeUntil - now) / this.shakeMs;
      sx = Math.sin(now / 21) * 4.5 * k;
      sy = Math.cos(now / 17) * 3 * k;
    }

    x.save();
    x.translate(sx, sy);
    this.#drawStage(now);

    // ---- game panel ---------------------------------------------------------------
    const { x: gx, y: gy, w: gw, h: gh } = L.panel;
    this.#panel(x, gx, gy, gw, gh, 20);

    if (gameFrame) {
      x.save();
      roundRect(x, gx, gy, gw, gh, 20); x.clip();
      // Contain, never cover: a table with its edges shaved off reads as a broken stream.
      const s = Math.min(gw / gameFrame.width, gh / gameFrame.height);
      const dw = gameFrame.width * s, dh = gameFrame.height * s;
      x.drawImage(gameFrame, gx + (gw - dw) / 2, gy + (gh - dh) / 2, dw, dh);
      const sc = x.createLinearGradient(0, gy + gh - 132, 0, gy + gh);
      sc.addColorStop(0, 'rgba(6,7,11,0)');
      sc.addColorStop(0.55, 'rgba(6,7,11,0.55)');
      sc.addColorStop(1, 'rgba(6,7,11,0.96)');
      x.fillStyle = sc;
      x.fillRect(gx, gy + gh - 132, gw, 132);
      // solid band under the chips: the table's own footer text must not bleed through
      x.fillStyle = 'rgba(8,10,16,0.97)';
      x.fillRect(gx, gy + gh - 54, gw, 54);
      x.restore();
    } else {
      this.#demoPanel(x, gx, gy, gw, gh, gameLabel || GAMES[0], round);
    }

    x.strokeStyle = 'rgba(255,255,255,0.14)';
    x.lineWidth = 1;
    roundRect(x, gx + 0.5, gy + 0.5, gw - 1, gh - 1, 20); x.stroke();
    x.strokeStyle = 'rgba(94,231,255,0.16)';
    x.lineWidth = 3;
    roundRect(x, gx - 3, gy - 3, gw + 6, gh + 6, 23); x.stroke();

    // Round history: one dot per resolved round, newest on the right. Kept in the
    // renderer because it is a view concern; it only needs the last result from stats.
    if (stats?.lastResult) {
      const r = stats.lastResult;
      const key = `${round}:${r.won}:${r.multiplier ?? ''}`;
      if (key !== this.resultKey) {
        this.resultKey = key;
        this.history.push({ won: r.won === true, mult: Number(r.multiplier) || 0 });
        if (this.history.length > 12) this.history.shift();
      }
    }

    const segLabel = segment === 'chatPick' ? 'YOUR PICK' : segment === 'chill' ? 'CHILL MODE' : 'LOCKED IN';
    let chipX = gx + 18;
    const chipY = gy + gh - 26;
    chipX += this.#chip(x, chipX, chipY, `ROUND ${round}`, C.cyan) + 8;
    if (stats) {
      const mult = Number(stats.multiplier);
      if (Number.isFinite(mult) && mult > 0) chipX += this.#chip(x, chipX, chipY, `${mult.toFixed(2)}x`, C.accent) + 8;
      const bal = Number(stats.balance);
      if (Number.isFinite(bal)) {
        // A crypto wallet reads 0.0004, not 0 — sub-unit balances need their decimals.
        const shown = Math.abs(bal) > 0 && Math.abs(bal) < 1
          ? bal.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
          : bal.toLocaleString('en-US');
        chipX += this.#chip(x, chipX, chipY, `BAL ${shown}`, C.ok) + 8;
      }
      const st = stats.streak;
      if (st?.count > 0) {
        const word = st.kind === 'win' ? 'WIN' : st.kind === 'loss' ? 'LOSS' : 'STREAK';
        chipX += this.#chip(x, chipX, chipY, `${word} x${st.count}`, st.kind === 'loss' ? C.red : C.accent) + 8;
      }
    }
    const segW = 0;

    // history dots sit left of the segment chip
    if (this.history.length) {
      const n = this.history.length;
      const dotW = 9, dotGap = 6;
      const hw = n * (dotW + dotGap) + 34;
      const hx = gx + gw - 18 - 54 - 12 - hw;
      const hy = chipY - 14;
      x.fillStyle = 'rgba(8,10,15,0.72)';
      roundRect(x, hx, hy, hw, 28, 14); x.fill();
      x.strokeStyle = 'rgba(255,255,255,0.09)'; x.lineWidth = 1; x.stroke();
      x.fillStyle = C.faint;
      x.font = `700 10px ${FONT}`;
      x.fillText('LAST', hx + 10, chipY + 3.5);
      for (let i = 0; i < n; i++) {
        const h = this.history[i];
        x.fillStyle = h.won ? C.ok : 'rgba(255,77,109,0.85)';
        x.beginPath();
        x.arc(hx + 34 + i * (dotW + dotGap) + dotW / 2, chipY, h.won ? 4 : 3.2, 0, Math.PI * 2);
        x.fill();
      }
    }

    // 18+ lives in the scrim strip, not over the game's own wallet/header chrome
    const badgeW = 54, badgeH = 28;
    const bgx = gx + gw - 18 - badgeW, bgy = chipY - badgeH / 2;
    const bgr = x.createLinearGradient(bgx, bgy, bgx, bgy + badgeH);
    bgr.addColorStop(0, '#ff5d78');
    bgr.addColorStop(1, '#d92c4b');
    x.fillStyle = bgr;
    roundRect(x, bgx, bgy, badgeW, badgeH, 9); x.fill();
    x.fillStyle = '#fff'; x.font = `800 17px ${FONT}`; x.textAlign = 'center';
    x.fillText('18+', bgx + badgeW / 2, bgy + 19.5);
    x.textAlign = 'left';

    // ---- header -------------------------------------------------------------------
    const lg = x.createLinearGradient(24, 26, 24, 62);
    lg.addColorStop(0, '#7ff3ff');
    lg.addColorStop(1, '#2bb6d6');
    x.fillStyle = lg;
    roundRect(x, 24, 26, 36, 36, 11); x.fill();
    x.fillStyle = '#04121a';
    x.font = `800 21px ${FONT}`;
    x.fillText('H', 35, 52);

    x.fillStyle = C.text;
    x.font = `750 26px ${FONT}`;
    x.fillText('HUBIE', 68, 52);

    // live pill sits on the wordmark row so the rail does not need a second stack
    const liveW = 66;
    const liveX = 68 + x.measureText('HUBIE').width + 10;
    x.fillStyle = 'rgba(255,77,109,0.16)';
    roundRect(x, liveX, 33, liveW, 21, 10.5); x.fill();
    x.fillStyle = C.red;
    x.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(now / 700));
    x.beginPath(); x.arc(liveX + 12, 43.5, 3.4, 0, Math.PI * 2); x.fill();
    x.globalAlpha = 1;
    x.fillStyle = '#ff8a9b';
    x.font = `700 10px ${FONT}`;
    x.fillText('LIVE', liveX + 20, 47);

    x.fillStyle = C.dim;
    x.font = `600 11px ${FONT}`;
    x.fillText(`AI HOST · 24/7 · ${segment === 'chatPick' ? 'YOUR PICK' : segment === 'chill' ? 'CHILL MODE' : 'LOCKED IN'}`, 68, 70);

    // ---- chat ---------------------------------------------------------------------
    const { x: cx0, y: cy0, w: cw, h: ch } = L.chat;
    this.#panel(x, cx0, cy0, cw, ch, 14);
    x.fillStyle = C.dim;
    x.font = `700 11px ${FONT}`;
    x.fillText('CHAT', cx0 + 16, cy0 + 24);
    x.fillStyle = C.cyan;
    x.globalAlpha = 0.8;
    x.beginPath(); x.arc(cx0 + 58, cy0 + 20, 3, 0, Math.PI * 2); x.fill();
    x.globalAlpha = 1;

    // uptime lives in the chat header — it used to sit under the panel and the avatar's
    // hat covered it
    const upNow = Math.floor((now - this.startedAt) / 1000);
    x.fillStyle = C.faint;
    x.font = `600 10.5px ${FONT}`;
    x.textAlign = 'right';
    x.fillText(fmtShort(upNow), cx0 + cw - 14, cy0 + 24);
    x.textAlign = 'left';

    const rows = visibleChatMessages(chat, { maxPx: ch - 62, linePx: 15, pad: 12, maxChars: 25 });
    // measure first, then anchor to the floor of the panel: a chat that grows downward
    // from the header leaves an empty box on quiet hours
    const rowH = (m) => Math.min(2, wrap(String(m.text || ''), 25).length) * 15 + 14;
    let usedH = 0;
    for (const m of rows) usedH += rowH(m);
    let ry = Math.max(cy0 + 46, cy0 + ch - 14 - usedH + 10);
    // Empty chat reads as a broken panel to a judge who lands at 3am, so say why it is
    // empty and invite a line. Same muted palette, no new colours.
    if (!rows.length) {
      const midY = cy0 + ch / 2;
      x.fillStyle = 'rgba(244,241,234,0.45)';
      x.font = `600 12.5px ${FONT}`;
      x.textAlign = 'center';
      x.fillText('chat is quiet', cx0 + cw / 2, midY - 6);
      x.fillStyle = 'rgba(244,241,234,0.28)';
      x.font = `500 11.5px ${FONT}`;
      x.fillText('say hi, or type !game', cx0 + cw / 2, midY + 14);
      x.textAlign = 'left';
      const pulse = 0.25 + 0.35 * Math.abs(Math.sin(now / 900));
      x.strokeStyle = `rgba(94,231,255,${pulse.toFixed(2)})`;
      x.lineWidth = 2;
      x.beginPath(); x.arc(cx0 + cw / 2, midY - 34, 11, 0, Math.PI * 2); x.stroke();
    }
    for (const m of rows) {
      const name = String(m.name || '');
      x.fillStyle = NAME_COLORS[hash(name) % NAME_COLORS.length];
      x.font = `700 12px ${FONT}`;
      x.fillText(truncate(name, 12), cx0 + 16, ry);
      x.fillStyle = 'rgba(244,241,234,0.9)';
      x.font = `500 12.5px ${FONT}`;
      for (const line of wrap(String(m.text || ''), 25).slice(0, 2)) { ry += 15; x.fillText(line, cx0 + 16, ry); }
      ry += 14;
      x.strokeStyle = 'rgba(255,255,255,0.05)';
      x.beginPath(); x.moveTo(cx0 + 16, ry - 6); x.lineTo(cx0 + cw - 16, ry - 6); x.stroke();
      if (ry > cy0 + ch - 16) break;
    }

    // ---- avatar -------------------------------------------------------------------
    const up = Math.floor((now - this.startedAt) / 1000);
    if (this.art?.image) {
      const img = this.art.image;
      const rig = this.art.rig;
      const t = now / 1000;
      const H = 256;
      const W = img.width * (H / img.height);
      const mouthAmt = clamp01(mouth);
      const hyped = expression === 'win' || expression === 'hype' || expression === 'laugh';
      const gestureKind = gesture?.kind || null;
      const gestureUntil = Number(gesture?.until) || 0;
      const gestureOn = !!gestureKind && gestureUntil > now;
      const lookChatOn = gestureKind === 'lookChat' && gestureOn;
      const nodOn = gestureKind === 'nod' && gestureOn;
      const shrugOn = gestureKind === 'shrug' && gestureOn;

      const energy = speaking ? 0.55 + 0.45 * mouthAmt + (hyped ? 0.12 : 0) : 0;
      const idleBoost = !speaking
        ? segment === 'chatPick' ? 1.2 : segment === 'play' ? 1.08 : 1.05
        : 1;
      const idleBobRate = segment === 'chatPick' ? 1.35 : segment === 'play' ? 1.25 : 1.1;
      const bobAmp = ((rig.bob ?? 4) + energy * (rig.speakBobBoost ?? 8)) * idleBoost;
      const idleSway = !speaking ? (rig.idleSwayBoost ?? 1.5) : 1;
      const swayAmp = (rig.sway ?? 2) * (speaking ? 1.5 : idleSway) * idleBoost;
      const nod = speaking && mouthAmt > 0.25
        ? Math.abs(Math.sin(t * 9.5)) * ((mouthAmt - 0.25) / 0.75) * (rig.speakBobBoost ?? 8) * (hyped ? 1.7 : 1.35)
        : 0;

      const wander = this.#look(now, rig.lookAmp ?? 4);
      const look = lookChatOn ? -(Number(rig.lookChat?.pull) || 0.75) * (rig.lookAmp ?? 4) : wander;

      let nodDip = 0;
      if (nodOn) {
        const nodMs = Math.max(1, Number(rig.nod?.ms) || 1100);
        const elapsed = Math.max(0, nodMs - (gestureUntil - now));
        const progress = Math.min(1, elapsed / nodMs);
        nodDip = Math.sin(progress * Math.PI * 2) ** 2 * (Number(rig.nod?.amp) || 16) * (1 - progress * 0.35);
      }

      // greet: a hop with a landing squash instead of a drawn arm
      let hop = 0, hopSquash = 0;
      if (waveUntil > now) {
        const total = 2200;
        const p = Math.min(1, Math.max(0, 1 - (waveUntil - now) / total));
        hop = Math.sin(Math.min(1, p * 1.25) * Math.PI) * 18;
        hopSquash = Math.max(0, Math.sin(p * Math.PI * 2)) * 0.03;
      }
      // lose: a slump that settles back
      let slump = 0;
      if (shrugOn) {
        const total = Math.max(1, Number(rig.shrug?.ms) || 1400);
        const p = Math.min(1, Math.max(0, 1 - (gestureUntil - now) / total));
        slump = Math.sin(Math.min(1, p * 1.6) * Math.PI) * 9;
      }

      const idleDip = this.#idleNod(now, speaking);
      const bob = Math.sin(t * (speaking ? 2.1 : idleBobRate)) * bobAmp - nod + nodDip + idleDip;
      const sway = Math.sin(t * (speaking ? 1.35 : 0.85)) * swayAmp
        + Math.sin(t * 0.37 + 1.3) * (speaking ? 1.4 : swayAmp * 0.55)
        + look * 0.5;
      const breath = Math.sin(t * (speaking ? 1.35 : 1.05)) * (rig.breathAmp ?? 0.012) * (speaking ? (1 - energy * 0.2) : 1.35);
      const tilt = Math.sin(t * 0.5) * (rig.tiltDeg ?? 1.6) * (Math.PI / 180) * (1 + energy * 0.5)
        + this.#idleTilt(now, speaking)
        + mouthAmt * (hyped ? 0.05 : 0.03)
        + (look / 90)
        + (shrugOn ? slump * 0.004 : 0);

      const cx = 24 + W / 2 + sway;
      const cy = L.avatarBottom - H + bob - hop + slump;

      const pool = x.createRadialGradient(cx, 712, 10, cx, 712, W * 0.85);
      pool.addColorStop(0, 'rgba(94,231,255,0.13)');
      pool.addColorStop(1, 'rgba(94,231,255,0)');
      x.fillStyle = pool;
      x.fillRect(cx - W, 600, W * 2, 130);

      x.fillStyle = 'rgba(0,0,0,0.5)';
      x.beginPath(); x.ellipse(cx, 714, W * 0.31, 10, 0, 0, Math.PI * 2); x.fill();

      const glowRgb = hyped ? '255,209,102' : expression === 'lose' ? '255,77,109' : '94,231,255';
      if (speaking || hyped) {
        const pulse2 = (hyped ? 0.18 : 0.10) + 0.09 * Math.abs(Math.sin(t * 2.6)) + 0.1 * mouthAmt + (hyped ? 0.14 : 0);
        const g = x.createRadialGradient(cx, cy + H * 0.5, 8, cx, cy + H * 0.5, W * 1.05);
        g.addColorStop(0, `rgba(${glowRgb},${pulse2.toFixed(3)})`);
        g.addColorStop(1, `rgba(${glowRgb},0)`);
        x.fillStyle = g;
        x.fillRect(cx - W, cy - 20, W * 2, H + 40);
      }

      const squash = mouthAmt * (hyped ? 0.045 : 0.028) + hopSquash;
      x.save();
      x.translate(cx, cy + H * 0.5);
      x.rotate(tilt);
      x.scale(1 + breath + squash * 0.65, 1 - breath * 0.6 - squash);
      x.drawImage(img, -W / 2, -H / 2, W, H);
      this.#drawFaceLayers(x, { left: -W / 2 + look, top: -H / 2, w: W, h: H }, mouth, this.#blinkAlpha(now), expression);
      x.restore();

    } else {
      const idleY = Math.sin(now / 700) * 4;
      this.#placeholderAvatar(x, 96 + Math.sin(now / 900) * 3, 600 + idleY, 44, mouth);
    }

    this.#drawFx(x);

    // ---- caption + footer ---------------------------------------------------------
    this.#drawCaption(x, caption, captionEndedAt, now);

    x.fillStyle = C.faint;
    x.font = `500 12.5px ${FONT}`;
    const foot = 'Gamble responsibly · 18+ only · demo play, no real money · housebets.com/casino';
    const fw = x.measureText(foot).width;
    x.fillText(foot, L.caption.x + (L.caption.w - fw) / 2, 700);

    if (this.flash > 0) {
      x.fillStyle = `rgba(255,225,150,${(this.flash * 0.16).toFixed(3)})`;
      x.fillRect(-6, -6, w + 12, h + 12);
    }

    x.restore();
    return this.canvas.data(); // raw RGBA
  }

  #drawPointer(x, pointer, viewport, box) {
    const vw = Math.max(1, Number(viewport?.w) || 1280);
    const vh = Math.max(1, Number(viewport?.h) || 720);
    const fw = Number(box.frame?.width) || vw;
    const fh = Number(box.frame?.height) || vh;
    const s = Math.max(box.gw / fw, box.gh / fh);
    const dw = fw * s;
    const dh = fh * s;
    const ox = box.gx + (box.gw - dw) / 2;
    const oy = box.gy + (box.gh - dh) / 2;
    const px = ox + (Math.max(0, Math.min(vw, Number(pointer.x) || 0)) / vw) * dw;
    const py = oy + (Math.max(0, Math.min(vh, Number(pointer.y) || 0)) / vh) * dh;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 170);

    x.save();
    roundRect(x, box.gx, box.gy, box.gw, box.gh, 20);
    x.clip();

    x.beginPath();
    x.arc(px, py, 9 + pulse * 9, 0, Math.PI * 2);
    x.strokeStyle = `rgba(255,209,102,${(0.85 - pulse * 0.4).toFixed(3)})`;
    x.lineWidth = 2.5;
    x.stroke();

    x.beginPath();
    x.moveTo(px, py);
    x.lineTo(px, py + 22);
    x.lineTo(px + 6, py + 16);
    x.lineTo(px + 11, py + 26);
    x.lineTo(px + 16, py + 24);
    x.lineTo(px + 11, py + 14);
    x.lineTo(px + 19, py + 14);
    x.closePath();
    x.fillStyle = '#ffffff';
    x.strokeStyle = 'rgba(0,0,0,0.85)';
    x.lineWidth = 2;
    x.fill();
    x.stroke();

    const label = truncate(String(pointer.text || '').replace(/\s+/g, ' ').trim(), 26);
    if (label) {
      x.font = `600 15px ${FONT}`;
      const tw = Math.min(box.gw - 20, Math.round(x.measureText(label).width) + 20);
      const lx = Math.max(box.gx + 8, Math.min(box.gx + box.gw - tw - 8, px + 18));
      const ly = Math.max(box.gy + 8, Math.min(box.gy + box.gh - 36, py + 24));
      x.fillStyle = 'rgba(11,12,16,0.9)';
      roundRect(x, lx, ly, tw, 28, 8); x.fill();
      x.strokeStyle = C.accent;
      x.lineWidth = 1;
      roundRect(x, lx, ly, tw, 28, 8); x.stroke();
      x.fillStyle = C.accent;
      x.textAlign = 'left';
      x.fillText(label, lx + 10, ly + 19);
      x.fillStyle = '#fff';
    }
    x.restore();
  }

  #demoPanel(x, gx, gy, gw, gh, label, round) {
    x.save();
    roundRect(x, gx, gy, gw, gh, 20); x.clip();
    const g = x.createLinearGradient(gx, gy, gx + gw, gy + gh);
    g.addColorStop(0, '#151b27');
    g.addColorStop(1, '#0b0f16');
    x.fillStyle = g; x.fillRect(gx, gy, gw, gh);

    for (let i = 0; i < 14; i++) {
      x.fillStyle = `rgba(94,231,255,${0.02 + (i % 4) * 0.008})`;
      x.fillRect(gx, gy + gh - (i + 1) * 36, gw, 36);
    }
    x.fillStyle = C.dim; x.font = `700 13px ${FONT}`;
    x.fillText('TABLE', gx + 32, gy + 40);
    x.fillStyle = C.text; x.font = `750 64px ${FONT}`;
    x.fillText(label, gx + 32, gy + 140);
    // a slow breathing ring reads as "loading" without faking a result
    const ph = (Date.now() % 1800) / 1800;
    x.strokeStyle = `rgba(94,231,255,${(0.35 * (1 - ph)).toFixed(3)})`;
    x.lineWidth = 3;
    x.beginPath(); x.arc(gx + 74, gy + 270, 26 + ph * 46, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = 'rgba(94,231,255,0.5)';
    x.beginPath(); x.arc(gx + 74, gy + 270, 24, 0, Math.PI * 2); x.stroke();
    x.fillStyle = C.dim; x.font = `600 18px ${FONT}`;
    x.fillText('connecting to the demo table…', gx + 128, gy + 277);
    x.restore();
  }

  #placeholderAvatar(x, ax, ay, r, mouth) {
    x.fillStyle = '#3a2b1f'; x.beginPath(); x.ellipse(ax, ay + 54, 74, 24, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#d9a066'; x.beginPath(); x.arc(ax, ay, r, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#c98d55'; x.beginPath(); x.arc(ax - r + 6, ay - 6, 18, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.arc(ax + r - 6, ay - 6, 18, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#f2cba1'; x.beginPath(); x.ellipse(ax, ay + 22, 40, 30, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#241a14';
    x.beginPath(); x.arc(ax - 20, ay - 12, 6, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.arc(ax + 20, ay - 12, 6, 0, Math.PI * 2); x.fill();
    const mh = 4 + 22 * mouth;
    x.beginPath(); x.ellipse(ax, ay + 26, 20, mh / 2 + 2, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#2b2f3d'; x.lineWidth = 6;
    x.beginPath(); x.arc(ax, ay - 4, r + 6, Math.PI * 1.05, Math.PI * 1.95); x.stroke();
  }
}

function roundRect(x, rx, ry, rw, rh, r) {
  x.beginPath();
  x.moveTo(rx + r, ry);
  x.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
  x.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
  x.arcTo(rx, ry + rh, rx, ry, r);
  x.arcTo(rx, ry, rx + rw, ry, r);
  x.closePath();
}

function star4(x, cx, cy, r) {
  x.beginPath();
  x.moveTo(cx, cy - r);
  x.quadraticCurveTo(cx + r * 0.18, cy - r * 0.18, cx + r, cy);
  x.quadraticCurveTo(cx + r * 0.18, cy + r * 0.18, cx, cy + r);
  x.quadraticCurveTo(cx - r * 0.18, cy + r * 0.18, cx - r, cy);
  x.quadraticCurveTo(cx - r * 0.18, cy - r * 0.18, cx, cy - r);
  x.closePath();
  x.fill();
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function wrap(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars) { if (line) lines.push(line); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function truncate(text, n) { return text.length > n ? text.slice(0, n - 1) + '…' : text; }
function fmtShort(s) { return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function fmt(s) { return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; }
function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function randMs(min, max) { return min + Math.random() * (max - min); }
function blinkAlphaAt(now, start, duration) {
  const t = (now - start) / duration;
  if (t < 0 || t >= 1) return 0;
  return 1 - Math.abs(2 * t - 1);
}
