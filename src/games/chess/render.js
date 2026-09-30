/**
 * 国际象棋绘制层：只接收 ctx + layout + state + theme，不持有状态、不碰平台 API。
 * 同一份代码同时供微信小游戏（ctx from wx.createCanvas）与浏览器预览使用。
 *
 * ── 棋子视觉：纯 Canvas 2D 路径画的 6 种立体造型剪影 ──
 * 早先版本是「圆底 + 中文字（兵/马/象…）」，这次按要求换成真正的棋子形象：
 *   ① 每种棋子由 2~4 个**部件路径**组成（兵 = 圆头 + 束腰 + 共用底盘；车 = 城垛顶 + 柱身 +
 *      底盘；马 = 马头侧影；象 = 尖顶 + 护翼；后 = 波浪冠齿 + 冠冕；王 = 十字冠 + 冠身），
 *      全部用 moveTo/lineTo/bezierCurveTo + 自实现的椭圆弧拼出来 —— **不用字体、不用 ♔♕♖
 *      这类 Unicode 棋子符号**（部分安卓机系统字体缺字会变豆腐块，这个坑早先踩过）；
 *   ② 一整子共用**同一副「整子高度」的线性渐变**，各部件自然明暗过渡；主体再叠一层左上角
 *      高光，加上落在格子上的底面投影 —— 棋子在格子上才有立体感；
 *   ③ 白子 = 暖白象牙 + 深棕描边，黑子 = 墨玉 + 银灰描边：**配色与描边双重区分**。
 *      木色棋盘上只靠深浅区分，白子会糊成一块（浅木色 #efcb92 与暖白很接近）。
 *
 * ── 落子动画（进度一律由传入的 now 推，绝不用 performance.now，见规范 §8）──
 *   点击己方棋子 →  抬高：上浮 + 底面阴影变大变淡（LIFT_MS，easeOutBack 带一点过冲）
 *   点目标格落子 →  落下：从抬起高度缓动落回（DROP_MS ≈ 260ms，easeOutCubic）+ 落定压扁回弹
 *   吃子          →  被吃子在**它原来那一格**淡出并缩小（CAPTURE_MS）；
 *                    吃过路兵的被吃兵在 (tx, fy)，不是终点格 —— 这里按 flag==='ep' 分开算
 *   易位          →  王与车同时落下（短易位车 h→f，长易位车 a→d）
 *
 * 统一 UI 约定（docs/游戏模块规范.md §10）：
 *   ① 不铺全屏底、不调 clearRect —— 集成层每帧负责「清屏 + 青白渐变铺底」；
 *   ② 不画自己的结算弹窗 —— 集成层统一绘制，本模块只在 index.js 里返回 outcome；
 *   ③ 底部按钮统一走集成层的 drawWoodButton（木质感，全站一致）；
 *   ④ 文字一律用 theme 令牌：浅底用深字。
 *
 * Canvas 变换卫生（规范 §11）：本文件每个 save() 都有配对的 restore()；
 * 高光用的 clip() 一律包在 save/restore 内，绝不把裁剪区留给下一颗棋子
 * （裁剪泄漏会让后面所有棋子只画出一角，且不报错）。
 */
import {
  PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE,
  typeOf, colorOf, findKing,
} from './core.js';
import { drawWoodButton } from '../../ui/renderer.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/** 字号兜底：集成层理论上会传完整 THEME，这里防一手残缺主题。 */
const FONT_FALLBACK = { fontTitle: 22, fontHud: 14, fontBtn: 15, fontBig: 34, fontSmall: 12 };
const fs = (theme, key) => theme[key] ?? FONT_FALLBACK[key] ?? 14;

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
  ctx.arcTo(x, y + rr, x + rr, y, rr);
  ctx.closePath();
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** easeOutCubic：落下用（末段减速，落得稳）。 */
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
/** easeOutBack：抬起用（末尾轻微过冲，像被"拎"起来）。 */
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/* ───────────────────────── 动画节奏（规范 §8：全部按传入的 now 算） ───────────────────────── */

/**
 * 抬升/落下/被吃三个时长。
 * 注意：theme.placeAnimMs = 140 是旧「弹出」节奏，太短，读起来像瞬移；
 * 本次要求「约 200~300ms 缓动 + 落定回弹」，所以落下单独用 260ms，
 * 不跟着主题里那个值走（主题里它还服务于别的模块的落子弹出）。
 */
const LIFT_MS = 130;      // 抬起
const DROP_MS = 260;      // 落下 + 回弹（要求 200~300ms）
const CAPTURE_MS = 220;   // 被吃子淡出
const LIFT_H = 0.17;      // 抬起高度 = 0.17 × 棋子标称尺寸
const PIECE_SPAN = 0.96;  // 棋子标称尺寸 / 格子边长

/* ───────────────────────── 路径基元 ───────────────────────── */

/**
 * 追加一段椭圆弧（用三次贝塞尔逼近）。
 * 小游戏基础库没有 ctx.ellipse（和没有 roundRect 是同一类问题），所以自己按 ≤90° 分段逼近，
 * 每段误差 < 0.03%，肉眼不可见。调用前路径的当前点必须已经在 a0 处。
 */
function ellipseArc(ctx, cx, cy, rx, ry, a0, a1) {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
  const da = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan(da / 4);
  let a = a0;
  for (let i = 0; i < n; i++) {
    const b = a + da;
    const ca = Math.cos(a), sa = Math.sin(a);
    const cb = Math.cos(b), sb = Math.sin(b);
    ctx.bezierCurveTo(
      cx + rx * (ca - k * sa), cy + ry * (sa + k * ca),
      cx + rx * (cb + k * sb), cy + ry * (sb - k * cb),
      cx + rx * cb, cy + ry * sb,
    );
    a = b;
  }
}

