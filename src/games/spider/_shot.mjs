/**
 * 蜘蛛纸牌渲染自检（临时工具，非交付物）
 *
 * 用「记录式 ctx + 本地光栅化器」在 Node 里把 render.js 画的一帧真正渲成 PNG，
 * 不需要浏览器、不需要任何依赖。用法：
 *   node src/games/spider/_shot.mjs [width height insetsBottom outPath]
 * 不给参数时会把一组常见机型全部铺开（同时做溢出体检）。
 */
import { createSession } from './index.js';
import { computeLayout, renderFrame, cardRect } from './render.js';
import { mulberry32 } from './core.js';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* ═══════════ 1. 记录式 Canvas 2D 上下文 ═══════════ */

function parseColor(c) {
  if (typeof c !== 'string') return [0, 0, 0, 1];
  const s = c.trim();
  if (s[0] === '#') {
    const hex = s.length === 4 ? s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s.slice(1);
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map(Number);
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return [0, 0, 0, 1];
}

/** 渐变替身：预算 64×64 采样表，光栅化时插值取色。 */
class FakeGradient {
  constructor(kind, a) { this.kind = kind; this.args = a; this.stops = []; this.table = null; }
  addColorStop(t, c) { this.stops.push([t, parseColor(c)]); }
  build() {
    const N = 64;
    this.table = new Float32Array(N * N * 4);
    let box;
    if (this.kind === 'linear') {
      const [x0, y0, x1, y1] = this.args;
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy || 1;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const px = x0 + (dx * i) / (N - 1);
          const py = y0 + (dy * j) / (N - 1);
          let t = ((px - x0) * dx + (py - y0) * dy) / len2;
          this.sample(t < 0 ? 0 : t > 1 ? 1 : t, (j * N + i) * 4);
        }
      }
      box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(dx) + 1, h: Math.abs(dy) + 1 };
    } else {
      const [cx0, cy0, r0, cx1, cy1, r1] = this.args;
      const R = Math.max(r0, r1, 1);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const px = cx1 - R + (2 * R * i) / (N - 1);
          const py = cy1 - R + (2 * R * j) / (N - 1);
          const d = Math.hypot(px - cx1, py - cy1);
          let t = Math.abs(r1 - r0) < 1e-6 ? 0 : (d - r0) / (r1 - r0);
          this.sample(t < 0 ? 0 : t > 1 ? 1 : t, (j * N + i) * 4);
        }
      }
      box = { x: cx1 - R, y: cy1 - R, w: 2 * R, h: 2 * R };
    }
    this.bbox = box;
    return box;
  }
  sample(t, o) {
    const st = this.stops;
    if (!st.length) { this.set(o, [0, 0, 0, 1]); return; }
    if (t <= st[0][0]) { this.set(o, st[0][1]); return; }
    for (let i = 1; i < st.length; i++) {
      if (t <= st[i][0]) {
        const [ta, ca] = st[i - 1];
        const [tb, cb] = st[i];
        const k = tb - ta < 1e-9 ? 0 : (t - ta) / (tb - ta);
        this.set(o, [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k,
          ca[2] + (cb[2] - ca[2]) * k, ca[3] + (cb[3] - ca[3]) * k]);
        return;
      }
    }
    this.set(o, st[st.length - 1][1]);
  }
  set(o, c) { this.table[o] = c[0]; this.table[o + 1] = c[1]; this.table[o + 2] = c[2]; this.table[o + 3] = c[3]; }
  colorAt(x, y) {
    const b = this.bbox || this.build();
    const N = 64;
    const u = Math.min(1, Math.max(0, (x - b.x) / (b.w || 1)));
    const v = Math.min(1, Math.max(0, (y - b.y) / (b.h || 1)));
    const o = (Math.round(v * (N - 1)) * N + Math.round(u * (N - 1))) * 4;
    return [this.table[o], this.table[o + 1], this.table[o + 2], this.table[o + 3]];
  }
}

