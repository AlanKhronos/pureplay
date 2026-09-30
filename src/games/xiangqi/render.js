/**
 * 中国象棋绘制层：只接收 ctx + layout + state，不持有任何状态、不碰平台 API。
 *
 * 视觉：**青白渐变底（集成层铺）** + 暖木棋盘 + 实体棋子。
 * 棋盘：多层木色（底渐变 + 左上暖光 + 细木纹 + 年轮 + 木节）、双线边框 + 四角回纹、
 *       九宫斜线、兵炮位角括号、楚河汉界书法字 + 水波纹。
 * 棋子：木片厚度 + 径向渐变面 + 内阴影环 + 双圈描边 + 弧形高光，红=朱砂、黑=墨玉，汉字走衬线字栈。
 * 动画：选中上浮（放大 + 投影增大）→ 落子先横移后下坠 → 落定压扁回弹；取消/换选平滑落回。
 *
 * 边界（规范 §10，重要）：
 *   - 全屏背景与清屏都由集成层负责，本模块**不铺底、不 clearRect**；
 *   - 统一结算弹窗由集成层绘制，本模块只把 outcome 交给它，不自己画浮层；
 *   - 左上角返回、右上角齿轮由集成层绘制，本模块不碰，标题/状态行避开两角约 56px；
 *   - 自己的按钮全部放在底部，并且下方留出 insets.bottom + 16 的余量（实机手势条会盖住）。
 *   - 所有动画进度都由传入的 `now`（Date.now 绝对毫秒）算出来，本文件**没有 performance.now**
 *     （规范 §8：两者不同源，混用会得到 1.79e12 量级的天文数字）。
 */
import { COLS, ROWS, RED, EMPTY, sideOf, typeOf, GLYPHS } from './core.js';
// 木质按钮由集成层提供（规范 §10：按钮统一走 drawWoodButton，保证全站风格一致）
import { drawWoodButton } from '../../ui/renderer.js';

/**
 * 棋子汉字用**衬线**字栈：宋/明体的横细竖粗有"刻"出来的味道，
 * 缩小到 20px 也认得出（比如方黑体更接近传统棋子的刻字）。
 */
const SERIF = '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", "SimSun", "宋体", serif';
/** 楷体优先的字体栈（「楚河汉界」的书法感用它；衬线栈在多数机型上拿不到时才回退到这里）。 */
const KAI = '"KaiTi", "STKaiti", "Kaiti SC", "楷体", "Songti SC", "SimSun", serif';
const SANS = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/**
 * 棋盘边缘留白（单位：格）——给边线上的棋子留出身位。
 * 0.78 → 0.84：多让出的一点点正好放得下"双线边框 + 四角回纹"这条装饰带，
 * 既不会压到 x=0/x=8 两列上的棋子（棋子半径 0.44 格），也不至于把棋盘缩水。
 */
const MARGIN = 0.84;

/* ───────────────────────── 动画参数 ───────────────────────── */

/** 抬起高度（相对格子）。0.30 格：手机上约 10px，够看出"离地"又不飘。 */
const LIFT_RATIO = 0.30;
/** 抬起时的放大倍数。 */
const LIFT_SCALE = 1.13;

/**
 * 动画时序（毫秒）。集中放在这里，index.js 也 import 它来算「还要不要继续推帧」——
 * 时长散落两处迟早会不一致（改了渲染忘了改 busy，动画就会被截断）。
 */
export const ANIM = {
  pickMs: 130,     // 点击己方棋子 → 上浮升程
  settleMs: 170,   // 取消 / 换选 → 平滑落回原位
  dropMs: 210,     // 落子：横移 + 下坠（任务要求 180–260ms 区间）
  squashMs: 90,    // 落定后的压扁回弹
  fadeMs: 280,     // 被吃掉的一方淡出
};
/** 一次落子动画的总时长。 */
ANIM.dropTotalMs = ANIM.dropMs + ANIM.squashMs;

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 圆角矩形路径（不依赖 ctx.roundRect，兼容小游戏基础库）。 */
function pathRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
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