/** 独立椭圆路径（绝对坐标）。 */
function pathEllipse(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  ctx.moveTo(cx + rx, cy);
  ellipseArc(ctx, cx, cy, rx, ry, 0, Math.PI * 2);
  ctx.closePath();
}

/**
 * 归一化坐标 → 像素投影。
 *
 * 造型统一用 nx ∈ [-1,1]（水平）、ny ∈ [-1,1]（竖直，**ny = 1 落在棋子底面基线**）。
 * W = 0.36×size、HY = 0.47×size ⇒ 棋子约 0.72×size 宽、0.94×size 高，正好坐在一格中间。
 *
 * 为什么不直接 ctx.scale()：落定回弹要把棋子「压扁在底面上」，把 sx/sy 折进投影里算，
 * 压扁支点天然落在基线（底面），而且完全不动变换栈 —— 少一次 save/restore 就少一个漏配对的机会。
 */
function makeProj(size, sx = 1, sy = 1) {
  const HY = size * 0.47;
  const W = size * 0.36;
  const BASE = HY * 0.95;
  return {
    size, W, HY, BASE, sx, sy,
    x: (nx) => nx * W * sx,
    y: (ny) => BASE - (1 - ny) * HY * sy,
    rx: (r) => r * W * sx,
    ry: (r) => r * HY * sy,
  };
}

/** 归一化坐标下的一颗椭圆（棋子某个部件）。 */
function pieceEllipse(ctx, P, nx, ny, rrx, rry) {
  pathEllipse(ctx, P.x(nx), P.y(ny), P.rx(rrx), P.ry(rry));
}

/* ───────────────────────── 棋子配色 ───────────────────────── */

/**
 * 白 = 暖白象牙，黑 = 墨玉。
 *
 * 主题（src/ui/theme.js，共享文件，本次不改）里只有 stoneWhite / stoneBlack 这组中性色，
 * 没有「象牙 / 墨玉」专用令牌，所以按本仓库既有写法用 `theme.X ?? 兜底色`
 *（tetris/render.js 的 `theme.panel ?? '…'` 是同一个套路）：主题一旦补上
 * pieceWhite / pieceBlack 令牌就自动优先采用，方便以后全站统一；缺令牌时退回内置近似色。
 */
function pieceStyle(theme, white) {
  if (white) {
    return {
      hi: theme.pieceWhiteHi ?? theme.stoneWhiteHi ?? '#fffef8',
      mid: theme.pieceWhiteMid ?? '#f2e5c6',            // 暖白象牙
      lo: theme.pieceWhiteLo ?? '#bd9757',              // 底座压到暖棕，白子才有体积
      glow: theme.pieceWhiteGlow ?? 'rgba(255,255,255,0.90)',
      edge: theme.pieceWhiteEdge ?? theme.boardEdge ?? '#7b5a2b',  // 深棕描边 → 与浅木格拉开
      ink: theme.pieceWhiteInk ?? 'rgba(96,66,24,0.55)',
      eye: theme.pieceWhiteEye ?? 'rgba(66,42,12,0.88)',
      shadow: theme.stoneShadow ?? 'rgba(90,70,30,0.35)',
    };
  }
  return {
    hi: theme.pieceBlackHi ?? '#66766f',                // 墨玉：偏青黑
    mid: theme.pieceBlackMid ?? theme.stoneBlackMid ?? '#23232c',
    lo: theme.pieceBlackLo ?? theme.stoneBlackLo ?? '#0a0a0e',
    glow: theme.pieceBlackGlow ?? 'rgba(226,240,236,0.55)',
    edge: theme.pieceBlackEdge ?? theme.stoneWhiteLo ?? '#c3c3d0', // 银灰描边 → 与深木格拉开
    ink: theme.pieceBlackInk ?? 'rgba(233,244,240,0.34)',
    eye: theme.pieceBlackEye ?? 'rgba(226,240,236,0.80)',
    shadow: theme.stoneShadow ?? 'rgba(90,70,30,0.35)',
  };
}

/* ───────────────────────── 6 种棋子的造型 ───────────────────────── */
/* 每个部件函数自己 beginPath…closePath，返回值无所谓；主循环负责 fill + stroke。
 * parts 的先后 = 绘制层次（后面的压在前面上）：主体的细节件要放在主体之后画。
 * main 是「主体部件」，左上角高光只裁在它里面（不裁全子，省一次 clip）。 */

/** 共用底盘（喇叭形底座）：6 种棋子共用，一排摆开时节奏统一。 */
function partBase(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.34), P.y(0.30));
  ctx.bezierCurveTo(P.x(-0.54), P.y(0.46), P.x(-0.72), P.y(0.58), P.x(-0.70), P.y(0.74));
  ctx.bezierCurveTo(P.x(-0.68), P.y(0.92), P.x(-0.34), P.y(1.0), P.x(0), P.y(1.0));
  ctx.bezierCurveTo(P.x(0.34), P.y(1.0), P.x(0.68), P.y(0.92), P.x(0.70), P.y(0.74));
  ctx.bezierCurveTo(P.x(0.72), P.y(0.58), P.x(0.54), P.y(0.46), P.x(0.34), P.y(0.30));
  ctx.closePath();
}

/* ── 兵：圆头 + 束腰 + 底盘 ── */
function partPawnBody(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.34), P.y(-0.26));
  ctx.bezierCurveTo(P.x(-0.30), P.y(0.04), P.x(-0.64), P.y(0.10), P.x(-0.60), P.y(0.36));
  ctx.lineTo(P.x(0.60), P.y(0.36));
  ctx.bezierCurveTo(P.x(0.64), P.y(0.10), P.x(0.30), P.y(0.04), P.x(0.34), P.y(-0.26));
  ctx.closePath();
}
function partPawnHead(ctx, P) { pieceEllipse(ctx, P, 0, -0.58, 0.42, 0.40); }
function partPawnCollar(ctx, P) { pieceEllipse(ctx, P, 0, -0.30, 0.37, 0.11); }

