/**
 * 扫雷绘制层：只负责「把状态画出来」，不持有状态、不碰平台 API。
 *
 * 视觉沿用「纯净玩」的木质感：
 *   - 未翻开 = 凸起木块（对角渐变 + 上亮下暗的倒角 + 投影）
 *   - 已翻开 = 凹陷浅色（左上内阴影 + 右下内高光 + 内描边）
 *   - 数字 1–8 各有固定颜色（扫雷玩家的肌肉记忆，不能乱换）
 *   - 旗子 / 地雷 / 踩雷爆炸 / 底部木质按钮
 *
 * 交给集成层的（规范 §10，本文件一律不碰）：
 *   - 全屏青白渐变底 + 每帧清屏（clearRect 会把集成层的底擦掉，蜘蛛纸牌踩过这个坑）
 *   - 左上返回键、右上齿轮（本文件连那两块 56px 角区都不画，HUD 整体从角区下方开始）
 *   - 统一结算弹窗（游戏只把 outcome 交回去）
 * 文字颜色一律取 theme.* 令牌 —— 深色主题那套写死的浅字在青白底上会直接隐形。
 */
import { HIDDEN, REVEALED, FLAGGED, PLAYING, WON, LOST, formatTime } from './core.js';
// 木质按钮由集成层提供（规范 §10：游戏的操作按钮统一走 drawWoodButton，保证全站按键风格一致）
import { drawWoodButton } from '../../ui/renderer.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/**
 * 顶部角区让位高度（逻辑像素）。
 * 集成层在左上/右上各画一个返回键与齿轮，规范 §10 要求游戏 HUD 避开这两个角区；
 * 这里取「角键底边 + 余量」与这个名义值中的较大者，任何机型下都不会压到它们。
 */
const CORNER_KEEPOUT = 56;