function normalizeInsets(insets = {}) {
  return {
    top: Math.max(0, Math.round(insets.top ?? 0)),
    bottom: Math.max(0, Math.round(insets.bottom ?? 0)),
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 缓出：起步快、收尾慢——上浮/横移用它，动作才"有粘性"。 */
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
/** 缓入（加速）：下坠用它，才像被重力拽下去，而不是匀速平移。 */
const easeInQuad = (t) => t * t;

/**
 * 确定性伪随机（0..1）。
 * 木纹的粗细/透明度起伏不能用 Math.random：同一帧连画两次纹理会不一样（画面会"抖"），
 * 而且每次启动的棋盘都长得不同。用序号当种子，纹理既自然又完全可复现。
 */
function hash01(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/* ───────────────────────── 布局 ───────────────────────── */

/**
 * 把屏幕尺寸换算成棋盘/按钮几何。
 * @param width/height 逻辑像素
 * @param insets { top, bottom } 安全区
 */
export function computeLayout(width, height, insets = {}) {
  const safe = normalizeInsets(insets);
  const pad = Math.max(12, Math.round(Math.min(width, height) * 0.045));
  const usableTop = safe.top;
  const usableBottom = height - safe.bottom;
  const usableH = usableBottom - usableTop;

  // 顶部信息区（标题 + 状态），只占一条窄带。
  // 从 insets.top + 8 往下排，并给左右两角的「返回 / 齿轮」键让位：
  // 两键由集成层画（约 56px 宽），文字带左右各让开 cornerKeep + 8，绝不压键。
  const headerTop = usableTop + 8;
  const headerH = Math.round(Math.min(92, Math.max(54, usableH * 0.11)));
  const cornerSize = Math.max(30, Math.round(pad * 2.1));   // 与 ui/layout.js 同公式
  const cornerKeep = Math.max(56, pad + cornerSize);        // 角键实占宽度（56 为下限）
  const bandX = cornerKeep + 8;
  const bandW = Math.max(40, width - bandX * 2);
  // 文字带左右对称，中心恒等于屏幕中心（标题居中不偏）
  const header = { x: Math.round((width - bandW) / 2), y: headerTop, w: bandW, h: headerH };

  // 底部按钮：按钮下沿再往下必须留出 insets.bottom + 16
  const btnH = Math.max(38, Math.min(52, Math.round(usableH * 0.062)));
  const bottomGap = safe.bottom + 16;
  const btnY = Math.round(height - bottomGap - btnH);

  const btnGap = Math.round(pad * 0.6);
  const btnW = Math.floor((width - pad * 2 - btnGap * 2) / 3);
  const buttons = [];
  for (let i = 0; i < 3; i++) {
    buttons.push({ x: pad + i * (btnW + btnGap), y: btnY, w: btnW, h: btnH });
  }

  // 棋盘：9 列 × 10 行，按最小边缩放后居中
  const areaTop = headerTop + headerH;
  const areaH = Math.max(80, btnY - 12 - areaTop);
  const areaW = width - pad * 2;
  const cell = Math.max(8, Math.min(areaW / (COLS - 1 + MARGIN * 2), areaH / (ROWS - 1 + MARGIN * 2)));
  const boardW = (COLS - 1 + MARGIN * 2) * cell;
  const boardH = (ROWS - 1 + MARGIN * 2) * cell;
  const boardX = Math.round((width - boardW) / 2);
  const boardY = Math.round(areaTop + (areaH - boardH) / 2);

  const board = {
    x: boardX,
    y: boardY,
    w: boardW,
    h: boardH,
    cell,
    stoneR: cell * 0.44,
    toScreen(gx, gy) {
      return { x: boardX + (MARGIN + gx) * cell, y: boardY + (MARGIN + gy) * cell };
    },
    fromScreen(px, py) {
      return {
        x: Math.round((px - boardX) / cell - MARGIN),
        y: Math.round((py - boardY) / cell - MARGIN),
      };
    },
  };

  return {
    width,
    height,
    safe,
    pad,
    header,
    cornerKeep,          // 顶部左右两角让位宽度（导出给自检断言用）
    board,
    buttons,
    bottomGap,
  };
}

/** 命中底部按钮，返回索引（-1 未命中）。 */
export function hitButton(layout, x, y) {
  return layout.buttons.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
}

/** 屏幕坐标 → 棋盘坐标；同时给出是否落在该交叉点附近（避免误点）。 */
export function pickPoint(layout, x, y) {
  const g = layout.board.fromScreen(x, y);
  if (g.x < 0 || g.y < 0 || g.x >= COLS || g.y >= ROWS) return null;
  const p = layout.board.toScreen(g.x, g.y);
  const dist = Math.hypot(x - p.x, y - p.y);
  if (dist > layout.board.cell * 0.6) return null;
  return { x: g.x, y: g.y, dist };
}

/* ───────────────────────── 棋盘 ───────────────────────── */

/** 在交叉点画「兵炮位」角括号（棋盘边缘自动省掉外侧那半边）。 */
function drawPositionMark(ctx, b, gx, gy, size) {
  const p = b.toScreen(gx, gy);
  const gap = size * 0.30;
  const len = size * 0.42;
  for (const sx of [-1, 1]) {
    if (gx === 0 && sx < 0) continue;       // 左边界：不画外侧
    if (gx === COLS - 1 && sx > 0) continue; // 右边界：不画外侧
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(p.x + sx * gap, p.y + sy * (gap + len));
      ctx.lineTo(p.x + sx * gap, p.y + sy * gap);
      ctx.lineTo(p.x + sx * (gap + len), p.y + sy * gap);
      ctx.stroke();
    }
  }
}

/** 回纹（「回」字方框）：外框 + 内框，象棋盘四角的传统装饰。 */
function drawMeanderMotif(ctx, cx, cy, size, color, lw) {
  const s = Math.max(4, Math.round(size));
  const inner = Math.max(3, Math.round(s * 0.44));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  // +0.5 让 1px 细线落在像素中心，木纹底上不会发虚
  ctx.strokeRect(Math.round(cx - s / 2) + 0.5, Math.round(cy - s / 2) + 0.5, s, s);
  ctx.strokeRect(Math.round(cx - inner / 2) + 0.5, Math.round(cy - inner / 2) + 0.5, inner, inner);
  ctx.restore();
}

/**
 * 木牌本体：投影 → 木色 → 暖光 → 细木纹/年轮/木节 → 内阴影 → 双线边框 + 四角回纹。
 *
 * 为什么这么多层：单层竖向渐变在手机上就是一块"纯色板"，用户评价"太过简陋"。
 * 木头的质感来自**多层不同频率的叠加**（大面积的色阶 + 中频的纹路 + 高频的杂点），
 * 这里按 4 个频率层层加，全部裁在圆角木牌里，边界干净。
 */
function drawWood(ctx, layout, theme) {
  const b = layout.board;
  const r = Math.round(b.cell * 0.5);

  // ① 投影：两层（贴地一层紧而实，散开一层虚）——木牌才有"浮在青白底上"的重量
  ctx.save();
  ctx.shadowColor = theme.boardShadow;
  ctx.shadowBlur = Math.round(b.cell * 0.9);
  ctx.shadowOffsetY = Math.round(b.cell * 0.22);
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  // theme.boardDark 在 THEME 里并不存在（历史遗留），这里按「深木边 → 下沿木色」兜底
  ctx.fillStyle = theme.boardDark ?? theme.boardEdge ?? theme.boardBottom;
  ctx.fill();
  ctx.restore();

  // ② 木面主色：竖向渐变（上文说得通的"上浅下深"，因为光从上方来）
  const wood = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
  wood.addColorStop(0, theme.boardTop);
  wood.addColorStop(0.62, theme.boardTop);
  wood.addColorStop(1, theme.boardBottom);
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.fillStyle = wood;
  ctx.fill();

  // ③ 以下纹理全部裁在木牌内（不进 clip 的话纹理会溢出圆角，看着像脏边）
  ctx.save();
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.clip();

  // ③-1 左上暖光：给木面"油润"的受光面，避免整块看起来是平面色卡
  const sheen = ctx.createRadialGradient(
    b.x + b.w * 0.30, b.y + b.h * 0.20, Math.min(b.w, b.h) * 0.04,
    b.x + b.w * 0.30, b.y + b.h * 0.20, Math.max(b.w, b.h) * 0.90,
  );
  sheen.addColorStop(0, 'rgba(255,246,220,0.34)');
  sheen.addColorStop(0.5, 'rgba(255,240,205,0.12)');
  sheen.addColorStop(1, 'rgba(255,235,190,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(b.x, b.y, b.w, b.h);

  // ③-2 细木纹：等距横向曲线，粗细与深浅按确定性伪随机起伏（不是一水儿的平行直线）
  ctx.strokeStyle = '#6b3f12';
  ctx.lineCap = 'round';
  const step = Math.max(3, Math.round(b.cell * 0.20));
  let gi = 0;
  for (let y = b.y + 1; y < b.y + b.h - 1; y += step, gi++) {
    const wob = Math.sin((y - b.y) * 0.17 + gi * 0.9) * (b.cell * 0.05);
    ctx.globalAlpha = 0.020 + hash01(gi) * 0.030;
    ctx.lineWidth = 0.6 + hash01(gi + 31) * 0.9;
    ctx.beginPath();
    ctx.moveTo(b.x + 1, y + wob);
    ctx.quadraticCurveTo(b.x + b.w * 0.5, y - wob * 1.8, b.x + b.w - 1, y + wob * 0.4);
    ctx.stroke();
  }

  // ③-3 年轮暗带：间隔大、更宽更淡，给"这是一块原木"的暗示（只有木纹会像塑料）
  const rings = [0.17, 0.46, 0.78];
  rings.forEach((f, k) => {
    const y = b.y + b.h * f;
    ctx.globalAlpha = 0.05;
    ctx.lineWidth = Math.max(2, b.cell * 0.13);
    ctx.beginPath();
    ctx.moveTo(b.x + 1, y);
    ctx.quadraticCurveTo(b.x + b.w * 0.5, y - b.cell * 0.15 * (k - 1), b.x + b.w - 1, y);
    ctx.stroke();
  });

  // ③-4 木节：两处小同心椭圆。用 translate+scale 拼椭圆，不依赖 ctx.ellipse
  //      （老基础库没有 ellipse，真机上会整块棋盘画不出来）
  for (const [kx, ky] of [[0.16, 0.72], [0.82, 0.31]]) {
    ctx.save();
    ctx.translate(b.x + b.w * kx, b.y + b.h * ky);
    ctx.scale(1, 0.62);
    ctx.lineWidth = 1;
    for (const [rr, aa] of [[b.cell * 0.32, 0.05], [b.cell * 0.17, 0.07]]) {
      ctx.globalAlpha = aa;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ③-5 内阴影：四边压暗，木牌才有厚度（纯亮色木面会显得像贴纸）
  ctx.globalAlpha = 1;
  const vig = ctx.createRadialGradient(
    b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.30,
    b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h) * 0.72,
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(90,52,16,0.26)');
  ctx.fillStyle = vig;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.restore();   // ← 结束 ③ 的 clip

  // ④ 木牌双线边框：外粗（深木边）+ 内细（浅木边），倒角感来自这一深一浅
  const fw = Math.max(1.2, b.cell * 0.045);
  pathRoundRect(ctx, b.x + fw, b.y + fw, b.w - fw * 2, b.h - fw * 2, r * 0.8);
  ctx.strokeStyle = theme.boardEdge;
  ctx.lineWidth = fw;
  ctx.stroke();
  const fw2 = b.cell * 0.12;
  pathRoundRect(ctx, b.x + fw2, b.y + fw2, b.w - fw2 * 2, b.h - fw2 * 2, r * 0.7);
  ctx.strokeStyle = theme.boardEdgeSoft;
  ctx.lineWidth = Math.max(1, b.cell * 0.022);
  ctx.stroke();

  // ⑤ 四角回纹：落在木牌边与棋盘外框之间的装饰带正中，太小的屏幕上自动省略（画了也是一团糊）
  const motif = b.cell * 0.30;
  if (motif >= 6) {
    const off = (MARGIN * b.cell) / 2;
    const lw = Math.max(1, b.cell * 0.028);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        drawMeanderMotif(
          ctx,
          sx < 0 ? b.x + off : b.x + b.w - off,
          sy < 0 ? b.y + off : b.y + b.h - off,
          motif, theme.boardEdge, lw,
        );
      }
    }
  }
}

/** 棋盘 = 木牌 + 网格/九宫/兵炮位 + 外框双线 + 楚河汉界。 */
function drawBoard(ctx, layout, theme) {
  const b = layout.board;
  drawWood(ctx, layout, theme);

  /* ── 网格 ── */
  ctx.save();
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = Math.max(1, b.cell * 0.035);
  ctx.lineCap = 'round';

  const p0 = b.toScreen(0, 0);
  const pEnd = b.toScreen(COLS - 1, ROWS - 1);

  // 横线 10 条，贯通全宽
  for (let y = 0; y < ROWS; y++) {
    const a = b.toScreen(0, y), z = b.toScreen(COLS - 1, y);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(z.x, z.y); ctx.stroke();
  }
  // 竖线：左右两条到底，中间 7 条被楚河汉界断开
  for (let x = 0; x < COLS; x++) {
    if (x === 0 || x === COLS - 1) {
      ctx.beginPath(); ctx.moveTo(b.toScreen(x, 0).x, p0.y); ctx.lineTo(b.toScreen(x, 0).x, pEnd.y); ctx.stroke();
    } else {
      const up0 = b.toScreen(x, 0), up1 = b.toScreen(x, 4);
      const dn0 = b.toScreen(x, 5), dn1 = b.toScreen(x, ROWS - 1);
      ctx.beginPath(); ctx.moveTo(up0.x, up0.y); ctx.lineTo(up1.x, up1.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(dn0.x, dn0.y); ctx.lineTo(dn1.x, dn1.y); ctx.stroke();
    }
  }

  // 九宫斜线（上下各一个米字格）
  const palace = (top) => {
    const y0 = top ? 0 : 7, y1 = top ? 2 : 9;
    const a = b.toScreen(3, y0), z = b.toScreen(5, y1);
    const c = b.toScreen(5, y0), d = b.toScreen(3, y1);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(z.x, z.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
  };
  palace(true);
  palace(false);

  // 外框加重（象棋盘常见的双线边框：外粗内细，中间一条缝）
  ctx.strokeStyle = theme.gridLineStrong;
  ctx.lineWidth = Math.max(1.4, b.cell * 0.055);
  ctx.strokeRect(p0.x, p0.y, pEnd.x - p0.x, pEnd.y - p0.y);
  const inset = b.cell * 0.16;
  ctx.lineWidth = Math.max(1, b.cell * 0.028);
  ctx.strokeRect(p0.x - inset, p0.y - inset, pEnd.x - p0.x + inset * 2, pEnd.y - p0.y + inset * 2);

  // 兵炮位标记
  ctx.strokeStyle = theme.gridLineStrong;
  ctx.lineWidth = Math.max(1, b.cell * 0.035);
  const marks = [
    [1, 2], [7, 2], [1, 7], [7, 7],                                     // 炮位
    [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],                             // 卒位
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],                             // 兵位
  ];
  for (const [mx, my] of marks) drawPositionMark(ctx, b, mx, my, b.cell);
  ctx.restore();

  drawRiver(ctx, b, theme);
}

/**
 * 楚河汉界：两道水波纹 + 书法题字。
 *
 * 为什么不用 `fillText('楚  河')` 这种"空格顶字距"的老写法：
 *   ① 空格宽度随字体而定，换台机器字距就变，四平八稳的对称排版会塌；
 *   ② 汉字要的是"刻在木上"的层次——用**逐字双重描画**（先右下偏移浅色当刀口受光面，
 *      再原位上深色墨），两笔叠出刻痕，比一整行平涂有书法感。
 */
function drawRiver(ctx, b, theme) {
  const riverY = (b.toScreen(0, 4).y + b.toScreen(0, 5).y) / 2;
  const p0 = b.toScreen(0, 0);
  const pEnd = b.toScreen(COLS - 1, ROWS - 1);
  const fs = Math.round(b.cell * 0.68);

  ctx.save();

  // ① 水波纹：河界之间原本空荡荡，两道极淡的折线让"河"有水的暗示
  //    （手工折线拼波浪，不用 setLineDash —— 老基础库不保证有它）
  ctx.strokeStyle = theme.gridLineStrong;
  ctx.lineWidth = Math.max(1, b.cell * 0.022);
  ctx.globalAlpha = 0.10;
  for (const k of [-1, 1]) {
    const y0 = riverY + k * b.cell * 0.21;
    const xa = p0.x + b.cell * 0.25;
    const xb = pEnd.x - b.cell * 0.25;
    ctx.beginPath();
    ctx.moveTo(xa, y0);
    for (let i = 1; i <= 8; i++) {
      ctx.lineTo(xa + (xb - xa) * (i / 8), y0 + Math.sin(i * 1.35) * (b.cell * 0.045));
    }
    ctx.stroke();
  }

  // ② 题字：逐字排版，字距可控
  ctx.font = `${fs}px ${KAI}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.88;
  const glyph = (ch, cx) => {
    ctx.fillStyle = 'rgba(255,246,224,0.55)';              // 刀口受光面
    ctx.fillText(ch, cx + fs * 0.035, riverY + fs * 0.045);
    ctx.fillStyle = theme.gridLineStrong;                  // 墨
    ctx.fillText(ch, cx, riverY);
  };
  const word = (chars, cx) => {
    const gap = fs * 0.16;
    const total = chars.length * fs + (chars.length - 1) * gap;
    chars.forEach((ch, i) => glyph(ch, cx - total / 2 + fs / 2 + i * (fs + gap)));
  };
  word(['楚', '河'], b.toScreen(2, 4).x);
  word(['漢', '界'], b.toScreen(6, 4).x);

  ctx.restore();
}

/* ───────────────────────── 棋子 ───────────────────────── */

/**
 * 画一颗棋子（**圆心坐标**版，动画要在格子之间飞，所以不能只接格子号）。
 *
 * 立体感的来源是五层，缺一层就"扁"：
 *   ① 投影（两层：一层散、一层实）——抬得越高，影子越大越虚（任务要求的"阴影同步增大"）
 *   ② 厚度盘（略大一圈，露出来的边就是棋子侧面）
 *   ③ 面盘（径向渐变，左上受光）
 *   ④ 内阴影环（面盘内侧压暗，盘子"凹"得下去）
 *   ⑤ 弧形高光 + 双圈描边 + 汉字刻痕
 *
 * 红=朱砂、黑=墨玉：色相一律从主题令牌取（规范 §7：不写死一堆魔法色值），
 * 明暗靠**几何 + 黑白透明叠加**做出来，所以换主题色也不会脏。
 *
 * @param px/py  圆心屏幕坐标（抬起时由调用方把 y 减掉 lift）
 * @param opts   { scale 缩放, lift 抬起高度(px), squashY 纵向压扁, alpha 透明度 }
 */
function drawPieceAt(ctx, theme, side, type, px, py, rBase, opts = {}) {
  const red = side === RED;
  const scale = opts.scale ?? 1;
  const r = rBase * scale;
  const sq = opts.squashY ?? 1;
  const alpha = opts.alpha ?? 1;
  const lift = opts.lift ?? 0;
  const glyph = GLYPHS[side]?.[type] ?? '';        // 数据异常时画空白，绝不把 "undefined" 印在棋盘上
  const ink = red ? theme.danger : theme.stoneBlackMid;
  const inkSoft = red ? 'rgba(192,57,43,0.42)' : 'rgba(35,35,44,0.42)';

  ctx.save();
  ctx.globalAlpha = alpha;

  // ① 投影：画在**地面（棋盘平面）**上的扁椭圆，抬得越高越大越虚。
  //    为什么压扁成椭圆：正圆的影子在木板上像"另一颗球叠上去"，
  //    压扁成 0.44 的椭圆才像投在平面上的影子——这是"离地"最直观的线索。
  //    为什么加速扩散：只把影子整体下移的话，它几乎全被抬起的身子盖住（实测只露 1~2px），
  //    横向铺开才看得见（抬满时两侧各露出一圈半影）。
  ctx.save();
  ctx.translate(px, py + rBase * 0.11);
  ctx.scale(1, 0.44);
  ctx.fillStyle = theme.stoneShadow;
  ctx.globalAlpha = alpha * Math.max(0.16, 0.70 - lift / (rBase * 3.2));   // 外层半影：越大越淡
  ctx.beginPath();
  ctx.arc(0, 0, rBase * (1.06 + lift / (rBase * 1.2)), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = alpha * Math.max(0.22, 0.92 - lift / (rBase * 3.0));   // 内层实影：跟得紧一点
  ctx.beginPath();
  ctx.arc(0, 0, rBase * (0.80 + lift / (rBase * 2.2)), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = alpha;

  // ②~⑤ 整体做纵向压扁（落定回弹），用一次 translate+scale 包住
  ctx.translate(px, py);
  ctx.scale(1, sq);

  // ② 厚度盘
  const bevel = ctx.createLinearGradient(0, -r, 0, r);
  bevel.addColorStop(0, '#f0d8ac');
  bevel.addColorStop(0.5, '#cfa265');
  bevel.addColorStop(1, '#a87c3d');
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = bevel;
  ctx.fill();

  // ③ 面盘：径向渐变（左上受光）。红方木面偏暖、黑方偏冷灰，一眼分清敌我
  const fr = r * 0.90;
  const face = ctx.createRadialGradient(-fr * 0.38, -fr * 0.44, fr * 0.05, 0, 0, fr * 1.16);
  if (red) {
    face.addColorStop(0, '#fdf6e6');
    face.addColorStop(0.50, theme.boardTop);
    face.addColorStop(0.88, theme.boardBottom);
    face.addColorStop(1, '#c99a54');
  } else {
    face.addColorStop(0, '#f7f1e4');
    face.addColorStop(0.50, '#e4d0ad');
    face.addColorStop(0.88, '#c2a075');
    face.addColorStop(1, '#a8874f');
  }
  ctx.beginPath();
  ctx.arc(0, 0, fr, 0, Math.PI * 2);
  ctx.fillStyle = face;
  ctx.fill();

  // ④ 内阴影环：贴着面盘内沿压暗一圈，盘子才像"凹"的
  ctx.beginPath();
  ctx.arc(0, 0, fr * 0.90, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(120,78,26,0.20)';
  ctx.lineWidth = fr * 0.16;
  ctx.stroke();

  // ⑤ 朱砂 / 墨玉 双圈：外粗内细（象棋棋子最认这个形）
  ctx.beginPath();
  ctx.arc(0, 0, fr * 0.90, 0, Math.PI * 2);
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, fr * 0.085);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, fr * 0.755, 0, Math.PI * 2);
  ctx.strokeStyle = inkSoft;
  ctx.lineWidth = Math.max(0.8, fr * 0.035);
  ctx.stroke();

  // ⑥ 弧形高光：一段弧比一个圆点更像釉面反光（左上 45° 那道常规受光）
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, fr * 0.80, Math.PI * 1.06, Math.PI * 1.55);
  ctx.strokeStyle = 'rgba(255,255,255,0.50)';
  ctx.lineWidth = fr * 0.13;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, fr * 0.53, Math.PI * 1.12, Math.PI * 1.38);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = fr * 0.09;
  ctx.stroke();

  // ⑦ 最外轮廓细描边：木片边缘收口，压住木纹不至于"糊"
  ctx.beginPath();
  ctx.arc(0, 0, r - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(90,58,18,0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // ⑧ 汉字：衬线字体；先画一层右下偏移的浅色当"刀口"，再压墨，字就"刻"进木里了
  if (glyph) {
    const fs = Math.round(fr * 1.16);
    ctx.font = `700 ${fs}px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,250,238,0.55)';
    ctx.fillText(glyph, 0, fr * 0.055 + 1);
    ctx.fillStyle = ink;
    ctx.fillText(glyph, 0, fr * 0.03);
  }
  ctx.restore();
}

/**
 * 解析一颗棋子此刻的「抬起量」（0 = 贴着棋盘，1 = 完全抬起）。
 *
 * 两种来源，同一颗子只会命中一种：
 *   ① anim.pick    选中上浮（130ms 缓出，升到 1 之后**一直保持**，直到落子/取消）
 *   ② anim.settle  取消 / 换选后落回原位（170ms 内 1→0）
 * 进度全部由传入的 now 推出来，本函数不读时钟、不存状态（规范 §8）。
 */
function motionOf(anim, x, y, now) {
  const at = (a) => a && a.x === x && a.y === y;
  if (at(anim.pick)) return easeOutCubic(clamp01((now - anim.pick.t0) / ANIM.pickMs));
  if (at(anim.settle)) return 1 - easeOutCubic(clamp01((now - anim.settle.t0) / ANIM.settleMs));
  return 0;
}

/** 选中光环：外扩柔光 + 金色圈线 + 八段缓慢转动的短刻线。 */
function drawSelectionHalo(ctx, b, theme, cx, cy, k, now) {
  const r = b.stoneR * (1.26 + 0.06 * k);
  const pulse = 0.5 + 0.5 * Math.sin((now ?? 0) / 380);
  ctx.save();

  // 柔光：抬起越高越亮，视线自动落到这颗子上
  ctx.globalAlpha = clamp01(k) * (0.72 + pulse * 0.28);
  const glow = ctx.createRadialGradient(cx, cy, r * 0.68, cx, cy, r * 1.45);
  glow.addColorStop(0, theme.accentSoft ?? 'rgba(176,125,22,0.18)');
  glow.addColorStop(1, 'rgba(240,180,41,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.45, 0, Math.PI * 2);
  ctx.fill();

  // 圈线
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = Math.max(1.4, b.stoneR * 0.10);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // 八段短刻线（手绘代替 setLineDash：老基础库不保证有它），一并缓慢转动
  ctx.globalAlpha = clamp01(k) * 0.7;
  ctx.lineWidth = Math.max(1.2, b.stoneR * 0.085);
  ctx.lineCap = 'round';
  const spin = (now ?? 0) / 1400;
  for (let i = 0; i < 8; i++) {
    const a = spin + (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.17, a, a + Math.PI / 9);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 棋盘上所有棋子。
 * 顺序有讲究：**抬起的棋子最后画**，这样它压在其他子和提示标记之上，
 * 不会被目标点的准心环或者旁边的子挡掉一截（视觉上它是"提在手里的"）。
 */
function drawPieces(ctx, layout, state, theme, now) {
  const b = layout.board;
  const anim = state.anim ?? {};
  const drop = activeDrop(anim.drop, now);
  const lifted = [];

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const piece = state.board.grid[y][x];
      if (piece === EMPTY) continue;

      // 正在飞行的那颗由 drawDrop 负责；这里必须跳过，
      // 否则"终点格已经站着一颗"会穿帮（两颗粒子同时出现）
      if (drop && drop.tx === x && drop.ty === y) continue;

      const k = motionOf(anim, x, y, now);
      if (k > 0.01) {
        lifted.push({ piece, x, y, k });
        continue;
      }
      const p = b.toScreen(x, y);
      drawPieceAt(ctx, theme, sideOf(piece), typeOf(piece), p.x, p.y, b.stoneR);
    }
  }

  for (const it of lifted) {
    const p = b.toScreen(it.x, it.y);
    const lift = b.cell * LIFT_RATIO * it.k;
    const scale = 1 + (LIFT_SCALE - 1) * it.k;
    // 光环跟着棋子一起抬高（不是留在地上）：圈线要"套住"那颗子，
    // 玩家才一眼看出"被拿起来的是这一颗"。地上留的那道是投影，负责表达离地高度。
    if (it.k > 0.02) drawSelectionHalo(ctx, b, theme, p.x, p.y - lift, it.k, now);
    drawPieceAt(ctx, theme, sideOf(it.piece), typeOf(it.piece), p.x, p.y - lift, b.stoneR, { scale, lift });
  }
}

/* ───────────────────────── 落子动画 ───────────────────────── */

/** 落子动画是否还在进行中（含落定回弹）。超时的动画一律当没有——宁可少画一帧也不留残影。 */
function activeDrop(d, now) {
  if (!d || !d.piece) return null;
  const age = (now ?? 0) - d.t0;
  if (age < 0 || age > ANIM.dropTotalMs) return null;
  return d;
}

/**
 * 落子动画：**先横移到目标格上方，再垂直落下**，落定后轻微压扁回弹。
 *
 * 为什么拆成两段：用户要的是"选定棋子抬高，然后选定位置再落下"。
 * 如果只做一条直线插值，棋子是"贴地平移"过去的，抬起的意义就没了。
 * 所以前 62% 保持抬起高度横移（还额外加一点抛物弧，像被"提"着走），
 * 到目标格正上方才开始下坠；下坠用加速缓动（easeInQuad），才有被重力拽下去的感觉。
 */
function drawDrop(ctx, layout, state, theme, now) {
  const d = activeDrop(state.anim?.drop, now);
  if (!d) return;
  const b = layout.board;
  const age = (now ?? 0) - d.t0;
  const from = b.toScreen(d.fx, d.fy);
  const to = b.toScreen(d.tx, d.ty);
  const liftMax = b.cell * LIFT_RATIO;
  const lift0 = liftMax * clamp01(d.lift0 ?? 0);

  // 被吃掉的子：原地淡出并缩一点（不是"啪"地消失），先画，压在飞行的子下面
  if (d.cap) {
    const q = clamp01(age / ANIM.fadeMs);
    if (q < 1) {
      drawPieceAt(ctx, theme, sideOf(d.cap), typeOf(d.cap), to.x, to.y + q * b.cell * 0.10, b.stoneR, {
        alpha: 1 - q,
        scale: 1 - 0.18 * q,
      });
    }
  }

  const p = clamp01(age / ANIM.dropMs);
  const SPLIT = 0.62;
  let px, py, lift, squash = 1;

  if (p <= SPLIT) {
    const u = easeOutCubic(p / SPLIT);
    px = from.x + (to.x - from.x) * u;
    py = from.y + (to.y - from.y) * u;
    lift = lift0 + (liftMax - lift0) * u + liftMax * 0.28 * Math.sin(Math.PI * u);
  } else if (p < 1) {
    const q = easeInQuad((p - SPLIT) / (1 - SPLIT));
    px = to.x;
    py = to.y;
    lift = liftMax * (1 - q);
  } else {
    px = to.x;
    py = to.y;
    lift = 0;
    // 落定回弹：一个正弦包络，压扁再弹回（90ms 收尾）
    const q = clamp01((age - ANIM.dropMs) / ANIM.squashMs);
    squash = 1 - 0.16 * Math.sin(Math.PI * q);
  }

  // 下落过程中放大倍数跟着抬起量回落：飞得越高显得越大，贴地时回到本体尺寸
  const scale = LIFT_SCALE - (LIFT_SCALE - 1) * (lift / liftMax);
  drawPieceAt(ctx, theme, sideOf(d.piece), typeOf(d.piece), px, py - lift, b.stoneR, {
    scale, lift, squashY: squash,
  });
}

/* ───────────────────────── 提示 / 标记 ───────────────────────── */

/** 可走点：空位画圆点，可吃子画准心环。 */
function drawTargets(ctx, layout, state, theme, now) {
  if (!state.selected || !state.targets || state.targets.length === 0) return;
  const b = layout.board;
  const pulse = 0.5 + 0.5 * Math.sin((now ?? 0) / 420);

  for (const t of state.targets) {
    const p = b.toScreen(t.tx, t.ty);
    const occupied = state.board.grid[t.ty][t.tx] !== EMPTY;
    ctx.save();
    if (occupied) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, b.stoneR * (1.14 + pulse * 0.06), 0, Math.PI * 2);
      ctx.strokeStyle = theme.danger;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1.6, b.stoneR * 0.13);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2.5, b.cell * 0.14) * (1 + pulse * 0.12), 0, Math.PI * 2);
      ctx.fillStyle = theme.accent;
      ctx.globalAlpha = 0.9;
      ctx.fill();
    }
    ctx.restore();
  }
}