/* ── 车：城垛顶（3 齿 2 凹口）+ 柱身 + 底盘 ── */
function partRookTop(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.66), P.y(-0.60));
  ctx.lineTo(P.x(-0.68), P.y(-0.98));
  ctx.lineTo(P.x(-0.42), P.y(-0.98));
  ctx.lineTo(P.x(-0.42), P.y(-0.80));
  ctx.lineTo(P.x(-0.14), P.y(-0.80));
  ctx.lineTo(P.x(-0.14), P.y(-0.98));
  ctx.lineTo(P.x(0.14), P.y(-0.98));
  ctx.lineTo(P.x(0.14), P.y(-0.80));
  ctx.lineTo(P.x(0.42), P.y(-0.80));
  ctx.lineTo(P.x(0.42), P.y(-0.98));
  ctx.lineTo(P.x(0.68), P.y(-0.98));
  ctx.lineTo(P.x(0.66), P.y(-0.60));
  ctx.closePath();
}
function partRookShaft(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.62), P.y(-0.66));
  ctx.lineTo(P.x(-0.46), P.y(0.30));
  ctx.lineTo(P.x(0.46), P.y(0.30));
  ctx.lineTo(P.x(0.62), P.y(-0.66));
  ctx.closePath();
}
function partRookCollarTop(ctx, P) { pieceEllipse(ctx, P, 0, -0.60, 0.67, 0.10); }
function partRookCollarLow(ctx, P) { pieceEllipse(ctx, P, 0, 0.30, 0.46, 0.09); }

/* ── 马：马头侧影（朝左；后颈 + 双耳 + 鼻梁 + 下颚） ── */
function partKnight(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(0.58), P.y(0.34));                                                       // 颈根（接底盘）
  ctx.bezierCurveTo(P.x(0.72), P.y(-0.02), P.x(0.56), P.y(-0.42), P.x(0.30), P.y(-0.54)); // 后颈 → 头后
  ctx.lineTo(P.x(0.28), P.y(-0.86));                                                      // 后耳尖
  ctx.lineTo(P.x(0.06), P.y(-0.64));                                                      // 两耳之间的凹口
  ctx.lineTo(P.x(-0.06), P.y(-0.88));                                                     // 前耳尖
  ctx.lineTo(P.x(-0.20), P.y(-0.60));                                                     // 耳根 → 额头
  ctx.bezierCurveTo(P.x(-0.46), P.y(-0.56), P.x(-0.68), P.y(-0.36), P.x(-0.76), P.y(-0.14)); // 鼻梁
  ctx.bezierCurveTo(P.x(-0.82), P.y(-0.02), P.x(-0.74), P.y(0.07), P.x(-0.60), P.y(0.07));   // 鼻头
  ctx.bezierCurveTo(P.x(-0.48), P.y(0.07), P.x(-0.42), P.y(-0.02), P.x(-0.36), P.y(0.08));   // 嘴 → 下颚
  ctx.bezierCurveTo(P.x(-0.24), P.y(0.24), P.x(0.06), P.y(0.20), P.x(0.16), P.y(0.34));      // 下颚 → 颈根
  ctx.closePath();
}
function detailKnightEye(ctx, P, st) {
  pieceEllipse(ctx, P, 0.0, -0.44, 0.082, 0.068);
  ctx.fillStyle = st.eye;
  ctx.fill();
}
function detailKnightMane(ctx, P) {
  // 鬃毛：沿后颈的一条弧 + 两股短弧（贴在后颈外侧）
  ctx.beginPath();
  ctx.moveTo(P.x(0.54), P.y(0.16));
  ctx.bezierCurveTo(P.x(0.48), P.y(-0.10), P.x(0.42), P.y(-0.30), P.x(0.30), P.y(-0.46));
  ctx.stroke();
  for (let i = 0; i < 2; i++) {
    const ny = -0.28 + i * 0.26;
    ctx.beginPath();
    ctx.moveTo(P.x(0.30 + i * 0.09), P.y(ny));
    ctx.quadraticCurveTo(P.x(0.42 + i * 0.09), P.y(ny - 0.06), P.x(0.46 + i * 0.09), P.y(ny - 0.18));
    ctx.stroke();
  }
}

/* ── 象：尖顶 + 护翼 + 顶球 + 底盘 ── */
function partBishopMitre(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.02), P.y(-0.74));
  ctx.bezierCurveTo(P.x(0.36), P.y(-0.62), P.x(0.58), P.y(-0.30), P.x(0.54), P.y(-0.14));
  ctx.lineTo(P.x(-0.58), P.y(-0.14));
  ctx.bezierCurveTo(P.x(-0.62), P.y(-0.30), P.x(-0.40), P.y(-0.62), P.x(-0.02), P.y(-0.74));
  ctx.closePath();
}
function partBishopKnob(ctx, P) { pieceEllipse(ctx, P, -0.02, -0.84, 0.13, 0.15); }
function partBishopCollar(ctx, P) { pieceEllipse(ctx, P, 0, -0.06, 0.47, 0.12); }
function partBishopBody(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.46), P.y(-0.06));
  ctx.bezierCurveTo(P.x(-0.36), P.y(0.10), P.x(-0.32), P.y(0.20), P.x(-0.36), P.y(0.34));
  ctx.lineTo(P.x(0.36), P.y(0.34));
  ctx.bezierCurveTo(P.x(0.32), P.y(0.20), P.x(0.36), P.y(0.10), P.x(0.46), P.y(-0.06));
  ctx.closePath();
}
function detailBishopSlit(ctx, P) {
  // 主教帽上的斜缝（护翼的标志性细节）
  ctx.beginPath();
  ctx.moveTo(P.x(0.18), P.y(-0.60));
  ctx.lineTo(P.x(-0.10), P.y(-0.30));
  ctx.stroke();
}

