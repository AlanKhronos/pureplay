/**
 * 俄罗斯方块绘制层：只负责「把状态画出来」，不持有状态、不碰平台 API。
 * 同一份代码同时供微信小游戏（ctx from wx.createCanvas）与浏览器预览使用。
 *
 * 屏幕分区（自上而下）：
 *   ┌ 标题 + 下一块预览 ─────────┐
 *   │  10×20 主棋盘（居中）      │
 *   │  分数 / 等级 / 消行统计     │
 *   │  ←  →  ⟳  /  加速 到底 暂停 │  ← 两排大按钮，底部留 insets.bottom + 16
 *   └───────────────────────────┘
 * 左上角返回、右上角齿轮由集成层绘制，本文件不碰。
 *
 * 性能约定（render 每帧都跑，见规范 §6）：
 *   - 渐变按「ctx + 位置」缓存，稳态下每帧 0~4 次 createLinearGradient；
 *   - 棋盘的 28 条格线合并成 1 条路径、1 次 stroke；
 *   - 同色方块的高光/压暗/内描边合并成「每色 4 次 stroke」（原来是每块 4 次）；
 *   - 棋盘投影不用 shadowBlur（它要每帧额外栅格化一层模糊，是整帧最贵的一项）；
 *   - 字体串缓存，不每帧拼模板字符串。
 * 这些都有计数断言兜着：node src/games/tetris/perf-check.mjs
 */
import {
  COLS, ROWS, EMPTY, TYPES, COLORS, DIFFICULTIES,
  rotateShape, cellsOf, dropDistance, statusText, clearLabel, fallProgress,
} from './core.js';
// 木质按钮外观由集成层统一提供（规范 §10）：本模块只调用，不自己画按钮底色。
// 这是唯一的跨模块 import —— 规范明确要求的「按钮外观走集成层」。
import { drawWoodButton } from '../../ui/renderer.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/** 预览框的换算基准：I 形最宽 4 格、其余方块最高 2 格。 */
const PREVIEW_MAX_W = 4;
const PREVIEW_MAX_H = 2;

/**
 * 按钮文字（布局里的兜底标签与图标面共用这一份，避免两处写死写不一致）。
 * ⚠️ 这是对外契约：test.mjs / render-check.mjs 直接断言这几个字，
 * 改文案必须同步改测试（用户要求：速降 → 到底，新增键 → 加速）。
 */
export const LABELS = {
  rotate: '旋转',
  soft: '加速',    // 用户要的第 6 个键位：按住加速下落（软降）
  drop: '到底',    // 原「速降」：一步落到底并立即锁定
  pause: '暂停',
};

/* ───────────────────────── 每帧绘制缓存 ─────────────────────────
 * 为什么要有缓存：render() 每帧都跑，而 canvas 的 createLinearGradient /
 * createRadialGradient 在真机上要现分配 shader，并不便宜。
 *   优化前：一屏几十个方块，每个方块每帧新建一条对角渐变（60 块 = 60 次/帧）；
 *   优化后：同一 (类型, 尺寸, 像素位置) 只建一次，稳态下每帧只剩「下落中那 4 个格子」
 *          （它的 y 是插值出来的连续小数，位置每帧都不同，故意不进缓存，见 blockGradient）。
 *
 * 按 ctx 隔离（WeakMap）：CanvasGradient 只在创建它的上下文里保证可用，
 * 换 canvas（预览页 / 真机 / 重开一局）后旧对象不能复用。
 * ─────────────────────────────────────────────────────────── */
const GRAD_CACHE_MAX = 512;             // 缓存上限：超了整体清空（栈的位置有限，清空极少发生）
const gradCaches = new WeakMap();

/** 取（或建）一个按 ctx 隔离的缓存渐变。 */
function cachedGradient(ctx, key, build) {
  let m = gradCaches.get(ctx);
  if (!m) { m = new Map(); gradCaches.set(ctx, m); }
  let g = m.get(key);
  if (!g) {
    // 上限兜底：宁可偶发重建，也不让缓存无上限增长（内存也是主包预算的一部分）
    if (m.size >= GRAD_CACHE_MAX) m.clear();
    g = build();
    m.set(key, g);
  }
  return g;
}

/**
 * 字体串缓存。
 * 优化前：每帧要拼 15 次以上模板字符串（`700 22px ...`），并反复触发
 * canvas 的 font 解析（解析字体串比想象中贵）。
 * 数字是有限的，缓存键就是「粗细 + 字号」，命中率极高。
 */
const fontCache = new Map();
function fontOf(weight, px) {
  // 键用字符串拼：字号缺失（theme 没给）时也能落到一个稳定键上，不会互相串
  const key = `${weight}|${px}`;
  let f = fontCache.get(key);
  if (!f) { f = `${weight} ${px}px ${FONT}`; fontCache.set(key, f); }
  return f;
}

/* ───────────────────────── 基础工具 ───────────────────────── */

/**
 * 往**当前路径**追加一个圆角矩形（不 beginPath）。
 * 为什么要把「开新路径」和「画形状」拆开：一帧里几十个方块的描边样式是完全相同的，
 * 把它们的子路径攒进同一条路径、只 stroke 一次，能让描边调用从 N 次降到 1 次；
 * 而 pathRoundRect 内部自带 beginPath，没法攒。
 */
export function addRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y + rr, x, y, rr);
  ctx.closePath();
}

/** 圆角矩形路径（不依赖 ctx.roundRect，兼容小游戏基础库）。 */
export function pathRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  addRoundRect(ctx, x, y, w, h, r);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 取某种方块的配色（未知类型退回灰色，绝不崩）。 */
export function blockColor(type) {
  return COLORS[type] ?? { base: '#8a90a0', hi: '#c9cede', lo: '#4a4f5c' };
}

