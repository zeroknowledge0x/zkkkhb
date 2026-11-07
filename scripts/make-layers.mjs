// Generate OUR animation overlays for Hubie.
// These are drawn shapes (not crops of Housebets' art), so they are ours to commit and
// the official webp art stays git-ignored. Run once: `npm run layers`.
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const OUT = path.join(process.cwd(), 'assets', 'hubie', 'layers');
fs.mkdirSync(OUT, { recursive: true });

function save(name, canvas) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  console.log(`[layers] ${name} ${canvas.width}x${canvas.height} ${fs.statSync(file).size} B`);
}

// Open mouth: soft dark ellipse + jaw shadow, with a faint tongue hint.
function mouthOpen() {
  const c = createCanvas(256, 128);
  const x = c.getContext('2d');
  x.clearRect(0, 0, 256, 128);

  let g = x.createRadialGradient(128, 64, 6, 128, 64, 120);
  g.addColorStop(0, 'rgba(28,14,10,0.92)');
  g.addColorStop(0.55, 'rgba(30,16,12,0.70)');
  g.addColorStop(1, 'rgba(30,16,12,0)');
  x.fillStyle = g;
  x.beginPath(); x.ellipse(128, 64, 120, 58, 0, 0, Math.PI * 2); x.fill();

  g = x.createRadialGradient(128, 72, 4, 128, 70, 92);
  g.addColorStop(0, 'rgba(12,6,5,0.95)');
  g.addColorStop(0.70, 'rgba(20,10,8,0.85)');
  g.addColorStop(1, 'rgba(20,10,8,0)');
  x.fillStyle = g;
  x.beginPath(); x.ellipse(128, 70, 96, 44, 0, 0, Math.PI * 2); x.fill();

  g = x.createRadialGradient(128, 94, 2, 128, 94, 54);
  g.addColorStop(0, 'rgba(150,66,62,0.45)');
  g.addColorStop(1, 'rgba(150,66,62,0)');
  x.fillStyle = g;
  x.beginPath(); x.ellipse(128, 94, 56, 18, 0, 0, Math.PI * 2); x.fill();

  return c;
}

// Closed mouth: thin soft smirk line with a gentle shadow.
function mouthClosed() {
  const c = createCanvas(256, 64);
  const x = c.getContext('2d');
  x.clearRect(0, 0, 256, 64);

  x.shadowColor = 'rgba(28,14,10,0.65)';
  x.shadowBlur = 7;
  x.shadowOffsetY = 1;
  x.strokeStyle = 'rgba(44,22,17,0.85)';
  x.lineWidth = 7;
  x.lineCap = 'round';
  x.beginPath();
  x.moveTo(30, 38);
  x.quadraticCurveTo(128, 20, 226, 32);
  x.stroke();
  return c;
}

// Blink: two soft dark lids, viewer-left lower than viewer-right to match the 3/4 pose.
function lidClosed() {
  const c = createCanvas(256, 80);
  const x = c.getContext('2d');
  x.clearRect(0, 0, 256, 80);

  // Lid centres match the 3/4 pose: viewer-left eye (48,56), viewer-right eye (208,26)
  // when the layer is stretched over the `eyes` box in rig.json.
  const lid = (cx, cy) => {
    const g = x.createLinearGradient(0, cy - 24, 0, cy + 24);
    g.addColorStop(0, 'rgba(38,22,16,0.08)');
    g.addColorStop(0.45, 'rgba(30,17,12,0.90)');
    g.addColorStop(1, 'rgba(20,11,8,0.96)');
    x.fillStyle = g;
    x.beginPath(); x.ellipse(cx, cy, 46, 24, 0, 0, Math.PI * 2); x.fill();

    x.shadowColor = 'rgba(16,9,7,0.8)';
    x.shadowBlur = 6;
    x.strokeStyle = 'rgba(16,9,7,0.9)';
    x.lineWidth = 5;
    x.lineCap = 'round';
    x.beginPath(); x.ellipse(cx, cy, 46, 24, 0, Math.PI * 0.08, Math.PI * 0.92); x.stroke();
    x.shadowBlur = 0;
  };

  lid(48, 56);
  lid(208, 26);
  return c;
}

save('mouth_open.png', mouthOpen());
save('mouth_closed.png', mouthClosed());
save('lid_closed.png', lidClosed());
console.log(`[layers] done -> ${OUT}`);