/* ── 后：波浪冠齿（5 尖 4 谷）+ 冠珠 + 冠带 + 束腰 + 底盘 ── */
function partQueenCrown(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.76), P.y(-0.42));
  ctx.lineTo(P.x(-0.84), P.y(-0.88));
  ctx.quadraticCurveTo(P.x(-0.62), P.y(-0.56), P.x(-0.42), P.y(-0.94));
  ctx.quadraticCurveTo(P.x(-0.24), P.y(-0.58), P.x(0), P.y(-1.0));
  ctx.quadraticCurveTo(P.x(0.24), P.y(-0.58), P.x(0.42), P.y(-0.94));
  ctx.quadraticCurveTo(P.x(0.62), P.y(-0.56), P.x(0.84), P.y(-0.88));
  ctx.lineTo(P.x(0.76), P.y(-0.42));
  ctx.closePath();
}
function partQueenBeads(ctx, P) {
  const tips = [[-0.84, -0.90, 0.11], [-0.42, -0.96, 0.12], [0, -1.02, 0.13], [0.42, -0.96, 0.12], [0.84, -0.90, 0.11]];
  for (const [nx, ny, r] of tips) pieceEllipse(ctx, P, nx, ny, r, r * 1.05);
}
function partQueenBand(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.68), P.y(-0.46));
  ctx.lineTo(P.x(0.68), P.y(-0.46));
  ctx.bezierCurveTo(P.x(0.74), P.y(-0.38), P.x(0.76), P.y(-0.32), P.x(0.74), P.y(-0.26));
  ctx.lineTo(P.x(-0.74), P.y(-0.26));
  ctx.bezierCurveTo(P.x(-0.76), P.y(-0.32), P.x(-0.74), P.y(-0.38), P.x(-0.68), P.y(-0.46));
  ctx.closePath();
}
function partQueenBody(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.60), P.y(-0.24));
  ctx.bezierCurveTo(P.x(-0.44), P.y(0.06), P.x(-0.40), P.y(0.16), P.x(-0.46), P.y(0.34));
  ctx.lineTo(P.x(0.46), P.y(0.34));
  ctx.bezierCurveTo(P.x(0.40), P.y(0.16), P.x(0.44), P.y(0.06), P.x(0.60), P.y(-0.24));
  ctx.closePath();
}
function detailQueenBandLine(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.68), P.y(-0.36));
  ctx.lineTo(P.x(0.68), P.y(-0.36));
  ctx.stroke();
}

/* ── 王：十字冠 + 冠身 + 束腰 + 底盘 ── */
function partKingCross(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.10), P.y(-1.04));
  ctx.lineTo(P.x(0.10), P.y(-1.04));
  ctx.lineTo(P.x(0.10), P.y(-0.90));
  ctx.lineTo(P.x(0.30), P.y(-0.90));
  ctx.lineTo(P.x(0.30), P.y(-0.70));
  ctx.lineTo(P.x(0.10), P.y(-0.70));
  ctx.lineTo(P.x(0.10), P.y(-0.56));
  ctx.lineTo(P.x(-0.10), P.y(-0.56));
  ctx.lineTo(P.x(-0.10), P.y(-0.70));
  ctx.lineTo(P.x(-0.30), P.y(-0.70));
  ctx.lineTo(P.x(-0.30), P.y(-0.90));
  ctx.lineTo(P.x(-0.10), P.y(-0.90));
  ctx.closePath();
}
function partKingCrown(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.70), P.y(-0.26));
  ctx.lineTo(P.x(-0.70), P.y(-0.48));
  ctx.quadraticCurveTo(P.x(0), P.y(-0.68), P.x(0.70), P.y(-0.48));
  ctx.lineTo(P.x(0.70), P.y(-0.26));
  ctx.closePath();
}
function partKingBody(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.58), P.y(-0.24));
  ctx.bezierCurveTo(P.x(-0.42), P.y(0.06), P.x(-0.38), P.y(0.16), P.x(-0.44), P.y(0.34));
  ctx.lineTo(P.x(0.44), P.y(0.34));
  ctx.bezierCurveTo(P.x(0.38), P.y(0.16), P.x(0.42), P.y(0.06), P.x(0.58), P.y(-0.24));
  ctx.closePath();
}
function detailKingBandLine(ctx, P) {
  ctx.beginPath();
  ctx.moveTo(P.x(-0.62), P.y(-0.30));
  ctx.lineTo(P.x(0.62), P.y(-0.30));
  ctx.stroke();
}

/**
 * 造型表：parts = 按层次顺序的部件（依次 fill + stroke），main = 主体（高光裁剪区），
 * details = 只描边的小细节（如马眼、象缝）。
 */