/** 命中矩形（布局与输入共用一份逻辑）。 */
export function hitRect(rect, x, y) {
  return !!rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/* ───────────────────────── 布局 ───────────────────────── */

/**
 * 顶部两个角区（集成层的返回键 / 右上齿轮）的下沿 y。
 *
 * 为什么本模块要自己算一遍：那两颗按钮由集成层画，游戏模块拿不到它们的矩形，
 * 但规范 §5/§10 要求「顶部同高度留空，避免遮挡」。
 * 集成层的尺子是 src/ui/layout.js：pad = round(min(w,h) * 0.045)、
 * size = max(30, round(pad * 2.1))，按钮从 safeTop + 4 起画。
 * 这里照同一把尺子推一遍（不 import 集成层布局，免得把五子棋的棋盘布局拖进来），
 * 再留 4px 余量——顺带兜住平板/大屏上角区比 56px 大得多的情况（768×1024 实测 74px）。
 */
function cornerBandBottom(width, height, safeTop) {
  const uiPad = Math.round(Math.min(width, height) * 0.045) || 16;
  const size = Math.max(30, Math.round(uiPad * 2.1));
  // 两把尺子取更保守的一把：
  //   ① 集成层角区实测下沿 = safeTop + 4 + 按钮边长（768×1024 上边长 74px，不止 56px）
  //   ② 规范 §10 给的粗略预留：顶部 56px
  return Math.round(Math.max(safeTop + 4 + size + 4, safeTop + 56));
}

/**
 * 计算本模块的全部几何信息。
 * @param width  逻辑像素宽
 * @param height 逻辑像素高
 * @param insets { top, bottom } 安全区（实机底部有手势条，必须让位）
 */
export function computeLayout(width, height, insets = {}) {
  const w = Math.max(200, Math.round(width || 375));
  const h = Math.max(320, Math.round(height || 667));
  const safeTop = Math.max(0, Math.round(insets.top ?? 0));
  const safeBottom = Math.max(0, Math.round(insets.bottom ?? 0));

  const pad = Math.max(12, Math.round(Math.min(w, h) * 0.035));
  // 顶部给集成层的返回/齿轮留出高度（我们不画，但不能压上去）
  const topH = Math.max(34, safeTop + (safeTop > 0 ? 12 : 30));

  // 按钮：两排各三个。宽高都往「手指好点」的方向取值
  const btnGap = Math.max(8, Math.round(pad * 0.55));
  const rowGap = btnGap;
  const btnW = Math.floor((w - pad * 2 - btnGap * 2) / 3);
  const btnH = Math.max(54, Math.min(78, Math.round(w * 0.155)));
  const blockH = btnH * 2 + rowGap;
  // 底部让位：insets.bottom + 16（实机手势条会吃掉下面那一截）
  const footerBottom = h - safeBottom - 16;
  const footerY = footerBottom - blockH;

  const buttons = [];
  // 六个操作键，顺序是**固定契约**（test.mjs 断言 left,rotate,right,soft,drop,pause）：
  //   第一排 移动 / 旋转，第二排 加速（按住）/ 到底（一步锁定）/ 暂停。
  //   用户要求：在 right 与 drop 之间插入「加速」；原「速降」改名「到底」。
  const keys = [
    ['left', '←'], ['rotate', '⟳'], ['right', '→'],
    ['soft', LABELS.soft], ['drop', LABELS.drop], ['pause', LABELS.pause],
  ];
  keys.forEach(([key, label], i) => {
    const r = Math.floor(i / 3), c = i % 3;
    buttons.push({
      key,
      label,
      x: pad + c * (btnW + btnGap),
      y: footerY + r * (btnH + rowGap),
      w: btnW,
      h: btnH,
    });
  });

  const statsH = Math.max(30, Math.round(btnH * 0.52));
  const statsY = footerY - 6 - statsH;

  // 顶部条带：标题居中（左右两个角落已被集成层的返回键/齿轮占用）。
  // 必须先算标题带、再算棋盘：标题带（safeTop+4 起、34px 高）在安全区大的机型上
  // 会伸到棋盘里——实测 375×667 上标题被棋盘压掉下半截、副标题更是在深色棋盘上
  // 变成"隐形字"（theme.textMuted 画在深底上对比度不足 2:1）。
  const cornerSize = Math.max(32, Math.round(pad * 2.1));
  const title = {
    x: pad,
    y: safeTop + 4,
    w: w - pad * 2,
    h: Math.max(34, cornerSize),
  };

  // 棋盘从标题带下方开始（topH 是给集成层顶部留的最小高度，两者取更靠下的）
  const boardTop = Math.max(topH, title.y + title.h + 4);
  const boardAreaH = Math.max(80, statsY - boardTop - pad);
  const boardAreaW = w - pad * 2;

  const cell = Math.max(6, Math.floor(Math.min(boardAreaW / COLS, boardAreaH / ROWS)));
  const bw = cell * COLS;
  const bh = cell * ROWS;
  const boardX = Math.round((w - bw) / 2);
  const boardY = Math.round(boardTop + Math.max(0, (boardAreaH - bh) / 2));

  const board = {
    x: boardX, y: boardY, w: bw, h: bh, cell,
    /** 格子坐标 → 屏幕像素（左上角）。 */
    toScreen(gx, gy) {
      return { x: boardX + gx * cell, y: boardY + gy * cell };
    },
  };

  // 下一块预览：放到**棋盘左侧的空白区**（标题居中 + 预览左移，这个方案保持不变）。
  // 三条硬要求，缺一条就会被挡住或压住棋盘：
  //   ① 不进顶部两个角区——集成层的返回键/齿轮会把这块压住（规范 §5/§10）
  //   ② 宽度不超过棋盘左侧留白，否则会压在棋盘上（方块预览也会变形）
  //   ③ 纵向落在棋盘范围内，别掉到统计条上
  const corner = cornerBandBottom(w, h, safeTop);      // 角区下沿（见下方函数）
  const nextGap = Math.round(pad * 0.5);
  const gutter = Math.max(0, boardX - pad - nextGap);  // 棋盘左侧可用留白
  const rawNext = Math.round(cell * 2.6);
  const nextSize = Math.max(38, Math.min(rawNext, gutter > 0 ? gutter : rawNext));
  const next = {
    x: Math.max(pad, boardX - nextSize - nextGap),
    y: Math.max(boardY + Math.round(pad * 0.6), corner),
    w: nextSize,
    h: nextSize,
  };

  return {
    width: w, height: h,
    safe: { top: safeTop, bottom: safeBottom },
    pad, topH, cell, board,
    next,
    title,
    stats: { x: pad, y: statsY, w: w - pad * 2, h: statsH },
    buttons,
    /** 让位后的底边（按钮最下沿必须 ≤ 它 + 16） */
    bottomLimit: h - safeBottom - 16,
    rowGap, btnGap,
  };
}

/** 按 key 取按钮。 */
export function buttonOf(layout, key) {
  return layout.buttons.find((b) => b.key === key) ?? null;
}

/** 命中哪个按钮（返回 key，未命中返回 null）。 */
export function hitButton(layout, x, y) {
  const b = layout.buttons.find((r) => hitRect(r, x, y));
  return b ? b.key : null;
}

/* ───────────────────────── 背景与棋盘 ───────────────────────── */

/**
 * 棋盘后方的**局部**柔光，把视线收进游戏区。
 *
 * ⚠️ 本模块不铺全屏背景（规范 §10）：青白渐变底由集成层的 drawBackground 铺，
 * 这里再铺一次会把集成层刚画好的底色盖掉；tools/audit-games.mjs 的 fullscreen-bg
 * 规则也专门盯「不透明的整屏铺底」（半透明遮罩/柔光不算问题，但本模块干脆一处都不留）。
 * 早先这里铺满屏的 bgTop→bgBottom 渐变，现已删除；只保留棋盘周围一圈光晕，
 * 光晕是径向渐变的，边缘透明，不会盖住集成层的青白底。
 */
export function drawBackground(ctx, layout, theme) {
  const b = layout.board;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const r0 = Math.max(20, b.w * 0.2);
  const r1 = Math.max(60, b.w * 1.1);
  // 柔光的几何只在 resize 时变，没必要时每帧重建 shader —— 按 ctx + 几何缓存
  const glow = cachedGradient(ctx, `glow|${cx},${cy},${r0},${r1}|${theme.accentSoft}`, () => {
    const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    // theme 缺令牌时给兜底色，避免 addColorStop(undefined) 在真机 canvas 上抛错
    g.addColorStop(0, theme.accentSoft ?? 'rgba(176,125,22,0.18)');
    g.addColorStop(1, 'rgba(240,180,41,0)');
    return g;
  });
  ctx.fillStyle = glow;
  // 只覆盖棋盘四周的余量，不铺满屏
  const m = Math.round(Math.max(28, b.w * 0.35));
  ctx.fillRect(b.x - m, b.y - m, b.w + m * 2, b.h + m * 2);
}

/** 棋盘底板 + 暗格纹（网格只做极低对比，避免抢方块的视觉）。 */
export function drawBoard(ctx, layout, theme) {
  const b = layout.board;
  const r = Math.round(b.cell * 0.35);

  // 投影：**不再用 shadowBlur**。
  // shadowBlur 要求 canvas 每帧为这个圆角矩形额外栅格化一层模糊，是整帧里最贵的一项
  // （真机上尤其明显）；改成「往下偏几像素的深色圆角块」，观感接近，开销只是一次普通填充。
  const sh = Math.max(2, Math.round(b.cell * 0.16));
  pathRoundRect(ctx, b.x, b.y + sh, b.w, b.h, r);
  ctx.fillStyle = 'rgba(6,8,14,0.42)';
  ctx.fill();

  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.fillStyle = 'rgba(6,8,14,0.9)';
  ctx.fill();

  // 井底：垂直渐变，下深上浅，制造纵深（按 ctx + 几何缓存，稳态下每帧 0 次新建）
  const g = cachedGradient(ctx, `board|${b.y}|${b.h}`, () => {
    const lg = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    lg.addColorStop(0, 'rgba(30,36,52,0.95)');
    lg.addColorStop(1, 'rgba(10,13,22,0.98)');
    return lg;
  });
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.fillStyle = g;
  ctx.fill();

  // 格子纹：28 条线**合并成一条路径、只 stroke 一次**。
  // 优化前是 28 次 beginPath + 28 次 stroke（样式完全相同，纯属浪费）；
  // 优化后 1 次 beginPath + 1 次 stroke，路径段数不变、观感一模一样。
  ctx.save();
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < COLS; x++) {
    ctx.moveTo(b.x + x * b.cell, b.y);
    ctx.lineTo(b.x + x * b.cell, b.y + b.h);
  }
  for (let y = 1; y < ROWS; y++) {
    ctx.moveTo(b.x, b.y + y * b.cell);
    ctx.lineTo(b.x + b.w, b.y + y * b.cell);
  }
  ctx.stroke();
  ctx.restore();

  // 边框：外亮内深，做出亚克力面板的倒角
  pathRoundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, r);
  ctx.strokeStyle = theme.panelBorder;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