/** 记录式 ctx。 */
function makeRecorder() {
  const ops = [];
  const st = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: 'rgba(0,0,0,0)', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
  };
  const stack = [];
  let path = [];
  let sub = null;
  // ⚠️ render.js 现在用 translate 把「建在局部原点的缓存渐变」挪到每张牌上（性能优化）。
  // 记录器必须真的把平移烘进路径/文字坐标，并把偏移记在 op 上供渐变取色用，
  // 否则截图里所有牌都会叠在左上角。
  let tx = 0, ty = 0;
  const snapPath = () => path.map((s) => ({ pts: s.pts.map((p) => [p[0], p[1]]), closed: s.closed }));

  return {
    ops,
    get fillStyle() { return st.fillStyle; }, set fillStyle(v) { st.fillStyle = v; },
    get strokeStyle() { return st.strokeStyle; }, set strokeStyle(v) { st.strokeStyle = v; },
    get lineWidth() { return st.lineWidth; }, set lineWidth(v) { st.lineWidth = v; },
    get globalAlpha() { return st.globalAlpha; }, set globalAlpha(v) { st.globalAlpha = v; },
    get font() { return st.font; }, set font(v) { st.font = v; },
    get textAlign() { return st.textAlign; }, set textAlign(v) { st.textAlign = v; },
    get textBaseline() { return st.textBaseline; }, set textBaseline(v) { st.textBaseline = v; },
    get shadowColor() { return st.shadowColor; }, set shadowColor(v) { st.shadowColor = v; },
    get shadowBlur() { return st.shadowBlur; }, set shadowBlur(v) { st.shadowBlur = v; },
    get shadowOffsetX() { return st.shadowOffsetX; }, set shadowOffsetX(v) { st.shadowOffsetX = v; },
    get shadowOffsetY() { return st.shadowOffsetY; }, set shadowOffsetY(v) { st.shadowOffsetY = v; },
    get lineCap() { return 'butt'; }, set lineCap(_v) {},
    get lineJoin() { return 'miter'; }, set lineJoin(_v) {},
    save() { stack.push({ ...st, tx, ty }); },
    restore() { const s = stack.pop(); if (s) { Object.assign(st, s); tx = s.tx; ty = s.ty; } },
    beginPath() { path = []; sub = null; },
    closePath() { if (sub) sub.closed = true; },
    moveTo(x, y) { sub = { pts: [[x + tx, y + ty]], closed: false }; path.push(sub); },
    lineTo(x, y) { if (!sub) this.moveTo(x, y); else sub.pts.push([x + tx, y + ty]); },
    arcTo(x1, y1) { if (sub) sub.pts.push([x1 + tx, y1 + ty]); },
    arc(cx, cy, r, a0, a1) {
      const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / 0.25));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        pts.push([cx + Math.cos(a) * r + tx, cy + Math.sin(a) * r + ty]);
      }
      sub = { pts, closed: true };
      path.push(sub);
    },
    fill() {
      ops.push({ k: 'fill', path: snapPath(), style: st.fillStyle, alpha: st.globalAlpha, s: { ...st }, gx: tx, gy: ty });
    },
    stroke() {
      ops.push({ k: 'stroke', path: snapPath(), style: st.strokeStyle, lw: st.lineWidth, alpha: st.globalAlpha, s: { ...st }, gx: tx, gy: ty });
    },
    fillRect(x, y, w, h) {
      ops.push({ k: 'rect', x: x + tx, y: y + ty, w, h, style: st.fillStyle, alpha: st.globalAlpha, s: { ...st }, gx: tx, gy: ty });
    },
    clearRect() {},
    clip() {},
    setLineDash() {},
    translate(dx, dy) { tx += dx; ty += dy; },
    rotate() {}, scale() {},
    measureText(t) {
      const m = /(\d+(?:\.\d+)?)px/.exec(st.font || '');
      const px = m ? parseFloat(m[1]) : 12;
      let w = 0;
      for (const ch of String(t)) w += ch.charCodeAt(0) > 0x2e80 ? px : px * 0.62;
      return { width: w };
    },
    fillText(t, x, y) {
      ops.push({ k: 'text', t: String(t), x: x + tx, y: y + ty, style: st.fillStyle, alpha: st.globalAlpha, s: { ...st }, gx: tx, gy: ty });
    },
    createLinearGradient(...a) { return new FakeGradient('linear', a); },
    createRadialGradient(...a) { return new FakeGradient('radial', a); },
  };
}

/* ═══════════ 2. PNG 写出（zlib + CRC，零依赖） ═══════════ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function writePng(w, h, rgba, out) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(out, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* ═══════════ 3. 光栅化 ═══════════ */