const SHAPES = {
  [PAWN]: {
    main: partPawnBody,
    parts: [partPawnBody, partPawnCollar, partPawnHead, partBase],
  },
  [ROOK]: {
    main: partRookShaft,
    parts: [partRookShaft, partRookTop, partRookCollarTop, partRookCollarLow, partBase],
    details: [
      // 檐口线：让城垛顶与柱身之间有一道分界
      (ctx, P) => { ctx.beginPath(); ctx.moveTo(P.x(-0.64), P.y(-0.66)); ctx.lineTo(P.x(0.64), P.y(-0.66)); ctx.stroke(); },
    ],
  },
  [KNIGHT]: {
    main: partKnight,
    parts: [partKnight, partBase],
    details: [detailKnightMane, detailKnightEye],
  },
  [BISHOP]: {
    main: partBishopBody,
    parts: [partBishopBody, partBishopCollar, partBishopMitre, partBishopKnob, partBase],
    details: [detailBishopSlit],
  },
  [QUEEN]: {
    main: partQueenBody,
    parts: [partQueenBody, partQueenBand, partQueenCrown, partQueenBeads, partBase],
    details: [detailQueenBandLine],
  },
  [KING]: {
    main: partKingBody,
    parts: [partKingBody, partKingCrown, partKingCross, partBase],
    details: [detailKingBandLine],
  },
};

/* ───────────────────────── 渐变缓存 ───────────────────────── */

/**
 * 渐变缓存：ctx → Map<key, CanvasGradient>。
 * 棋盘每帧要画 32 颗棋子，每颗一份线性渐变 + 一份高光径向渐变 = 64 次 create*Gradient；
 * 集成层的渲染循环是常驻的（空闲也逐帧渲染），不缓存就是每秒几千次原生对象分配。
 * 渐变定义在**棋子的局部坐标**里，只要尺寸与压扁比例一致就能复用（键里量化了这两项）。
 */
const GRAD_CACHE = new WeakMap();
function cachedGradient(ctx, key, make) {
  let map = GRAD_CACHE.get(ctx);
  if (!map) { map = new Map(); GRAD_CACHE.set(ctx, map); }
  let g = map.get(key);
  if (!g) {
    if (map.size > 48) map.clear();   // 尺寸/压扁比例种类翻花样时防无界增长
    g = make();
    map.set(key, g);
  }
  return g;
}

/* ───────────────────────── 画一颗棋子 ───────────────────────── */

/**
 * 画一颗棋子（导出以便复用与自检）。
 *
 * @param type  PAWN / KNIGHT / BISHOP / ROOK / QUEEN / KING
 * @param color WHITE / BLACK
 * @param cx,cy 格子中心（逻辑像素）
 * @param size  棋子标称尺寸（一般取格宽 × 0.96）
 * @param opts  { theme, lift, squash, scale, alpha, shadow }
 *   lift   0~1 抬升量：整体上浮 + 底面阴影变大变淡（抬起、落下、被吃都用它）
 *   squash 0~1 落定压扁：以底面为支点压扁，用于落定回弹
 *   scale  整体缩放（吃子缩小用）
 *   alpha  整体透明度（吃子淡出用）
 *   shadow false 时不画底面投影
 */
export function drawPiece(ctx, type, color, cx, cy, size, opts = {}) {
  const theme = opts.theme ?? {};
  const white = color === WHITE;
  const style = pieceStyle(theme, white);
  const shape = SHAPES[type] ?? SHAPES[PAWN];
  const lift = Math.max(0, opts.lift ?? 0);
  const squash = clamp01(opts.squash ?? 0);
  const scale = Math.max(0.02, opts.scale ?? 1);
  const alpha = clamp01(opts.alpha ?? 1);
  if (alpha <= 0.02 || size <= 2) return;

  const sx = scale * (1 + squash * 0.5);   // 压扁时横向略鼓
  const sy = scale * (1 - squash);
  const P = makeProj(size, sx, sy);
  const dy = -lift * size * LIFT_H;        // 抬升位移（向下为正）

  // ① 底面投影：**不跟着棋子抬升**，始终落在格子上；抬得越高越大越淡
  if (opts.shadow !== false) {
    const k = 1 + lift * 0.65;
    ctx.save();
    ctx.globalAlpha = alpha * Math.max(0, 0.30 - lift * 0.12);
    ctx.fillStyle = style.shadow;
    pathEllipse(
      ctx,
      cx, cy + size * 0.47 * 0.95,                 // 接触点在基线上（与抬升无关）
      size * 0.36 * scale * 0.78 * k,
      Math.max(1, size * 0.47 * scale * 0.19 * k),
    );
    ctx.fill();
    ctx.restore();
  }

  // ② 主体：所有部件共用「整子高度」的一副渐变，部件之间自然过渡
  ctx.save();
  ctx.translate(cx, cy + dy);
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const key = `${white ? 'w' : 'b'}|${Math.round(size)}|${sx.toFixed(2)}|${sy.toFixed(2)}`;
  const grad = cachedGradient(ctx, `lin|${key}`, () => {
    const g = ctx.createLinearGradient(0, P.y(-1.06), 0, P.y(1));
    g.addColorStop(0, style.hi);
    g.addColorStop(0.38, style.mid);
    g.addColorStop(1, style.lo);
    return g;
  });

  const edgeW = Math.max(1, size * (white ? 0.030 : 0.026));
  for (const part of shape.parts) {
    part(ctx, P);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = edgeW;
    ctx.stroke();
  }

  // ③ 左上角高光：只裁在主体部件里（clip 用完立刻 restore，绝不外泄到下一颗棋子）
  ctx.save();
  shape.main(ctx, P);
  ctx.clip();
  const glow = cachedGradient(ctx, `rad|${key}`, () => {
    const g = ctx.createRadialGradient(
      P.x(-0.34), P.y(-0.46), Math.max(1, P.rx(0.05)),
      P.x(-0.10), P.y(-0.20), Math.max(2, P.rx(1.5)),
    );
    g.addColorStop(0, style.glow);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  });
  ctx.globalAlpha = alpha * (white ? 0.55 : 0.34);
  ctx.fillStyle = glow;
  // 只铺主体自身的外接矩形（局部坐标，不是全屏）
  ctx.fillRect(P.x(-1.05), P.y(-1.06), P.rx(2.1), P.y(1) - P.y(-1.06));
  ctx.restore();

  // ④ 细节：描边线 + 小暗点（马眼 / 象缝 / 檐口线…）
  if (shape.details) {
    ctx.strokeStyle = style.ink;
    ctx.lineWidth = Math.max(0.8, size * 0.017);
    for (const fn of shape.details) fn(ctx, P, style);
  }
  ctx.restore();
}