/* ───────────────────────── 方块 ───────────────────────── */

/* 下面四条边都只往**当前路径**追加子路径，不 beginPath / 不 stroke。
 * 这样批量绘制能把 N 个方块的同类边攒进一条路径、只描一次边。
 * 参数全部用标量传：一个批次里 size/inset 是常数，s / r / hiW 只算一次就够，
 * 不必每个方块、每条边再算一遍几何（那是纯粹白烧的 CPU 与 GC）。 */

/** 上高光边。 */
function addTopHighlight(ctx, x, y, s, r, hiW) {
  ctx.moveTo(x + r * 1.1, y + hiW);
  ctx.lineTo(x + s - r * 1.1, y + hiW);
}

/** 左高光边。 */
function addLeftHighlight(ctx, x, y, s, r, hiW) {
  ctx.moveTo(x + hiW, y + r * 1.1);
  ctx.lineTo(x + hiW, y + s - r * 1.6);
}

/** 右下压暗边（一条折线，加强体积感）。 */
function addDarkEdge(ctx, x, y, s, r, hiW) {
  ctx.moveTo(x + r * 1.1, y + s - hiW * 0.7);
  ctx.lineTo(x + s - hiW * 0.7, y + s - hiW * 0.7);
  ctx.lineTo(x + s - hiW * 0.7, y + r * 1.1);
}

