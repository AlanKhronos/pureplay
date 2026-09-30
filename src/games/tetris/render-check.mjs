/**
 * 俄罗斯方块 · UI 适配自检（桩 ctx + 几何断言，纯本地零 token）
 *
 * 用法：node src/games/tetris/render-check.mjs
 *
 * 为什么单独一个文件：UI 适配的结论要能「被数字证明」，而不是靠肉眼印象。
 * 本文件把「背景是否整屏铺底」「按钮是否走木质外观」「顶部是否撞角区」
 * 「按钮是否在安全区内」「浮层文字对比度」全部落成断言，可反复跑。
 * （逻辑测试在 test.mjs；本文件不碰它，只在渲染与几何上把关。）
 *
 * 覆盖：
 *   ① 背景：本模块不再有整屏铺底，也不再有清屏调用（青白底交给集成层，规范 §10）
 *   ② 按钮：6 个操作按钮全部走集成层的 drawWoodButton，文字用深色令牌
 *      （文案契约：加速 / 到底 / 旋转 / 暂停）
 *   ③ 顶部让位：标题居中；NEXT 不撞集成层的左上返回键 / 右上齿轮，也不压棋盘
 *   ④ 底部安全区：按钮最下沿 ≤ height − insets.bottom − 16
 *   ⑤ 浮层：暂停浮层不做全屏遮罩、卡片文字与卡片底色对比度 ≥ 2.5（无隐形字）；
 *      结算弹窗归集成层（规范 §9/§10），模块帧内不再自绘结算文案
 *   ⑥ 变换卫生：一帧渲染里 save/restore 完全配对（规范 §11）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeLayout, renderFrame, buttonOf } from './render.js';
import { computeLayout as uiLayout } from '../../ui/layout.js';
import { THEME } from '../../ui/theme.js';
import { createState } from './core.js';

/* ───────────────────────── 断言小工具 ───────────────────────── */