/* ───────────────────────── 棋子落子 / 抬起 / 被吃动画 ───────────────────────── */

/**
 * 解析「最近一手」的动画信息。
 * 数据源：index.js 落账的 state.animMove（优先），兜底 state.lastMove（例如悔棋之后）。
 * 被吃子的位置要分开算：吃过路兵时被吃的兵在 (tx, fy)，不在终点格。
 */
function pieceAnimInfo(state) {
  const m = state.animMove ?? state.lastMove;
  if (!m || typeof m.tx !== 'number') return null;
  const ep = m.flag === 'ep';
  return {
    fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty,
    flag: m.flag ?? '',
    capture: m.capture ?? 0,
    capX: m.tx,
    capY: ep ? m.fy : m.ty,
  };
}

/**
 * 落子动画相位：从 state.animT0 起算，DROP_MS 内算「还在落」。
 * 进度用传入的 now（绝对毫秒）算 —— 规范 §8 明确禁用 performance.now()。
 */
function dropPhase(state, info, now) {
  const t0 = state.animT0 ?? 0;
  if (!info || !t0) return null;
  const prog = clamp01((now - t0) / DROP_MS);
  return { ...info, prog, active: prog < 1 };
}

/** 逐格画子 + 抬起 / 落下 / 被吃动画。 */
export function drawPieces(ctx, layout, state, theme, now) {
  const b = layout.board;
  const board = state.board;
  const size = b.cell * PIECE_SPAN;
  const t = now ?? 0;
  const info = pieceAnimInfo(state);
  const anim = dropPhase(state, info, t);

  // 动画中的落子格（与易位的车格）先跳过，最后单独画在最上层，免得被相邻棋子压住
  const skip = new Set();
  if (anim && anim.active) {
    skip.add(`${anim.tx},${anim.ty}`);
    if (anim.flag === 'castleK') skip.add(`${anim.tx - 1},${anim.ty}`);      // 车 h→f
    else if (anim.flag === 'castleQ') skip.add(`${anim.tx + 1},${anim.ty}`); // 车 a→d
  }

  // 选中的子：抬高（上浮 + 阴影加大），一直抬着直到改选 / 落子
  const sel = state.selected;
  const liftT0 = state.liftT0 ?? 0;
  const liftProg = liftT0 ? easeOutBack(clamp01((t - liftT0) / LIFT_MS)) : 0;

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const code = board.grid[y][x];
      if (!code) continue;
      if (skip.has(`${x},${y}`)) continue;
      const p = b.toScreen(x, y);
      const lift = sel && sel.x === x && sel.y === y ? liftProg : 0;
      drawPiece(ctx, typeOf(code), colorOf(code), p.x, p.y, size, { theme, lift });
    }
  }

  // 被吃子：在它原来那一格淡出 + 缩小（略微上浮，像被"挑"走）
  if (anim && anim.active && anim.capture) {
    const ct = clamp01((t - state.animT0) / CAPTURE_MS);
    if (ct < 1) {
      const cp = b.toScreen(anim.capX, anim.capY);
      drawPiece(ctx, typeOf(anim.capture), colorOf(anim.capture), cp.x, cp.y, size, {
        theme,
        alpha: 1 - ct,
        scale: 1 - 0.5 * ct,
        lift: 0.35 * (1 - ct),
      });
    }
  }

  // 落下：从抬起高度缓动落回 + 落定压扁回弹（易位的车同步落）
  if (anim && anim.active) {
    const fall = easeOutCubic(anim.prog);
    const k = anim.prog > 0.72 ? (anim.prog - 0.72) / 0.28 : 0;
    const squash = k > 0 ? Math.sin(k * Math.PI) * 0.16 * (1 - k) : 0;
    const lift = 1 - fall;

    const code = board.grid[anim.ty][anim.tx];
    if (code) {
      const p = b.toScreen(anim.tx, anim.ty);
      drawPiece(ctx, typeOf(code), colorOf(code), p.x, p.y, size, { theme, lift, squash });
    }
    if (anim.flag === 'castleK' || anim.flag === 'castleQ') {
      const rx = anim.flag === 'castleK' ? anim.tx - 1 : anim.tx + 1;
      const rc = board.grid[anim.ty][rx];
      if (rc) {
        const rp = b.toScreen(rx, anim.ty);
        drawPiece(ctx, typeOf(rc), colorOf(rc), rp.x, rp.y, size, { theme, lift, squash });
      }
    }

    // 落定涟漪：只在落点格上画一圈细椭圆（局部效果，不是全屏铺底）
    if (anim.prog > 0.6) {
      const rt = clamp01((anim.prog - 0.6) / 0.4);
      const p = b.toScreen(anim.tx, anim.ty);
      ctx.save();
      ctx.globalAlpha = (1 - rt) * 0.40;
      ctx.strokeStyle = theme.accent ?? '#b07d16';
      ctx.lineWidth = Math.max(1, b.cell * 0.035);
      pathEllipse(ctx, p.x, p.y + b.cell * 0.40, b.cell * (0.20 + rt * 0.34), b.cell * (0.06 + rt * 0.10));
      ctx.stroke();
      ctx.restore();
    }
  }
}

/* ───────────────────────── 背景（整块交给集成层） ───────────────────────── */