/** 极细内描边（深色底上轮廓更利落）。 */
function addInnerOutline(ctx, x, y, s, r) {
  addRoundRect(ctx, x + 0.5, y + 0.5, s - 1, s - 1, r);
}

/** 单块的 4 条细节描边（逐块绘制用；批量绘制走 drawBlockBatch 的合并版）。 */
function strokeBlockDetails(ctx, x, y, s, r, hiW) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  addTopHighlight(ctx, x, y, s, r, hiW);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = hiW;
  ctx.stroke();

  ctx.beginPath();
  addLeftHighlight(ctx, x, y, s, r, hiW);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = hiW * 0.8;
  ctx.stroke();

  ctx.beginPath();
  addDarkEdge(ctx, x, y, s, r, hiW);
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = hiW * 0.9;
  ctx.stroke();

  ctx.beginPath();
  addInnerOutline(ctx, x, y, s, r);
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 真正新建一条方块对角渐变（左上亮 → 右下暗）。 */
function makeBlockGradient(ctx, c, x, y, s) {
  const lg = ctx.createLinearGradient(x, y, x + s, y + s);
  lg.addColorStop(0, c.hi);
  lg.addColorStop(0.42, c.base);
  lg.addColorStop(1, c.lo);
  return lg;
}

/**
 * 取某个「颜色 + 尺寸 + 内缩」组合的**子缓存**。
 * 一帧里同色方块有几十个，这个解析（要拼一次字符串）只该做一次，
 * 之后每个方块只用数字键查 —— 优化前后差的就是这几十次字符串分配。
 */
function subCache(ctx, c, size, inset) {
  let byColor = gradCaches.get(ctx);
  if (!byColor) { byColor = new Map(); gradCaches.set(ctx, byColor); }
  const key = `${c.base}|${size}|${inset}`;
  let sub = byColor.get(key);
  if (!sub) { sub = new Map(); byColor.set(key, sub); }
  return sub;
}

/**
 * 取方块的对角渐变（整数像素位置走缓存）。
 *
 * 为什么只给整数位置缓存：栈 / 幽灵 / NEXT 预览都落在整数格点上，位置有限且在整局里
 * 反复复用，命中率极高（优化前每帧几十次新建 → 稳态下 0 次）；
 * 而下落中的方块 y 是插值出来的**连续小数**，每帧都是新位置 —— 缓存它只会把缓存撑爆、
 * 频繁触发整体清空，反而更慢。那 4 个格子就每帧老实新建（4 次/帧，可接受）。
 *
 * 缓存键用数字（px * 4096 + py）而不是字符串：逻辑像素坐标不会超过 4096，
 * 数字键省掉每块一次字符串拼接与哈希。
 */
function blockGradient(ctx, c, size, inset, px, py, x, y, s) {
  if (!Number.isInteger(px) || !Number.isInteger(py)) return makeBlockGradient(ctx, c, x, y, s);
  const sub = subCache(ctx, c, size, inset);
  const key = px * 4096 + py;
  let g = sub.get(key);
  if (!g) {
    if (sub.size >= GRAD_CACHE_MAX) sub.clear();     // 上限兜底，不让缓存无上限增长
    g = makeBlockGradient(ctx, c, x, y, s);
    sub.set(key, g);
  }
  return g;
}

/**
 * 画一个立体方块。
 * 三层结构：圆角底 + 对角渐变（左上亮、右下暗）+ 上/左高光边，右下压暗边。
 * @param inset 内缩（px），让格子之间有缝，块与块能数得清
 * @param alpha 透明度（幽灵块用）
 */
