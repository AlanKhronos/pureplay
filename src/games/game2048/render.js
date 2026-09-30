/**
 * 2048 绘制层：只负责「把状态画出来」，不持有状态、不碰平台 API。
 *
 * 视觉沿用「纯净玩」的木质感，但**只画棋盘区域**：
 *   - 不画全屏背景（集成层铺青白渐变底）；
 *   - 不画自己的结算弹窗（集成层统一画，本模块只返回 outcome）；
 *   - 不画左上返回键与右上齿轮（集成层负责）；
 *   - 文字颜色一律从 theme 取（浅底深字），主题缺字段时回落到浅色主题的默认值。
 *
 * 方块配色：2 / 4 / 8 / … / 2048 / 4096+ 各有一套（经典 2048 的暖色梯度），
 * 数字位数多时自动缩小字号，保证 4 位数也塞得下。
 */
import { tileExp, statusText, LOST } from './core.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/** 动画时长（毫秒）。 */
export const SPAWN_MS = 140;   // 新方块：缩放淡入
export const MERGE_MS = 170;   // 合并：弹一下再回到正常大小
export const GAIN_MS = 700;    // 得分飘字
/** 滑块方向判定的最小位移（逻辑像素）。 */
export const SLIDE_THRESHOLD = 24;

/**
 * 方块配色表：指数 → {hi, base, lo, text}。
 * 2 与 4 用浅底深字（经典做法），8 以上底色变深、字转白。
 * 4096 及以上统一用最高档深色（牌面值再大也不会变成看不见的颜色）。
 */
export const TILE_COLORS = {
  1:  { hi: '#fbf6ea', base: '#f4ecdc', lo: '#e2d5bd', text: '#6b5b45' },  // 2
  2:  { hi: '#f9efd2', base: '#eee2c0', lo: '#d9c79c', text: '#6b5b45' },  // 4
  3:  { hi: '#f7c47c', base: '#f2b179', lo: '#d9924f', text: '#ffffff' },  // 8
  4:  { hi: '#f9b077', base: '#f59563', lo: '#d9773f', text: '#ffffff' },  // 16
  5:  { hi: '#fb9d72', base: '#f67c5f', lo: '#d95f42', text: '#ffffff' },  // 32
  6:  { hi: '#f68d67', base: '#f65e3b', lo: '#d64321', text: '#ffffff' },  // 64
  7:  { hi: '#f5eeb2', base: '#edcf72', lo: '#c9a94e', text: '#5c4b1e' },  // 128
  8:  { hi: '#f6e9a0', base: '#edcc61', lo: '#c8a844', text: '#5c4b1e' },  // 256
  9:  { hi: '#f6e48e', base: '#edc850', lo: '#c7a333', text: '#5c4b1e' },  // 512
  10: { hi: '#f6e07c', base: '#edc22e', lo: '#c7a01a', text: '#5c4b1e' },  // 1024
  11: { hi: '#f7dc6f', base: '#edc22e', lo: '#b98f10', text: '#5c4b1e' },  // 2048
};
/** 超出配色表（4096+）的兜底色。 */
const TILE_COLORS_MAX = { hi: '#4f7fb5', base: '#3c5f8f', lo: '#27405f', text: '#ffffff' };
/** 空格的底色（棋盘上一格一格的凹槽）。 */
const CELL_EMPTY = 'rgba(115,80,42,0.22)';

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 圆角矩形路径（不依赖 ctx.roundRect，兼容小游戏基础库）。 */
export function pathRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
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