/**
 * 背景：**本模块不再画任何背景**，函数已移除。
 *
 * ⚠️ 对局背景（青白渐变 theme.bgTop→bgBottom）由集成层每帧统一铺（规范 §10
 * 「全屏青白渐变背景由集成层提供，游戏不要自己铺满屏」）。早先这里有两笔整屏绘制：
 *   ① 一层自带渐变底（整屏铺底，把集成层的青白底整个盖住）；
 *   ② 一圈「棋盘后方柔光」（半径为棋盘的 0.9 倍，同样铺满整屏）。
 * 现在两笔都去掉了：棋盘自身的木框投影（见 drawBoard 的 shadowBlur）已经能把视线收到中央，
 * 既不铺底也不会在大屏（平板）上出现「盖住 90%+ 屏幕」的填充。
 */

/** 木框 + 64 个深浅交替格 + 边框坐标。 */
export function drawBoard(ctx, layout, state, theme) {
  const b = layout.board;
  const r = Math.round(b.size * 0.035);

  // 木框投影
  ctx.save();
  ctx.shadowColor = theme.boardShadow;
  ctx.shadowBlur = Math.round(b.size * 0.04);
  ctx.shadowOffsetY = Math.round(b.size * 0.012);
  pathRoundRect(ctx, b.x, b.y, b.size, b.size, r);
  ctx.fillStyle = theme.boardEdge;
  ctx.fill();
  ctx.restore();

  // 木框（比格子深一档，形成外框感）
  const wood = ctx.createLinearGradient(0, b.y, 0, b.y + b.size);
  wood.addColorStop(0, theme.boardEdge);
  wood.addColorStop(1, theme.starPoint);
  pathRoundRect(ctx, b.x, b.y, b.size, b.size, r);
  ctx.fillStyle = wood;
  ctx.fill();

  // 64 格：深浅交替
  const pad = b.framePad ?? Math.max(9, Math.round(b.size * 0.036));
  const inner = b.size - pad * 2;
  const cell = inner / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? theme.boardTop : theme.boardBottom;
      ctx.fillRect(b.x + pad + x * cell, b.y + pad + y * cell, Math.ceil(cell) + 0.5, Math.ceil(cell) + 0.5);
    }
  }

  // 内亮边（木框倒角）
  pathRoundRect(ctx, b.x + pad - 1.5, b.y + pad - 1.5, inner + 3, inner + 3, Math.max(2, r * 0.4));
  ctx.strokeStyle = theme.boardEdgeSoft;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 边框
  pathRoundRect(ctx, b.x + 0.5, b.y + 0.5, b.size - 1, b.size - 1, r);
  ctx.strokeStyle = theme.gridLineStrong;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // 坐标：字母在木框下边、数字在木框左边（画在留白里，不压棋子）
  ctx.save();
  ctx.font = `600 ${Math.max(8, Math.round(cell * 0.22))}px ${FONT}`;
  ctx.fillStyle = theme.boardEdgeSoft;
  ctx.textBaseline = 'middle';
  for (let x = 0; x < 8; x++) {
    ctx.textAlign = 'center';
    ctx.fillText('abcdefgh'[x], b.x + pad + x * cell + cell / 2, b.y + pad + 8 * cell + pad * 0.55);
  }
  ctx.textAlign = 'center';
  for (let y = 0; y < 8; y++) {
    ctx.fillText(String(8 - y), b.x + pad * 0.5, b.y + pad + y * cell + cell / 2);
  }
  ctx.restore();
}

/* ───────────────────────── 标记层：上一步 / 选中 / 可走点 / 将军 ───────────────────────── */