export function drawBlock(ctx, px, py, size, type, alpha = 1, inset = 1) {
  const c = blockColor(type);
  const s = size - inset * 2;
  if (s <= 1) return;
  const r = Math.max(1.5, s * 0.20);
  const hiW = Math.max(1.5, s * 0.16);
  const x = px + inset;
  const y = py + inset;

  ctx.save();
  if (alpha !== 1) {
    ctx.globalAlpha = alpha;
    // 幽灵块只描边，不填实心，避免盖住底下的方块
    pathRoundRect(ctx, x, y, s, s, r);
    ctx.strokeStyle = c.base;
    ctx.lineWidth = Math.max(1.2, s * 0.10);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // 底：对角渐变（整数位置走缓存）
  ctx.beginPath();
  addRoundRect(ctx, x, y, s, s, r);
  ctx.fillStyle = blockGradient(ctx, c, size, inset, px, py, x, y, s);
  ctx.fill();

  strokeBlockDetails(ctx, x, y, s, r, hiW);
  ctx.restore();
}

/**
 * 同色多块的批量绘制。
 *
 * 底仍然逐块填充（每个块的渐变端点不同，没法合并），但「上高光 / 左高光 / 右下压暗 /
 * 内描边」这四条边各合并成**一次** stroke。一屏几十个方块时描边次数从 4N 降到 4，
 * 而结果与逐块 drawBlock 完全一致：同样的几何、同样的顺序、同样的样式；
 * 子路径之间互不重叠，圆头线帽也不会在子路径交界处连起来。
 *
 * @param pts 扁平坐标数组 [x0,y0, x1,y1, ...]（少建一半小数组）
 */
export function drawBlockBatch(ctx, pts, size, type, inset) {
  const n = pts.length;
  if (n < 2) return;
  const s = size - inset * 2;
  if (s <= 1) return;
  const r = Math.max(1.5, s * 0.20);
  const hiW = Math.max(1.5, s * 0.16);
  const c = blockColor(type);
  const sub = subCache(ctx, c, size, inset);        // 每批只解析一次缓存（见 subCache 注释）

  // ① 底：逐块填充（这一步的路径没法合并，见上）
  for (let i = 0; i < n; i += 2) {
    const px = pts[i], py = pts[i + 1];
    const x = px + inset, y = py + inset;
    ctx.beginPath();
    addRoundRect(ctx, x, y, s, s, r);
    const key = px * 4096 + py;                     // 栈上的方块一定在整数格点，直接查
    let g = sub.get(key);
    if (!g) {
      if (sub.size >= GRAD_CACHE_MAX) sub.clear();
      g = makeBlockGradient(ctx, c, x, y, s);
      sub.set(key, g);
    }
    ctx.fillStyle = g;
    ctx.fill();
  }

  // ②③④⑤ 四条边各合并成一次描边
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  for (let i = 0; i < n; i += 2) addTopHighlight(ctx, pts[i] + inset, pts[i + 1] + inset, s, r, hiW);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = hiW;
  ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i < n; i += 2) addLeftHighlight(ctx, pts[i] + inset, pts[i + 1] + inset, s, r, hiW);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = hiW * 0.8;
  ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i < n; i += 2) addDarkEdge(ctx, pts[i] + inset, pts[i + 1] + inset, s, r, hiW);
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = hiW * 0.9;
  ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i < n; i += 2) addInnerOutline(ctx, pts[i] + inset, pts[i + 1] + inset, s, r);
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

/**
 * 已落定的方块堆。
 * 先按方块类型分桶，再按桶批量绘制 —— 同色方块的描边样式完全一样，
 * 分开画就是白花几十次 stroke（优化前 60 块 = 240 次描边，现在 7 种颜色最多 28 次）。
 * 桶数组是**复用**的（每帧清空长度而不是新建数组），省掉每帧几十个数组的垃圾。
 */
const BUCKET_IDX = { I: 0, O: 1, T: 2, S: 3, Z: 4, J: 5, L: 6 };
const BUCKET_PTS = [[], [], [], [], [], [], []];

export function drawStack(ctx, layout, state) {
  const b = layout.board;
  const grid = state.grid;
  const cell = b.cell;
  const inset = Math.max(1, cell * 0.045);

  for (let y = 0; y < ROWS; y++) {
    const row = grid[y];
    const py = b.y + y * cell;
    for (let x = 0; x < COLS; x++) {
      const v = row[x];
      if (v === EMPTY) continue;
      const bi = BUCKET_IDX[v];
      if (bi === undefined) {
        // 理论上不会发生（格子只写 TYPES 里的值）；真出脏数据也别让整帧崩掉
        drawBlock(ctx, b.x + x * cell, py, cell, v, 1, inset);
        continue;
      }
      BUCKET_PTS[bi].push(b.x + x * cell, py);
    }
  }

  for (let i = 0; i < BUCKET_PTS.length; i++) {
    const pts = BUCKET_PTS[i];
    if (pts.length === 0) continue;
    drawBlockBatch(ctx, pts, cell, TYPES[i], inset);
    pts.length = 0;                                 // 清空复用，不新建数组
  }
}

/** 幽灵落点（半透明轮廓，告诉玩家会落在哪）。 */
export function drawGhost(ctx, layout, state) {
  const piece = state.piece;
  if (!piece || state.status === 'over') return;
  const dy = dropDistance(state, piece);
  if (dy <= 0) return;
  const b = layout.board;
  const m = rotateShape(piece.type, piece.r);
  const inset = Math.max(1, b.cell * 0.10);
  for (const [cx, cy] of cellsOf(m)) {
    const gy = piece.y + dy + cy;
    if (gy < 0) continue;
    const p = b.toScreen(piece.x + cx, gy);
    drawBlock(ctx, p.x, p.y, b.cell, piece.type, 0.30, inset);
  }
}

/**
 * 当前方块某一格应该画在哪个像素 y —— **含下落插值**。
 *
 * 为什么要有这个函数：core 里的 y 是整格坐标，直接照着画就是「每 650ms 跳一格」，
 * 所以旧版看起来是一格一格地蹦，没有连续下落的感觉。这里把 core 算好的
 * 「距上次落格的进度 t∈[0,1]」乘上一格高度补进去，方块就变成连续下移：
 *
 *     落格前：画在  y*cell + t*cell      （t 从 0 涨到 1）
 *     落格后：y+1 格、t 回到 0 → 画在 (y+1)*cell + 0
 *   两者像素位置完全相等 —— 所以「落格瞬间」不会抖动（这是插值最容易出错的地方）。
 *
 * 只导出给测试取证用（断言下落位移是连续变化而不是整格跳）；drawPiece 内部也走它，
 * 保证「测试断言的值」和「真正画出去的值」是同一处定义。
 *
 * @param gy   该格的棋盘行号（已经是绝对值，调用方自己加 piece.y）
 * @param yOff 可选：本帧的插值偏移（px）。一次绘制里 4 个格子共用同一个偏移，
 *             传进来可以少算 3 次 canMove。
 */