/** 最后一步：起止点各画四个角括号（落点更亮）。 */
function drawLastMove(ctx, layout, state, theme) {
  const last = state.lastMove;
  if (!last) return;
  const b = layout.board;
  const gap = b.stoneR * 1.02;
  const len = b.stoneR * 0.52;

  const bracket = (gx, gy, alpha) => {
    const p = b.toScreen(gx, gy);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = Math.max(1.4, b.cell * 0.055);
    ctx.lineCap = 'round';
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(p.x + sx * (gap + len), p.y + sy * gap);
        ctx.lineTo(p.x + sx * gap, p.y + sy * gap);
        ctx.lineTo(p.x + sx * gap, p.y + sy * (gap + len));
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  bracket(last.fx, last.fy, 0.40);
  bracket(last.tx, last.ty, 0.85);
}

/**
 * 将军提示（三处联动，不与顶部文字重复）：
 *   ① 被将的帅/将套一圈呼吸红环；② 棋盘外框泛红；③ 顶部状态文字由 index.js 标红。
 */
function drawCheck(ctx, layout, state, theme, now) {
  if (!state.check || !state.checkKing) return;
  const b = layout.board;
  const p = b.toScreen(state.checkKing.x, state.checkKing.y);
  const pulse = 0.5 + 0.5 * Math.sin((now ?? 0) / 260);

  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, b.stoneR * (1.22 + pulse * 0.16), 0, Math.PI * 2);
  ctx.strokeStyle = theme.danger;
  ctx.globalAlpha = 0.55 + pulse * 0.45;
  ctx.lineWidth = Math.max(2, b.stoneR * 0.18);
  ctx.stroke();
  ctx.restore();

  // 棋盘外框泛红：一眼看出"这步是将军"
  ctx.save();
  ctx.globalAlpha = 0.35 + pulse * 0.45;
  pathRoundRect(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, Math.round(b.cell * 0.55));
  ctx.strokeStyle = theme.danger;
  ctx.lineWidth = Math.max(2, b.cell * 0.09);
  ctx.stroke();
  ctx.restore();
}

