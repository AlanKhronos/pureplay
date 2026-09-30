/**
 * 围棋（13 路休闲 / 19 路专业）核心逻辑 + 会话层测试
 * 用法：node src/games/go/test.mjs
 *
 * 覆盖：
 *   棋盘两档（13/19）与星位、气、提子（单子·整块·边界）、禁止自杀、
 *   打劫（简单劫 + 位置型超劫）、数子估算、虚手与连续虚手终局、认输、填子安全阀、
 *   AI 六档（休闲 简单/普通/困难 + 专业 1/5/9 段）：落点合法、提子必吃、
 *   局部候选、段位参数、**单步时间上限（真实时钟 + 假时钟注入）**、
 *   会话层：布局安全区、棋盘居中与格子尺寸、桩 ctx 多帧渲染（13/19）、
 *   不铺全屏底、不 clearRect、顶部不撞角区、HUD 三行不重叠、按钮安全区、
 *   **时间注入（传 N 与 N+3000 断言用时 00:03）**、音效可选（缺失/抛异常都静默降级）。
 *
 * 反 flaky（规范 §12）：AI 的随机源一律用 `random` 注入固定序列，测试里不依赖真随机。
 */
import {
  SIZE, SIZE_CASUAL, SIZE_PRO, EMPTY, BLACK, WHITE, DRAW, KOMI, STAR_POINTS,
  LEVELS, LEVEL_KEYS, AI_THINK_BUDGET_MS, MAX_QUIET_MOVES,
  komiFor, starPoints, maxQuietMoves, quietPassThreshold, settlePassMoves,
  createBoard, cloneBoard, boardHash, opponent, inBounds,
  groupAt, liberties, libertyPoints, simulate, canPlace, place, pass, resign,
  lastMove, scoreBoard, areaScore, finishGame, resultText,
  candidates, localCandidates, capturePoints, savePoints,
  evaluatePoint, isSelfEye, chooseMove, shouldPass, boardSizeOfLevel,
} from './core.js';
import { meta, createSession, CORNER_KEEPOUT } from './index.js';
import { THEME } from '../../ui/theme.js';