const SS = 2;
function distSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(px - a[0], py - a[1]);
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
function coverage(paths, px, py, halfW) {
  let hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS - 0.5;
      const y = py + (sy + 0.5) / SS - 0.5;
      let inside = false;
      for (const sp of paths) {
        const pts = sp.pts;
        if (pts.length < 2) continue;
        if (halfW > 0) {
          for (let i = 0; i < pts.length - 1; i++) {
            if (distSeg(x, y, pts[i], pts[i + 1]) <= halfW) { inside = !inside; break; }
          }
          if (sp.closed && pts.length > 2 && distSeg(x, y, pts[pts.length - 1], pts[0]) <= halfW) inside = !inside;
        } else {
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
            if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
          }
        }
      }
      if (inside) hits++;
    }
  }
  return hits / (SS * SS);
}

const FONT57 = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  'A': [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], 'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  'Q': [0x0e, 0x11, 0x11, 0x11, 0x15, 0x0e, 0x03], 'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c], ' ': [0, 0, 0, 0, 0, 0, 0], '-': [0, 0, 0, 0x1f, 0, 0, 0],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0], '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
};

function drawText(op, buf, w, h, blend) {
  const m = /(\d+(?:\.\d+)?)px/.exec(op.s.font || '');
  const px = m ? parseFloat(m[1]) : 12;
  const align = op.s.textAlign || 'left';
  const baseline = op.s.textBaseline || 'alphabetic';
  const col = op.style instanceof FakeGradient ? op.style.colorAt(op.x, op.y) : parseColor(op.style);
  let total = 0;
  for (const ch of op.t) total += ch.charCodeAt(0) > 0x2e80 ? px : px * 0.62;
  let x0 = op.x;
  if (align === 'center') x0 -= total / 2;
  else if (align === 'right') x0 -= total;
  let top = op.y;
  if (baseline === 'middle') top = op.y - px * 0.5;
  else if (baseline === 'alphabetic' || baseline === 'bottom') top = op.y - px * 0.78;

  const put = (px0, py0) => {
    const x = Math.round(px0), y = Math.round(py0);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    blend((y * w + x) * 4, col, op.alpha);
  };
  for (const ch of op.t) {
    if (ch === ' ') { x0 += px * 0.62; continue; }
    if (ch.charCodeAt(0) > 0x2e80) {
      const bw = px * 0.9, bh = px * 0.9;
      for (let j = 0; j < bh; j++) {
        for (let i = 0; i < bw; i++) {
          if (i < 1 || j < 1 || i > bw - 2 || j > bh - 2 || Math.abs(i - bw / 2) < 1) put(x0 + i, top + j);
        }
      }
      x0 += px;
      continue;
    }
    const rows = FONT57[ch] || FONT57[ch.toUpperCase()] || FONT57[' '];
    const scl = Math.max(1, px / 7.5);
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (!(rows[r] & (1 << (4 - c)))) continue;
        for (let dy = 0; dy < scl; dy++) for (let dx = 0; dx < scl; dx++) put(x0 + c * scl + dx, top + r * scl + dy);
      }
    }
    x0 += px * 0.62;
  }
}