/** easeOutCubic：动画收尾更柔和。 */
function easeOutCubic(t) {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/** 文本对齐设置，省得每处重复两行。 */
function setText(ctx, align, baseline) {
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
}

/** 取某个数值的配色（未知 / 超大值兜底，绝不返回 undefined）。 */
export function tileColor(value) {
  if (!(value > 0)) return null;
  return TILE_COLORS[tileExp(value)] ?? TILE_COLORS_MAX;
}

/** 命中矩形（布局与输入共用）。 */
export function hitRect(rect, x, y) {
  return !!rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/**
 * 主题令牌 → 本模块配色。
 * 只画棋盘，所以底色固定用木色；文字/按钮/强调色从 theme 取。
 * 主题里缺字段时回落到浅色主题（青白底深字）的默认值，绝不写成深色底白字。
 */
export function palette(theme = {}) {
  const light = theme.textTitle != null || theme.textOnWood != null;
  return {
    woodTop: theme.woodTop ?? theme.boardTop ?? '#eec98f',
    woodBottom: theme.woodBottom ?? theme.boardBottom ?? '#d9a95f',
    woodEdge: theme.woodEdge ?? theme.boardEdge ?? '#b98a41',
    woodDeep: theme.woodDeep ?? theme.boardDark ?? '#8a5f22',
    woodInk: theme.woodInk ?? '#5c3d10',

    textPrimary: theme.textPrimary ?? (light ? theme.textBody ?? '#3d5b56' : '#2f4f4a'),
    textMuted: theme.textMuted ?? 'rgba(61,91,86,0.62)',
    accent: theme.accent ?? theme.woodDeep ?? '#b98a41',
    accentSoft: theme.accentSoft ?? 'rgba(240,180,41,0.20)',
    danger: theme.danger ?? '#c0392b',

    cardBg: theme.cardBg ?? 'rgba(255,255,255,0.78)',
    cardBorder: theme.cardBorder ?? 'rgba(150,110,50,0.28)',
    cardShadow: theme.cardShadow ?? 'rgba(90,70,30,0.18)',

    fontTitle: theme.fontTitle ?? 30,
    fontHud: theme.fontHud ?? 14,
    fontBig: theme.fontBig ?? 34,
    fontSmall: theme.fontSmall ?? 12,
    fontBtn: theme.fontBtn ?? 15,
  };
}

/* ───────────────────────── 布局 ───────────────────────── */

/**
 * 计算一屏几何。纯函数，Node 里可直接单测。
 *
 * 纵向四段：顶部标题 + 分数面板 / 棋盘 / 提示行（有空间才放）/ 底部按钮。
 * 底部按钮基线 = height − insets.bottom − 16（规范硬约束，实机手势条不遮按钮）。
 */
export function computeLayout(width, height, insets = {}, size = 4) {
  const w = Math.max(220, Math.round(width || 375));
  const h = Math.max(360, Math.round(height || 667));
  const safeTop = Math.max(0, Math.round(insets?.top ?? 0));
  const safeBottom = Math.max(0, Math.round(insets?.bottom ?? 0));
  const n = Math.max(2, Math.floor(size) || 4);

  const pad = Math.max(14, Math.round(Math.min(w, h) * 0.04));

  // 顶部：集成层在左上/右上画返回与齿轮，标题从它们下面开始
  const topH = Math.max(34, safeTop + 26);
  const title = { x: pad, y: topH, w: w - pad * 2, h: Math.max(30, Math.round(Math.min(w, h) * 0.075)) };

  // 底部按钮：底部让位 insets.bottom + 16
  const btnGap = Math.max(8, Math.round(pad * 0.55));
  const btnW = Math.floor((w - pad * 2 - btnGap) / 2);
  const btnH = Math.max(44, Math.min(60, Math.round(h * 0.068)));
  const bottomLimit = h - safeBottom - 16;
  const btnY = bottomLimit - btnH;
  const buttons = [
    { key: 'restart', label: '重新开始', x: pad, y: btnY, w: btnW, h: btnH },
    { key: 'undo', label: '撤销', x: pad + btnW + btnGap, y: btnY, w: btnW, h: btnH },
  ];

  // 分数面板：标题下方一条
  const hudH = Math.max(42, Math.round(btnH * 0.86));
  const hudY = title.y + title.h + pad * 0.4;
  const hud = { x: pad, y: hudY, w: w - pad * 2, h: hudH };

  // 棋盘：正方形，塞进分数面板与按钮之间的空间
  const availW = w - pad * 2;
  const availH = Math.max(80, btnY - pad - (hudY + hudH));   // 止于底部按钮上方（方向键已删，这块竖向空间还给棋盘）
  const boardSize = Math.max(n * 16, Math.round(Math.min(availW, availH)));
  const boardX = Math.round((w - boardSize) / 2);
  const boardY = Math.round(hudY + hudH + Math.max(0, (availH - boardSize) / 2));
  const cell = boardSize / n;                 // 浮点：下面的间距都用它算，避免累积误差
  const gap = Math.max(2, cell * 0.075);
  const tile = cell - gap;

  const board = {
    x: boardX, y: boardY, w: boardSize, h: boardSize, size: n, cell, gap, tile,
    /** 格子坐标 → 该格左上角的屏幕像素。 */
    toScreen(gx, gy) {
      return { x: boardX + gap / 2 + gx * cell, y: boardY + gap / 2 + gy * cell };
    },
  };

  // 提示行：按钮与棋盘之间还剩多少空间，够画就画
  const belowBoard = buttons[0].y - (boardY + boardSize);
  const hint = {
    y: boardY + boardSize + belowBoard / 2,
    visible: belowBoard > Math.max(16, h * 0.03),
  };

  return {
    width: w,
    height: h,
    safe: { top: safeTop, bottom: safeBottom },
    pad,
    topH,
    size: n,
    title,
    hud,
    board,
    hint,
    buttons,
    /** 让位后的底边（按钮最下沿必须 ≤ 它） */
    bottomLimit,
    isLight: true,
  };
}

/** 命中底部按钮，返回 key（'restart' / 'undo'）或 null。 */
export function hitButton(layout, x, y) {
  const b = layout.buttons.find((r) => hitRect(r, x, y));
  return b ? b.key : null;
}

/**
 * 由滑动位移判定方向（gesture 滑动手势专用，屏上没有方向按钮）。
 * @returns {'left'|'right'|'up'|'down'|null} 位移小于阈值或不是单向滑动 → null
 */
export function directionFor(dx, dy, threshold = SLIDE_THRESHOLD) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return null;
  // 取主轴（斜滑也算，按位移大的那个轴走）
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

/* ───────────────────────── 棋盘 ───────────────────────── */

/** 木质感棋盘底板 + 空格凹槽 + 木纹（只画棋盘这一块，不铺全屏背景）。 */
export function drawBoard(ctx, layout, theme) {
  const p = palette(theme);
  const b = layout.board;
  const r = Math.max(8, Math.round(b.cell * 0.22));

  // 投影：让木板从青白底上浮起来
  ctx.save();
  ctx.shadowColor = p.cardShadow;
  ctx.shadowBlur = Math.round(b.w * 0.05);
  ctx.shadowOffsetY = Math.round(b.w * 0.014);
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.fillStyle = p.woodBottom;
  ctx.fill();
  ctx.restore();

  // 木面：垂直渐变（上浅下深）+ 几道低对比木纹
  const wood = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
  wood.addColorStop(0, p.woodTop);
  wood.addColorStop(1, p.woodBottom);
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.fillStyle = wood;
  ctx.fill();

  ctx.save();
  pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.clip();
  ctx.strokeStyle = 'rgba(120,80,30,0.10)';
  ctx.lineWidth = 1;
  const grain = Math.max(3, Math.round(b.w / 22));
  for (let i = 1; i < grain; i++) {
    const gy = b.y + (b.h / grain) * i;
    ctx.beginPath();
    ctx.moveTo(b.x, gy);
    ctx.lineTo(b.x + b.w, gy + Math.sin(i * 1.7) * 1.5);
    ctx.stroke();
  }
  ctx.restore();

  // 外描边收口
  pathRoundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, r);
  ctx.strokeStyle = p.woodEdge;
  ctx.lineWidth = Math.max(1, b.w * 0.004);
  ctx.stroke();

  // 空格凹槽
  for (let y = 0; y < b.size; y++) {
    for (let x = 0; x < b.size; x++) {
      const p0 = b.toScreen(x, y);
      pathRoundRect(ctx, p0.x, p0.y, b.tile, b.tile, Math.max(3, b.tile * 0.14));
      ctx.fillStyle = CELL_EMPTY;
      ctx.fill();
    }
  }
}

/** 单个方块：缩放动画 + 对角渐变 + 上高光 / 下压暗 + 按位数自适应的字号。 */
export function drawTile(ctx, layout, cx, cy, value, scale = 1) {
  const c = tileColor(value);
  if (!c) return;
  const b = layout.board;
  const s = b.tile * (scale > 0 ? scale : 1);
  const half = s / 2;
  const r = Math.max(3, s * (value >= 128 ? 0.13 : 0.16));
  const x = cx - half;
  const y = cy - half;
  const hiW = Math.max(1.5, s * 0.10);

  // 底：对角渐变
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, c.hi);
  g.addColorStop(0.55, c.base);
  g.addColorStop(1, c.lo);
  pathRoundRect(ctx, x, y, s, s, r);
  ctx.fillStyle = g;
  ctx.fill();

  // 上高光 / 右下压暗，做出实体感
  ctx.beginPath();
  ctx.moveTo(x + r * 1.2, y + hiW);
  ctx.lineTo(x + s - r * 1.2, y + hiW);
  ctx.strokeStyle = 'rgba(255,255,255,0.42)';
  ctx.lineWidth = hiW;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + r * 1.2, y + s - hiW * 0.6);
  ctx.lineTo(x + s - hiW * 0.6, y + s - hiW * 0.6);
  ctx.lineTo(x + s - hiW * 0.6, y + r * 1.2);
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = hiW * 0.9;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 数字：位数越多字号越小（4 位数不会溢出格子）
  const digits = String(value).length;
  const scaleFont = digits <= 2 ? 0.46 : digits === 3 ? 0.38 : digits === 4 ? 0.30 : 0.24;
  ctx.font = `800 ${Math.round(s * scaleFont)}px ${FONT}`;
  setText(ctx, 'center', 'middle');
  ctx.fillStyle = c.text;
  ctx.fillText(String(value), cx, cy + s * 0.03);
  setText(ctx, 'left', 'alphabetic');
}

