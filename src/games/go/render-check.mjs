/**
 * 围棋（Go）UI 适配自检 —— 桩 ctx 渲染一帧，把验收项变成可断言的数字。
 *
 * 这是**开发用自检脚本**，不属于规范要求的 4 个文件（core/render/index/test），
 * 不参与游戏运行、不被任何生产代码 import。用法：
 *   node src/games/go/render-check.mjs
 *
 * 为什么要有它：截图只能证明"看着像"，本脚本用桩 ctx 记录一帧的全部绘制调用，
 * 逐项断言（全部来自《游戏模块规范.md》§10 与《UI适配清单.md》验收标准）：
 *   ① 无全屏铺底：本模块自己 drawing 的填充里，没有任何一块覆盖 ≥95% 屏幕
 *   ② 浅底深字：每一条 fillText 的**生效颜色**（含透明度合成）亮度 ≤ 0.72
 *   ③ 顶部让位：所有文字包围盒（保守放大 15%）不与左上返回键 / 右上齿轮、
 *      以及左上/右上各 56px 的角区相交
 *   ④ 底部安全区：三个按钮底边 ≤ height − insets.bottom − 16
 *   ⑤ 按钮木质化：每个按钮矩形上有木质按钮的签名绘制（渐变底 + 上半部高光矩形），
 *      主操作按钮的渐变里出现木质色标
 *   ⑥ 集成层合成帧：青白渐变底铺完后，游戏模块没有再铺任何全屏底
 *   ⑦ 13 路 / 19 路两档：各自的星位数量、棋盘居中、格子尺寸、离屏棋盘缓存
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEME } from '../../ui/theme.js';
import { computeLayout as computeChromeLayout, computeHallLayout, computeLevelLayout } from '../../ui/layout.js';
import { createSession } from './index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
let passCount = 0;
let failCount = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`); console.log(`  ✗ ${name} ${extra}`); }
}

/* ───────────────────────── 颜色工具 ───────────────────────── */

/** 解析 '#rgb' / '#rrggbb' / 'rgb(...)' / 'rgba(...)'；失败返回 null。 */
function parseColor(style) {
  if (typeof style !== 'string') return null;
  const s = style.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** 相对亮度（0=黑 1=白），用于判定"文字是否够深"。 */
function luminance(color, bg = { r: 233, g: 245, b: 245 }) {
  const c = parseColor(color);
  if (!c) return null;
  const mix = (ch, b) => (c.a >= 1 ? ch : ch * c.a + b * (1 - c.a));
  const r = mix(c.r, bg.r) / 255;
  const g = mix(c.g, bg.g) / 255;
  const b = mix(c.b, bg.b) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ───────────────────────── 桩 ctx ───────────────────────── */

/** 估算文字宽度：CJK/全角按 1 个字宽，ASCII 按 0.5 个字宽。 */
function textWidth(text, px) {
  let w = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    w += code > 0x2e80 ? px : px * 0.5;
  }
  return w;
}

function fontSizeOf(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font ?? ''));
  return m ? +m[1] : 14;
}

/**
 * 记录型 Canvas 2D 桩：记下 fill/stroke/fillText/fillRect/clearRect/渐变/drawImage，
 * 并按路径点位算出每次 fill() 的包围盒（用于认出按钮矩形）。
 */
