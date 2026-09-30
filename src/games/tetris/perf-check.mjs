/**
 * 俄罗斯方块 · 每帧绘制开销自检（计数断言 + 桩环境耗时，纯本地零 token）
 *
 * 用法：
 *   node src/games/tetris/perf-check.mjs                    # 测当前 render.js
 *   node src/games/tetris/perf-check.mjs --render ./x.js    # 测指定的渲染实现（做前后对比用）
 *   node src/games/tetris/perf-check.mjs --json             # 额外输出一行 PERF_JSON
 *
 * 为什么单独一个文件：性能结论必须能被**数字**证明，而不是"感觉流畅了"。
 * 本文件在一个"打到一半"的真实局面上跑几千帧，逐项统计每帧的绘制调用：
 *   createLinearGradient / createRadialGradient / beginPath / stroke / fill /
 *   路径段数（moveTo+lineTo+arc+arcTo）/ 字体设置 / 阴影设置
 * 并把阈值写成断言 —— 以后谁把渐变缓存或批量描边改回去，这里会直接变红。
 *
 * 两个口径：
 *   ① 整帧（renderFrame）：含集成层的 6 个木质按钮，是玩家真正看到的每帧总开销；
 *   ② 热路径（board/stack/ghost/piece/top/stats）：只看本模块优化过的那几块，
 *      排除 drawWoodButton（集成层代码，按钮数量变化会影响它，不该算在优化账上）。
 *
 * ⚠️ 关于"耗时"的诚实说明：
 *   桩 ctx 的方法是空函数，量到的是**JS 侧调用开销**，不含真实光栅化。
 *   真机上最贵的是 shadowBlur（每帧额外栅格化一层模糊）与渐变 shader 的创建，
 *   这两项在桩里几乎不花时间，但它们的**调用次数**在这里被如实统计
 *   （棋盘投影已不再用 shadowBlur；方块渐变从每块一条变成缓存复用）。
 *   所以：调用次数是硬证据，耗时只代表 JS 侧趋势。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createState, start, makePiece, activeInterval, ROWS, COLS, TYPES } from './core.js';
import { THEME } from '../../ui/theme.js';

/* ───────────────────────── 小工具 ───────────────────────── */