export function pieceCellY(layout, state, gy, yOff) {
  const b = layout.board;
  const off = yOff === undefined ? fallProgress(state) * b.cell : yOff;
  return b.y + gy * b.cell + off;
}

/** 当前正在下落的方块（轻微呼吸描边，注意力落点）。 */
export function drawPiece(ctx, layout, state, now) {
  const piece = state.piece;
  if (!piece || state.status === 'over') return;
  const b = layout.board;
  const m = rotateShape(piece.type, piece.r);
  const inset = Math.max(1, b.cell * 0.045);
  const pulse = 0.5 + 0.5 * Math.sin((now ?? 0) / 380);
  // 本帧的插值偏移：4 个格子共用（下落进度与格子无关，算一次就够）
  const yOff = fallProgress(state) * b.cell;

  for (const [cx, cy] of cellsOf(m)) {
    const gy = piece.y + cy;
    if (gy < 0) continue;
    const px = b.x + (piece.x + cx) * b.cell;
    const py = pieceCellY(layout, state, gy, yOff);
    drawBlock(ctx, px, py, b.cell, piece.type, 1, inset);

    // 外圈微弱光晕：越接近锁定越明显
    ctx.save();
    ctx.globalAlpha = 0.18 + pulse * 0.18;
    pathRoundRect(ctx, px + inset, py + inset, b.cell - inset * 2, b.cell - inset * 2, Math.max(2, b.cell * 0.20));
    ctx.strokeStyle = blockColor(piece.type).hi;
    ctx.lineWidth = Math.max(1, b.cell * 0.06);
    ctx.stroke();
    ctx.restore();
  }
}

/* ───────────────────────── 顶部 HUD 与下一块 ───────────────────────── */

/** 把某个方块画进一个方框（居中、按格子缩放）。 */
export function drawPieceInBox(ctx, box, type, cell) {
  const m = rotateShape(type, 0);
  if (!m) return;                       // 未知类型直接跳过，绘制层不能因数据异常崩
  const cells = cellsOf(m);
  if (!cells.length) return;
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const w = (maxX - minX + 1) * cell;
  const h = (maxY - minY + 1) * cell;
  // 取整到整像素：预览框的居中量常常是半个像素（如 .5），
  // 取整后位移不超过 0.5px（肉眼看不出），但方块的渐变就能进缓存 —— 每帧少建几次 shader。
  const ox = Math.round(box.x + (box.w - w) / 2 - minX * cell);
  const oy = Math.round(box.y + (box.h - h) / 2 - minY * cell);
  for (const [cx, cy] of cells) {
    drawBlock(ctx, ox + cx * cell, oy + cy * cell, cell, type, 1, Math.max(1, cell * 0.06));
  }
}

/** 顶栏：居中标题（当前难度）+ 棋盘左侧的下一块预览框。 */
export function drawTop(ctx, layout, state, theme, now) {
  const cfg = DIFFICULTIES[state.difficulty] ?? DIFFICULTIES.normal;
  const t = layout.title;

  // 标题居中：左右两个角落留给集成层的返回键与齿轮
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.textPrimary;
  ctx.font = fontOf(700, theme.fontTitle);
  ctx.fillText('俄罗斯方块', t.x + t.w / 2, t.y + t.h * 0.40);

  ctx.font = fontOf(500, theme.fontSmall);
  ctx.fillStyle = theme.textMuted;
  ctx.fillText(`难度 ${cfg.name} · 消 ${state.lines} 行`, t.x + t.w / 2, t.y + t.h * 0.78);

  // 下一块：胶囊框 + 小标签
  const n = layout.next;
  pathRoundRect(ctx, n.x, n.y, n.w, n.h, Math.round(n.w * 0.22));
  ctx.fillStyle = theme.panel ?? 'rgba(255,255,255,0.78)';
  ctx.fill();
  ctx.strokeStyle = theme.panelBorder ?? 'rgba(150,110,50,0.28)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = fontOf(600, Math.max(9, (theme.fontSmall ?? 12) - 2));
  ctx.fillStyle = theme.textMuted ?? 'rgba(61,91,86,0.62)';
  // 标签放进框内顶部：挂在框外会被上一行的内容蹭到
  ctx.fillText('NEXT', n.x + n.w / 2, n.y + Math.max(8, Math.round(n.h * 0.15)));

  // 预览格大小：按「最宽的方块占 4 格、最高的方块占 2 格」反推，
  // 保证任何方块（含 I 形的 4 连）都完整装进框里，不会溢出边框。
  const cell = Math.max(3, Math.floor(Math.min((n.w - 8) / PREVIEW_MAX_W, (n.h - 8) / PREVIEW_MAX_H)));
  const nextType = typeof state.next === 'string' ? state.next : (state.next?.type ?? 'T');
  drawPieceInBox(ctx, { x: n.x + 4, y: n.y + 4, w: n.w - 8, h: n.h - 8 }, nextType, cell);
  ctx.textAlign = 'left';
}