function createStubCtx(canvas = null) {
  const rec = {
    fills: [], texts: [], rects: [], clears: [], gradients: [], strokes: [], drawImages: [],
    transforms: 0, stack: [],
  };
  let path = null;
  let gradSeq = 0;
  let tx = 0;
  let ty = 0;

  const ctx = {
    // ── 绘制状态（游戏/集成层会直接赋值）──
    canvas,
    fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1,
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '400 14px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    rec,

    // ── 状态栈 ──
    save() { rec.stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline }); },
    restore() { const s = rec.stack.pop(); if (s) Object.assign(this, s); },
    // 变换：只跟踪平移（本项目文字不使用 rotate/scale），供包围盒换算
    translate(x, y) { tx += x; ty += y; rec.transforms++; },
    rotate() { rec.transforms++; },
    scale() { rec.transforms++; },
    setTransform() { tx = 0; ty = 0; },
    resetTransform() { tx = 0; ty = 0; },
    transform() { rec.transforms++; },

    // ── 路径（只记包围盒）──
    beginPath() { path = null; },
    closePath() {},
    moveTo(x, y) { path = grow(path, x, y); },
    lineTo(x, y) { path = grow(path, x, y); },
    arcTo(x1, y1, x2, y2) { path = grow(grow(path, x1, y1), x2, y2); },
    bezierCurveTo(x1, y1, x2, y2, x3, y3) { path = grow(grow(grow(path, x1, y1), x2, y2), x3, y3); },
    quadraticCurveTo(x1, y1, x2, y2) { path = grow(grow(path, x1, y1), x2, y2); },
    rect(x, y, w, h) { path = grow(grow(path, x, y), x + w, y + h); },
    arc(cx, cy, r) { path = grow(grow(grow(grow(path, cx - r, cy - r), cx + r, cy + r), cx - r, cy + r), cx + r, cy - r); },
    ellipse(cx, cy, rx, ry) { path = grow(grow(grow(grow(path, cx - rx, cy - ry), cx + rx, cy + ry), cx - rx, cy + ry), cx + rx, cy - ry); },
    clip() {},

    fill() { rec.fills.push({ bbox: path, style: this.fillStyle, alpha: this.globalAlpha }); },
    stroke() { rec.strokes.push({ bbox: path, style: this.strokeStyle, alpha: this.globalAlpha, lineWidth: this.lineWidth }); },
    fillRect(x, y, w, h) { rec.rects.push({ x, y, w, h, style: this.fillStyle, alpha: this.globalAlpha, op: 'fillRect' }); },
    strokeRect(x, y, w, h) { rec.rects.push({ x, y, w, h, style: this.strokeStyle, alpha: this.globalAlpha, op: 'strokeRect' }); },
    clearRect(x, y, w, h) { rec.clears.push({ x, y, w, h }); },

    // ── 渐变（带 id，便于回溯 fillStyle 里挂的是哪个渐变）──
    createLinearGradient() { return makeGradient('linear'); },
    createRadialGradient() { return makeGradient('radial'); },

    // ── 文字 ──
    measureText(text) { return { width: textWidth(text, fontSizeOf(this.font)) }; },
    fillText(text, x, y) {
      const px = fontSizeOf(this.font);
      rec.texts.push({
        text: String(text), x: x + tx, y: y + ty, px,
        width: textWidth(text, px),
        style: this.fillStyle, alpha: this.globalAlpha,
        align: this.textAlign, baseline: this.textBaseline,
      });
    },
    strokeText() {},
    drawImage(img, dx, dy, dw, dh) { rec.drawImages.push({ img, dx, dy, dw, dh }); },
    createPattern() { return null; },
  };

  function makeGradient(kind) {
    const id = ++gradSeq;
    const g = {
      __id: id, __kind: kind, stops: [],
      addColorStop(offset, color) { g.stops.push({ offset, color }); },
    };
    rec.gradients.push(g);
    return g;
  }

  function grow(b, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return b;
    if (!b) return { x0: x, y0: y, x1: x, y1: y };
    return { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) };
  }

  // 未实现的方法一律当空操作（避免个别 API 缺失把整帧打断）
  return new Proxy(ctx, {
    get(target, key) {
      if (key in target) return target[key];
      return () => {};
    },
  });
}

/* ───────────────────────── 通用判定 ───────────────────────── */

const RATIO_FULLSCREEN = 0.95;