/**
 * 画整盘方块。动画全部由 now 与快照里的时间戳算出来（不持有状态）：
 *   - 新生成：0.72 → 1.0 缩放 + 淡入
 *   - 合并后：1.0 → 1.06 → 1.0 弹一下
 */
export function drawGrid(ctx, layout, view, theme, now) {
  const b = layout.board;
  const t = Number.isFinite(now) ? now : view.now ?? 0;

  for (let y = 0; y < b.size; y++) {
    const row = view.cells[y];
    if (!row) continue;
    for (let x = 0; x < b.size; x++) {
      const cell = row[x];
      if (!cell || !cell.value) continue;
      const p0 = b.toScreen(x, y);
      const cx = p0.x + b.tile / 2;
      const cy = p0.y + b.tile / 2;
      const center = { x: cx, y: cy };

      let scale = 1;
      let alpha = 1;
      if (cell.spawnAt > 0) {
        const k = clamp01((t - cell.spawnAt) / SPAWN_MS);
        if (k < 1) { scale = 0.72 + 0.28 * easeOutCubic(k); alpha = 0.35 + 0.65 * k; }
      }
      if (cell.mergeAt > 0) {
        const k = clamp01((t - cell.mergeAt) / MERGE_MS);
        if (k < 1) scale *= 1 + 0.12 * Math.sin(Math.PI * k);
      }

      ctx.save();
      if (alpha !== 1) ctx.globalAlpha = alpha;
      ctx.translate(center.x, center.y);
      ctx.scale(scale, scale);
      drawTile(ctx, layout, 0, 0, cell.value, 1);
      ctx.restore();
    }
  }
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 顶部：标题 / 分数 / 最高分 ───────────────────────── */

/** 标题 + 当前难度；右侧是分数与最高分两枚小卡。 */
export function drawHud(ctx, layout, view, theme) {
  const p = palette(theme);
  const t = layout.title;

  ctx.font = `800 ${p.fontTitle}px ${FONT}`;
  setText(ctx, 'left', 'middle');
  ctx.fillStyle = p.textPrimary;
  ctx.fillText('2048', t.x, t.y + t.h * 0.34);

  ctx.font = `500 ${p.fontSmall}px ${FONT}`;
  ctx.fillStyle = p.textMuted;
  const level = `${view.levelName ?? ''} · ${layout.size}×${layout.size}`.trim();
  ctx.fillText(level, t.x, t.y + t.h * 0.78);

  // 分数 / 最高分：两张并排小卡（都在棋盘上方，不与集成层的角标打架）
  const hud = layout.hud;
  const gap = Math.round(hud.w * 0.03);
  const cardW = Math.floor((hud.w - gap) / 2);
  const items = [
    { label: '分数', value: String(view.score), color: p.accent },
    { label: '最高分', value: String(view.best), color: p.textPrimary },
  ];

  items.forEach((it, i) => {
    const x = hud.x + i * (cardW + gap);
    pathRoundRect(ctx, x, hud.y, cardW, hud.h, Math.round(hud.h * 0.32));
    ctx.fillStyle = p.cardBg;
    ctx.fill();
    ctx.strokeStyle = p.cardBorder;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.font = `500 ${p.fontSmall}px ${FONT}`;
    ctx.fillStyle = p.textMuted;
    ctx.fillText(it.label, x + cardW * 0.06, hud.y + hud.h * 0.30);

    ctx.font = `800 ${Math.max(14, Math.round(hud.h * 0.40))}px ${FONT}`;
    ctx.fillStyle = it.color;
    ctx.fillText(it.value, x + cardW * 0.06, hud.y + hud.h * 0.70);
  });

  setText(ctx, 'left', 'alphabetic');
}

/**
 * 得分飘字（+N）：从分数卡下沿浮起并淡出。
 * 必须画在 drawHud 之后、且往上留 -20 的余量——第一版画在卡片上方时正好压在标题上。
 */
export function drawGain(ctx, layout, view, theme) {
  if (!view.gain || !(view.gain.value > 0)) return;
  const t = Number.isFinite(view.now) ? view.now : 0;
  const age = t - view.gain.at;
  if (!(age >= 0) || age > GAIN_MS) return;

  const p = palette(theme);
  const k = clamp01(age / GAIN_MS);
  const hud = layout.hud;

  ctx.save();
  ctx.globalAlpha = 1 - k;
  setText(ctx, 'left', 'middle');
  ctx.font = `800 ${p.fontHud}px ${FONT}`;
  ctx.fillStyle = p.accent;
  ctx.fillText(`+${view.gain.value}`, layout.pad + hud.w * 0.06, hud.y + hud.h + 4 + k * 18);
  ctx.restore();
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 提示与状态 ───────────────────────── */

/**
 * 棋盘下方的提示行：操作说明（有空间时）。
 * 2026 的棋盘占主要空间，所以这里只给一行轻提示，不做教程蒙层。
 */
export function drawHint(ctx, layout, view, theme) {
  const p = palette(theme);
  setText(ctx, 'center', 'middle');
  ctx.font = `500 ${p.fontSmall}px ${FONT}`;

  if (view.result === LOST) {
    ctx.fillStyle = p.danger;
    ctx.fillText('没有可移动的方向了 · 点「重新开始」', layout.width / 2, layout.hint.y);
  } else if (layout.hint.visible) {
    ctx.fillStyle = p.textMuted;
    ctx.fillText('滑动合并同数方块', layout.width / 2, layout.hint.y);
  }
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 底部按钮 ───────────────────────── */

/** 底部两颗胶囊：重新开始 / 撤销（无历史时撤销置灰）。 */
export function drawButtons(ctx, layout, view, theme) {
  const p = palette(theme);
  setText(ctx, 'center', 'middle');

  for (const btn of layout.buttons) {
    const pressed = view.pressButton === btn.key;
    const disabled = btn.key === 'undo' && !view.canUndo;
    const primary = btn.key === 'restart';

    pathRoundRect(ctx, btn.x, btn.y, btn.w, btn.h, btn.h / 2);
    ctx.fillStyle = pressed ? p.accentSoft : p.cardBg;
    ctx.fill();
    ctx.strokeStyle = primary ? p.woodEdge : p.cardBorder;
    ctx.lineWidth = primary ? 1.8 : 1.2;
    ctx.stroke();

    ctx.save();
    if (disabled) ctx.globalAlpha = 0.42;
    ctx.font = `600 ${p.fontBtn}px ${FONT}`;
    ctx.fillStyle = primary ? p.woodInk : p.textPrimary;
    ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 0.5);

    // 撤销图标：一道回转箭头，位置在文字左边
    if (btn.key === 'undo') {
      const r = Math.min(btn.h * 0.26, 12);
      const cx = btn.x + btn.w * 0.20;
      const cy = btn.y + btn.h / 2;
      ctx.strokeStyle = p.textPrimary;
      ctx.lineWidth = Math.max(1.6, r * 0.30);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI * 0.15, Math.PI * 1.55);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - r * 1.05, cy - r * 1.05);
      ctx.lineTo(cx - r * 0.20, cy - r * 1.35);
      ctx.lineTo(cx - r * 0.30, cy - r * 0.40);
      ctx.closePath();
      ctx.fillStyle = p.textPrimary;
      ctx.fill();
    }
    ctx.restore();
  }
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一帧完整绘制：棋盘底板 → 方块 → 顶部信息 → 得分飘字 → 提示 → 底部按钮。
 * 背景（青白渐变）、结算弹窗、左上返回、右上齿轮都由集成层负责，这里一律不画。
 *
 * @param ctx    Canvas 2D 上下文
 * @param layout computeLayout 的结果
 * @param view   渲染视图（index.js 组装：快照 + 交互态 + 时间戳）
 * @param theme  主题令牌
 * @param now    当前时间（ms，Date.now() 同源）
 */
export function renderFrame(ctx, layout, view, theme, now) {
  // 不清屏！集成层已经铺好底色，clearRect 会把青白渐变一起擦掉
  drawBoard(ctx, layout, theme);
  drawGrid(ctx, layout, view, theme, now);
  drawHud(ctx, layout, view, theme);
  drawGain(ctx, layout, view, theme);
  drawHint(ctx, layout, view, theme);
  drawButtons(ctx, layout, view, theme);
}

/** 状态文案（供 index.js 的 hud 用）。 */
export { statusText };