let pass = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) { pass++; return; }
  failures.push(`${label}${extra ? ' → ' + extra : ''}`);
}
function eq(a, b, label) { ok(a === b, label, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`); }

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const AS_JSON = process.argv.includes('--json');

/* ───────────────────────── 桩 ctx ───────────────────────── */

/**
 * 计数桩：记录每次绘制调用的次数/坐标。
 * ⚠️ 只能用来数次数，**不能用来计时** —— 每帧上千次 `c.x++` 本身就占掉绝大部分时间，
 * 会把真正被优化的部分淹掉（实测同一份代码开/不开计数差 2~3 倍）。计时用下面的空桩。
 */
function makeCountCtx() {
  const c = {
    linearGrad: 0, radialGrad: 0, beginPath: 0, stroke: 0, fill: 0,
    blockGrad: 0,       // 对角渐变（x0≠x1）= 本模块的方块渐变
    verticalGrad: 0,    // 竖向渐变（x0==x1）= 集成层 drawWoodButton 的按钮面
    moveTo: 0, lineTo: 0, arc: 0, arcTo: 0, fillText: 0, fillRect: 0, clearRect: 0,
    save: 0, restore: 0, fontSet: 0, shadowBlurSet: 0, measureText: 0,
    depth: 0, minDepth: 0,
    _font: '', _sb: 0,
  };
  const ctx = makeStub(c);
  return { ctx, c };
}

/**
 * 空桩：方法全为空函数、**不做任何计数**，只用来量 JS 侧调用开销。
 * 走的是与计数桩完全相同的绘制路径，所以两边的调用次数一一对应。
 */
function makePlainCtx() {
  const c = {
    beginPath: 0, stroke: 0, fill: 0, moveTo: 0, lineTo: 0, arc: 0, arcTo: 0,
    clearRect: 0, save: 0, restore: 0, depth: 0, minDepth: 0,
  };
  const ctx = makeStub(c, false);
  return { ctx, c };
}

/** 两种桩共用的骨架：count=false 时所有计数点都是空函数。 */
function makeStub(c, count = true) {
  const noop = () => {};
  const bump = count ? null : noop;      // count=false → 计数点用 noop（零开销）
  const grad = { addColorStop: noop };
  const ctx = {
    canvas: { width: 750, height: 1334 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    textAlign: 'left', textBaseline: 'top', globalAlpha: 1,
    shadowColor: '', shadowOffsetY: 0, font: '', shadowBlur: 0,
    save() { if (count) { c.save++; c.depth++; } },
    restore() { if (count) { c.restore++; c.depth--; if (c.depth < c.minDepth) c.minDepth = c.depth; } },
    beginPath() { if (count) c.beginPath++; },
    closePath: noop, clip: noop,
    moveTo() { if (count) c.moveTo++; }, lineTo() { if (count) c.lineTo++; },
    arc() { if (count) c.arc++; }, arcTo() { if (count) c.arcTo++; }, rect: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop, drawImage: noop,
    clearRect() { if (count) c.clearRect++; },
    fillRect() { if (count) c.fillRect++; },
    strokeRect: noop,
    fill() { if (count) c.fill++; }, stroke() { if (count) c.stroke++; },
    fillText() { if (count) c.fillText++; }, strokeText: noop,
    measureText(t) { if (count) c.measureText++; return { width: String(t).length * 8 }; },
    createLinearGradient(x0, y0, x1, y1) {
      if (count) {
        c.linearGrad++;
        // 方块的渐变是对角的（左上→右下）；按钮面板的渐变是竖向的（x0==x1==0）。
        // 分开统计，才能把"本模块的方块渐变"与"集成层按钮的渐变"分开看。
        if (x0 !== x1) c.blockGrad++; else c.verticalGrad++;
      }
      return grad;
    },
    createRadialGradient() { if (count) c.radialGrad++; return grad; },
  };
  if (count) {
    Object.defineProperty(ctx, 'font', {
      get() { return c._font; },
      set(v) { c.fontSet++; c._font = v; },
    });
    Object.defineProperty(ctx, 'shadowBlur', {
      get() { return c._sb; },
      set(v) { c.shadowBlurSet++; c._sb = v; },
    });
  }
  return ctx;
}

/* ───────────────────────── 局面：一局打到一半的真实盘面 ───────────────────────── */

/** 造一个「底部堆了 6 行（带洞）、上方有下落块」的中局，最接近真机负载。 */
function benchState(seed = 3) {
  const st = createState({ seed, difficulty: 'normal' });
  start(st);
  let filled = 0;
  for (let y = ROWS - 6; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if ((x * 3 + y) % 7 === 3) continue;         // 留几个洞，别一消一大片
      st.grid[y][x] = TYPES[(x + y) % 7];
      filled++;
    }
  }
  st.piece = makePiece('T', 3, 4, 1);
  st.score = 12340;
  st.lines = 27;
  st.level = 3;
  st.lastClear = 2;
  st.lastClearAt = 0;
  st.flashWallAt = 0;
  return { st, filled };
}

/* ───────────────────────── 加载被测渲染实现 ───────────────────────── */

const renderPath = argValue('--render') ?? './render.js';
const R = await import(new URL(renderPath, import.meta.url).href);
const L = R.computeLayout(375, 667, { top: 44, bottom: 34 });
const { st, filled } = benchState();

const WARM = 400;      // 预热帧：让各类缓存放满、V8 把热函数编译好
const MEASURE = 6000;  // 计量帧
const TIMING_ROUNDS = 5;   // 计时轮数（取中位数，压掉离群轮）

/**
 * 推进一帧的"视觉状态"而不真的改盘面：
 * 只把 core 的下落累计量往前推，让下落块的 y 带上 0~1 格的插值相位
 * （这正是真机上每帧都在变的东西）。
 * 盘面保持不变 = 前后两次测量的工作量完全一致，对比才有意义。
 */
const advance = () => { st.dropAcc = (st.dropAcc + 16) % activeInterval(st); };

/**
 * 跑 WARM + MEASURE 帧。
 * 计数用计数桩跑 1 轮；计时用空桩跑 TIMING_ROUNDS 轮取**中位数**
 * （实测同一份代码的单轮耗时能出现 2 倍以上的离群值，最小值会被"虚快"的那轮带偏）。
 */
function measure(drawOne, { counting }) {
  const rounds = counting ? 1 : TIMING_ROUNDS;
  const factory = counting ? makeCountCtx : makePlainCtx;
  const times = [];
  let lastC = null;
  let threw = null;

  for (let r = 0; r < rounds; r++) {
    const { ctx, c } = factory();
    let now = 1000;
    try {
      for (let i = 0; i < WARM; i++) { advance(); drawOne(ctx, (now += 16)); }
    } catch (e) { threw = e; break; }
    if (counting) {
      for (const k of Object.keys(c)) if (typeof c[k] === 'number') c[k] = 0;
      c.depth = 0; c.minDepth = 0;
    }
    const t0 = Date.now();
    try {
      for (let i = 0; i < MEASURE; i++) { advance(); drawOne(ctx, (now += 16)); }
    } catch (e) { threw = e; break; }
    times.push(Date.now() - t0);
    lastC = c;
  }
  times.sort((a, b) => a - b);
  const med = times.length ? times[times.length >> 1] : 0;
  return { c: lastC, elapsed: med, rounds: times, threw };
}

const fBackground = R.drawBackground, fBoard = R.drawBoard, fStack = R.drawStack;
const fGhost = R.drawGhost, fPiece = R.drawPiece, fTop = R.drawTop;
const fStats = R.drawStats, fFlash = R.drawClearFlash, fFrame = R.renderFrame;

/** 整帧：含集成层的 6 个木质按钮。 */
const fullDraw = (ctx, now) => fFrame(ctx, L, st, THEME, now);
/** 热路径：只画本模块优化过的那几块（排除集成层的按钮，按钮数量的变化不该算进优化账）。 */
const hotDraw = (ctx, now) => {
  fBackground(ctx, L, THEME);
  fBoard(ctx, L, THEME);
  fStack(ctx, L, st);
  fGhost(ctx, L, st);
  fPiece(ctx, L, st, now);
  fTop(ctx, L, st, THEME, now);
  fStats(ctx, L, st, THEME);
  fFlash(ctx, L, st, THEME, now);
};

const full = measure(fullDraw, { counting: true });
const fullTime = measure(fullDraw, { counting: false });
/** 热路径：只画本模块优化过的那几块，把集成层的按钮排除在外，前后才可比。 */
const hot = measure(hotDraw, { counting: true });
const hotTime = measure(hotDraw, { counting: false });

const perFrame = (m, t) => {
  const c = m.c;
  return {
    createLinearGradient: Number((c.linearGrad / MEASURE).toFixed(2)),
    blockGradient: Number((c.blockGrad / MEASURE).toFixed(2)),
    woodButtonGradient: Number((c.verticalGrad / MEASURE).toFixed(2)),
    createRadialGradient: Number((c.radialGrad / MEASURE).toFixed(3)),
    beginPath: Number((c.beginPath / MEASURE).toFixed(2)),
    stroke: Number((c.stroke / MEASURE).toFixed(2)),
    fill: Number((c.fill / MEASURE).toFixed(2)),
    segments: Number(((c.moveTo + c.lineTo + c.arc + c.arcTo) / MEASURE).toFixed(2)),
    fillText: Number((c.fillText / MEASURE).toFixed(2)),
    fontSet: Number((c.fontSet / MEASURE).toFixed(2)),
    shadowBlurSet: Number((c.shadowBlurSet / MEASURE).toFixed(2)),
    save: Number((c.save / MEASURE).toFixed(2)),
    restore: Number((c.restore / MEASURE).toFixed(2)),
    us_per_frame: Number(((t.elapsed * 1000) / MEASURE).toFixed(2)),
  };
};

const FULL = perFrame(full, fullTime);
const HOT = perFrame(hot, hotTime);

const M = {
  render: renderPath,
  frames: MEASURE,
  filledCells: filled,
  full_frame: FULL,
  hot_path: HOT,
  saveRestoreBalanced: full.c.depth === 0 && full.c.minDepth === 0 && hot.c.depth === 0 && hot.c.minDepth === 0,
  clearRect: full.c.clearRect + hot.c.clearRect,
};

/* ───────────────────────── 输出 ───────────────────────── */

console.log(`\n被测实现：${renderPath}`);
console.log(`局面：${COLS}×${ROWS} 棋盘，已落定 ${filled} 格，再加 1 个下落块（带插值相位）+ 幽灵 + 预览`);
console.log(`帧数：预热 ${WARM} + 计量 ${MEASURE}\n`);

const rows = Object.keys(FULL).filter((k) => k !== 'us_per_frame');
console.log('每帧绘制调用（稳态）         全文整帧        本模块热路径');
for (const k of rows) {
  console.log(`   ${k.padEnd(22, ' ')} ${String(FULL[k]).padStart(9)} ${String(HOT[k]).padStart(14)}`);
}
console.log(`   ${'JS 调用耗时(µs)'.padEnd(20, ' ')} ${String(FULL.us_per_frame).padStart(9)} ${String(HOT.us_per_frame).padStart(14)}`);
console.log('   注：woodButtonGradient 来自集成层 src/ui/renderer.js 的 drawWoodButton（6 个按钮 ×2），本模块不碰它。');

ok(full.threw === null && hot.threw === null, `${WARM + MEASURE} 帧渲染全程不抛异常`,
  String(full.threw?.message ?? hot.threw?.message ?? ''));
ok(M.saveRestoreBalanced, '一帧渲染里 save/restore 严格配对（规范 §11）',
  `depth=${full.c.depth}/${full.c.minDepth}`);
eq(M.clearRect, 0, '渲染层不调用 clearRect（规范 §10：清屏归集成层）');

// 本模块的**方块对角渐变**：稳态下只剩「下落中那 4 个格子」（栈/幽灵/预览/棋盘都走缓存）
ok(HOT.blockGradient <= 5,
  '每帧方块渐变 ≤ 5 次（优化前是「每个方块一条」，一屏几十次）',
  String(HOT.blockGradient));
ok(HOT.createRadialGradient <= 0.01, '每帧 createRadialGradient ≈ 0 次（棋盘柔光按几何缓存）',
  String(HOT.createRadialGradient));
ok(HOT.beginPath <= 150, '热路径每帧 beginPath ≤ 150 次', String(HOT.beginPath));
ok(HOT.stroke <= 80, '热路径每帧 stroke ≤ 80 次（优化前 ≈ 每块 4 次，几百次）', String(HOT.stroke));

/* ───────────────────────── 源码级：不得用 performance.now / 不得用 shadowBlur 铺投影 ───────────────────────── */

const HERE = fileURLToPath(new URL('.', import.meta.url));
for (const f of ['core.js', 'render.js', 'index.js']) {
  const src = readFileSync(`${HERE}${f}`, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))          // 去掉行注释再判断（注释里提到不算）
    .join('\n');
  ok(!/performance\.now\s*\(/.test(src), `${f} 里没有 performance.now()（规范 §8：时间只能由传入的 now 推导）`);
}
ok(!readFileSync(`${HERE}index.js`, 'utf8').includes('setInterval'),
  'index.js 里没有 setInterval（下落推进只能由传入的 now 驱动）');

// render.js 里 shadowBlur 只允许出现在暂停卡片（drawCard）那一处：
// 棋盘投影如果也用 shadowBlur，每帧都要多栅格化一层模糊，真机上是最贵的一项。
const renderSrc = readFileSync(`${HERE}render.js`, 'utf8');
const shadowLines = renderSrc.split('\n').filter((l) => /shadowBlur\s*=/.test(l));
eq(shadowLines.length, 1, 'render.js 里只有 1 处 shadowBlur（暂停卡片），棋盘投影不再用它',
  JSON.stringify(shadowLines));

/* ───────────────────────── 汇总 ───────────────────────── */

if (AS_JSON) console.log('PERF_JSON ' + JSON.stringify(M));

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) { console.log('失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(failures.length === 0 ? 0 : 1);