/** 分数 / 等级 / 消行 三格统计条。 */
export function drawStats(ctx, layout, state, theme) {
  const s = layout.stats;
  const gap = Math.round(s.w * 0.02);
  const cw = (s.w - gap * 2) / 3;
  const items = [
    { label: '分数', value: String(state.score), color: theme.accent },
    { label: '等级', value: String(state.level), color: theme.textPrimary },
    { label: '消行', value: String(state.lines), color: theme.textPrimary },
  ];

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  items.forEach((it, i) => {
    const x = s.x + i * (cw + gap);
    pathRoundRect(ctx, x, s.y, cw, s.h, Math.round(s.h * 0.30));
    ctx.fillStyle = theme.panel;
    ctx.fill();

    ctx.font = fontOf(500, Math.max(9, theme.fontSmall - 1));
    ctx.fillStyle = theme.textMuted;
    ctx.fillText(it.label, x + cw / 2, s.y + s.h * 0.29);

    ctx.font = fontOf(700, Math.max(13, Math.round(s.h * 0.40)));
    ctx.fillStyle = it.color;
    ctx.fillText(it.value, x + cw / 2, s.y + s.h * 0.70);
  });
  ctx.textAlign = 'left';
}

/* ───────────────────────── 底部按钮 ───────────────────────── */

/** 画按钮上一个简易矢量图标（箭头 / 旋转 / 加速 / 暂停 / 到底）。 */
function drawIcon(ctx, key, cx, cy, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, r * 0.30);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (key === 'left' || key === 'right') {
    const dir = key === 'left' ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(cx - dir * r * 0.75, cy);
    ctx.lineTo(cx + dir * r * 0.75, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + dir * r * 0.05, cy - r * 0.62);
    ctx.lineTo(cx + dir * r * 0.80, cy);
    ctx.lineTo(cx + dir * r * 0.05, cy + r * 0.62);
    ctx.stroke();
  } else if (key === 'soft') {
    // 加速键：向下的**双箭头**。与「到底」的单箭头 + 落地横线刻意区分开：
    // 语义是「往下得更快」，不是「一步落到底」。
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.62, cy - r * 0.72);
    ctx.lineTo(cx, cy - r * 0.24);
    ctx.lineTo(cx + r * 0.62, cy - r * 0.72);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.62, cy + r * 0.10);
    ctx.lineTo(cx, cy + r * 0.58);
    ctx.lineTo(cx + r * 0.62, cy + r * 0.10);
    ctx.stroke();
  } else if (key === 'rotate') {
    // 顺时针圆箭头
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.66, Math.PI * 0.35, Math.PI * 1.75);
    ctx.stroke();
    const a = Math.PI * 1.75;
    const hx = cx + Math.cos(a) * r * 0.66, hy = cy + Math.sin(a) * r * 0.66;
    ctx.beginPath();
    ctx.moveTo(hx - r * 0.36, hy - r * 0.10);
    ctx.lineTo(hx + r * 0.14, hy - r * 0.02);
    ctx.lineTo(hx - r * 0.12, hy + r * 0.44);
    ctx.closePath();
    ctx.fill();
  } else if (key === 'drop') {
    // 两条横线 + 下箭头 = 一步落到底（文字「到底」）
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.62, cy - r * 0.78);
    ctx.lineTo(cx + r * 0.62, cy - r * 0.78);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.34);
    ctx.lineTo(cx, cy + r * 0.52);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.48, cy + r * 0.02);
    ctx.lineTo(cx, cy + r * 0.62);
    ctx.lineTo(cx + r * 0.48, cy + r * 0.02);
    ctx.stroke();
  } else if (key === 'pause') {
    ctx.fillRect(cx - r * 0.52, cy - r * 0.66, r * 0.38, r * 1.32);
    ctx.fillRect(cx + r * 0.14, cy - r * 0.66, r * 0.38, r * 1.32);
  }
  ctx.restore();
}

/**
 * 六个按钮的「脸面」：矢量图标 + 文字。
 *   - 文字交给集成层的 drawWoodButton 居中绘制（全站按钮墨色由此统一）
 *   - 图标由本文件矢量绘制，颜色取主题令牌 theme.textOnWood（木底上的墨色）
 * 键盘/读屏无关：这里只描述外观，命中判定仍走 computeLayout 的按钮矩形。
 */
const BTN_FACE = {
  left:   { icon: 'left',   text: '' },                 // 箭头只画矢量图标，不叠字形
  rotate: { icon: 'rotate', text: LABELS.rotate },
  right:  { icon: 'right',  text: '' },
  soft:   { icon: 'soft',   text: LABELS.soft },        // 新增键：按住加速下落（文字「加速」）
  drop:   { text: LABELS.drop },                        // 主操作：只放文字，primary 木底色已足够突出
  pause:  { icon: 'pause',  text: LABELS.pause },
};

/**
 * 两排大按钮（移动端手指可点）。
 * 外观统一走集成层导出的 drawWoodButton（规范 §10：按钮外观由集成层提供），
 * 本文件只补图标，并用主题令牌上色——不再自己填色、自己描边。
 */
export function drawButtons(ctx, layout, state, theme) {
  const fontSize = theme.fontBtn ?? 15;
  const ink = theme.textOnWood ?? '#4a2f08';   // 木底墨色（令牌），不写死

  for (const btn of layout.buttons) {
    const face = BTN_FACE[btn.key] ?? {};
    const pressed = state.pressKey === btn.key;
    const primary = btn.key === 'drop';

    // ① 木质底板 + 居中文字（hard drop 走 primary 金色木面）
    drawWoodButton(ctx, btn, face.text ?? btn.label ?? '', { pressed, primary, fontSize });

    // ② 图标：有文字时贴在文字左侧，没有文字时居中
    if (!face.icon) continue;
    const r = Math.min(btn.h, btn.w) * 0.26;
    const cy = btn.y + btn.h / 2;
    let cx = btn.x + btn.w / 2;
    if (face.text) {
      // 用与 drawWoodButton 相同的字体量文字宽度，图标才贴得准
      ctx.font = fontOf(700, fontSize);
      const tw = ctx.measureText(face.text).width;
      cx = btn.x + btn.w / 2 - tw / 2 - r - 4;
    }
    drawIcon(ctx, face.icon, cx, cy, r, ink);
  }
}