export function drawMarks(ctx, layout, state, theme, now) {
  const b = layout.board;
  const cell = b.cell;
  const pulse = 0.5 + 0.5 * Math.sin((now ?? 0) / 380);

  // 上一步：起点 + 终点淡金块
  const last = state.lastMove;
  if (last) {
    for (const [fx, fy] of [[last.fx, last.fy], [last.tx, last.ty]]) {
      const p = b.squareRect(fx, fy);
      ctx.fillStyle = theme.accentSoft;
      ctx.fillRect(p.x, p.y, p.w, p.h);
    }
  }

  // 被将军的王：整格红色告警 + 呼吸描边（比柔光更醒目：一眼看出哪一格的王危险）
  if (state.status?.check) {
    const k = findKing(state.board, state.board.turn);
    if (k) {
      const p = b.squareRect(k.x, k.y);
      ctx.save();
      ctx.fillStyle = theme.danger;
      ctx.globalAlpha = 0.26 + pulse * 0.18;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.globalAlpha = 0.70 + pulse * 0.30;
      ctx.strokeStyle = theme.danger;
      ctx.lineWidth = Math.max(2, cell * 0.065);
      ctx.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2);
      ctx.restore();
    }
  }

  // 选中格：金色描边 + 淡底
  const sel = state.selected;
  if (sel) {
    const p = b.squareRect(sel.x, sel.y);
    ctx.save();
    ctx.fillStyle = theme.accentSoft;
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = Math.max(2, cell * 0.06);
    ctx.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2);
    ctx.restore();
  }

  // 可走点：空位画实心圆，吃子画空心环
  if (state.targets?.length) {
    for (const t of state.targets) {
      const p = b.squareRect(t.x, t.y);
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      ctx.save();
      if (t.capture) {
        ctx.strokeStyle = theme.danger;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = Math.max(2.2, cell * 0.075);
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.42, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.34 + pulse * 0.18;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // 鼠标悬停格（浏览器预览用）
  const hv = state.hover;
  if (hv && !state.outcome) {
    const p = b.squareRect(hv.x, hv.y);
    ctx.save();
    ctx.strokeStyle = theme.textMuted;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(p.x + 1.5, p.y + 1.5, p.w - 3, p.h - 3);
    ctx.restore();
  }
}

/* ───────────────────────── HUD / 按钮 / 结算 ───────────────────────── */

export function drawHud(ctx, layout, state, theme, now) {
  const hud = layout.hud;
  const cx = layout.width / 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.textPrimary;
  ctx.font = `700 ${fs(theme, 'fontTitle')}px ${FONT}`;
  ctx.fillText('国际象棋', cx, hud.y + hud.h * 0.32);

  // 状态行
  ctx.font = `500 ${fs(theme, 'fontHud')}px ${FONT}`;
  ctx.fillStyle = state.status?.check && !state.outcome ? theme.danger : theme.textMuted;
  ctx.fillText(state.statusText ?? '', cx, hud.y + hud.h * 0.78);

  // AI 思考的跳点
  if (state.aiThinking) {
    const baseX = cx + ctx.measureText(state.statusText ?? '').width / 2 + 14;
    for (let i = 0; i < 3; i++) {
      const phase = ((now ?? 0) / 260 + i * 0.6) % (Math.PI * 2);
      const dy = Math.sin(phase) * 3;
      ctx.beginPath();
      ctx.arc(baseX + i * 8, hud.y + hud.h * 0.78 + dy, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = theme.accent;
      ctx.fill();
    }
  }

  // 右上角：手数（避开集成层齿轮，这里只写在下半区靠右）
  ctx.textAlign = 'right';
  ctx.font = `500 ${fs(theme, 'fontSmall')}px ${FONT}`;
  ctx.fillStyle = theme.textMuted;
  ctx.fillText(`${Math.max(1, Math.ceil(state.board.history.length / 2))} 回合`, layout.width - layout.pad, hud.y + hud.h * 0.78);

  // 左下角：难度
  ctx.textAlign = 'left';
  ctx.fillText(`AI · ${state.levelName ?? ''}`, layout.pad, hud.y + hud.h * 0.78);
  ctx.textAlign = 'left';
}

/**
 * 底部三颗按钮：统一走集成层导出的 drawWoodButton（木质感，全站一致，规范 §10）。
 * 主操作「重新开始」传 primary:true；「悔棋 / 认输」不可用时传 disabled:true。
 */
export function drawButtons(ctx, layout, theme, state) {
  const labels = ['重新开始', '悔棋', '认输'];
  const disabled = [
    false,                                                    // 重新开始随时可用（结算后就靠它开新局）
    state.board.history.length === 0 || state.aiThinking,     // 无棋可悔 / AI 思考中
    !!state.outcome,                                          // 已结算不能再认输
  ];
  layout.buttons.forEach((btn, i) => {
    drawWoodButton(ctx, btn, labels[i], {
      pressed: state.pressIndex === i,
      primary: i === 0,
      disabled: disabled[i],
      fontSize: fs(theme, 'fontBtn'),
    });
  });
}

/**
 * 结算浮层：**已删除**（原来在这里画一层全屏遮罩 + 一张结果卡）。
 *
 * 为什么删：规范 §10 明确「统一结算弹窗由集成层绘制，游戏只返回 outcome」。
 * 集成层（src/app.js）在本模块返回 outcome 后会画自己的遮罩 + 弹窗（再来一局 / 回到主界面），
 * 原来这里再画一遍，结果是两层遮罩叠加、两张卡片互相压着，而且那段整屏铺底
 * 也属于「游戏自带全屏铺底」——审计规则 fullscreen-bg 会直接判失败。
 * 现在终局画面保持不变（棋盘 + 结果由集成层弹窗呈现），outcome 一直返回直到 destroy/resize 重建。
 */

/** 浮动提示（非法走法 / 提醒）。 */
export function drawToast(ctx, layout, theme, state, now) {
  const t = state.toast;
  if (!t) return;
  const age = (now ?? 0) - t.t0;
  if (age > t.ms) { state.toast = null; return; }
  const fade = age < 150 ? age / 150 : age > t.ms - 300 ? Math.max(0, (t.ms - age) / 300) : 1;

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.font = `600 ${fs(theme, 'fontHud')}px ${FONT}`;
  const tw = ctx.measureText(t.text).width;
  const h = 36;
  const w = Math.min(layout.width - layout.pad * 3, tw + 36);
  const x = (layout.width - w) / 2;
  const y = layout.buttons[0].y - h - 12;

  pathRoundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = theme.panel;
  ctx.fill();
  ctx.strokeStyle = theme.btnPrimaryBorder;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.accent;
  ctx.fillText(t.text, layout.width / 2, y + h / 2 + 0.5);
  ctx.restore();
  ctx.textAlign = 'left';
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一次完整绘制（棋盘 → 标记 → 棋子 → HUD → 按钮 → 浮动提示）。
 *
 * ⚠️ 不铺背景、不调 ctx.clearRect：集成层每帧负责「清屏 + 青白渐变铺底」（规范 §10）。
 * 早先这里有一句 clearRect，会把集成层刚铺好的青白底清掉，整屏露出页面深色背景
 * （蜘蛛纸牌踩过同一个坑，实机截图表现为整屏深灰）。
 * 结算弹窗同样不在本层画 —— 由集成层读 outcome 后统一绘制。
 */
export function renderGame(ctx, layout, state, theme, now) {
  drawBoard(ctx, layout, state, theme);
  drawMarks(ctx, layout, state, theme, now);
  drawPieces(ctx, layout, state, theme, now);
  drawHud(ctx, layout, state, theme, now);
  drawButtons(ctx, layout, theme, state);
  drawToast(ctx, layout, theme, state, now);
}

export { pathRoundRect };