/* ───────────────────────── 顶部信息 / 按钮 / 结算 ───────────────────────── */

function drawHeader(ctx, layout, state, theme) {
  const h = layout.header;
  const cx = h.x + h.w / 2;   // 让开两角的安全带，中心即屏幕中心

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 第四参 maxWidth：文字万一过长会被压缩在安全带内，绝不压到左上返回 / 右上齿轮
  ctx.font = `700 ${theme.fontTitle}px ${SANS}`;
  ctx.fillStyle = theme.textPrimary;
  ctx.fillText('中国象棋', cx, h.y + h.h * 0.30, h.w);

  ctx.font = `500 ${theme.fontHud}px ${SANS}`;
  ctx.fillStyle = state.thinking ? theme.accent : (state.check ? theme.danger : theme.textMuted);
  ctx.fillText(state.statusText ?? '', cx, h.y + h.h * 0.68, h.w);

  ctx.textAlign = 'left';
  ctx.restore();
}

function drawButtons(ctx, layout, state, theme) {
  const labels = state.buttonLabels ?? ['重新开始', '悔棋', '认输'];
  const disabled = state.buttonDisabled ?? [false, false, false];

  ctx.save();
  layout.buttons.forEach((btn, i) => {
    // 统一走集成层的木质按钮（规范 §10）：
    //   primary=主操作（重新开始）；pressed=按下反馈；disabled=不可用（灰化，文字由集成层给足对比度）
    // 早前这里自绘胶囊按钮，禁用态写死 rgba(242,243,247,0.28)（深色主题的浅字），
    // 在青白底上完全看不见（实机截图：底部「悔棋」只剩一个空壳）。
    drawWoodButton(ctx, btn, labels[i], {
      primary: i === 0,
      pressed: state.pressIndex === i,
      disabled: disabled[i] === true,
      fontSize: theme.fontBtn ?? 15,
    });
  });
  ctx.restore();
}