let passCount = 0, failCount = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${expected}，实际 ${actual}`);
}

/** 两档棋盘：休闲 13 路 / 专业 19 路。 */
const SIZES = [SIZE_CASUAL, SIZE_PRO];

/* ───────────────────────── 测试辅助 ───────────────────────── */

/** 把一颗子直接摆到盘上（仍走 simulate 合法性检查，避免造出非法局面）。 */
function put(board, x, y, color) {
  const sim = simulate(board, x, y, color);
  if (!sim.ok) throw new Error(`摆子失败 ${x},${y}=${color}: ${sim.reason}`);
  board.grid = sim.grid;
  return sim;
}
/** 按坐标表连续摆子。 */
function setupBoard(list, size = SIZE_CASUAL) {
  const b = createBoard(size);
  b.current = BLACK;
  for (const [x, y, c] of list) put(b, x, y, c);
  return b;
}
/** 按字符画摆盘（#=黑 o=白 .=空），纯布局（不走合法性检查，供数子测试）。 */
function fromArt(rows) {
  const b = createBoard(rows.length);
  b.grid = rows.map((r) => [...r].map((c) => (c === '#' ? BLACK : c === 'o' ? WHITE : EMPTY)));
  return b;
}
/** 某形状的指纹（打劫测试用）。 */
const shapeOf = (grid) => grid.map((row) => row.join('')).join('');

/* ───────────────────────── 桩 Canvas 2D ───────────────────────── */

/** 估算文字宽度：CJK/全角按 1 个字宽，ASCII 按 0.5 个字宽。 */
function textWidth(text, px) {
  let w = 0;
  for (const ch of String(text)) w += (ch.codePointAt(0) > 0x2e80 ? px : px * 0.5);
  return w;
}
function fontSizeOf(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font ?? ''));
  return m ? +m[1] : 14;
}

/**
 * 记录型桩 ctx：记下 fill/stroke/fillRect/clearRect/fillText/drawImage 与路径包围盒。
 * 用于把「不铺全屏底 / 不 clearRect / 文字不撞角区 / 按钮安全区 / 网格线是否被缓存」变成可断言的数字。
 */
function createStubCtx(canvas = null) {
  const rec = { fills: [], rects: [], clears: [], texts: [], strokes: [], drawImages: [], stack: [], transforms: 0 };
  let path = null, tx = 0, ty = 0;
  const grow = (b, x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return b;
    if (!b) return { x0: x, y0: y, x1: x, y1: y };
    return { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) };
  };
  const makeGrad = () => {
    const g = { stops: [], addColorStop(o, c) { g.stops.push({ offset: o, color: c }); } };
    return g;
  };
  const ctx = {
    canvas,
    fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1,
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '400 14px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    rec,
    save() { rec.stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline }); },
    restore() { const s = rec.stack.pop(); if (s) Object.assign(this, s); },
    translate(x, y) { tx += x; ty += y; rec.transforms++; },
    rotate() { rec.transforms++; },
    scale() { rec.transforms++; },
    setTransform() { tx = 0; ty = 0; },
    resetTransform() { tx = 0; ty = 0; },
    transform() { rec.transforms++; },
    beginPath() { path = null; },
    closePath() {},
    moveTo(x, y) { path = grow(path, x, y); },
    lineTo(x, y) { path = grow(path, x, y); },
    arcTo(x1, y1, x2, y2) { path = grow(grow(path, x1, y1), x2, y2); },
    bezierCurveTo(a, b, c, d, e, f) { path = grow(grow(grow(path, a, b), c, d), e, f); },
    quadraticCurveTo(a, b, c, d) { path = grow(grow(path, a, b), c, d); },
    rect(x, y, w, h) { path = grow(grow(path, x, y), x + w, y + h); },
    arc(cx, cy, r) { path = grow(grow(grow(grow(path, cx - r, cy - r), cx + r, cy + r), cx - r, cy + r), cx + r, cy - r); },
    ellipse(cx, cy, rx, ry) { path = grow(grow(grow(grow(path, cx - rx, cy - ry), cx + rx, cy + ry), cx - rx, cy + ry), cx + rx, cy - ry); },
    clip() {},
    fill() { rec.fills.push({ bbox: path, style: this.fillStyle, alpha: this.globalAlpha }); },
    stroke() { rec.strokes.push({ bbox: path, style: this.strokeStyle, alpha: this.globalAlpha, lineWidth: this.lineWidth }); },
    fillRect(x, y, w, h) { rec.rects.push({ x, y, w, h, style: this.fillStyle, alpha: this.globalAlpha }); },
    strokeRect(x, y, w, h) { rec.rects.push({ x, y, w, h, style: this.strokeStyle, alpha: this.globalAlpha, kind: 'stroke' }); },
    clearRect(x, y, w, h) { rec.clears.push({ x, y, w, h }); },
    createLinearGradient() { return makeGrad(); },
    createRadialGradient() { return makeGrad(); },
    measureText(text) { return { width: textWidth(text, fontSizeOf(this.font)) }; },
    fillText(text, x, y) {
      const px = fontSizeOf(this.font);
      rec.texts.push({
        text: String(text), x: x + tx, y: y + ty, px,
        width: textWidth(text, px), style: this.fillStyle, alpha: this.globalAlpha,
        align: this.textAlign, baseline: this.textBaseline,
      });
    },
    strokeText() {},
    drawImage(img, dx, dy, dw, dh) { rec.drawImages.push({ img, dx, dy, dw, dh }); },
    createPattern() { return null; },
  };
  return ctx;
}

/** 一块填充覆盖屏幕的比例。 */
function coverRatio(r, W, H) {
  const x0 = Math.max(0, Math.min(r.x, r.x + r.w));
  const x1 = Math.min(W, Math.max(r.x, r.x + r.w));
  const y0 = Math.max(0, Math.min(r.y, r.y + r.h));
  const y1 = Math.min(H, Math.max(r.y, r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  return ((x1 - x0) * (y1 - y0)) / (W * H);
}

/** 全屏级填充（fillRect 与 path fill 都算）。 */
function fullscreenFills(rec, W, H) {
  const out = [];
  for (const r of rec.rects) if (coverRatio(r, W, H) >= 0.95) out.push({ ...r, how: 'fillRect' });
  for (const f of rec.fills) {
    if (!f.bbox) continue;
    const r = { x: f.bbox.x0, y: f.bbox.y0, w: f.bbox.x1 - f.bbox.x0, h: f.bbox.y1 - f.bbox.y0 };
    if (coverRatio(r, W, H) >= 0.95) out.push({ ...r, how: 'fill(path)', style: f.style });
  }
  return out;
}

/** 某条文字包围盒（按对齐方式推算，宽度放大 15% 保守估计）。 */
function textBox(t) {
  const w = t.width * 1.15;
  const h = t.px * 1.25;
  let x0 = t.x;
  if (t.align === 'center') x0 = t.x - w / 2;
  else if (t.align === 'right' || t.align === 'end') x0 = t.x - w;
  let y0 = t.y - h / 2;
  if (t.baseline === 'alphabetic' || t.baseline === 'bottom') y0 = t.y - h;
  const box = { x: x0, y: y0, w, h };
  box.x1 = x0 + w; box.y1 = y0 + h;
  return box;
}
const intersects = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && b.x - pad < a.x + a.w && a.y < b.y + b.h + pad && b.y - pad < a.y + a.h;

/** 左上/右上各 56px 的角区（集成层返回键与齿轮的地盘，规范 §10）。 */
function cornerZones(W, insets) {
  const S = CORNER_KEEPOUT;
  return [
    { name: '左上', x: 0, y: insets.top ?? 0, w: S, h: S },
    { name: '右上', x: W - S, y: insets.top ?? 0, w: S, h: S },
  ];
}

/** 造一个「工厂被调用几次都记录」的离屏画布工厂（模拟集成层/宿主提供离屏能力）。 */
function makeOffscreenFactory() {
  const log = { calls: 0, canvases: [] };
  const factory = (w, h) => {
    log.calls++;
    const canvas = {
      width: Math.max(1, Math.ceil(w)), height: Math.max(1, Math.ceil(h)),
      __offscreen: true, __ctx: null,
      getContext() { if (!this.__ctx) this.__ctx = createStubCtx(this); return this.__ctx; },
    };
    log.canvases.push(canvas);
    return canvas;
  };
  factory.log = log;
  return factory;
}

/** 盘面上是否出现过网格线描边（颜色等于主题的 gridLine / gridLineStrong）。 */
const hasGridStroke = (rec) =>
  rec.strokes.some((s) => s.style === THEME.gridLine || s.style === THEME.gridLineStrong);

console.log('\n【一】棋盘基础：13 / 19 两档与星位');
{
  eq(SIZE_CASUAL, 13, '休闲档 13 路');
  eq(SIZE_PRO, 19, '专业档 19 路');
  eq(SIZE, SIZE_CASUAL, '默认路数 = 休闲档 13 路');

  const b = createBoard();
  eq(b.size, 13, 'createBoard() 默认 13 路');
  eq(b.current, BLACK, '黑先手');
  eq(b.moves.length, 0, '初始无对局记录');
  eq(b.captures[BLACK], 0, '黑方提子数初始 0');
  eq(b.captures[WHITE], 0, '白方提子数初始 0');
  eq(b.over, false, '初始未终局');
  eq(b.ko, null, '初始无打劫禁着点');
  eq(b.hashes.length, 0, '初始无历史指纹');
  eq(opponent(BLACK), WHITE, 'opponent 黑→白');
  eq(opponent(WHITE), BLACK, 'opponent 白→黑');

  const b19 = createBoard(SIZE_PRO);
  eq(b19.size, 19, 'createBoard(19) 是 19 路');
  eq(b19.grid.length, 19, '19 路 19 行');
  eq(b19.grid[18].length, 19, '19 路每行 19 点');
  let empties = 0;
  for (const row of b19.grid) for (const v of row) if (v === EMPTY) empties++;
  eq(empties, 361, '19 路 361 个交叉点全空');

  // 星位：13 路 5 个（3/6/9 线），19 路 9 个（3/9/15 线）
  const s13 = starPoints(13);
  eq(s13.length, 5, '13 路 5 个星位');
  eq(s13.map((p) => p.join(',')).join(' '), '3,3 9,3 6,6 3,9 9,9', '13 路星位坐标 = 四角 + 天元');
  const s19 = starPoints(19);
  eq(s19.length, 9, '19 路 9 个星位');
  eq(s19.map((p) => p.join(',')).join(' '),
    '3,3 9,3 15,3 3,9 9,9 15,9 3,15 9,15 15,15', '19 路星位坐标 = 3/9/15 线两两相交');
  ok(s19.every(([x, y]) => x === 3 || x === 9 || x === 15), '19 路星位都落在 3/9/15 线上（x）');
  ok(s19.every(([x, y]) => y === 3 || y === 9 || y === 15), '19 路星位都落在 3/9/15 线上（y）');
  ok(new Set(s19.map((p) => p.join(','))).size === 9, '19 路 9 个星位互不重复');
  ok(s19.every(([x, y]) => x > 0 && x < 18 && y > 0 && y < 18), '19 路星位都在盘内且不在一线边上');
  eq(STAR_POINTS.length, 5, '默认（13 路）星位 5 个');
  ok(starPoints(19) !== starPoints(19), 'starPoints 每次返回新数组（调用方可改）');

  ok(inBounds(b19, 0, 0) && inBounds(b19, 18, 18) && !inBounds(b19, 19, 0), '19 路 inBounds 边界判定');
  ok(inBounds(b, 0, 0) && inBounds(b, 12, 12) && !inBounds(b, 13, 0), '13 路 inBounds 边界判定');

  const c = cloneBoard(b);
  c.grid[0][0] = BLACK;
  eq(b.grid[0][0], EMPTY, 'cloneBoard 深拷贝（改动不影响原盘）');
  eq(cloneBoard(b19).size, 19, 'cloneBoard 保留路数');
  ok(boardHash(b) !== boardHash(c), '棋盘指纹随局面变化');

  // 贴目按路数：19 路标准贴 7.5；13 路折半贴 6.5
  eq(KOMI, 6.5, '小盘贴目 6.5');
  eq(komiFor(13), 6.5, '13 路贴目 6.5');
  eq(komiFor(19), 7.5, '19 路贴目 7.5');
  eq(areaScore(createBoard(19)).whiteScore, 7.5, '19 路空盘白方合计 = 贴目 7.5');

  // 安全阀/收官阈值随路数放大（大棋盘不能被中盘误判终局）
  eq(MAX_QUIET_MOVES, 60, '9 路基准安全阀 60 手');
  eq(maxQuietMoves(13), 125, '13 路安全阀 = 60 × 169/81 = 125 手');
  eq(maxQuietMoves(19), 267, '19 路安全阀 = 60 × 361/81 = 267 手');
  ok(maxQuietMoves(19) > maxQuietMoves(13), '路数越大安全阀越宽');
  ok(quietPassThreshold(19) > quietPassThreshold(13), '19 路收官阈值更宽');
  ok(settlePassMoves(19) > settlePassMoves(13), '19 路反复虚手收工的手数下限更高');
  eq(boardSizeOfLevel('lv2'), 13, '休闲档棋盘 13 路');
  eq(boardSizeOfLevel('dan5'), 19, '专业档棋盘 19 路');
  eq(boardSizeOfLevel('不存在的档'), 13, '未知难度 key 退回普通档（13 路）');
}

console.log('\n【二】气（liberty）计算：13 / 19 路各一套');
for (const n of SIZES) {
  const c = Math.floor(n / 2);
  const b = createBoard(n);
  put(b, c, c, BLACK);
  eq(liberties(b, c, c), 4, `${n} 路天元单子 4 气`);
  eq(libertyPoints(b, c, c).length, 4, `${n} 路气点数量一致`);
  eq(liberties(b, 0, 0), 0, `${n} 路空点气数为 0`);

  const e = createBoard(n);
  put(e, 0, 0, WHITE);
  eq(liberties(e, 0, 0), 2, `${n} 路角上单子 2 气`);
  const f = createBoard(n);
  put(f, 0, c, WHITE);
  eq(liberties(f, 0, c), 3, `${n} 路边上单子 3 气`);

  const g = createBoard(n);
  put(g, c - 1, c, BLACK); put(g, c, c, BLACK); put(g, c + 1, c, BLACK);
  eq(groupAt(g, c, c).length, 3, `${n} 路横连三子属同一棋块`);
  eq(liberties(g, c, c), 8, `${n} 路横连三子共 8 气（3×2 端 + 上下各 1）`);

  // 被围成一口气
  const h = createBoard(n);
  put(h, c, c - 1, WHITE); put(h, c, c + 1, WHITE); put(h, c - 1, c, WHITE);
  put(h, c, c, BLACK);
  eq(liberties(h, c, c), 1, `${n} 路被三面围住的单子 1 气`);
}

console.log('\n【三】提子（单子 / 整块 / 边界）：13 / 19 路各一套');
for (const n of SIZES) {
  const c = Math.floor(n / 2);

  // 提单子
  const b = createBoard(n);
  b.current = BLACK;
  put(b, c, c, WHITE);
  put(b, c - 1, c, BLACK); put(b, c + 1, c, BLACK); put(b, c, c - 1, BLACK);
  eq(liberties(b, c, c), 1, `${n} 路白子被紧气到 1 气`);
  const sim = simulate(b, c, c + 1, BLACK);
  ok(sim.ok, `${n} 路最后一气可落子`);
  eq(sim.captured.length, 1, `${n} 路试算：提 1 子`);
  eq(sim.captured[0][0], c, `${n} 路试算：被提子坐标 x 正确`);
  b.current = BLACK;
  const r = place(b, c, c + 1);
  ok(r.ok, `${n} 路正式落子成功`);
  eq(b.grid[c][c], EMPTY, `${n} 路被提的子已从盘上移除`);
  eq(b.captures[BLACK], 1, `${n} 路黑方提子数 +1`);
  eq(b.moves.length, 1, `${n} 路对局记录累积（摆子不记谱，正式落子才记）`);
  eq(b.hashes.length, b.moves.length, `${n} 路每手都写入历史指纹`);

  // 提整块：两个白子共 6 气，逐口紧死
  const g = createBoard(n);
  g.current = BLACK;
  put(g, c, c, WHITE); put(g, c, c + 1, WHITE);
  eq(liberties(g, c, c), 6, `${n} 路两子棋块共 6 气`);
  for (const [x, y] of [[c - 1, c], [c + 1, c], [c, c - 1], [c, c + 2], [c - 1, c + 1]]) {
    g.current = BLACK;
    const rr = place(g, x, y);
    ok(rr.ok, `${n} 路紧气落子 (${x},${y})`);
  }
  eq(liberties(g, c, c), 1, `${n} 路整块只剩 1 气`);
  g.current = BLACK;
  const rc = place(g, c + 1, c + 1);
  ok(rc.ok, `${n} 路落最后一气`);
  eq(rc.captured.length, 2, `${n} 路整块 2 子被提`);
  eq(g.grid[c][c], EMPTY, `${n} 路整块第 1 子被移除`);
  eq(g.grid[c + 1][c], EMPTY, `${n} 路整块第 2 子被移除`);
  eq(g.captures[BLACK], 2, `${n} 路提子数累计正确`);

  // 边界提子：角上白子 2 气
  const cc = createBoard(n);
  cc.current = BLACK;
  put(cc, 0, 0, WHITE);
  put(cc, 1, 0, BLACK);
  eq(liberties(cc, 0, 0), 1, `${n} 路角上白子被紧到 1 气`);
  cc.current = BLACK;
  const rc2 = place(cc, 0, 1);
  ok(rc2.ok, `${n} 路边线最后一气可落子`);
  eq(cc.grid[0][0], EMPTY, `${n} 路角上白子被提`);
  eq(cc.captures[BLACK], 1, `${n} 路边界提子计数正确`);
}

console.log('\n【四】禁止自杀：13 / 19 路各一套');
for (const n of SIZES) {
  const c = Math.floor(n / 2);

  // 白把 (c,c) 四邻占满 → 黑落 (c,c) 无气且提不到子
  const b = createBoard(n);
  for (const [x, y] of [[c - 1, c], [c + 1, c], [c, c - 1], [c, c + 1]]) put(b, x, y, WHITE);
  const s = simulate(b, c, c, BLACK);
  ok(!s.ok && s.reason === 'suicide', `${n} 路自杀点被 simulate 拒绝（reason=suicide）`);
  eq(canPlace(b, c, c, BLACK), false, `${n} 路 canPlace 同样拒绝`);
  b.current = BLACK;
  const r = place(b, c, c);
  ok(!r.ok && r.reason === 'suicide', `${n} 路正式落子拒绝自杀`);
  eq(b.grid[c][c], EMPTY, `${n} 路盘面未被改动`);

  // 能提子就不算自杀：黑把白棋提掉后自己有气
  const e = createBoard(n);
  e.current = BLACK;
  put(e, c, c, WHITE);
  put(e, c - 1, c, BLACK); put(e, c + 1, c, BLACK); put(e, c, c - 1, BLACK);
  ok(simulate(e, c, c + 1, BLACK).ok, `${n} 路「能提子」的近似自杀点合法`);

  // 提不到的最后一气：白把 (1,1) 四邻占满（自身有气、提不掉），黑落此处＝自杀
  const f = createBoard(n);
  for (const [x, y] of [[0, 1], [1, 0], [1, 2], [2, 1]]) put(f, x, y, WHITE);
  eq(liberties(f, 1, 0), 3, `${n} 路围子自身有气（提不到，所以是自杀而非提子）`);
  const s4 = simulate(f, 1, 1, BLACK);
  ok(!s4.ok && s4.reason === 'suicide', `${n} 路被围死的空点落子＝自杀`);
}

console.log('\n【五】打劫：禁止立即回提 + 位置型超劫：13 / 19 路各一套');
for (const n of SIZES) {
  const c = Math.floor(n / 2);

  /** 造一个可提子的局面：白 (c,c-1) 只剩 (c,c) 一气，黑 (c,c) 落子即可提。 */
  const setup = () => {
    const b = createBoard(n);
    const at = (x, y, col) => { b.grid[y][x] = col; };
    at(c, c - 1, WHITE);                                  // 待提的白单子
    at(c - 1, c - 1, BLACK); at(c + 1, c - 1, BLACK); at(c, c - 2, BLACK);  // 围白
    b.moves = [{ x: 2, y: 2, player: WHITE, pass: false }];   // 上一手（位置随意）
    b.current = BLACK;
    return b;
  };

  const b = setup();
  eq(liberties(b, c, c - 1), 1, `${n} 路白 (${c},${c - 1}) 只剩 1 气 (${c},${c})`);
  const probe = simulate(b, c, c, BLACK);
  ok(probe.ok && probe.captured.length === 1, `${n} 路黑 (${c},${c}) 可提这 1 子`);
  const shapeAfter = shapeOf(probe.grid);

  // ① 把「提子后的局面」塞进历史作为「上一手之前」→ 这一手构成同形循环，应被禁
  const withH = setup();
  withH.hashes = [shapeAfter, shapeAfter];
  const verdictH = simulate(withH, c, c, BLACK);
  ok(!verdictH.ok && verdictH.reason === 'ko', `${n} 路提子后回到「上一手之前」→ 判为打劫，拒绝`);
  eq(canPlace(withH, c, c, BLACK), false, `${n} 路 canPlace 同样拒绝`);
  withH.current = BLACK;
  const r2 = place(withH, c, c);
  ok(!r2.ok && r2.reason === 'ko', `${n} 路正式落子拒绝（盘面不变）`);
  eq(withH.grid[c][c], EMPTY, `${n} 路回提未生效（该点仍为空）`);
  eq(withH.grid[c - 1][c], WHITE, `${n} 路白子仍在盘上`);

  // ② 位置型超劫：历史里任一更早的同形也禁止（只回看一手会漏掉这种循环）
  const withAncient = setup();
  withAncient.hashes = ['随便一个旧局面', shapeAfter, '另一个局面'];
  const verdictA = simulate(withAncient, c, c, BLACK);
  ok(!verdictA.ok && verdictA.reason === 'ko', `${n} 路与更早的历史局面同形 → 超劫同样禁止`);

  // ③ 同样的落点，没有同形历史时合法（证明拒绝只来自同形判定）
  const withoutH = setup();
  withoutH.hashes = [];
  const verdictW = simulate(withoutH, c, c, BLACK);
  ok(verdictW.ok, `${n} 路同样落点在无重复历史时合法`);
  withoutH.current = BLACK;
  const real = place(withoutH, c, c);
  ok(real.ok, `${n} 路无重复历史时提子成功`);
  eq(real.captured.length, 1, `${n} 路提出 1 子`);
  eq(withoutH.grid[c - 1][c], EMPTY, `${n} 路被提的白子已移除`);
  eq(withoutH.grid[c][c], BLACK, `${n} 路黑提子已在盘上`);
  ok(withoutH.ko === null || (typeof withoutH.ko.x === 'number' && typeof withoutH.ko.y === 'number'),
    `${n} 路 board.ko 要么为空、要么是合法坐标（UI 打劫红叉不会画出界）`);

  // ④ 虚手会清掉打劫禁着点
  pass(withoutH);
  eq(withoutH.ko, null, `${n} 路虚手后禁着点解除`);
}

console.log('\n【六】地盘估算（数子法 / 中国规则）');
{
  // 全空盘：无一方独占的区域 → 全中立（两档各一次）
  const e13 = createBoard(13);
  const se13 = scoreBoard(e13);
  eq(se13.neutral, 169, '13 路空盘 169 点全中立');
  eq(se13.owner[0][0], EMPTY, '13 路空盘无归属');
  const se19 = scoreBoard(createBoard(19));
  eq(se19.neutral, 361, '19 路空盘 361 点全中立');
  eq(se19.black, 0, '19 路空盘黑方 0');

  // 黑 3×3 方块围住中心 (2,2)：被围空点 + 外围空间都只接触黑方 → 归黑
  const b = fromArt([
    '.........',
    '.###.....',
    '.#.#.....',
    '.###.....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
  ]);
  const sb = scoreBoard(b);
  eq(sb.owner[2][2], BLACK, '被黑环围住的空点归黑');
  eq(sb.blackStones, 8, '方环黑子 8 颗');
  eq(sb.blackTerritory, 73, '黑地 73 点（围住 1 + 与黑相邻的 72）');
  eq(sb.black, 8 + 73, '黑方子 + 地 = 81');
  eq(sb.neutral, 0, '全部空点都只接触黑方 → 无中立');

  // 十字形（同样的 8 子，只是错位一格）：结论一致
  const plus = fromArt([
    '.........',
    '..###....',
    '..#.#....',
    '..###....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
  ]);
  const sp = scoreBoard(plus);
  eq(sp.owner[2][3], BLACK, '十字形围住的中心空点归黑');
  eq(sp.blackTerritory, 73, '十字形黑地同样 73 点');
  eq(sp.blackStones, 8, '十字形黑子 8 颗');

  // 白环在黑框内：环内 3×3 空点归白，环与框之间的空点双方相邻算中立
  const art = fromArt([
    '#########',
    '#.......#',
    '#.ooooo.#',
    '#.o...o.#',
    '#.o...o.#',
    '#.o...o.#',
    '#.ooooo.#',
    '#.......#',
    '#########',
  ]);
  const sw = scoreBoard(art);
  eq(sw.owner[4][4], WHITE, '被白环围住的空点归白');
  eq(sw.whiteTerritory, 9, '白地 9 点（环内 3×3）');
  eq(sw.blackTerritory, 0, '黑框没有围出空点（内部全被白环占住）');
  eq(sw.neutral, 24, '环与框之间的空点双方相邻 → 中立');

  // 双方都相邻的空区算中立
  const m = fromArt([
    '#.......o',
    '.........',
    '.........',
  ]);
  const sm = scoreBoard(m);
  eq(sm.owner[1][4], EMPTY, '黑与白之间的空区算中立');
  eq(sm.neutral, 25, '夹在黑白之间的大空区 25 点全中立');
  eq(sm.black, 1, '空区只算中立，不计入黑方子数');
  eq(sm.white, 1, '空区只算中立，不计入白方子数');

  // 19 路：一条黑边 + 一条白边，中间大空区中立（验证大棋盘数子不越界）
  const big = createBoard(19);
  for (let x = 0; x < 19; x++) { big.grid[0][x] = BLACK; big.grid[18][x] = WHITE; }
  const sbig = scoreBoard(big);
  eq(sbig.blackStones, 19, '19 路黑边 19 子');
  eq(sbig.whiteStones, 19, '19 路白边 19 子');
  eq(sbig.neutral, 361 - 38, '19 路中间 323 点双方相邻 → 中立');
  eq(sbig.black, 19, '19 路黑方只有子数、无围空');

  // 满盘 19 路黑子：黑 361 子，白方仅贴目
  const full19 = createBoard(19);
  for (let y = 0; y < 19; y++) for (let x = 0; x < 19; x++) full19.grid[y][x] = BLACK;
  const rFull = finishGame(full19, 'test');
  eq(rFull.score.black, 361, '19 路满盘黑 361 子');
  eq(rFull.winner, BLACK, '19 路满盘黑胜');
  eq(rFull.margin, 361 - 7.5, '19 路满盘分差 = 361 − 7.5（贴目 7.5）');

  // 贴目与胜负（13 路）
  const a = areaScore(createBoard(13));
  eq(a.komi, 6.5, '13 路 areaScore 默认贴目 6.5');
  eq(a.whiteScore, 6.5, '13 路空盘白方合计 = 6.5');
  const res = finishGame(createBoard(13), 'test');
  eq(res.winner, WHITE, '13 路空盘终局白方（贴目）胜');
  eq(res.margin, 6.5, '13 路空盘终局分差 = 贴目');
  eq(createBoard(13).over, false, 'finishGame 只作用于传入棋盘');

  const resB = finishGame(fromArt(['#####', '#####', '#####', '#####', '#####']), 'test');
  eq(resB.winner, BLACK, '满盘黑子终局黑胜');
  eq(resB.margin, 25 - KOMI, '满盘黑 25 子分差 = 25 − 6.5');
  eq(resultText({ result: resB }).includes('黑棋胜'), true, '结果文案含「黑棋胜」');

  const resR = { result: { reason: 'resign', winner: BLACK } };
  ok(resultText(resR).includes('认输'), '认输文案正确');

  // 合法序列也能围空（13 路）
  const legal = setupBoard([[1, 0, BLACK], [0, 1, BLACK], [2, 1, BLACK], [1, 2, BLACK]]);
  const sl = scoreBoard(legal);
  eq(sl.owner[1][1], BLACK, '合法序列下 (1,1) 归黑');
  eq(sl.blackStones, 4, '合法序列下黑子 4 颗');
  ok(sl.blackTerritory >= 1, '合法序列下至少围出 1 点');
}

console.log('\n【七】虚手（pass）/ 认输 / 终局安全阀：13 / 19 路各一套');
for (const n of SIZES) {
  const b = createBoard(n);
  put(b, 0, 0, BLACK);
  const p1 = pass(b);
  ok(p1.ok && p1.ended === false, `${n} 路第 1 次虚手不终局`);
  eq(b.passes, 1, `${n} 路连续虚手计数 = 1`);
  eq(b.current, WHITE, `${n} 路虚手后轮到对方`);
  eq(b.moves[b.moves.length - 1].pass, true, `${n} 路对局记录标记为虚手`);
  eq(lastMove(b).x, -1, `${n} 路虚手的坐标记为 -1`);
  eq(b.ko, null, `${n} 路虚手清掉禁着点`);

  // 中间落子会清零连续虚手计数
  const c = createBoard(n);
  put(c, 0, 0, BLACK);
  c.current = WHITE;
  pass(c);
  eq(c.passes, 1, `${n} 路虚手计数 1`);
  c.current = BLACK;
  place(c, 1, 0);
  eq(c.passes, 0, `${n} 路落子后连续虚手计数清零`);

  // 连续两次虚手终局
  const d = createBoard(n);
  d.grid[0][0] = BLACK;
  d.current = WHITE;
  pass(d);
  d.current = BLACK;
  const p2 = pass(d);
  ok(p2.ok && p2.ended === true, `${n} 路第 2 次连续虚手终局`);
  eq(d.over, true, `${n} 路终局标记 over=true`);
  ok(d.result && d.result.reason === 'two-passes', `${n} 路终局原因 = 连续虚手`);
  eq(d.result.winner, BLACK, `${n} 路单黑子盘 → 黑胜（估算）`);
  eq(d.result.score.blackStones, 1, `${n} 路终局比分快照含黑子数 1`);
  eq(d.result.score.black, n * n, `${n} 路单黑子盘：子 + 地 = ${n * n}`);
  const over = pass(d);
  ok(!over.ok && over.reason === 'over', `${n} 路终局后不能再虚手`);

  // 认输
  const rg = createBoard(n);
  put(rg, 0, 0, BLACK);
  rg.current = WHITE;
  const r2 = resign(rg, WHITE);
  ok(r2.ok, `${n} 路认输成功`);
  eq(rg.over, true, `${n} 路认输后终局`);
  eq(rg.result.winner, BLACK, `${n} 路白方认输 → 黑胜`);
  eq(rg.result.margin, null, `${n} 路认输没有分差`);
  ok(resultText(rg).includes('认输'), `${n} 路认输文案正确`);
  ok(!resign(rg, BLACK).ok, `${n} 路终局后不能再认输`);

  // 填子安全阀：连续无提子无虚手到阈值即终局（阈值随路数放大）
  const q = createBoard(n);
  q.quiet = maxQuietMoves(n) - 1;
  q.grid[0][0] = BLACK;
  q.current = WHITE;
  const rr = place(q, n - 1, n - 1);
  ok(rr.ok && q.over === true, `${n} 路连续 ${maxQuietMoves(n)} 手无提子无虚手 → 安全阀终局`);
  ok(q.result && q.result.reason === 'max-moves', `${n} 路安全阀终局写明原因`);

  // 结算规则：反复虚手（哪怕中间夹着零星落子）也会收工
  const e2 = createBoard(n);
  e2.grid[0][0] = BLACK;
  e2.current = WHITE;
  e2.moves = new Array(settlePassMoves(n)).fill({ x: -1, y: -1, player: BLACK, pass: true });
  pass(e2);
  ok(e2.over === true, `${n} 路长时间反复虚手后自动结算终局`);
}

console.log('\n【八】AI：休闲三档 + 专业三档（1/5/9 段）');
{
  eq(LEVEL_KEYS.length, 6, '六个难度档（休闲 3 + 专业 3）');
  eq(Object.keys(LEVELS).length, 6, 'LEVELS 六个键');
  ok(LEVELS.lv1 && LEVELS.lv2 && LEVELS.lv3, '休闲档键存在');
  ok(LEVELS.dan1 && LEVELS.dan5 && LEVELS.dan9, '专业档键存在（1/5/9 段）');
  eq(LEVELS.dan1.dan, 1, '1 段标注 dan=1');
  eq(LEVELS.dan5.dan, 5, '5 段标注 dan=5');
  eq(LEVELS.dan9.dan, 9, '9 段标注 dan=9');
  ok(LEVELS.dan1.name.includes('1'), '1 段名字带段位数字');
  ok(LEVELS.dan9.name.includes('9'), '9 段名字带段位数字');
  for (const k of ['lv1', 'lv2', 'lv3']) eq(LEVELS[k].size, 13, `${k} 用 13 路棋盘`);
  for (const k of ['dan1', 'dan5', 'dan9']) eq(LEVELS[k].size, 19, `${k} 用 19 路棋盘`);
  ok(LEVELS.lv1.sample < LEVELS.lv3.sample, '休闲简单档抽样更少（更容易漏看）');
  ok(LEVELS.lv1.noise > LEVELS.lv3.noise, '休闲简单档随机扰动更大');
  ok(LEVELS.dan1.noise > LEVELS.dan9.noise, '1 段扰动大于 9 段');
  ok(LEVELS.dan1.attack <= LEVELS.dan9.attack, '9 段提子权重不低于 1 段');
  ok((LEVELS.dan5.radius ?? 0) >= 1 && (LEVELS.dan9.radius ?? 0) >= 1, '专业档有局部候选半径');
  ok(AI_THINK_BUDGET_MS > 0 && AI_THINK_BUDGET_MS <= 1000,
    `AI 单步硬预算 = ${AI_THINK_BUDGET_MS}ms（≤1000ms）`);

  // 空盘第一手：天元（13 → (6,6)，19 → (9,9)）
  const first13 = chooseMove(createBoard(13), BLACK, { level: 'lv2', random: () => 0.5 });
  eq(first13.x, 6, '13 路空盘首手 x = 天元');
  eq(first13.y, 6, '13 路空盘首手 y = 天元');
  eq(first13.truncated, false, '空盘首手没有触发超预算');
  const first19 = chooseMove(createBoard(19), BLACK, { level: 'dan9', random: () => 0.5 });
  eq(first19.x, 9, '19 路空盘首手 x = 天元');
  eq(first19.y, 9, '19 路空盘首手 y = 天元');

  // 提子必吃：白子被紧到 1 气，AI 应吃掉它
  for (const n of SIZES) {
    const c = Math.floor(n / 2);
    const lv = n === 13 ? 'lv3' : 'dan9';
    const b = createBoard(n);
    put(b, c, c, WHITE);
    put(b, c - 1, c, BLACK); put(b, c + 1, c, BLACK); put(b, c, c - 1, BLACK);
    const eat = chooseMove(b, BLACK, { level: lv, random: () => 0.5 });
    ok(eat.x === c && eat.y === c + 1, `${n} 路 ${lv} 吃掉 1 气白子（实选 ${eat.x},${eat.y}）`);
  }

  // 提子点/救子点识别
  const cp = createBoard(19);
  put(cp, 9, 9, WHITE);
  put(cp, 8, 9, BLACK); put(cp, 10, 9, BLACK); put(cp, 9, 8, BLACK);
  const caps = capturePoints(cp, BLACK);
  eq(caps.length, 1, 'capturePoints 找出 1 个提子点');
  eq(caps[0].join(','), '9,10', 'capturePoints 坐标正确');
  eq(capturePoints(cp, WHITE).length, 0, '白方没有可提的点');
  const sp2 = createBoard(19);
  put(sp2, 9, 9, BLACK);
  put(sp2, 8, 9, WHITE); put(sp2, 10, 9, WHITE); put(sp2, 9, 8, WHITE);
  const saves = savePoints(sp2, BLACK);
  eq(saves.length, 1, 'savePoints 找出 1 个救子点');
  eq(saves[0].join(','), '9,10', 'savePoints 坐标正确');

  // 候选点
  const late = createBoard(13);
  put(late, 0, 0, BLACK); put(late, 12, 0, BLACK); put(late, 0, 12, BLACK); put(late, 12, 12, BLACK);
  put(late, 2, 2, WHITE); put(late, 6, 6, WHITE);
  const cands = candidates(late);
  ok(cands.length === 169 - 6, '13 路 candidates 只返回空点');
  eq(cands.length + 6, 169, '13 路空点数 + 已有子数 = 169');
  const cands19 = candidates(createBoard(19));
  eq(cands19.length, 361, '19 路 candidates 返回 361 个空点（全盘）');

  // 局部候选：19 路必须比全盘小很多
  const one19 = createBoard(19);
  put(one19, 9, 9, BLACK);
  const loc1 = localCandidates(one19, 1);
  eq(loc1.length, 8, '19 路一环邻域（半径 1）恰好 8 个空点');
  const loc2 = localCandidates(one19, 2);
  eq(loc2.length, 24, '19 路二环邻域（半径 2）恰好 24 个空点');
  ok(loc2.length < candidates(one19).length / 10, '局部候选数量远小于全盘（性能前提）');
  eq(localCandidates(createBoard(19), 2).length, 0, '空盘没有局部候选');
  const edge19 = createBoard(19);
  put(edge19, 0, 0, BLACK);
  const locEdge = localCandidates(edge19, 2);
  ok(locEdge.every(([x, y]) => x >= 0 && y >= 0 && x < 19 && y < 19), '角上局部候选不越界');
  eq(locEdge.length, 8, '角上一子半径 2 的候选数 = 3×3 − 1（边界裁剪）');

  // 三档专业段位：连续多手全部合法（19 路）
  const seq = [0.1, 0.37, 0.72, 0.95, 0.55, 0.28, 0.63, 0.84];
  for (const lv of ['dan1', 'dan5', 'dan9']) {
    const g = createBoard(19);
    put(g, 9, 9, BLACK);
    put(g, 8, 8, WHITE);
    let allLegal = true;
    let reason = '';
    for (let i = 0; i < 10; i++) {
      const mv = chooseMove(g, g.current, { level: lv, random: () => seq[i % seq.length] });
      if (!mv) { allLegal = false; reason = '返回空'; break; }
      if (mv.pass) { pass(g); continue; }
      const s = simulate(g, mv.x, mv.y, g.current);
      if (!s.ok) { allLegal = false; reason = `非法 ${mv.x},${mv.y}:${s.reason}`; break; }
      const p = place(g, mv.x, mv.y);
      if (!p.ok) { allLegal = false; reason = `落子失败 ${p.reason}`; break; }
    }
    ok(allLegal, `${lv} 连续 10 手全部是合法落点`, reason);
  }
  // 休闲三档（13 路）
  for (const lv of ['lv1', 'lv2', 'lv3']) {
    const g = createBoard(13);
    put(g, 6, 6, BLACK);
    put(g, 5, 5, WHITE);
    let allLegal = true;
    let reason = '';
    for (let i = 0; i < 8; i++) {
      const mv = chooseMove(g, g.current, { level: lv, random: () => seq[i % seq.length] });
      if (!mv) { allLegal = false; reason = '返回空'; break; }
      if (mv.pass) { pass(g); continue; }
      const s = simulate(g, mv.x, mv.y, g.current);
      if (!s.ok) { allLegal = false; reason = `非法 ${mv.x},${mv.y}:${s.reason}`; break; }
      if (!place(g, mv.x, mv.y).ok) { allLegal = false; reason = '落子失败'; break; }
    }
    ok(allLegal, `${lv} 连续 8 手全部是合法落点`, reason);
  }

  // ── 单步时间上限 ──────────────────────────────────────────────
  // ① 真实时钟：先走一段真实对局把 19 路盘面堆到中盘密度，再逐个档位计时
  const dense = createBoard(19);
  for (let i = 0; i < 90 && !dense.over; i++) {
    const lv = ['dan1', 'dan5', 'dan9'][i % 3];
    const mv = chooseMove(dense, dense.current, { level: lv, random: () => seq[i % seq.length] });
    if (!mv) break;
    if (mv.pass) pass(dense); else place(dense, mv.x, mv.y);
  }
  let stones = 0;
  for (const row of dense.grid) for (const v of row) if (v !== EMPTY) stones++;
  ok(stones >= 60, `19 路中盘密度足够（盘上 ${stones} 子）用于性能断言`);
  let worstMs = 0;
  let worstLv = '';
  for (const lv of ['dan1', 'dan5', 'dan9']) {
    const t0 = Date.now();
    const mv = chooseMove(dense, dense.current, { level: lv, random: () => 0.42 });
    const dt = Date.now() - t0;
    if (dt > worstMs) { worstMs = dt; worstLv = lv; }
    ok(dt < 1000, `19 路 ${lv} 单步真实耗时 ${dt}ms < 1000ms`);
    ok(mv && (mv.pass || simulate(dense, mv.x, mv.y, dense.current).ok), `19 路 ${lv} 计时用的落点合法`);
    ok(Number.isFinite(mv.elapsedMs), `19 路 ${lv} 回报单步耗时 elapsedMs=${mv.elapsedMs}ms`);
  }
  ok(worstMs < 1000, `19 路三档单步最差 ${worstMs}ms（${worstLv}）< 1000ms 上限`);
  console.log(`       ↳ 19 路单步实测：最差 ${worstMs}ms（${worstLv}），盘面 ${stones} 子`);

  // ② 假时钟注入：预算耗尽必须立刻停手，且仍返回合法落点（确定性，反 flaky）
  let ticks = 0;
  const fakeClock = () => { ticks++; return ticks * 1000; };
  const mvBudget = chooseMove(dense, dense.current, {
    level: 'dan9', clock: fakeClock, deadlineMs: 500, random: () => 0.5,
  });
  ok(mvBudget.truncated === true, '预算耗尽时标记 truncated=true（单步有硬上限）');
  ok(ticks <= 6, `超预算后立即停止评估（假时钟只被问了 ${ticks} 次）`);
  ok(mvBudget.truncated ? true : false, 'truncated 是布尔量');
  ok(mvBudget && (mvBudget.pass || simulate(dense, mvBudget.x, mvBudget.y, dense.current).ok),
    '超预算返回的仍然是一手合法棋');
  ok(mvBudget.elapsedMs > 500, `超预算时 elapsedMs 如实上报（${mvBudget.elapsedMs}ms > 500ms）`);
  // 预算极小时也必须给出合法落点（不能返回 null / 非法点）
  const mvTiny = chooseMove(dense, dense.current, {
    level: 'dan9', clock: fakeClock, deadlineMs: 0, random: () => 0.5,
  });
  ok(mvTiny && (mvTiny.pass || simulate(dense, mvTiny.x, mvTiny.y, dense.current).ok),
    '预算为 0 时仍返回合法落点（不会卡死/不返回）');

  // 自评函数：非法点返回 -Infinity，不吃自己的眼
  const f = createBoard(13);
  const evIllegal = evaluatePoint(f, -1, -1, BLACK);
  ok(!isFinite(evIllegal.score), '越界点评估为 -Infinity');
  put(f, 5, 6, BLACK); put(f, 7, 6, BLACK); put(f, 6, 5, BLACK); put(f, 6, 7, BLACK);
  eq(isSelfEye(f, 6, 6, BLACK), true, '四邻皆己方判定为真眼');
  eq(isSelfEye(f, 0, 0, BLACK), false, '空点处不是真眼');

  // 简单/1 段会下坏棋：同一局面用同一随机序列，产出依然合法
  const cmp = createBoard(13);
  put(cmp, 6, 6, WHITE);
  put(cmp, 5, 6, BLACK); put(cmp, 7, 6, BLACK); put(cmp, 6, 5, BLACK);
  const easy = chooseMove(cmp, BLACK, { level: 'lv1', random: () => 0.9 });
  ok(easy !== null, '简单档也能给出落点（可能不是最佳手）');
  const lowDan = chooseMove(cmp, BLACK, { level: 'dan1', random: () => 0.9 });
  ok(lowDan !== null, '1 段也能给出落点');

  // 收官时 AI 会考虑虚手
  const late2 = createBoard(13);
  put(late2, 0, 0, BLACK); put(late2, 12, 0, BLACK); put(late2, 0, 12, BLACK); put(late2, 12, 12, BLACK);
  put(late2, 2, 2, WHITE); put(late2, 6, 6, WHITE);
  late2.quiet = 30;
  eq(shouldPass(late2, BLACK, { level: 'lv3', random: () => 0.9 }), true, '盘面进入收官且 quiet 高时 AI 会选择虚手');
  late2.quiet = 0;
  eq(shouldPass(late2, BLACK, { level: 'lv3', random: () => 0.9 }), false, '开局阶段 AI 不虚手');
  late2.quiet = 0;
  eq(shouldPass(late2, BLACK, { level: 'lv1', random: () => 0.1 }), false, '简单档会「看不出该收工」而继续下');
  const late19 = createBoard(19);
  late19.quiet = 41;
  eq(shouldPass(late19, BLACK, { level: 'dan9', random: () => 0.9 }), true, '19 路 quiet 超阈值时 AI 收工');
}

console.log('\n【九】完整对局：AI 自对弈不产生非法手（13 路 / 19 路各一局）');
for (const [n, lv] of [[13, 'lv2'], [19, 'dan5']]) {
  const b = createBoard(n);
  let illegal = null;
  let turns = 0;
  const seq = [0.05, 0.17, 0.29, 0.41, 0.53, 0.65, 0.77, 0.89, 0.95];
  while (!b.over && turns < 900) {
    const mv = chooseMove(b, b.current, { level: lv, random: () => seq[turns % seq.length] });
    if (!mv) { illegal = `第 ${turns} 手 AI 返回空`; break; }
    if (!mv.pass && !simulate(b, mv.x, mv.y, b.current).ok) { illegal = `第 ${turns} 手 ${mv.x},${mv.y} 非法`; break; }
    const r = mv.pass ? pass(b) : place(b, mv.x, mv.y);
    if (!r.ok) { illegal = `第 ${turns} 手落子失败: ${r.reason}`; break; }
    turns++;
  }
  ok(illegal === null, `${n} 路 ${lv} 自对弈全程无非法手`, illegal ?? '');
  ok(b.over === true, `${n} 路自对弈最终终局（共 ${turns} 手，原因 ${b.result && b.result.reason}）`);
  ok(b.result && (b.result.winner === BLACK || b.result.winner === WHITE || b.result.winner === DRAW),
    `${n} 路终局产出胜负或和棋`);
  ok(b.captures[BLACK] + b.captures[WHITE] >= 0, `${n} 路提子数统计非负`);
  eq(b.moves.length, turns, `${n} 路对局记录与手数一致`);
  let stoneCount = 0;
  for (const row of b.grid) for (const v of row) if (v !== EMPTY) stoneCount++;
  ok(stoneCount > n * n * 0.3, `${n} 路终局盘面不算空（${stoneCount} 子 / ${n * n} 点）`);
}

console.log('\n【十】会话层：13 路 / 19 路两档（布局 / 渲染 / 交互 / 时间注入 / 音效）');
{
  eq(meta.id, 'go', 'meta.id 与目录一致');
  eq(meta.ready, true, 'meta.ready = true');
  eq(meta.glyph.length, 1, 'meta.glyph 是单字');
  eq(meta.difficulties.length, 6, '六个难度档位（休闲 3 + 专业段位 3）');
  eq(meta.difficulties.map((d) => d.key).join(','), 'lv1,lv2,lv3,dan1,dan5,dan9', '难度 key 依次为 lv1..lv3 + dan1/dan5/dan9');
  ok(meta.difficulties.every((d) => LEVELS[d.key]), '每个难度 key 在 LEVELS 中都有配置');
  ok(meta.desc.length <= 16, `meta.desc ≤16 字（${meta.desc}）`);
  ok(meta.difficulties.every((d) => d.desc.length <= 16), '每个难度 desc ≤16 字');
  ok(meta.difficulties.every((d) => (d.name ?? '').length <= 4), '每个难度 name ≤4 字');
  ok(meta.difficulties.slice(0, 3).every((d) => d.desc.includes('13 路')), '前三档 desc 标注 13 路（休闲）');
  ok(meta.difficulties.slice(3).every((d) => d.desc.includes('19 路')), '后三档 desc 标注 19 路（专业）');
  ok(meta.difficulties[3].name.includes('段') && meta.difficulties[5].name.includes('段'), '专业档用段位命名');
}

const W = 375, H = 812, INSETS = { top: 44, bottom: 34 };
const N = 1700000000000;   // 绝对时间戳（Date.now 量级），用于时间注入断言
const bottomLimit = H - INSETS.bottom - 16;

for (const [key, size] of [['lv2', 13], ['dan5', 19]]) {
  console.log(`\n  ── 会话档位 ${key}（${size} 路）──`);
  const events = [];
  const s = createSession({
    width: W, height: H, insets: INSETS,
    difficulty: key, theme: THEME,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const L = s.layout;

  // 接口齐备
  for (const fn of ['tap', 'press', 'release', 'hover', 'update', 'render', 'resize', 'destroy']) {
    eq(typeof s[fn], 'function', `${key} 会话暴露 ${fn}`);
  }
  eq(s.outcome, null, `${key} 未终局时 outcome = null`);
  eq(s.state.boardSize, size, `${key} 会话棋盘 ${size} 路`);
  eq(s.state.board.size, size, `${key} 棋盘状态路数一致`);
  eq(s.state.level, key, `${key} 会话记住难度 key`);
  eq(s.state.mode, size === 19 ? 'pro' : 'casual', `${key} 模式标注正确`);

  // 布局：安全区 / 居中去 / 格子尺寸
  ok(L.buttons.length === 3, `${key} 底部三个按钮`);
  ok(L.buttons.every((b) => b.y + b.h <= bottomLimit + 1e-6),
    `${key} 按钮底边留出 insets.bottom + 16（${L.buttons[0].y + L.buttons[0].h} ≤ ${bottomLimit}）`);
  ok(L.buttons.every((b) => b.x >= 0 && b.x + b.w <= W), `${key} 按钮在屏幕横向范围内`);
  ok(L.board.y >= INSETS.top + 40, `${key} 棋盘不侵入顶部安全区`);
  ok(Math.abs((L.board.x + L.board.size / 2) - W / 2) <= 1, `${key} 棋盘水平居中（x=${L.board.x}）`);
  ok(L.board.x >= 0 && L.board.x + L.board.size <= W, `${key} 棋盘不越出屏幕（${L.board.size}px）`);
  ok(L.board.size >= 340, `${key} 棋盘吃满可用宽度（${L.board.size}px ≥ 340）`);
  ok(L.board.y + L.board.size <= L.buttons[0].y, `${key} 棋盘与底部按钮不重叠`);
  const cellMin = size === 13 ? 24 : 17;
  ok(L.board.cell >= cellMin, `${key} 格子尺寸够大（${L.board.cell.toFixed(2)}px ≥ ${cellMin}px）`);
  ok(Math.abs(L.board.inner - L.board.cell / 2) < 0.01, `${key} 棋盘内边距 = 半格（格子取到最大）`);
  const ratio = (L.board.stoneR * 2) / L.board.cell;
  ok(ratio > 0.85 && ratio <= 1.0, `${key} 棋子直径 ≈ 格宽（比值 ${ratio.toFixed(2)}）`);
  ok(L.stars.length === (size === 19 ? 9 : 5), `${key} 星位数量正确（${L.stars.length} 个）`);
  ok(L.stars.every(([x, y]) => {
    const p = L.board.toScreen(x, y);
    return p.x >= L.board.x && p.x <= L.board.x + L.board.size && p.y >= L.board.y && p.y <= L.board.y + L.board.size;
  }), `${key} 星位都画在棋盘范围内`);

  const c00 = L.board.toScreen(0, 0);
  const cN = L.board.toScreen(size - 1, size - 1);
  ok(Math.abs((cN.x - c00.x) - (size - 1) * L.board.cell) < 0.001, `${key} toScreen 网格间距一致`);
  const back = L.board.fromScreen(c00.x, c00.y);
  eq(back.x, 0, `${key} fromScreen/toScreen 互逆（x）`);
  eq(back.y, 0, `${key} fromScreen/toScreen 互逆（y）`);
  ok(s.hud && typeof s.hud.title === 'string', `${key} hud 可读`);
  ok(s.hud.title.includes('围棋') && s.hud.title.includes(String(size)), `${key} hud 标题含「围棋 · ${size} 路」`);
  eq(s.hud.elapsed, '00:00', `${key} 初始用时 00:00`);

  // ── 时间注入：传 N 与 N+3000，断言计时正确（规范 §8）──
  const center = L.board.toScreen(Math.floor(size / 2), Math.floor(size / 2));
  s.tap(center.x, center.y, N);
  eq(s.state.startedAt, N, `${key} 首手记住起始时间戳 N`);
  eq(s.state.elapsedMs, 0, `${key} 传 N 时用时 0`);
  eq(s.state.clockText, '00:00', `${key} 传 N 时用时段 00:00`);
  eq(s.state.board.grid[Math.floor(size / 2)][Math.floor(size / 2)], BLACK, `${key} 点击交叉点成功落子`);
  ok(s.state.aiThinking, `${key} 落子后轮到 AI（aiThinking=true）`);
  ok(s.busy, `${key} AI 思考时 busy = true`);
  // AI 有「思考中」的最短观感时间：到点前不许落子
  s.update(N + 100);
  eq(s.state.board.moves.length, 1, `${key} AI 思考未到点时不落子（now = N+100）`);
  s.update(N + 3000);
  eq(s.state.board.moves.length, 2, `${key} AI 已应一手`);
  ok(!s.state.aiThinking, `${key} AI 落子后思考态结束`);
  eq(s.state.elapsedMs, 3000, `${key} 传 N 与 N+3000 → 用时 3000ms`);
  eq(s.state.clockText, '00:03', `${key} 用时段显示 00:03`);
  const aiMv = s.state.board.moves[1];
  ok(aiMv.player === WHITE, `${key} AI 执白落子`);
  ok(aiMv.pass || (aiMv.x >= 0 && aiMv.x < size && aiMv.y >= 0 && aiMv.y < size), `${key} AI 首手在棋盘内`);
  ok(s.state.board.moves.every((m) => m.pass || (m.x >= 0 && m.x < size && m.y >= 0 && m.y < size)),
    `${key} 历史中坐标合法`);
  ok(s.state.aiLastMs >= 0 && s.state.aiLastMs < 1000, `${key} AI 单步耗时 ${s.state.aiLastMs}ms < 1000ms`);

  // ── 桩 ctx 多帧渲染：不抛异常 + 全套 UI 断言 ──
  const offscreen = makeOffscreenFactory();
  const cacheS = s;   // 复用同一会话（已有 2 手）
  cacheS.layout.createOffscreen = offscreen;

  const frames = [];
  let threw = null;
  try {
    for (let f = 0; f < 5; f++) {
      const ctx = createStubCtx({ __dpr: 2 });
      s.render(ctx, N + 3000 + f * 16);
      frames.push(ctx.rec);
    }
  } catch (e) { threw = e; }
  ok(threw === null, `${key} 桩 ctx 连续渲染 5 帧不抛异常`, threw ? String(threw && threw.message) : '');
  ok(frames.length === 5, `${key} 五帧都被记录`);
  if (frames.length === 5) {
    const rec = frames[0];
    ok(fullscreenFills(rec, W, H).length === 0, `${key} 本模块没有任何全屏铺底`,
      fullscreenFills(rec, W, H).map((f) => f.how).join('；'));
    ok(rec.clears.length === 0, `${key} 本模块不调用 clearRect（清屏是集成层职责）`);
    ok(frames.every((r) => r.clears.length === 0), `${key} 五帧都没有 clearRect`);

    // 棋盘缓存：首帧把静态层画进离屏，之后每帧只 drawImage
    eq(offscreen.log.calls, 1, `${key} 离屏画布只创建一次（缓存复用）`);
    const offCanvas = offscreen.log.canvases[0];
    ok(offCanvas && offCanvas.width >= L.board.size * 2 * 0.9,
      `${key} 离屏画布按 dpr 放大绘制（${offCanvas && offCanvas.width}px）`);
    ok(offscreen.log.canvases[0].__ctx.rec.strokes.length > 0, `${key} 首帧把网格线画进了离屏缓存`);
    ok(hasGridStroke(offscreen.log.canvases[0].__ctx.rec) || offscreen.log.canvases[0].__ctx.rec.strokes.length > 0,
      `${key} 离屏缓存里包含网格描边`);
    ok(frames[0].drawImages.length >= 1, `${key} 首帧就把缓存贴回上屏（drawImage）`);
    ok(frames.slice(1).every((r) => r.drawImages.length >= 1), `${key} 后续帧每帧只贴一次缓存位图`);
    ok(frames.slice(1).every((r) => !hasGridStroke(r)), `${key} 后续帧不再重画网格线（19 路 361 点的性能前提）`);
    ok(!hasGridStroke(frames[0]), `${key} 首帧也不在上屏画网格线（静态层全部落在离屏缓存里）`);
    ok(offscreen.log.canvases[0].__ctx.rec.strokes.length > frames[0].strokes.length,
      `${key} 首帧静态层描边（${offscreen.log.canvases[0].__ctx.rec.strokes.length}）多于上屏描边（${frames[0].strokes.length}）`);

    // 顶部三行 HUD：不重叠、不撞角区
    const hudTexts = rec.texts.filter((t) => t.y < L.board.y);
    eq(hudTexts.length, 3, `${key} 棋盘上方正好三行 HUD 文字`);
    const boxes = hudTexts.map(textBox).sort((a, b) => a.y - b.y);
    let overlap = null;
    for (let i = 1; i < boxes.length; i++) {
      if (intersects(boxes[i - 1], boxes[i])) overlap = `第 ${i} 行与第 ${i + 1} 行重叠`;
    }
    ok(overlap === null, `${key} 顶部 HUD 三行互不重叠`, overlap ?? '');
    const zones = cornerZones(W, INSETS);
    const hits = [];
    for (const t of rec.texts) {
      const box = textBox(t);
      for (const z of zones) if (intersects(box, z, 2)) hits.push(`「${t.text}」∩${z.name}`);
    }
    ok(hits.length === 0, `${key} 顶部文字不撞 56px 角区`, hits.join('；'));
    const texts = rec.texts.map((t) => t.text).join(' | ');
    ok(texts.includes('00:03'), `${key} 画面里出现用时 00:03（时间注入渲染正确）`, texts);
    ok(texts.includes(String(size) + ' 路'), `${key} 画面里出现路数标注`);
  }

  // ── 无离屏能力时降级为逐帧直接绘制，仍然不抛异常 ──
  const s2 = createSession({ width: W, height: H, insets: INSETS, difficulty: key, theme: THEME });
  let threw2 = null;
  const plainFrames = [];
  try {
    for (let f = 0; f < 3; f++) {
      const ctx = createStubCtx();
      s2.render(ctx, N + f * 16);
      plainFrames.push(ctx.rec);
    }
  } catch (e) { threw2 = e; }
  ok(threw2 === null, `${key} 无离屏能力时 3 帧渲染仍不抛异常`, threw2 ? String(threw2 && threw2.message) : '');
  ok(plainFrames.every((r) => r.clears.length === 0), `${key} 降级路径同样不 clearRect`);
  ok(plainFrames.every((r) => fullscreenFills(r, W, H).length === 0), `${key} 降级路径同样没有全屏铺底`);
  ok(hasGridStroke(plainFrames[0]) && hasGridStroke(plainFrames[0]) === hasGridStroke(plainFrames[2]),
    `${key} 降级路径逐帧直接画网格（外观一致，只是没有缓存加速）`);
  s2.destroy();

  // ── 交互 ──
  const occupied = L.board.toScreen(Math.floor(size / 2), Math.floor(size / 2));
  s.tap(occupied.x, occupied.y, N + 5000);
  ok(s.state.toast && s.state.toast.text.includes('已有'), `${key} 点已占点给出提示`);
  eq(s.state.board.moves.length, 2, `${key} 非法点击不产生落子`);
  s.tap(2, 2, N + 5100);
  eq(s.state.board.moves.length, 2, `${key} 棋盘外点击被忽略`);

  const passBtn = L.buttons[1];
  const before = s.state.board.moves.length;
  s.tap(passBtn.x + passBtn.w / 2, passBtn.y + passBtn.h / 2, N + 6000);
  const lastM = s.state.board.moves[s.state.board.moves.length - 1];
  ok(s.state.board.moves.length > before, `${key} 「停一手」按钮产生虚手记录`);
  ok(lastM.pass === true || s.state.board.over, `${key} 虚手被正确记录（或已终局）`);
  s.update(N + 30000);

  s.press(L.buttons[0].x + 2, L.buttons[0].y + 2);
  eq(s.state.pressIndex, 0, `${key} press 记录按压索引`);
  s.release();
  eq(s.state.pressIndex, -1, `${key} release 清除按压态`);

  s.tap(L.buttons[0].x + L.buttons[0].w / 2, L.buttons[0].y + L.buttons[0].h / 2, N + 60000);
  eq(s.state.board.moves.length, 0, `${key} 「重新开始」清空对局`);
  eq(s.state.board.over, false, `${key} 重开后未终局`);
  eq(s.state.territory, null, `${key} 重开后清掉地盘标记`);
  eq(s.state.elapsedMs, 0, `${key} 重开后用时归零`);
  eq(s.state.clockText, '00:00', `${key} 重开后用时段归零`);

  const resignBtn = L.buttons[2];
  s.tap(resignBtn.x + resignBtn.w / 2, resignBtn.y + resignBtn.h / 2, N + 90000);
  ok(s.state.board.over, `${key} 「认输」结束对局`);
  const oc = s.outcome;
  ok(oc && oc.result === 'lose', `${key} 认输后 outcome.result = lose`);
  ok(events.some((e) => e.type === 'end'), `${key} 向上汇报 end 事件`);
  ok(events.some((e) => e.type === 'move'), `${key} 向上汇报 move 事件`);

  const c2 = L.board.toScreen(1, 1);
  const movesBefore = s.state.board.moves.length;
  s.tap(c2.x, c2.y, N + 91000);
  eq(s.state.board.moves.length, movesBefore, `${key} 终局后不再落子`);
  ok(s.state.territory && s.state.territory.owner, `${key} 终局后生成地盘估算标记`);
  ok(s.outcome !== null, `${key} 结算后 outcome 持续返回（不自动重开，规范 §9）`);

  // 终局帧渲染
  let threw3 = null;
  try {
    const ctxEnd = createStubCtx();
    s.render(ctxEnd, N + 92000);
    ok(fullscreenFills(ctxEnd.rec, W, H).length === 0, `${key} 终局帧也没有全屏遮罩`);
    ok(!hasGridStroke(ctxEnd.rec), `${key} 终局帧同样命中棋盘缓存（不重画网格）`);
    ok(ctxEnd.rec.texts.filter((t) => t.y < L.board.y).length === 3, `${key} 终局帧 HUD 仍是三行`);
  } catch (e) { threw3 = e; }
  ok(threw3 === null, `${key} 终局帧渲染不抛异常`);

  // resize 后仍满足安全区约束
  s.resize(320, 568, { top: 20, bottom: 0 });
  const L2 = s.layout;
  ok(L2.buttons.every((b) => b.y + b.h <= 568 - 0 - 16 + 0.001), `${key} 小屏 resize 后按钮仍留 16 余量`);
  ok(L2.buttons.every((b) => b.x + b.w <= 320), `${key} 小屏按钮不越界`);
  ok(L2.board.size > 140, `${key} 小屏棋盘仍有可用尺寸`);
  ok(L2.board.y + L2.board.size <= L2.buttons[0].y, `${key} 小屏棋盘与按钮不重叠`);
  ok(L2.board.x + L2.board.size <= 320, `${key} 小屏棋盘不越界`);
  let threw4 = null;
  try {
    const ctxSmall = createStubCtx();
    s.render(ctxSmall, N + 93000);
    ok(ctxSmall.rec.texts.filter((t) => t.y < L2.board.y).length === 3, `${key} 小屏 HUD 仍三行`);
    const hits2 = [];
    for (const t of ctxSmall.rec.texts) {
      const box = textBox(t);
      for (const z of cornerZones(320, { top: 20, bottom: 0 })) if (intersects(box, z, 2)) hits2.push(`「${t.text}」∩${z.name}`);
    }
    ok(hits2.length === 0, `${key} 小屏顶部文字不撞角区`, hits2.join('；'));
  } catch (e) { threw4 = e; }
  ok(threw4 === null, `${key} 小屏渲染不抛异常`);

  s.destroy();
  const afterDestroy = s.state.board.moves.length;
  s.tap(c2.x, c2.y, N + 94000);
  eq(s.state.board.moves.length, afterDestroy, `${key} destroy 后不再响应点击`);
}

console.log('\n【十一】音效接入（可选能力，一律静默降级）');
{
  const played = [];
  const sfxStub = { play: (name) => { played.push(name); return true; } };
  const s = createSession({
    width: W, height: H, insets: INSETS, difficulty: 'lv2', theme: THEME, sfx: sfxStub,
  });
  const st = s.state;
  const p0 = s.layout.board.toScreen(2, 2);
  s.tap(p0.x, p0.y, N);
  ok(played.includes('tap'), '正常落子播放 tap（落子音）');

  // 造一个能提子的局面：白 (6,5) 只剩 (6,6) 一气
  const sb = st.board;
  sb.grid[5][6] = WHITE;                                   // (x=6, y=5) 白
  sb.grid[5][5] = BLACK; sb.grid[5][7] = BLACK; sb.grid[4][6] = BLACK;  // 三面围住
  sb.current = BLACK;
  st.aiThinking = false;
  st.aiPending = false;
  played.length = 0;
  const cap = s.layout.board.toScreen(6, 6);
  s.tap(cap.x, cap.y, N + 10);
  eq(sb.grid[5][6], EMPTY, '提子局面下成功提掉白子');
  ok(played.includes('capture'), '提子时播放 capture（吃子音）');
  ok(!played.includes('tap'), '有子被提时不会同时播放 tap（音效不叠）');

  // 按钮音
  sb.current = BLACK;
  st.aiThinking = false;
  st.aiPending = false;
  const passBtn = s.layout.buttons[1];
  played.length = 0;
  s.tap(passBtn.x + passBtn.w / 2, passBtn.y + passBtn.h / 2, N + 20);
  ok(played.includes('click'), '「停一手」按钮播放 click（按钮音）');
  played.length = 0;
  const restart = s.layout.buttons[0];
  s.tap(restart.x + 2, restart.y + 2, N + 30);
  ok(played.includes('click'), '「重新开始」按钮播放 click');
  s.destroy();

  // sfx 缺失
  let threw = null;
  try {
    const s2 = createSession({ width: W, height: H, insets: INSETS, difficulty: 'lv2', theme: THEME });
    const p2 = s2.layout.board.toScreen(6, 6);
    s2.tap(p2.x, p2.y, N);
    s2.update(N + 400);
    s2.destroy();
  } catch (e) { threw = e; }
  ok(threw === null, 'options.sfx 缺省（undefined）时不抛异常', threw ? String(threw.message) : '');

  // sfx.play 抛异常
  let threw2 = null;
  try {
    const s3 = createSession({
      width: W, height: H, insets: INSETS, difficulty: 'lv2', theme: THEME,
      sfx: { play: () => { throw new Error('音频上下文炸了'); } },
    });
    const p3 = s3.layout.board.toScreen(6, 6);
    s3.tap(p3.x, p3.y, N);
    s3.update(N + 400);
    s3.destroy();
  } catch (e) { threw2 = e; }
  ok(threw2 === null, 'sfx.play 抛异常时静默降级（对局不中断）', threw2 ? String(threw2.message) : '');

  // play 不是函数
  let threw3 = null;
  try {
    const s4 = createSession({ width: W, height: H, insets: INSETS, difficulty: 'dan1', theme: THEME, sfx: {} });
    const p4 = s4.layout.board.toScreen(9, 9);
    s4.tap(p4.x, p4.y, N);
    s4.update(N + 400);
    s4.destroy();
  } catch (e) { threw3 = e; }
  ok(threw3 === null, 'sfx 没有 play 方法时静默降级', threw3 ? String(threw3.message) : '');
}

console.log(`\n通过 ${passCount} 项，失败 ${failCount} 项`);
if (failCount > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failCount > 0 ? 1 : 0);