function rasterize(ops, w, h) {
  const buf = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const r = 0xd7 + (0xfb - 0xd7) * t;
    const g = 0xec + (0xfd - 0xec) * t;
    const b = 0xec + (0xfd - 0xec) * t;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
  }
  const blend = (o, col, a) => {
    const al = a * (col[3] === undefined ? 1 : col[3]);
    if (al <= 0.002) return;
    buf[o] += (col[0] - buf[o]) * al;
    buf[o + 1] += (col[1] - buf[o + 1]) * al;
    buf[o + 2] += (col[2] - buf[o + 2]) * al;
  };

  for (const op of ops) {
    const gx = op.gx || 0, gy = op.gy || 0;
    if (op.k === 'rect') {
      const x0 = Math.max(0, Math.floor(op.x)), y0 = Math.max(0, Math.floor(op.y));
      const x1 = Math.min(w - 1, Math.ceil(op.x + op.w) - 1);
      const y1 = Math.min(h - 1, Math.ceil(op.y + op.h) - 1);
      const solid = op.style instanceof FakeGradient ? null : parseColor(op.style);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) blend((y * w + x) * 4, solid || op.style.colorAt(x - gx, y - gy), op.alpha);
      }
      continue;
    }
    if (op.k === 'text') { drawText(op, buf, w, h, blend); continue; }

    const s = op.s || {};
    for (const which of ['shadow', 'main']) {
      if (which === 'shadow' && !(s.shadowBlur > 0 || s.shadowOffsetX || s.shadowOffsetY)) continue;
      const dx = which === 'shadow' ? (s.shadowOffsetX || 0) : 0;
      const dy = which === 'shadow' ? (s.shadowOffsetY || 0) : 0;
      const alpha = which === 'shadow' ? Math.min(0.42, op.alpha * 0.5) : op.alpha;
      const shadowCol = which === 'shadow' ? parseColor(s.shadowColor || 'rgba(0,0,0,0.4)') : null;
      const halfW = op.k === 'stroke' ? op.lw / 2 : 0;
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (const sp of op.path) for (const p of sp.pts) {
        if (p[0] < minx) minx = p[0];
        if (p[0] > maxx) maxx = p[0];
        if (p[1] < miny) miny = p[1];
        if (p[1] > maxy) maxy = p[1];
      }
      const pad = halfW + (s.shadowBlur || 0) * 0.5 + 2;
      const x0 = Math.max(0, Math.floor(minx - pad + dx));
      const y0 = Math.max(0, Math.floor(miny - pad + dy));
      const x1 = Math.min(w - 1, Math.ceil(maxx + pad + dx));
      const y1 = Math.min(h - 1, Math.ceil(maxy + pad + dy));
      const shifted = op.path.map((sp) => ({ pts: sp.pts.map((p) => [p[0] + dx, p[1] + dy]), closed: sp.closed }));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const cov = coverage(shifted, x, y, halfW);
          if (cov <= 0.01) continue;
          // 渐变建在局部原点，取色时把 translate 偏移减回去
          const c = shadowCol || (op.style instanceof FakeGradient ? op.style.colorAt(x - gx, y - gy) : parseColor(op.style));
          blend((y * w + x) * 4, c, alpha * cov);
        }
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i];
  return out;
}

/* ═══════════ 4. 跑一帧 + 体检 ═══════════ */