/** 数字 1–8 的配色（固定色，不随主题走）。 */
const NUMBER_COLORS = [
  '',            // 0 不画
  '#1d5bbf',     // 1 蓝
  '#1f7a3c',     // 2 绿
  '#c62f2f',     // 3 红
  '#4a2f8a',     // 4 深紫
  '#8a4a12',     // 5 棕
  '#0f6f74',     // 6 青
  '#2b2b33',     // 7 近黑
  '#6b6b74',     // 8 灰
];

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 圆角矩形路径（不依赖 ctx.roundRect，兼容小游戏基础库）。 */
export function pathRoundRect(ctx, x, y, w, h, r) {
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
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** easeOutCubic：爆炸扩散的手感曲线。 */
function easeOutCubic(t) {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/** 文本水平居中基线设置，省得每处重复。 */
function setText(ctx, align, baseline) {
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
}

/* ───────────────────────── 布局 ───────────────────────── */

/**
 * 计算一屏的几何信息。纯函数，方便 Node 里直接单测。
 *
 * 纵向三段：HUD（顶部信息） / 网格（居中） / 脚部按钮。
 * 底部按钮的基线 = height - insets.bottom - 16，再往上放按钮本体，
 * 保证实机手势条不会压住按钮（规范里的硬约束）。
 */
export function computeLayout(width, height, insets, cols, rows) {
  const safeTop = Math.max(0, Math.round(insets?.top ?? 0));
  const safeBottom = Math.max(0, Math.round(insets?.bottom ?? 0));
  const pad = Math.round(Math.min(width, height) * 0.045) || 16;

  // 集成层在左上/右上画了返回与齿轮（边长 max(30, pad*2.1)，从 insets.top+4 起）。
  // 顶部信息整体落到角区下方：取「角键底边 + 一点余量」与名义角区 56px 的较大值。
  // ⚠️ 别再为了省空间把这行压回去 —— 压上去 HUD 会压住返回键/齿轮（实机截图见过重叠）。
  const cornerSize = Math.max(32, Math.round(pad * 2.1));
  const hudTop = Math.max(cornerSize + Math.round(pad * 0.35), CORNER_KEEPOUT);
  const hud = {
    x: pad,
    y: safeTop + hudTop,
    w: width - pad * 2,
    // 高度要同时容纳三行：标题(22px) + 状态(14px) + 小字(12px)。
    // 早先给 46，标题底边会压到状态行（实机截图可见重叠）。
    h: Math.max(60, Math.round(Math.min(height, width) * 0.115)),
  };

  // 底部：手势条让位 + 16 余量（硬约束）
  const btnH = Math.max(42, Math.round(Math.min(58, height * 0.062)));
  const btnBottom = height - safeBottom - 16;
  const btnY = Math.round(btnBottom - btnH);

  const footer = { y: btnY, h: btnH + 16 };

  // 网格：正方形，塞进 HUD 与 footer 之间的剩余空间
  const availW = width - pad * 2;
  const availH = btnY - 16 - (hud.y + hud.h);
  const gridSize = Math.max(80, Math.floor(Math.min(availW, availH)));
  const gridX = Math.round((width - gridSize) / 2);
  const gridY = Math.round(hud.y + hud.h + Math.max(0, (availH - gridSize) / 2));
  const cell = gridSize / cols;

  // 底部两颗胶囊：左「重新开始」宽一些，右「标旗模式」稍窄
  const gap = Math.round(pad * 0.6);
  const totalW = width - pad * 2;
  const restartW = Math.round((totalW - gap) * 0.46);
  const flagW = totalW - gap - restartW;
  const buttons = [
    { x: pad, y: btnY, w: restartW, h: btnH, key: 'restart' },
    { x: pad + restartW + gap, y: btnY, w: flagW, h: btnH, key: 'flagMode' },
  ];

  return {
    width, height,
    safe: { top: safeTop, bottom: safeBottom },
    pad,
    hud,
    footer,
    buttons,
    // 底部安全线（调试/自检用：按钮底边必须 ≤ 这条线）
    bottomLimit: btnBottom,
    grid: { x: gridX, y: gridY, size: gridSize, cell, cols, rows },
  };
}

/** 逻辑坐标 → 格子下标；不在网格内返回 null。 */
export function gridAt(layout, x, y) {
  const g = layout.grid;
  if (x < g.x || y < g.y || x >= g.x + g.size || y >= g.y + g.size) return null;
  const col = Math.floor((x - g.x) / g.cell);
  const row = Math.floor((y - g.y) / g.cell);
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return null;
  return { x: col, y: row };
}

/** 命中底部按钮，返回 key（'restart' / 'flagMode'）或 null。 */
export function hitButton(layout, x, y) {
  for (const b of layout.buttons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.key;
  }
  return null;
}

/* ───────────────────────── 底与网格底板 ───────────────────────── */

/**
 * 网格后方的暖色柔光（只铺网格四周一圈，绝不铺满屏）。
 *
 * ⚠️ 规范 §10：全屏青白渐变底与清屏（clearRect）都是**集成层**的职责。
 * 早先这里铺了一层全屏渐变 + 全屏柔光，虽然用的是主题令牌、肉眼看着一样，
 * 但它盖住了集成层刚铺好的底，属于越界（蜘蛛纸牌就因为一句 clearRect 露过深色底）。
 * 现在只保留「聚焦中央」的柔光，且限制在网格外接方形内 ——
 * 渐变两端都是透明，不会在青白底上留下边。
 */
export function drawGlow(ctx, layout, theme) {
  const grid = layout.grid;
  const cx = grid.x + grid.size / 2;
  const cy = grid.y + grid.size / 2;
  const r = grid.size * 0.82;
  const glow = ctx.createRadialGradient(cx, cy, grid.size * 0.12, cx, cy, r);
  glow.addColorStop(0, 'rgba(240,180,41,0.10)');
  glow.addColorStop(1, 'rgba(240,180,41,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

/** 网格底板：一块更深的木槽，让凸起的木块有落脚处。 */
/* ───────────────────────── 金属材质调色板（用户要求：扫雷棋盘改成金属质感）─────────────────────────
 * 这是本模块私有的配色，**不改全局 theme**（其他游戏仍用木色），
 * 银灰钢面：冷色渐变 + 亮边高光 + 细缝线，做出"金属格栅"的观感。 */
const METAL = {
  deep:   '#59636a',   // 外框暗部
  edge:   '#aeb8bf',   // 外框亮部
  top:    '#eff3f6',   // 格子亮面
  bottom: '#c2ccd3',   // 格子暗面
  soft:   '#f8fbfd',   // 高光边
  groove: '#98a3aa',   // 缝线
  shadow: 'rgba(20,30,38,0.42)',
};
export function drawGridBase(ctx, layout, theme) {
  const g = layout.grid;
  const r = Math.max(6, Math.round(g.size * 0.035));
  const inset = Math.max(4, Math.round(g.cell * 0.16));

  ctx.save();
  ctx.shadowColor = METAL.shadow;
  ctx.shadowBlur = Math.round(g.size * 0.045);
  ctx.shadowOffsetY = Math.round(g.size * 0.010);
  pathRoundRect(ctx, g.x - inset, g.y - inset, g.size + inset * 2, g.size + inset * 2, r);
  ctx.fillStyle = METAL.deep;
  ctx.fill();
  ctx.restore();

  const wood = ctx.createLinearGradient(0, g.y - inset, 0, g.y + g.size + inset);
  wood.addColorStop(0, METAL.bottom);
  wood.addColorStop(1, METAL.edge);
  pathRoundRect(ctx, g.x - inset, g.y - inset, g.size + inset * 2, g.size + inset * 2, r);
  ctx.fillStyle = wood;
  ctx.fill();
  ctx.strokeStyle = METAL.edge;
  ctx.lineWidth = Math.max(1, g.size * 0.004);
  ctx.stroke();
}

/* ───────────────────────── 格子 ───────────────────────── */

/**
 * 未翻开的木块：对角渐变 + 上/左亮、下/右暗的倒角 + 投影。
 * 用两条细边框做倒角，比三色渐变便宜且更像木头。
 */
function drawCoveredCell(ctx, x, y, size, theme, opts) {
  const gap = Math.max(1, size * 0.035);
  const w = size - gap;
  const r = Math.max(1.5, size * 0.14);
  const lit = opts && opts.lit;   // 按压/悬停高亮

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = Math.max(1, size * 0.10);
  ctx.shadowOffsetY = Math.max(1, size * 0.055);

  const g = ctx.createLinearGradient(x, y, x + w, y + w);
  g.addColorStop(0, lit ? METAL.soft : METAL.top);
  g.addColorStop(1, lit ? METAL.top : METAL.bottom);
  pathRoundRect(ctx, x, y, w, w, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  // 上/左亮边
  ctx.beginPath();
  ctx.moveTo(x + r, y + w - r);
  ctx.arcTo(x, y + w, x, y + w - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.strokeStyle = METAL.soft;
  ctx.lineWidth = Math.max(1, size * 0.055);
  ctx.lineCap = 'round';
  ctx.stroke();

  // 下/右暗边
  ctx.beginPath();
  ctx.moveTo(x + r, y + w);
  ctx.lineTo(x + w - r, y + w);
  ctx.arcTo(x + w, y + w, x + w, y + w - r, r);
  ctx.lineTo(x + w, y + r);
  ctx.strokeStyle = 'rgba(96,58,18,0.55)';
  ctx.lineWidth = Math.max(1, size * 0.045);
  ctx.stroke();
}

/** 已翻开的凹陷浅色格。 */
function drawRevealedCell(ctx, x, y, size, theme) {
  const gap = Math.max(1, size * 0.035);
  const w = size - gap;
  const r = Math.max(1.5, size * 0.11);

  pathRoundRect(ctx, x, y, w, w, r);
  ctx.fillStyle = METAL.bottom;
  ctx.fill();

  // 左上内阴影（凹陷感）
  ctx.save();
  pathRoundRect(ctx, x, y, w, w, r);
  ctx.clip();
  const sh = ctx.createLinearGradient(x, y, x + w * 0.7, y + w * 0.7);
  sh.addColorStop(0, 'rgba(90,52,16,0.30)');
  sh.addColorStop(0.55, 'rgba(90,52,16,0.02)');
  sh.addColorStop(1, 'rgba(255,246,225,0.28)');
  ctx.fillStyle = sh;
  ctx.fillRect(x, y, w, w);
  ctx.restore();

  // 内描边收口
  pathRoundRect(ctx, x + 0.5, y + 0.5, w - 1, w - 1, r);
  ctx.strokeStyle = 'rgba(140,96,40,0.35)';
  ctx.lineWidth = Math.max(1, size * 0.03);
  ctx.stroke();
}

/** 数字 1–8 与旗子/地雷。 */
function drawNumber(ctx, cx, cy, size, adj) {
  if (adj <= 0) return;
  const color = NUMBER_COLORS[Math.min(adj, 8)] || NUMBER_COLORS[8];
  ctx.font = `800 ${Math.round(size * 0.62)}px ${FONT}`;
  setText(ctx, 'center', 'middle');
  ctx.fillStyle = color;
  ctx.fillText(String(adj), cx, cy + size * 0.03);
}

/** 旗子：木柄 + 红三角 + 底座。 */
function drawFlag(ctx, x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const h = size * 0.52;

  // 木柄
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.04, cy - h * 0.52);
  ctx.lineTo(cx - size * 0.04, cy + h * 0.40);
  ctx.strokeStyle = 'rgba(70,42,12,0.85)';
  ctx.lineWidth = Math.max(1.4, size * 0.075);
  ctx.lineCap = 'round';
  ctx.stroke();

  // 底座
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.22, cy + h * 0.48);
  ctx.lineTo(cx + size * 0.18, cy + h * 0.48);
  ctx.strokeStyle = 'rgba(70,42,12,0.85)';
  ctx.lineWidth = Math.max(1.4, size * 0.075);
  ctx.stroke();

  // 红三角旗面
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.04, cy - h * 0.48);
  ctx.lineTo(cx + size * 0.30, cy - h * 0.16);
  ctx.lineTo(cx - size * 0.04, cy + h * 0.16);
  ctx.closePath();
  ctx.fillStyle = '#d63b32';
  ctx.fill();
  ctx.strokeStyle = 'rgba(90,20,16,0.55)';
  ctx.lineWidth = Math.max(1, size * 0.035);
  ctx.stroke();
}

/** 地雷：球体渐变 + 高光 + 八根尖刺。 */
function drawMine(ctx, x, y, size, theme, dead) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.22;

  // 尖刺
  ctx.strokeStyle = dead ? '#ffe9b8' : '#2a2a32';
  ctx.lineWidth = Math.max(1.4, size * 0.06);
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
    ctx.lineTo(cx + Math.cos(a) * r * 1.72, cy + Math.sin(a) * r * 1.72);
    ctx.stroke();
  }

  // 球体
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.38, r * 0.10, cx, cy, r * 1.05);
  if (dead) {
    g.addColorStop(0, '#fff4d8');
    g.addColorStop(0.5, '#f0b429');
    g.addColorStop(1, '#8a4a12');
  } else {
    g.addColorStop(0, '#6a6a76');
    g.addColorStop(0.5, '#2b2b33');
    g.addColorStop(1, '#0b0b0f');
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  // 高光
  ctx.beginPath();
  ctx.arc(cx - r * 0.34, cy - r * 0.38, r * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = dead ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)';
  ctx.fill();
}

/* ───────────────────────── 网格总绘 ───────────────────────── */

/**
 * 画整个网格。snapshot 是 core.js 的 snapshot() 结果（只读快照）。
 * 全部格子按两种底色分桶绘制，避免每次 fill 都重建路径。
 */
export function drawGrid(ctx, layout, view, theme, now) {
  const g = layout.grid;
  const size = g.cell;
  const grid = view.grid;

  // 首点翻开后一小段整体「点亮」动效（只影响不透明度，不逐格建动画队列）
  const revealRamp = view.revealT0
    ? clamp01(((now ?? view.revealT0) - view.revealT0) / 180)
    : 1;

  for (let ry = 0; ry < g.rows; ry++) {
    const row = grid[ry];
    for (let rx = 0; rx < g.cols; rx++) {
      const cell = row[rx];
      const x = g.x + rx * size;
      const y = g.y + ry * size;

      if (cell.state === REVEALED) {
        // 地雷底衬（翻开后还能看见的雷）
        if (cell.mine) {
          ctx.save();
          ctx.globalAlpha = revealRamp;
          drawRevealedCell(ctx, x, y, size, theme);
          drawMine(ctx, x, y, size, theme, view.result === LOST && view.boom && view.boom.x === rx && view.boom.y === ry);
          ctx.restore();
        } else {
          ctx.save();
          ctx.globalAlpha = revealRamp;
          drawRevealedCell(ctx, x, y, size, theme);
          drawNumber(ctx, x + size / 2, y + size / 2, size, cell.adj);
          ctx.restore();
        }
        continue;
      }

      // 未翻开 / 已插旗
      const hovered = view.hover && view.hover.x === rx && view.hover.y === ry;
      const pressed = view.press && view.press.x === rx && view.press.y === ry;
      drawCoveredCell(ctx, x, y, size, theme, { lit: hovered || pressed });

      if (cell.state === FLAGGED) drawFlag(ctx, x, y, size);
    }
  }

  // 标旗模式下给未翻开的格子一点提示（细红点）
  if (view.flagMode && view.result === PLAYING) {
    ctx.fillStyle = 'rgba(214,59,50,0.55)';
    for (let ry = 0; ry < g.rows; ry++) {
      for (let rx = 0; rx < g.cols; rx++) {
        if (grid[ry][rx].state !== HIDDEN) continue;
        ctx.beginPath();
        ctx.arc(g.x + rx * size + size * 0.80, g.y + ry * size + size * 0.20, Math.max(1.2, size * 0.06), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 按压态的外描边，手指下有反馈
  if (view.press) {
    const { x: rx, y: ry } = view.press;
    if (rx >= 0 && ry >= 0 && rx < g.cols && ry < g.rows) {
      pathRoundRect(ctx, g.x + rx * size, g.y + ry * size, size, size, size * 0.16);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = Math.max(1.5, size * 0.07);
      ctx.stroke();
    }
  }
}

/* ───────────────────────── 爆炸特效 ───────────────────────── */

/**
 * 踩雷爆炸：中心闪光 + 两道扩散环 + 八条放射线 + 火花。
 * 全部用确定性的 sin/cos 造粒子，不引入随机数（保证每帧稳定、不抖动）。
 */
export function drawExplosion(ctx, layout, view, theme, now) {
  if (!view.boom || !view.loseT0) return;
  const age = (now ?? view.loseT0) - view.loseT0;
  if (age < 0 || age > 900) return;

  const g = layout.grid;
  const cx = g.x + view.boom.x * g.cell + g.cell / 2;
  const cy = g.y + view.boom.y * g.cell + g.cell / 2;
  const t = clamp01(age / 900);
  const fade = 1 - clamp01((age - 420) / 480);
  const R = Math.max(g.cell * 2.4, g.size * 0.34);

  ctx.save();

  // 中心闪光
  const flash = clamp01(1 - age / 260);
  if (flash > 0) {
    const fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.85);
    fg.addColorStop(0, `rgba(255,250,225,${0.90 * flash})`);
    fg.addColorStop(0.35, `rgba(240,180,41,${0.55 * flash})`);
    fg.addColorStop(1, 'rgba(240,180,41,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.85, 0, Math.PI * 2);
    ctx.fill();
  }

  // 扩散环
  for (let i = 0; i < 2; i++) {
    const rt = clamp01((t - i * 0.16) / 0.84);
    if (rt <= 0) continue;
    const rr = easeOutCubic(rt) * R * (1 - i * 0.28);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.strokeStyle = i === 0 ? `rgba(255,214,120,${0.85 * fade})` : `rgba(239,95,95,${0.60 * fade})`;
    ctx.lineWidth = Math.max(1.5, g.cell * (i === 0 ? 0.20 : 0.13));
    ctx.stroke();
  }

  // 放射线
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + 0.25;
    const rr = easeOutCubic(t) * R * 0.95;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * g.cell * 0.4, cy + Math.sin(a) * g.cell * 0.4);
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    ctx.strokeStyle = `rgba(255,196,90,${0.55 * fade})`;
    ctx.lineWidth = Math.max(1.2, g.cell * 0.10);
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // 火花（确定性抖动）
  for (let i = 0; i < 12; i++) {
    const a = i * 2.399963 + 0.7;
    const speed = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7));
    const rr = easeOutCubic(t) * R * speed;
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr + t * t * g.cell * 0.9;   // 一点重力感
    const s = Math.max(1, g.cell * 0.10 * (1 - t));
    ctx.beginPath();
    ctx.arc(px, py, s, 0, Math.PI * 2);
    ctx.fillStyle = i % 3 === 0
      ? `rgba(255,246,214,${0.85 * fade})`
      : `rgba(240,150,40,${0.75 * fade})`;
    ctx.fill();
  }

  // 屏幕边缘泛红（让爆炸有冲击力，但不遮住网格）
  const vig = clamp01(1 - age / 700) * 0.22;
  if (vig > 0.01) {
    const rg = ctx.createRadialGradient(cx, cy, g.size * 0.28, cx, cy, Math.max(layout.width, layout.height) * 0.75);
    rg.addColorStop(0, 'rgba(239,95,95,0)');
    rg.addColorStop(1, `rgba(239,95,95,${vig})`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, layout.width, layout.height);
  }

  ctx.restore();
}

/* ───────────────────────── HUD ───────────────────────── */

/** 顶部信息：剩余雷数 + 计时 + 局面状态。集成层不画 HUD，这里自绘。 */
export function drawHud(ctx, layout, view, theme, now) {
  const hud = layout.hud;
  const cx = layout.width / 2;

  // 标题（左上/右上角落是集成层的按钮，标题居中不与它们打架）
  ctx.font = `700 ${theme.fontTitle}px ${FONT}`;
  setText(ctx, 'center', 'middle');
  ctx.fillStyle = theme.textPrimary;
  ctx.fillText('扫雷', cx, hud.y + hud.h * 0.24);

  // 第二行：剩余雷数 · 用时
  const elapsed = formatTime(view.elapsed ?? 0);
  const status = view.result === WON ? '扫雷成功'
    : view.result === LOST ? '踩雷了'
      : '剩余雷数';
  const line = view.result === PLAYING
    ? `${status} ${view.remaining}  ·  ${elapsed}`
    : `${status}  ·  ${elapsed}`;

  ctx.font = `600 ${theme.fontHud}px ${FONT}`;
  ctx.fillStyle = view.result === WON ? theme.success
    : view.result === LOST ? theme.danger
      : theme.textMuted;
  ctx.fillText(line, cx, hud.y + hud.h * 0.56);

  // 第三行：难度 + 进度（弱化）
  // ⚠️ 必须用主题令牌：早先写死 rgba(242,243,247,0.38)（深色主题的浅字），
  // 换成青白渐变底后这行直接隐形（实机截图里「初级 · 已翻开 0%」整行看不见）。
  const pct = Math.round((view.progress ?? 0) * 100);
  ctx.font = `500 ${theme.fontSmall}px ${FONT}`;
  ctx.fillStyle = theme.textMuted;
  ctx.fillText(`${view.levelName ?? ''}  ·  已翻开 ${pct}%`, cx, hud.y + hud.h * 0.84);

  // 标旗模式提示条（模式开着才画，避免常驻噪音）
  if (view.flagMode && view.result === PLAYING) {
    const pulse = 0.65 + 0.35 * Math.sin((now ?? 0) / 420);
    const w = Math.min(layout.width - layout.pad * 4, 190);
    const h = Math.max(24, Math.round(theme.fontHud * 1.7));
    const bx = (layout.width - w) / 2;
    const by = hud.y + hud.h + 4;
    ctx.save();
    ctx.globalAlpha = 0.55 + pulse * 0.35;
    pathRoundRect(ctx, bx, by, w, h, h / 2);
    ctx.fillStyle = theme.accentSoft;
    ctx.fill();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.font = `600 ${theme.fontSmall}px ${FONT}`;
    ctx.fillStyle = theme.accent;
    ctx.fillText('标旗模式：点按 = 插旗', layout.width / 2, by + h / 2 + 0.5);
    ctx.restore();
  }
}

/* ───────────────────────── 结算层（已删） ───────────────────────── */

/* 结算卡片已删除（规范 §10：统一结算弹窗由集成层 drawResultDialog 绘制）。
 * 早先这里的自绘结算卡（半透明遮罩 + 卡片 + 结果文案 + 数据行）会与集成层的
 * 统一弹窗叠加——集成层弹窗四周露出一截自绘卡片的边。
 * 终局时本模块只保持棋盘画面照常显示（含踩雷爆炸特效）、outcome 照常返回，
 * 胜负状态仍由 drawHud 的状态行给出；不自动重开，由集成层弹窗决定。 */

/* ───────────────────────── 底部按钮 ───────────────────────── */

/**
 * 底部两颗胶囊按钮：重新开始 / 标旗模式。
 * 一律走集成层导出的 drawWoodButton（规范 §10）：全站按键木质感一致，
 * 渐变、按压位移、禁用态都由集成层定义，游戏这边只管给 rect + 文案 + 状态。
 * ⚠️ 别自己 fill/stroke 了 —— 各自画按钮正是这次 UI 适配要消灭的问题（清单问题 C）。
 */
export function drawButtons(ctx, layout, view, theme) {
  layout.buttons.forEach((btn, i) => {
    const isFlag = btn.key === 'flagMode';
    const active = isFlag && view.flagMode;
    const label = isFlag ? (view.flagMode ? '标旗模式：开' : '标旗模式：关') : '重新开始';

    // 主操作「重新开始」用木质主色；「标旗模式」是次要操作，用默认白木色。
    // 开关状态靠文案 + 按钮上那枚小旗子表示（drawWoodButton 没有 active 态）。
    drawWoodButton(ctx, btn, label, {
      pressed: view.pressButton === btn.key,
      primary: i === 0,
      fontSize: theme.fontBtn ?? 15,
    });

    // 标旗模式开启时，按钮上挂一枚小旗子做状态指示
    if (active) {
      const fx = btn.x + 14;
      const fy = btn.y + btn.h / 2 - btn.h * 0.30;
      const s = btn.h * 0.60;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx + s * 0.34, fy + s * 0.18);
      ctx.lineTo(fx, fy + s * 0.36);
      ctx.closePath();
      ctx.fillStyle = '#d63b32';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx, fy + s * 0.72);
      ctx.strokeStyle = 'rgba(70,42,12,0.85)';
      ctx.lineWidth = Math.max(1.2, btn.h * 0.045);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  });
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一帧完整绘制（柔光 → 底板 → 网格 → 爆炸 → HUD → 按钮）。
 *
 * 不画的东西（规范 §10）：
 *   - 全屏青白渐变底：集成层每帧 clearRect + drawBackground 铺好，本模块不越界；
 *   - 左上返回键、右上齿轮、统一结算弹窗：集成层画。
 *   - 也**不调 clearRect** —— 早先这里有 `ctx.clearRect(0,0,w,h)`，
 *     它会把集成层刚铺好的青白底擦成透明（蜘蛛纸牌踩过同一个坑，整屏露深色）。
 *
 * @param ctx Canvas 2D 上下文
 * @param layout computeLayout 的结果
 * @param view   渲染视图（由 index.js 组装：快照 + 交互态 + 时间戳）
 * @param theme   THEME
 * @param now     当前时间（ms）
 */
export function renderFrame(ctx, layout, view, theme, now) {
  drawGlow(ctx, layout, theme);
  drawGridBase(ctx, layout, theme);
  drawGrid(ctx, layout, view, theme, now);
  drawExplosion(ctx, layout, view, theme, now);
  drawHud(ctx, layout, view, theme, now);
  drawButtons(ctx, layout, view, theme);
  // 终局不再画模块自绘结算卡（规范 §10：结算弹窗归集成层），棋盘画面照常保留
}