/** 一块填充相对屏幕的覆盖比例。 */
function coverRatio(r, W, H) {
  const x0 = Math.max(0, Math.min(r.x, r.x + r.w));
  const x1 = Math.min(W, Math.max(r.x, r.x + r.w));
  const y0 = Math.max(0, Math.min(r.y, r.y + r.h));
  const y1 = Math.min(H, Math.max(r.y, r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  return ((x1 - x0) * (y1 - y0)) / (W * H);
}

/** 路径包围盒是否是"全屏级"填充（fillRect 与 path fill 都算）。 */
function fullscreenFills(rec, W, H) {
  const out = [];
  for (const r of rec.rects) {
    if (coverRatio(r, W, H) >= RATIO_FULLSCREEN) out.push({ ...r, how: 'fillRect' });
  }
  for (const f of rec.fills) {
    if (!f.bbox) continue;
    const r = { x: f.bbox.x0, y: f.bbox.y0, w: f.bbox.x1 - f.bbox.x0, h: f.bbox.y1 - f.bbox.y0 };
    if (coverRatio(r, W, H) >= RATIO_FULLSCREEN) out.push({ ...r, how: 'fill(path)', style: f.style });
  }
  return out;
}

/** 文字包围盒（按对齐方式推算，宽度放大 15% 做保守估计）。 */
function textBox(t) {
  const w = t.width * 1.15;
  const h = t.px * 1.25;
  let x0 = t.x;
  if (t.align === 'center') x0 = t.x - w / 2;
  else if (t.align === 'right' || t.align === 'end') x0 = t.x - w;
  let y0 = t.y - h / 2;
  if (t.baseline === 'alphabetic' || t.baseline === 'bottom') y0 = t.y - h;
  else if (t.baseline === 'top' || t.baseline === 'hanging') y0 = t.y;
  return { x: x0, y: y0, w, h, x1: x0 + w, y1: y0 + h };
}

function intersects(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && b.x - pad < a.x + a.w
    && a.y < b.y + b.h + pad && b.y - pad < a.y + a.h;
}

/** 左上/右上角区：以安全区顶为起点、各 56px 见方。 */
function cornerZones(W, insets) {
  const S = 56;
  return [
    { name: '左上角区', x: 0, y: insets.top ?? 0, w: S, h: S },
    { name: '右上角区', x: W - S, y: insets.top ?? 0, w: S, h: S },
  ];
}

const WOOD_STOPS = new Set(['#eec98f', '#d9a95f', '#dfae63', '#c08f42']);

/** 按钮的木质签名：渐变底 + 上半部高光矩形（drawWoodButton 的两个特征）。 */
function checkWoodButtons(rec, buttons, tag) {
  buttons.forEach((btn, i) => {
    const body = rec.fills.find((f) => f.bbox
      && Math.abs(f.bbox.x0 - btn.x) < 1.5 && Math.abs(f.bbox.y0 - btn.y) < 1.5
      && Math.abs(f.bbox.x1 - (btn.x + btn.w)) < 1.5 && Math.abs(f.bbox.y1 - (btn.y + btn.h)) < 1.5);
    ok(!!body, `${tag} 按钮${i + 1} 有按矩形大小的填充`, body ? '' : '没找到与按钮矩形吻合的填充');
    const isGrad = !!body && typeof body.style === 'object' && Array.isArray(body.style.stops);
    ok(isGrad, `${tag} 按钮${i + 1} 底是渐变（木质按钮签名，而非扁平色块）`);
    if (isGrad && i === 0) {
      const stops = body.style.stops.map((s) => String(s.color).toLowerCase());
      ok(stops.some((c) => WOOD_STOPS.has(c)), `${tag} 主操作按钮用木质色（primary:true）`, stops.join(','));
    }
    const hi = rec.rects.find((r) => Math.abs(r.x - btn.x) < 1.5
      && Math.abs(r.y - btn.y) < 1.5 && Math.abs(r.w - btn.w) < 1.5
      && Math.abs(r.h - btn.h * 0.5) < 1.5);
    ok(!!hi, `${tag} 按钮${i + 1} 有上半部高光（drawWoodButton 签名）`);
  });
}

function checkTextReadable(rec, tag) {
  let bad = 0;
  let sample = '';
  for (const t of rec.texts) {
    const L = luminance(t.style);
    if (L === null) {
      // 渐变或未识别色：文字用渐变属于异常写法，按不可判定计失败
      if (typeof t.style !== 'string') { bad++; sample = `${t.text}（非纯色）`; }
      continue;
    }
    const eff = t.alpha < 1
      ? luminance(t.style, { r: 233, g: 245, b: 245 })   // 已含透明度合成
      : L;
    const lum = t.alpha < 1 ? (eff ?? L) : L;
    if (lum > 0.72) { bad++; if (!sample) sample = `「${t.text}」亮度过高 ${lum.toFixed(2)} (${t.style})`; }
  }
  ok(bad === 0, `${tag} 全部 ${rec.texts.length} 条文字都是浅底深字（亮度 ≤ 0.72）`, bad ? `${bad} 条不合格：${sample}` : '');
}

function checkCorners(rec, layout, insets, tag) {
  const chrome = computeChromeLayout(layout.width, layout.height, insets);
  const zones = [
    { name: '左上返回键', ...chrome.back },
    { name: '右上齿轮', ...chrome.gear },
    ...cornerZones(layout.width, insets),
  ];
  const hits = [];
  for (const t of rec.texts) {
    const box = textBox(t);
    for (const z of zones) if (intersects(box, z, 2)) hits.push(`「${t.text}」∩ ${z.name}`);
  }
  ok(hits.length === 0, `${tag} 顶部文字不与返回键/齿轮/56px 角区相交`, hits.join('；'));
}

function checkSafeArea(layout, insets, tag) {
  const bottomLimit = layout.height - (insets.bottom ?? 0) - 16;
  const bad = layout.buttons.filter((b) => b.y + b.h > bottomLimit + 1e-6);
  ok(bad.length === 0, `${tag} 三个按钮底边 ≤ height − insets.bottom − 16（${layout.buttons[0].y + layout.buttons[0].h} ≤ ${bottomLimit}）`);
  const out = layout.buttons.filter((b) => b.x < 0 || b.x + b.w > layout.width || b.y < 0);
  ok(out.length === 0, `${tag} 按钮不出屏`);
}

/** HUD 三行不重叠（只取棋盘上方那三条文字）。 */
function checkHudLines(rec, layout, tag) {
  const hudTexts = rec.texts.filter((t) => t.y < layout.board.y);
  ok(hudTexts.length === 3, `${tag} 棋盘上方正好三行 HUD 文字`, `实际 ${hudTexts.length} 条`);
  const boxes = hudTexts.map(textBox).sort((a, b) => a.y - b.y);
  let overlap = null;
  for (let i = 1; i < boxes.length; i++) {
    if (intersects(boxes[i - 1], boxes[i])) overlap = `第 ${i} 行与第 ${i + 1} 行重叠`;
  }
  ok(overlap === null, `${tag} 顶部 HUD 三行互不重叠`, overlap ?? '');
}

/** 棋盘几何：居中、吃满宽度、格子取到最大、星位数量正确。 */
function checkBoardGeometry(layout, size, tag) {
  const b = layout.board;
  ok(Math.abs((b.x + b.size / 2) - layout.width / 2) <= 1, `${tag} 棋盘水平居中（x=${b.x}）`);
  ok(b.x >= 0 && b.x + b.size <= layout.width, `${tag} 棋盘不越出屏幕（${b.size}px / 屏宽 ${layout.width}）`);
  // 「格子尽量大」的可判定形式：棋盘吃满 90% 屏宽 + cell = 棋盘边长 / 路数（在给定边长下取到最大）
  ok(b.size >= layout.width * 0.9, `${tag} 棋盘吃满屏宽（${b.size}px ≥ ${Math.round(layout.width * 0.9)}px）`);
  ok(Math.abs(b.cell - b.size / size) < 0.01, `${tag} cell = 棋盘边长/路数 = ${b.cell.toFixed(2)}px（格子取到理论最大）`);
  ok(Math.abs(b.inner - b.cell / 2) < 0.01, `${tag} 内边距 = 半格（棋盘边长 = 路数 × 格宽）`);
  const ratio = (b.stoneR * 2) / b.cell;
  ok(ratio > 0.85 && ratio <= 1.0, `${tag} 棋子直径 ≈ 格宽（${ratio.toFixed(2)}）`);
  ok(layout.stars.length === (size === 19 ? 9 : 5), `${tag} 星位 ${layout.stars.length} 个（19 路应为 9 个）`);
  ok(layout.stars.every(([x, y]) => {
    const p = b.toScreen(x, y);
    return p.x >= b.x && p.x <= b.x + b.size && p.y >= b.y && p.y <= b.y + b.size;
  }), `${tag} 星位都落在棋盘范围内`);
  ok(b.y + b.size <= layout.buttons[0].y, `${tag} 棋盘与底部按钮不重叠`);
}

/** 造一个记录「创建了几块离屏画布」的工厂：验证棋盘底缓存只建一次。 */
function makeOffscreenFactory() {
  const log = { calls: 0, canvases: [] };
  const factory = (w, h) => {
    log.calls++;
    const canvas = {
      width: Math.max(1, Math.ceil(w)), height: Math.max(1, Math.ceil(h)),
      __ctx: null,
      getContext() { if (!this.__ctx) this.__ctx = createStubCtx(this); return this.__ctx; },
    };
    log.canvases.push(canvas);
    return canvas;
  };
  factory.log = log;
  return factory;
}

const hasGridStroke = (rec) =>
  rec.strokes.some((s) => s.style === THEME.gridLine || s.style === THEME.gridLineStrong);

/* ───────────────────────── ① 源码扫描 ───────────────────────── */

console.log('\n【一】源码扫描：全屏铺底 / 硬编码浅色 / 木质按钮 / 棋盘缓存');

const renderSrc = readFileSync(`${HERE}render.js`, 'utf8');
const indexSrc = readFileSync(`${HERE}index.js`, 'utf8');

/** 去掉注释只留代码：注释里提到旧写法/规范条款不算违规。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const renderCode = stripComments(renderSrc);
const indexCode = stripComments(indexSrc);

// 与 tools/audit-games.mjs 的 fullscreen-bg 规则同一口径（该规则整文件扫，注释也算，故连原文一起查）
ok(!/fillRect\(\s*0\s*,\s*0\s*,/.test(renderSrc), 'render.js（连注释）无 fillRect(0, 0, …)（对齐 audit-games 规则）');
ok(!/ctx\.clearRect/.test(renderCode), 'render.js 代码内无 clearRect（清屏是集成层职责，规范 §10）');
ok(!/242\s*,\s*243\s*,\s*247/.test(renderSrc), 'render.js（连注释）无深色主题浅字 242,243,247 那组色值');
ok(!/242\s*,\s*243\s*,\s*247/.test(indexCode), 'index.js 代码内无深色主题浅字 242,243,247 那组色值');
ok(/import\s*\{[^}]*drawWoodButton[^}]*\}\s*from\s*'\.\.\/\.\.\/ui\/renderer\.js'/.test(renderCode),
  'render.js 从集成层引入 drawWoodButton（规范 §10 指定复用）');
ok(/drawWoodButton\s*\(/.test(renderCode), 'render.js 实际调用了 drawWoodButton');
// 棋盘尺寸必须来自布局（layout.size / board.size），不能再用模块级常量 SIZE 画 9 路
ok(!/\bfor\s*\([^)]*\bSIZE\b/.test(renderCode), 'render.js 的循环不再用固定的 SIZE 常量（路数由 layout 决定）');
ok(/layout\.size/.test(renderCode), 'render.js 用 layout.size 取当前路数');
ok(/ensureBoardCache/.test(renderCode) && /drawImage/.test(renderCode), 'render.js 有离屏棋盘缓存 + drawImage 复用路径');

/* ───────────────────────── ② 会话单帧（13 路 / 19 路） ───────────────────────── */

const W = 375, H = 812, INSETS = { top: 44, bottom: 34 };
const NOW = 1700000000000;

for (const [key, size] of [['lv2', 13], ['dan5', 19]]) {
  const tag = `${size} 路（${key}）：`;
  console.log(`\n【二】桩 ctx 渲染围棋会话一帧（${W}×${H}，insets top=${INSETS.top} bottom=${INSETS.bottom}，${size} 路）`);
  const session = createSession({
    width: W, height: H, insets: INSETS, difficulty: key, theme: THEME,
  });
  const offscreen = makeOffscreenFactory();
  session.layout.createOffscreen = offscreen;

  // 落两子，让盘面/HUD/最后一手标记都进画面（不终局）
  const c0 = Math.floor(size / 2);
  const p0 = session.layout.board.toScreen(c0, c0);
  session.tap(p0.x, p0.y, NOW);
  session.update(NOW + 600);
  const p1 = session.layout.board.toScreen(c0 - 2, c0 + 2);
  session.tap(p1.x, p1.y, NOW + 1000);
  session.update(NOW + 2000);

  // 多帧：首帧建缓存，之后每帧只贴位图
  const recs = [];
  for (let f = 0; f < 4; f++) {
    const ctx = createStubCtx({ __dpr: 2 });
    session.render(ctx, NOW + 2000 + f * 16);
    recs.push(ctx.rec);
  }
  const rec1 = recs[0];

  const full1 = fullscreenFills(rec1, W, H);
  ok(full1.length === 0, `${tag} 本模块没有任何全屏铺底（fillRect / path 填充）`, full1.map((f) => `${f.how} ${JSON.stringify(f)}`).join('；'));
  checkTextReadable(rec1, tag);
  checkCorners(rec1, session.layout, INSETS, tag);
  checkSafeArea(session.layout, INSETS, tag);
  checkWoodButtons(rec1, session.layout.buttons, tag);
  checkHudLines(rec1, session.layout, tag);
  checkBoardGeometry(session.layout, size, tag);
  ok(rec1.clears.length === 0, `${tag} 本模块不调用 clearRect`);
  ok(recs.every((r) => r.clears.length === 0), `${tag} 连续 4 帧都不 clearRect`);

  // 缓存：离屏只建一次；首帧起就不在上屏画网格线
  ok(offscreen.log.calls === 1, `${tag} 离屏棋盘缓存只创建一次（跨帧复用）`, `实际 ${offscreen.log.calls} 次`);
  ok(recs.every((r) => r.drawImages.length >= 1), `${tag} 每帧只贴一次缓存位图（drawImage）`);
  ok(recs.every((r) => !hasGridStroke(r)), `${tag} 每帧都不在上屏重画网格线/星位`);
  ok(offscreen.log.canvases[0].__ctx.rec.strokes.length > 10,
    `${tag} 静态层（木纹/网格/边框）落在离屏缓存里（${offscreen.log.canvases[0].__ctx.rec.strokes.length} 次描边）`);

  // 终局帧：认输 → 只看 HUD/按钮是否仍合规，且没有自绘深色结算层
  const resignBtn = session.layout.buttons[2];
  session.tap(resignBtn.x + resignBtn.w / 2, resignBtn.y + resignBtn.h / 2, NOW + 3000);
  const ctx2 = createStubCtx({ __dpr: 2 });
  session.render(ctx2, NOW + 3200);
  const rec2 = ctx2.rec;
  ok(session.outcome !== null, `${tag} 认输后 outcome 保持非空（不自动重开，规范 §9）`);
  const full2 = fullscreenFills(rec2, W, H);
  ok(full2.length === 0, `${tag} 终局帧也没有全屏遮罩（结算弹窗由集成层画）`, full2.map((f) => f.how).join('；'));
  checkTextReadable(rec2, tag);
  checkCorners(rec2, session.layout, INSETS, tag);
  checkHudLines(rec2, session.layout, tag);

  // 小屏 / 无安全区：再核一遍安全区与角区
  session.resize(320, 568, { top: 20, bottom: 0 });
  const ctx3 = createStubCtx();
  session.render(ctx3, NOW + 4000);
  checkSafeArea(session.layout, { top: 20, bottom: 0 }, `${tag} 小屏 320×568：`);
  checkCorners(ctx3.rec, session.layout, { top: 20, bottom: 0 }, `${tag} 小屏 320×568：`);
  checkBoardGeometry(session.layout, size, `${tag} 小屏 320×568：`);
  session.destroy();
}

/* ───────────────────────── ③ 集成层合成帧 ───────────────────────── */

console.log('\n【三】集成层合成帧：青白渐变底铺完后，游戏模块不再铺全屏底（13 路 / 19 路）');

let appLoadError = null;
let createGame = null;
let GAMES = null;
try {
  [{ createGame }, { GAMES }] = await Promise.all([
    import('../../app.js'),
    import('../registry.js'),
  ]);
} catch (e) {
  appLoadError = e;
}

// ⚠️ app.js 会把**所有**游戏模块都拉进同一个模块图：别的游戏正被别人改到一半时，
// 这里就会整体导入失败。那不是围棋的问题，所以只警告不判失败（一旦报错里出现 games/go
// 才说明是围棋自己坏了，那时才计失败）。
if (appLoadError) {
  // 从栈里抽出所有出现过的 src/games/<目录>/：只有当**全部**都指向 go 时，才算围棋自己坏了
  const dirs = new Set(
    [...String(appLoadError.stack ?? appLoadError.message ?? '').matchAll(/games[\\/]([a-z0-9]+)[\\/][\w.-]+/g)]
      .map((m) => m[1]),
  );
  const mine = dirs.has('go') && [...dirs].every((d) => d === 'go');
  if (mine) {
    ok(false, '集成层合成帧检查可运行（围棋模块自身可导入）', String(appLoadError.message));
  } else {
    console.log('  ⚠ 跳过【三】：集成层模块图当前不可导入（与围棋无关，多半是别的游戏正被改动）');
    console.log(`    涉及目录：${[...dirs].join(', ') || '未知'}`);
    console.log(`    ${String(appLoadError.message).split('\n')[0]}`);
  }
}

if (createGame && GAMES) {
  try {
    const gi = GAMES.findIndex((g) => g.id === 'go');
    ok(gi >= 0, '注册表里有围棋');
    ok(GAMES[gi].difficulties.length === 6, '注册表里围棋提供 6 个难度档（含段位）');
    ok(GAMES[gi].difficulties.slice(3).every((d) => d.name.includes('段')), '专业档在难度页显示为段位');

  for (const [rowIndex, size, key] of [[1, 13, 'lv2'], [4, 19, 'dan5'], [5, 19, 'dan9']]) {
    const tag = `${size} 路（${key}）：`;
    const game = createGame({ width: W, height: H, insets: INSETS, theme: THEME, bgm: null });
    const hall = game.activeLayout;
    const card = hall.cards[gi];
    game.tap(card.x + card.w / 2, card.y + card.h / 2, NOW);
    ok(game.scene === 'level', `${tag} 大厅点围棋卡片 → 难度页`);
    // ⚠️ 难度页布局必须按**本游戏**的档位数重算：早先 app.js 只在 resize() 里重算，
    //    而真机没有 window resize 事件 → 第 6 档（9 段）点不到。这条断言防它回归。
    ok(game.activeLayout.rows.length === GAMES[gi].difficulties.length,
      `${tag} 难度页行数 = 围棋档位数（${game.activeLayout.rows.length} / ${GAMES[gi].difficulties.length}）`);
    const lv = game.activeLayout.rows[rowIndex];
    ok(!!lv, `${tag} 难度页第 ${rowIndex + 1} 档存在`);
    game.tap(lv.x + lv.w / 2, lv.y + lv.h / 2, NOW + 10);
    ok(game.scene === 'game' && !!game.sessionRef, `${tag} 难度页点击 → 进入围棋对局（module 会话已建）`);

    const s2 = game.sessionRef;
    ok(s2.state.boardSize === size, `${tag} 会话棋盘 ${s2.state.boardSize} 路`);
    ok(s2.state.level === key, `${tag} 会话难度 = ${s2.state.level}`);
    const c1 = s2.layout.board.toScreen(Math.floor(size / 2), Math.floor(size / 2));
    game.tap(c1.x, c1.y, NOW + 20);
    game.update(NOW + 700);

    // 先把「只有集成层」的那一帧录下来：清屏 + 青白渐变底 + 外框（把会话渲染临时换成空操作）
    const origRender = s2.render;
    s2.render = () => {};
    const ctxBase = createStubCtx({ __dpr: 2 });
    game.render(ctxBase, NOW + 780);
    const baseFulls = fullscreenFills(ctxBase.rec, W, H);
    ok(baseFulls.length >= 1, `${tag} 集成层自己铺了全屏底（${baseFulls.length} 处：青白渐变 + 柔光）`);
    s2.render = origRender;

    const ctx4 = createStubCtx({ __dpr: 2 });
    game.render(ctx4, NOW + 800);
    const rec4 = ctx4.rec;

    // 精确归因：游戏模块介入后，全屏填充的**数量不许增加**
    const fulls = fullscreenFills(rec4, W, H);
    ok(fulls.length === baseFulls.length,
      `${tag} 游戏模块没有新增任何全屏铺底（集成层 ${baseFulls.length} 处 → 合成后 ${fulls.length} 处）`,
      fulls.map((f) => f.how).join('；'));
    const bg = baseFulls.find((f) => typeof f.style === 'object' && f.style?.stops
      ?.some((x) => String(x.color).toLowerCase() === String(THEME.bgTop).toLowerCase()));
    const bgStops = bg && typeof bg.style === 'object' ? bg.style.stops.map((x) => String(x.color).toLowerCase()) : [];
    ok(bgStops.includes(String(THEME.bgTop).toLowerCase()) && bgStops.includes(String(THEME.bgBottom).toLowerCase()),
      `${tag} 集成层那一层底确实是青白渐变（bgTop→bgBottom）`, bgStops.join(','));
    const allGrad = fulls.every((f) => typeof f.style === 'object' && Array.isArray(f.style.stops));
    ok(allGrad, `${tag} 所有全屏填充都是渐变（没有深色遮罩式平铺）`, fulls.map((f) => `${f.how}:${typeof f.style}`).join('；'));
    ok(rec4.clears.length >= 1, `${tag} 集成层负责 clearRect（合成帧里有清屏）`);
    checkTextReadable(rec4, tag);
    checkCorners(rec4, s2.layout, INSETS, tag);
    checkSafeArea(s2.layout, INSETS, tag);
    checkWoodButtons(rec4, s2.layout.buttons, tag);
    checkHudLines(rec4, s2.layout, tag);
    checkBoardGeometry(s2.layout, size, tag);

    await Promise.resolve(game.sessionRef?.destroy?.());
    }
  } catch (e) {
    ok(false, '集成层合成帧检查可运行', String(e && e.message));
  }
}

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${passCount} 项，失败 ${failCount} 项`);
if (failCount > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failCount > 0 ? 1 : 0);