function shoot(W, H, insetBottom, out, label, deals = 0, opt = {}) {
  const INSET_TOP = 44;
  const session = createSession({
    width: W, height: H, insets: { top: INSET_TOP, bottom: insetBottom },
    difficulty: opt.difficulty || 'easy', theme: {}, rng: mulberry32(20260807),
  });
  const NOW = 1790000000000;
  session.update(NOW);
  // 可选：先发几轮牌，制造「一列里有好几张明牌」的中局画面（验证明牌错开是否正确）
  for (let i = 0; i < deals; i++) {
    const l0 = computeLayout(W, H, { top: INSET_TOP, bottom: insetBottom }, session.snapshot);
    const btn = l0.buttons.find((b) => b.key === 'deal');
    session.tap(btn.x + btn.w / 2, btn.y + btn.h / 2, NOW);
    session.update(NOW);
  }
  const snap = session.snapshot;
  // 合成视图：可强制把某几列清空（用来验证「空列底槽可见」这条视觉效果）
  const columns = snap.columns.map((c, i) => (opt.emptyCols && opt.emptyCols.includes(i)
    ? { ...c, cards: [], faceDown: 0, faceUp: 0, movableFrom: -1, empty: true }
    : c));
  const view = {
    key: snap.key, columns, stock: snap.stock, dealsLeft: snap.dealsLeft,
    canDeal: snap.canDeal, collected: snap.collected, remainingRuns: snap.remainingRuns,
    moves: snap.moves, canUndo: snap.canUndo, undoLeft: 0, result: snap.result,
    cardsLeft: snap.cardsLeft, levelName: '简单', requireSameSuit: false, elapsedMs: 0,
    selection: null, pressButton: null, pressCard: null, hint: null,
    rejectCol: null, rejectAt: 0, toast: null, lastCollectAt: 0, winAt: 0, stuckAt: 0,
  };
  const layout = computeLayout(W, H, { top: INSET_TOP, bottom: insetBottom }, view);
  const ctx = makeRecorder();
  renderFrame(ctx, layout, view, {}, NOW);
  const buf = rasterize(ctx.ops, W, H);
  if (out) writePng(W, H, buf, out);

  /* ── 像素抽样（等价于浏览器里的 getImageData 取样） ── */
  const px = (x, y) => {
    const xi = Math.max(0, Math.min(W - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(H - 1, Math.round(y)));
    const o = (yi * W + xi) * 4;
    return [buf[o], buf[o + 1], buf[o + 2]];
  };
  const luma = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  const meanLuma = (x0, y0, w, h) => {
    let s = 0, n = 0;
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++) {
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++) { s += luma(px(x, y)); n++; }
    }
    return n ? s / n : 0;
  };

  let worstBottom = 0, topMin = Infinity, flagsOk = true, maxUp = 0, maxDown = 0;
  for (let c = 0; c < view.columns.length; c++) {   // 列数按难度（5/7/9），不再写死 10
    const col = view.columns[c];
    topMin = Math.min(topMin, layout.columns[c].top);
    if (!col.cards.length) continue;
    const last = cardRect(layout, view, c, col.cards.length - 1);
    worstBottom = Math.max(worstBottom, last.y + last.h);
    maxUp = Math.max(maxUp, col.faceUp);
    maxDown = Math.max(maxDown, col.faceDown);
    // 只有「最后一张」必须是正面；更靠前的牌（走过牌会翻开）正反面都合法
    if (col.cards[col.cards.length - 1].faceUp !== true) flagsOk = false;
  }

  // ① 牌桌向下延伸：牌桌内部（所有牌下方）应当是木色，与同高度的页面背景明显不同
  const t = layout.table;
  const probeY = Math.min(H - 2, t.bottom - 10);
  const inTable = px(t.x + t.w * 0.5, probeY);
  const outTable = px(Math.max(2, t.x - 6), probeY);
  const woodBias = (p) => p[0] - p[2];            // 木色偏暖（r>b），青白底偏冷（b>r）
  const deepWood = woodBias(inTable) - woodBias(outTable);
  const depthPx = Math.round(t.bottom - worstBottom);

  // ② 只露最上一张牌：同一列里「最后一张（明牌）」是浅色牌面；
  //    再找一个露着一条背的暗牌，它的条带必须是深色牌背
  const c0 = view.columns[0];
  const c0geo = layout.columns[0];
  let faceLuma = 0, backLuma = 0, topOnlyOk = true, backIdx = -1;
  if (c0.cards.length >= 2) {
    for (let k = 0; k < c0.cards.length - 1; k++) if (!c0.cards[k].faceUp) backIdx = k;   // 取最深的那个
    const rLast = cardRect(layout, view, 0, c0.cards.length - 1);
    const sx = c0geo.x + layout.cardW * 0.72;   // 避开左上角点数（「10」两字较宽）
    faceLuma = luma(px(sx, rLast.y + layout.cardH * 0.28));
    if (backIdx >= 0) {
      const rBack = cardRect(layout, view, 0, backIdx);
      backLuma = luma(px(sx, rBack.y + Math.max(1, layout.faceDownGap * 0.5)));
      topOnlyOk = faceLuma > 150 && backLuma < 130 && faceLuma - backLuma > 60;
    } else {
      topOnlyOk = faceLuma > 150;   // 该列已经没有暗牌了，只能验明牌够亮
    }
  }

  // ③ 空列底槽可见：空列槽位（白色 10% 填充 + 虚线边）比紧下方的木色更亮
  let slotGain = 0, slotOk = true;
  if (opt.emptyCols && opt.emptyCols.length) {
    const ec = opt.emptyCols[0];
    const geo = layout.columns[ec];
    const slot = meanLuma(geo.x + 3, geo.top + 3, layout.cardW - 6, layout.cardH - 6);
    const below = meanLuma(geo.x + 3, geo.top + layout.cardH + 8, layout.cardW - 6, layout.cardH - 6);
    slotGain = slot - below;
    slotOk = slotGain > 1.5;
  }

  const r = {
    label, W, H,
    tableTop: t.y, tableBottom: t.bottom, tableH: t.h,
    faceDownGap: layout.faceDownGap, faceUpGap: layout.faceUpGap,
    cardW: layout.cardW, cardH: layout.cardH,
    topMin, worstBottom, footerY: layout.footer.y, btnBottom: layout.bottomLimit,
    maxUp, maxDown,
    deepWood: +deepWood.toFixed(1), depthPx,
    faceLuma: +faceLuma.toFixed(1), backLuma: +backLuma.toFixed(1),
    topOnlyOk: opt.emptyCols ? true : topOnlyOk,
    slotGain: +slotGain.toFixed(2), slotOk,
    overflow: worstBottom > t.bottom + 1 || topMin < t.y - 1,
    flagsOk,
    inScreen: t.bottom <= layout.footer.y + 1 && layout.bottomLimit <= H - insetBottom,
  };
  session.destroy();
  return r;
}