/* 结算浮层已删除：统一结算弹窗（再来一局 / 回到主界面）由集成层绘制（规范 §9、§10）。
 * 早前这里自绘一层深色遮罩 + 深色卡片，在青白主题下会盖住集成层的弹窗，属于重复绘制；
 * 本模块现在只负责「保持终局画面」并把 outcome 交给集成层。 */

/** 轻提示（非法着法 / 规则说明）。 */
function drawToast(ctx, layout, state, theme, now) {
  const t = state.toast;
  if (!t) return;
  const age = (now ?? 0) - t.t0;
  if (age > t.ms) return;
  const fade = age < 150 ? age / 150 : age > t.ms - 300 ? Math.max(0, (t.ms - age) / 300) : 1;

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.font = `600 ${theme.fontHud}px ${SANS}`;
  const tw = ctx.measureText(t.text).width;
  const padX = 16, hh = 34;
  const w = Math.min(layout.width - layout.pad * 2, tw + padX * 2);
  const x = (layout.width - w) / 2;
  const y = layout.buttons[0].y - hh - 10;

  pathRoundRect(ctx, x, y, w, hh, hh / 2);
  ctx.fillStyle = 'rgba(20,14,8,0.88)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(240,180,41,0.55)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.accent;
  ctx.fillText(t.text, layout.width / 2, y + hh / 2 + 0.5);
  ctx.restore();
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一次完整绘制。
 * @param ctx 2D 上下文（由调用方提供，本模块只读不改）
 * @param layout computeLayout 的结果
 * @param state 会话状态（见 index.js）
 * @param theme THEME
 * @param now 当前时间（ms，用于动画）
 */
export function renderFrame(ctx, layout, state, theme, now) {
  // ⚠️ 不铺底、不清屏：青白渐变背景与 clearRect 都由集成层负责（规范 §10）。
  // 早前这里有 clearRect + 渐变铺底，会把集成层刚铺好的青白底清掉（蜘蛛纸牌踩过同一个坑）。
  drawBoard(ctx, layout, theme);
  drawLastMove(ctx, layout, state, theme);
  drawTargets(ctx, layout, state, theme, now);
  drawPieces(ctx, layout, state, theme, now);
  // 落子动画排在棋子之后：飞行中的那颗要压在所有子与提示标记上面
  drawDrop(ctx, layout, state, theme, now);
  drawCheck(ctx, layout, state, theme, now);
  drawHeader(ctx, layout, state, theme);
  drawButtons(ctx, layout, state, theme);
  drawToast(ctx, layout, state, theme, now);
}