let pass = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) { pass++; return; }
  failures.push(`${label}${extra ? ' → ' + extra : ''}`);
}
function eq(a, b, label) { ok(a === b, label, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`); }
function near(a, b, tol, label) { ok(Math.abs(a - b) <= tol, label, `${a} 与 ${b} 相差 ${Math.abs(a - b).toFixed(2)} > ${tol}`); }

/* ───────────────────────── 颜色与对比度 ───────────────────────── */

/** '#rgb' / '#rrggbb' / 'rgba(r,g,b,a)' → [r,g,b,a] */
function parseColor(s) {
  const t = String(s).trim();
  if (t.startsWith('#')) {
    const h = t.slice(1);
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(t);
  if (!m) return [0, 0, 0, 1];
  const n = m[1].split(',').map((x) => Number(x.trim()));
  return [n[0], n[1], n[2], n[3] === undefined ? 1 : n[3]];
}

/** 把 fg（可带透明度）叠在 bg（不透明）上。 */
function over(fg, bg) {
  const [r, g, b, a] = parseColor(fg);
  const [br, bg2, bb] = parseColor(bg);
  return [r * a + br * (1 - a), g * a + bg2 * (1 - a), b * a + bb * (1 - a)];
}

/** sRGB 相对亮度。 */
function lum(rgb) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

/** 对比度（WCAG）。 */
function contrast(c1, c2) {
  const a = lum(c1), b = lum(c2);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/* ───────────────────────── 桩 ctx ───────────────────────── */

const WOOD_SHADOW = 'rgba(120,90,30,0.30)';   // drawWoodButton 未禁用时的投影色（唯一指纹）

function makeStub() {
  const rec = {
    rects: [],            // 每次 fillRect 的矩形
    texts: [],            // 每次 fillText 的 { t, x, y, fill, font }
    woodButtons: 0,       // 走 drawWoodButton 的次数（靠投影色指纹数）
    clears: 0,            // 清屏调用次数（必须为 0）
    depth: 0,             // save/restore 深度
    minDepth: 0,
  };
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = {
    canvas: { width: 750, height: 1334 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: 'left', textBaseline: 'top', globalAlpha: 1,
    shadowBlur: 0, shadowOffsetY: 0, _sc: '',
    save() { rec.depth++; },
    restore() { rec.depth--; if (rec.depth < rec.minDepth) rec.minDepth = rec.depth; },
    beginPath: noop, closePath: noop, clip: noop, moveTo: noop, lineTo: noop,
    arc: noop, arcTo: noop, rect: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop, drawImage: noop,
    clearRect() { rec.clears++; },
    fillRect(x, y, w, h) { rec.rects.push({ x, y, w, h }); },
    strokeRect: noop,
    fill: noop, stroke: noop, strokeText: noop,
    fillText(t, x, y) { rec.texts.push({ t: String(t), x, y, fill: ctx.fillStyle, font: ctx.font }); },
    measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => grad, createRadialGradient: () => grad,
  };
  Object.defineProperty(ctx, 'shadowColor', {
    get() { return ctx._sc; },
    set(v) { ctx._sc = v; if (v === WOOD_SHADOW) rec.woodButtons++; },
  });
  return { ctx, rec };
}

const rectHit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/* ═════════════════════ ① 源码级 ═════════════════════ */

console.log('\n【一】源码：不铺全屏、不清屏、按钮走集成层');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const src = readFileSync(`${HERE}render.js`, 'utf8');

ok(!/fillRect\(\s*0\s*,\s*0\s*,/.test(src), 'render.js 里没有「从 (0,0) 铺满全屏」的调用（规范 §10）');
ok(!src.includes('clearRect'), 'render.js 里没有清屏调用（会把集成层的青白底擦掉）');
ok(/from '\.\.\/\.\.\/ui\/renderer\.js'/.test(src), '引用了集成层导出的绘制工具（src/ui/renderer.js）');
ok(src.includes('drawWoodButton(ctx, btn'), '按钮底板走 drawWoodButton（不再自己填色描边）');
ok(!src.includes("'游戏结束'"), 'render.js 不再自绘结算文案（结算弹窗归集成层，规范 §10）');

/* ═════════════════════ ②③④ 几何：多种屏幕 × 安全区 ═════════════════════ */

console.log('\n【二】几何：底部安全区 / 顶部角区 / 棋盘不重叠');

const CASES = [
  [375, 667, { top: 44, bottom: 34 }],
  [390, 844, { top: 47, bottom: 34 }],
  [320, 568, {}],
  [768, 1024, { top: 20, bottom: 20 }],
  [414, 896, { top: 48, bottom: 34 }],
  [430, 932, { top: 59, bottom: 34 }],
];

for (const [w, h, ins] of CASES) {
  const L = computeLayout(w, h, ins);
  const UI = uiLayout(w, h, ins);            // 集成层的真实布局（返回键/齿轮的真实位置）
  const tag = `${w}×${h}`;

  // ④ 底部安全区
  const lowest = Math.max(...L.buttons.map((b) => b.y + b.h));
  ok(lowest <= h - (ins.bottom ?? 0) - 16, `${tag} 按钮不侵占底部安全区（${lowest} ≤ ${h - (ins.bottom ?? 0) - 16}）`);

  // ③ NEXT 不撞左上返回键 / 右上齿轮，也不压棋盘
  const back = UI.back, gear = UI.gear;
  ok(!rectHit(L.next, back), `${tag} NEXT 不压左上返回键`,
    JSON.stringify({ next: L.next, back }));
  ok(!rectHit(L.next, gear), `${tag} NEXT 不压右上齿轮`);
  const boardRect = { x: L.board.x, y: L.board.y, w: L.board.w, h: L.board.h };
  ok(!rectHit(L.next, boardRect), `${tag} NEXT 不压棋盘`,
    JSON.stringify({ next: L.next, board: boardRect }));
  ok(L.next.y >= back.y + back.h, `${tag} NEXT 在角区之下（y=${L.next.y} ≥ 返回键下沿 ${back.y + back.h}）`);
  ok(L.next.y >= (ins.top ?? 0) + 56 - 0.5, `${tag} NEXT 至少让出顶部 56px（y=${L.next.y} ≥ ${(ins.top ?? 0) + 56}）`);

  // ③ 标题带不能落到棋盘上（否则深色棋盘会把令牌文字吃掉）
  ok(!rectHit(L.title, boardRect), `${tag} 标题带不与棋盘重叠`,
    JSON.stringify({ title: L.title, board: boardRect }));

  // ③ 标题居中，且文字带不与角区重叠（按标题 6 个字 × 字号估宽）
  eq(L.title.x + L.title.w / 2, w / 2, `${tag} 标题条水平居中`);
  const titleHalf = (6 * THEME.fontTitle) / 2;
  const gapL = w / 2 - titleHalf - (back.x + back.w);
  const gapR = gear.x - (w / 2 + titleHalf);
  ok(gapL >= 8 && gapR >= 8, `${tag} 标题文字不与两侧角区重叠（左余 ${Math.round(gapL)} / 右余 ${Math.round(gapR)}）`);

  // NEXT 预览框不能小到看不清方块：至少能放下 4 格宽
  ok(L.next.w >= 32 && L.next.h >= 32, `${tag} NEXT 框尺寸可用（${L.next.w}×${L.next.h}）`);
}

/* ═════════════════════ ②⑤ 帧级：桩 ctx 渲染 ═════════════════════ */

console.log('\n【三】帧级：一帧渲染的填充/文字/按钮');

const W = 375, H = 667, INS = { top: 44, bottom: 34 };
const L = computeLayout(W, H, INS);

// —— 进行中 ——
{
  const { ctx, rec } = makeStub();
  const st = createState({ seed: 7 });
  st.status = 'playing';
  renderFrame(ctx, L, st, THEME, 1000);

  eq(rec.clears, 0, '渲染一帧不调用清屏');
  eq(rec.depth, 0, '一帧结束时 save/restore 完全配对');
  eq(rec.minDepth, 0, '没有多余的 restore（不会出现负深度）');

  const full = rec.rects.filter((r) => r.x <= 1 && r.y <= 1 && r.x + r.w >= W - 1 && r.y + r.h >= H - 1);
  eq(full.length, 0, '没有任何一次填充覆盖整屏（背景交给集成层）', JSON.stringify(full));

  eq(rec.woodButtons, 6, '6 个操作按钮全部走 drawWoodButton（木质底板）');

  // 按钮文字：深色令牌墨，落在各自按钮矩形内。
  // 文案是契约（用户要求：速降 → 到底；新增第 6 键 = 加速），改文案就要改这里。
  for (const [key, label] of [['soft', '加速'], ['drop', '到底'], ['rotate', '旋转'], ['pause', '暂停']]) {
    const btn = buttonOf(L, key);
    ok(!!btn, `布局里有 ${key} 按钮`);
    const hit = rec.texts.find((t) => t.t === label && t.x >= btn.x - 1 && t.x <= btn.x + btn.w + 1 && t.y >= btn.y - 1 && t.y <= btn.y + btn.h + 1);
    ok(!!hit, `按钮「${label}」有文字且落在按钮矩形内`);
    if (hit) {
      ok(lum(parseColor(hit.fill)) < 0.25, `按钮「${label}」文字是深色墨（浅色在木底上看不见）`, hit.fill);
    }
  }
  const drop = rec.texts.find((t) => t.t === '到底');
  eq(drop?.fill, THEME.textOnWood, '主操作「到底」的文字用了令牌色 theme.textOnWood');

  // 标题居中（不是被推到角区去的旧写法）
  const title = rec.texts.find((t) => t.t === '俄罗斯方块');
  near(title.x, W / 2, 0.5, '标题文字水平居中');
  // NEXT 标签在预览框内
  const nextLabel = rec.texts.find((t) => t.t === 'NEXT');
  ok(nextLabel && nextLabel.y > L.next.y && nextLabel.y < L.next.y + L.next.h, 'NEXT 标签落在预览框内', JSON.stringify(nextLabel));
}

// —— 暂停浮层（模块仍自绘的唯一浮层卡）——
{
  const { ctx, rec } = makeStub();
  const st = createState({ seed: 7 });
  st.status = 'paused'; st.pausedAt = 0;
  renderFrame(ctx, L, st, THEME, 800);

  const full = rec.rects.filter((r) => r.x <= 1 && r.y <= 1 && r.x + r.w >= W - 1 && r.y + r.h >= H - 1);
  eq(full.length, 0, '暂停浮层不做全屏遮罩（只压暗棋盘这块容器）');
  ok(rec.texts.some((t) => t.t === '已暂停'), '暂停浮层文案「已暂停」照常画出');
  eq(rec.depth, 0, '暂停浮层渲染后 save/restore 配对');
}

// —— 终局帧：结算弹窗归集成层（规范 §9/§10）——
{
  const { ctx, rec } = makeStub();
  const st = createState({ seed: 7 });
  st.status = 'over'; st.overAt = 0;
  renderFrame(ctx, L, st, THEME, 800);

  const full = rec.rects.filter((r) => r.x <= 1 && r.y <= 1 && r.x + r.w >= W - 1 && r.y + r.h >= H - 1);
  eq(full.length, 0, '终局帧不做全屏遮罩');
  ok(!rec.texts.some((t) => t.t === '游戏结束' || t.t === '本局得分'), '结算弹窗归集成层：模块帧内不再自绘结算文案');
  ok(rec.texts.some((t) => t.t === '俄罗斯方块') && rec.texts.some((t) => t.t === '分数'), '终局帧棋盘画面照常渲染（标题/统计仍在）');
  eq(rec.depth, 0, '终局帧渲染后 save/restore 配对');
}

/* ═════════════════════ ⑤ 卡片对比度（无隐形字） ═════════════════════ */

console.log('\n【四】浮层卡片：文字对比度');

{
  // 模块仅剩暂停这一张卡（结算卡已删，归集成层）。
  // 卡片压在「棋盘被局部遮罩压暗」之上：取遮罩后的棋盘近似色，再把卡片底色叠上去
  const dimmedBoard = over('rgba(5,7,12,0.62)', '#0a0d16');   // 暂停层 dimBoard 的实际 alpha
  const card = over(THEME.cardBg, `rgb(${dimmedBoard.map((v) => Math.round(v)).join(',')})`);
  const cardCss = `rgb(${card.map((v) => Math.round(v)).join(',')})`;

  // 旧写法（深色卡片）作为对照，证明这不是"感觉上更好"
  const oldCard = over('rgba(20,24,34,0.97)', `rgb(${dimmedBoard.map((v) => Math.round(v)).join(',')})`);

  const cTitle = contrast(over(THEME.textPrimary, cardCss), card);
  const cMuted = contrast(over(THEME.textMuted, cardCss), card);
  const cOldMuted = contrast(over(THEME.textMuted, `rgb(${oldCard.map((v) => Math.round(v)).join(',')})`), oldCard);

  console.log(`   卡片底色 ${cardCss}：标题 ${cTitle.toFixed(2)}:1，次要文字 ${cMuted.toFixed(2)}:1`);
  console.log(`   （旧的深色卡片方案：次要文字只有 ${cOldMuted.toFixed(2)}:1 —— 那就是"隐形字"）`);

  ok(lum(card) > 0.6, '卡片是浅色木牌（不再用深色卡片）');
  ok(cTitle >= 3, '卡片标题对比度 ≥ 3:1');
  ok(cMuted >= 2.5, '卡片次要文字对比度 ≥ 2.5:1（旧方案 1.7:1 属于隐形）');
  ok(cMuted > cOldMuted * 1.4, '相比旧的深色卡片，次要文字对比度有明显提升', `${cOldMuted.toFixed(2)} → ${cMuted.toFixed(2)}`);
}

/* ═════════════════════ 汇总 ═════════════════════ */

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) { console.log('失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(failures.length === 0 ? 0 : 1);