const args = process.argv.slice(2);
const DIR = dirname(fileURLToPath(import.meta.url));   // 截图落在本文件旁边，哪份副本跑都行
const cases = args.length >= 3
  ? [{ w: Number(args[0]), h: Number(args[1]), b: Number(args[2]), out: args[3] || join(DIR, '_shot.png'), label: '自定义', deals: Number(args[4] || 0) }]
  : [
      { w: 320, h: 480, b: 20, out: join(DIR, '_shot_320x480.png'), label: '小屏', deals: 0 },
      { w: 360, h: 640, b: 30, out: join(DIR, '_shot_360x640.png'), label: '常见', deals: 0 },
      { w: 375, h: 667, b: 34, out: join(DIR, '_shot_375x667.png'), label: 'iPhone8', deals: 0 },
      { w: 420, h: 805, b: 34, out: join(DIR, '_shot_420x805.png'), label: '用户机型', deals: 0 },
      { w: 430, h: 932, b: 40, out: join(DIR, '_shot_430x932.png'), label: '大屏', deals: 0 },
      { w: 420, h: 805, b: 34, out: join(DIR, '_shot_420x805_mid.png'), label: '中局', deals: 5 },
      { w: 420, h: 805, b: 34, out: join(DIR, '_shot_420x805_empty.png'), label: '手动空列', deals: 0, opt: { emptyCols: [0, 2] } },
      { w: 420, h: 805, b: 34, out: join(DIR, '_shot_420x805_hard.png'), label: '困难档', deals: 0, opt: { difficulty: 'hard' } },
      { w: 420, h: 805, b: 34, out: join(DIR, '_shot_420x805_normal.png'), label: '普通档', deals: 0, opt: { difficulty: 'normal' } },
      { w: 420, h: 805, b: 34, out: join(DIR, '_shot_420x805_full.png'), label: '简单满堆', deals: 16, opt: { difficulty: 'easy' } },
    ];

let bad = 0;
for (const cs of cases) {
  const r = shoot(cs.w, cs.h, cs.b, cs.out, cs.label, cs.deals, cs.opt || {});
  if (r.overflow || !r.flagsOk || !r.inScreen || !r.topOnlyOk || !r.slotOk) bad++;
  console.log(
    `${r.label.padEnd(9)} ${String(r.W).padStart(3)}×${String(r.H).padEnd(4)} bottom=${String(cs.b).padStart(2)} 发${cs.deals}轮  `
    + `牌桌 y=${String(r.tableTop).padStart(3)}→${String(r.tableBottom).padStart(3)}(h=${String(r.tableH).padStart(3)})  `
    + `间距 暗${String(r.faceDownGap).padStart(2)}/明${String(r.faceUpGap).padStart(2)}  牌 ${r.cardW}×${r.cardH}  `
    + `列底 ${String(r.worstBottom).padStart(3)} 下方纵深 ${String(r.depthPx).padStart(3)}px(木色偏 ${r.deepWood})  `
    + `明牌 ${r.faceLuma}/${r.backLuma}  `
    + (r.overflow ? '✗ 溢出' : '✓ 不溢出')
    + (r.inScreen ? ' / ✓ 在屏内' : ' / ✗ 越界')
    + (r.topOnlyOk ? ' / ✓ 只露明牌' : ' / ✗ 明暗取样异常')
    + (cs.opt && cs.opt.emptyCols ? ` / 空列槽 +${r.slotGain}亮度` : '')
    + (r.slotOk ? '' : ' / ✗ 空列槽不可见'),
  );
}
console.log(`\n异常用例：${bad} / ${cases.length}     PNG 目录：${DIR}`);