/* ───────────────────────── 浮层：暂停 ───────────────────────── */
/* 结算卡片已删除（规范 §10：统一结算弹窗由集成层 drawResultDialog 绘制）。
 * 终局时本模块只保持棋盘画面照常显示、outcome 照常返回（规范 §9：不得自动重开）。 */

/**
 * 局部遮罩：只压暗**棋盘**这块容器。
 * ⚠️ 不做全屏遮罩——全屏铺底是集成层的职责（规范 §10）；
 * 而且「整屏压暗」在青白主题下会把集成层辛苦铺的底色整块吃掉。
 */
function dimBoard(ctx, layout, alpha) {
  const b = layout.board;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#05070c';
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, Math.round(b.cell * 0.35));
  ctx.fill();
  ctx.restore();
}

/**
 * 浮层卡片（暂停 / 结算）。
 * 走**浅色木牌**：青白主题下深色卡片配深色令牌文字等于看不见
 *（theme.textMuted 画在深底上对比度不足 2:1，属于「隐形字」）。
 */
function drawCard(ctx, layout, theme, opts) {
  const { title, titleColor, lines = [], hint = '', fade = 1 } = opts;
  const w = Math.min(layout.width - layout.pad * 3, 290);
  const h = Math.max(150, Math.round(w * 0.62));
  const x = Math.round((layout.width - w) / 2);
  // 卡片悬在棋盘上半部，别盖住底部的按钮
  const y = Math.round(layout.board.y + layout.board.h * 0.26);
  const r = Math.round(w * 0.055);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.shadowColor = theme.cardShadow ?? 'rgba(90,70,30,0.20)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  pathRoundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = theme.cardBg ?? 'rgba(255,255,255,0.85)';
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = fade;
  pathRoundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = theme.panelBorder ?? 'rgba(150,110,50,0.28)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontOf(800, theme.fontBig ?? 34);
  ctx.fillStyle = titleColor ?? theme.textPrimary ?? '#2f4f4a';
  ctx.fillText(title, x + w / 2, y + h * 0.20);

  ctx.font = fontOf(500, theme.fontHud ?? 14);
  lines.forEach((ln, i) => {
    ctx.fillStyle = i === 0 ? (theme.accent ?? '#b07d16') : (theme.textMuted ?? 'rgba(61,91,86,0.62)');
    ctx.fillText(ln, x + w / 2, y + h * (0.46 + i * 0.15));
  });

  if (hint) {
    ctx.font = fontOf(500, theme.fontSmall ?? 12);
    ctx.fillStyle = theme.textMuted ?? 'rgba(61,91,86,0.62)';
    ctx.fillText(hint, x + w / 2, y + h * 0.90);
  }
  ctx.restore();
  ctx.textAlign = 'left';
}

/** 暂停层。 */
export function drawPauseLayer(ctx, layout, state, theme, now) {
  if (state.status !== 'paused') return;
  const fade = clamp01(((now ?? 0) - (state.pausedAt ?? 0)) / 180);
  dimBoard(ctx, layout, fade * 0.62);
  drawCard(ctx, layout, theme, {
    title: '已暂停',
    titleColor: theme.accent,
    lines: [`分数 ${state.score}`, `消行 ${state.lines} · 等级 ${state.level}`],
    // 暂停时能做的只有「再点一次暂停继续」。
    // 旧文案写的是「点硬降重开」——那个按钮早就改名/改语义了，照着点只会把方块摔到底，
    // 属于会误导玩家的过期提示，这里一并修正。
    hint: '点「暂停」继续',
    fade,
  });
}

/** 消行飘字（在棋盘中央上方短期提示）。 */
export function drawClearFlash(ctx, layout, state, theme, now) {
  if (!state.lastClear || state.lastClearAt < 0) return;
  const age = (now ?? 0) - state.flashWallAt;
  if (!(age >= 0) || age > 900) return;
  const fade = age < 120 ? age / 120 : Math.max(0, 1 - (age - 120) / 780);
  const b = layout.board;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontOf(800, Math.round(theme.fontTitle * 0.92));
  ctx.fillStyle = theme.accent;
  ctx.fillText(clearLabel(state.lastClear), b.x + b.w / 2, b.y + b.h * 0.30 - age * 0.02);
  ctx.restore();
  ctx.textAlign = 'left';
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一次完整绘制。
 * @param ctx    Canvas 2D 上下文
 * @param layout computeLayout 的结果
 * @param state  本局状态（core.createState 的返回值，外加 pressKey 等 UI 字段）
 * @param theme  THEME
 * @param now    当前时间（ms，用于动画）
 */
export function renderFrame(ctx, layout, state, theme, now) {
  // ⚠️ 这里**不**清屏：清屏 + 铺青白渐变底是集成层的职责（规范 §10）。
  // 早先这里有一句「擦掉整屏」（canvas 的 clear-rect），会把集成层刚铺好的
  // 青白底一起擦掉——本文件现在一处清屏调用都没有。
  drawBackground(ctx, layout, theme);
  drawBoard(ctx, layout, theme);
  drawStack(ctx, layout, state);
  drawGhost(ctx, layout, state);
  drawPiece(ctx, layout, state, now);
  drawTop(ctx, layout, state, theme, now);
  drawStats(ctx, layout, state, theme);
  drawClearFlash(ctx, layout, state, theme, now);
  drawButtons(ctx, layout, state, theme);
  drawPauseLayer(ctx, layout, state, theme, now);
  // 终局不再画模块自绘结算卡（规范 §10：结算弹窗归集成层），棋盘画面照常保留
}

/** 顶部状态文案（供 index.js 的 hud 使用）。 */
export { statusText };
