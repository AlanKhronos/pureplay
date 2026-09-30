/**
 * 布局：把「屏幕尺寸」换算成各区块几何信息（纯函数，无平台依赖）
 *
 * 安全区（重要）：
 *   手机底部常有手势条/导航条、顶部有状态栏与刘海。布局必须把这两块让出来，
 *   否则底部按钮会被推出屏幕外（实机验证过的坑）。
 *   调用方传入 insets = { top, bottom }（逻辑像素），本模块负责让位。
 *
 * 两套布局：
 *   computeLayout      —— 对局界面（棋盘 + HUD + 按钮）
 *   computeMenuLayout  —— 主界面（标题 + 模式选择 + 难度选择 + 开始）
 */
import { BOARD_SIZE } from '../core/board.js';

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

/** 通用：安全区归一化。 */
function normalizeInsets(insets = {}) {
  const top = Math.max(0, Math.round(insets.top ?? 0));
  const bottom = Math.max(0, Math.round(insets.bottom ?? 0));
  return { top, bottom };
}

/* ─────────────────── 对局界面 ─────────────────── */

export function computeLayout(width, height, insets = {}) {
  const safe = normalizeInsets(insets);
  const pad = Math.round(Math.min(width, height) * 0.045) || 16;

  // 可用纵向空间（扣掉上下安全区）
  const usableTop = safe.top;
  const usableBottom = height - safe.bottom;
  const usableH = usableBottom - usableTop;

  // 顶部信息区：标题 + 执子/步数
  const hudH = Math.round(Math.min(104, usableH * 0.13));
  // 底部按钮区（含安全区让位）
  const footerH = Math.round(Math.min(132, usableH * 0.17));

  // 棋盘：正方形，取宽/高较小者
  const availW = width - pad * 2;
  const availH = usableH - hudH - footerH - pad;
  const boardOuter = Math.max(160, Math.min(availW, availH));

  const boardX = Math.round((width - boardOuter) / 2);
  const boardY = Math.round(usableTop + hudH + (usableH - hudH - footerH - boardOuter) / 2);

  const inner = Math.round(boardOuter * 0.045);
  const gridSize = boardOuter - inner * 2;
  const cell = gridSize / (BOARD_SIZE - 1);
  const stoneR = cell * 0.44;

  // 底部按钮：贴住"可用底边"再留 pad
  const btnGap = Math.round(pad * 0.6);
  const btnCount = 3;
  const btnW = Math.floor((width - pad * 2 - btnGap * (btnCount - 1)) / btnCount);
  const btnH = Math.max(38, Math.round(footerH * 0.42));
  const btnY = Math.round(usableBottom - pad - btnH);
  const buttons = [];
  for (let i = 0; i < btnCount; i++) {
    buttons.push({ x: pad + i * (btnW + btnGap), y: btnY, w: btnW, h: btnH });
  }

  return {
    width,
    height,
    safe,
    pad,
    hud: { x: pad, y: usableTop, w: width - pad * 2, h: hudH },
    board: {
      x: boardX,
      y: boardY,
      size: boardOuter,
      inner,
      cell,
      stoneR,
      toScreen(gx, gy) {
        return { x: boardX + inner + gx * cell, y: boardY + inner + gy * cell };
      },
      fromScreen(px, py) {
        return {
          x: Math.round((px - boardX - inner) / cell),
          y: Math.round((py - boardY - inner) / cell),
        };
      },
    },
    buttons,
    footer: { y: usableBottom - footerH, h: footerH },
    // 左上角返回 / 右上角设置齿轮
    ...(() => {
      const size = Math.max(30, Math.round(pad * 2.1));
      return {
        back: { x: pad, y: usableTop + 4, w: size, h: size },
        gear: { x: width - pad - size, y: usableTop + 4, w: size, h: size },
      };
    })(),
  };
}

/* ─────────────────── 主界面 ─────────────────── */

/**
 * 主界面布局。
 * @param modes 模式数量（固定 2：休闲 / 专业）
 * @param levels 难度数量（固定 5）
 */
export function computeMenuLayout(width, height, insets = {}, modes = 2, levels = 5) {
  const safe = normalizeInsets(insets);
  const pad = Math.round(Math.min(width, height) * 0.055) || 18;
  const usableTop = safe.top;
  const usableBottom = height - safe.bottom;
  const usableH = usableBottom - usableTop;

  // 纵向节奏：标题 28% / 模式 20% / 难度 26% / 开始 26%
  const titleH = Math.round(usableH * 0.28);
  const modeH = Math.round(usableH * 0.20);
  const levelH = Math.round(usableH * 0.26);

  const title = { x: pad, y: usableTop, w: width - pad * 2, h: titleH };

  // 模式卡片：横向两张
  const modeGap = Math.round(pad * 0.7);
  const modeW = Math.floor((width - pad * 2 - modeGap * (modes - 1)) / modes);
  const modeCardH = Math.round(modeH * 0.72);
  const modeY = usableTop + titleH + Math.round(modeH * 0.10);
  const modeCards = [];
  for (let i = 0; i < modes; i++) {
    modeCards.push({ x: pad + i * (modeW + modeGap), y: modeY, w: modeW, h: modeCardH });
  }

  // 难度：一排 5 个胶囊（窄屏自动两行），在所属区域内垂直居中，避免中间留大片空白
  const levelTop = usableTop + titleH + modeH;
  const levelCards = [];
  const perRow = width < 340 ? 3 : levels;
  const rows = Math.ceil(levels / perRow);
  const lvGap = Math.round(pad * 0.45);
  const lvW = Math.floor((width - pad * 2 - lvGap * (perRow - 1)) / perRow);
  const lvH = Math.max(34, Math.round(levelH * 0.34));
  const lvBlockH = rows * lvH + (rows - 1) * lvGap;
  const lvStartY = levelTop + Math.max(0, Math.round((levelH - lvBlockH) / 2));
  for (let i = 0; i < levels; i++) {
    const r = Math.floor(i / perRow), c = i % perRow;
    levelCards.push({
      x: pad + c * (lvW + lvGap),
      y: lvStartY + r * (lvH + lvGap),
      w: lvW,
      h: lvH,
    });
  }

  // 开始按钮
  const startW = Math.min(width - pad * 2, 320);
  const startH = Math.max(46, Math.round(usableH * 0.075));
  const start = {
    x: Math.round((width - startW) / 2),
    y: Math.round(usableBottom - pad - startH),
    w: startW,
    h: startH,
  };

  return {
    width, height, safe, pad,
    title,
    modeCards,
    levelCards,
    start,
    rows: { perRow, count: levels },
  };
}

/* ─────────────────── 通用小部件 ─────────────────── */

/** 左上角返回键 + 右上角设置齿轮（各界面共用）。 */
function cornerWidgets(width, insets, pad) {
  const size = Math.max(32, Math.round(pad * 2.0));
  return {
    back: { x: pad, y: insets.top + 18, w: size, h: size },
    gear: { x: width - pad - size, y: insets.top + 18, w: size, h: size },
  };
}

/* ─────────────────── 大厅：游戏列表 ─────────────────── */

/**
 * 「纯净玩」大厅布局：标题 + 游戏卡片网格（每行 2 个）。
 * @param games 游戏数量
 */
export function computeHallLayout(width, height, insets = {}, games = 1) {
  const safe = normalizeInsets(insets);
  const pad = Math.round(Math.min(width, height) * 0.055) || 18;
  const usableTop = safe.top;
  const usableBottom = height - safe.bottom;
  const usableH = usableBottom - usableTop;

  const titleH = Math.round(usableH * 0.22);
  const title = { x: pad, y: usableTop, w: width - pad * 2, h: titleH };
  const corners = cornerWidgets(width, safe, pad);

  // 卡片网格：2 列，行数随游戏数量增长；卡片高度自适应（游戏多了自动变矮，不会溢出屏幕）
  const cols = 2;
  const gap = Math.round(pad * 0.6);
  const cardW = Math.floor((width - pad * 2 - gap * (cols - 1)) / cols);
  const gridTop = usableTop + titleH;
  const gridBottom = usableBottom - Math.round(pad * 2.2);   // 给底部提示留位置
  const areaH = Math.max(120, gridBottom - gridTop);
  const rows = Math.max(1, Math.ceil(games / cols));
  const maxCardH = Math.floor((areaH - gap * (rows - 1)) / rows);
  const cardH = Math.max(96, Math.min(Math.round(cardW * 1.15), maxCardH));
  const cards = [];
  for (let i = 0; i < games; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    cards.push({
      x: pad + c * (cardW + gap),
      y: gridTop + r * (cardH + gap),
      w: cardW,
      h: cardH,
    });
  }

  return {
    width, height, safe, pad,
    title,
    cards,
    ...corners,
    hint: { x: pad, y: usableBottom - Math.round(pad * 1.6), w: width - pad * 2, h: Math.round(pad * 1.6) },
  };
}

/* ─────────────────── 模式：上下并排两大块 ─────────────────── */

export function computeModeLayout(width, height, insets = {}, modes = 2) {
  const safe = normalizeInsets(insets);
  const pad = Math.round(Math.min(width, height) * 0.055) || 18;
  const usableTop = safe.top;
  const usableBottom = height - safe.bottom;
  const usableH = usableBottom - usableTop;

  const titleH = Math.round(usableH * 0.17);
  const title = { x: pad, y: usableTop, w: width - pad * 2, h: titleH };
  const corners = cornerWidgets(width, safe, pad);

  // 上下两块：给块高设上限并整体垂直居中，避免长屏上"两块各占半屏、内部空旷"
  const areaTop = usableTop + titleH;
  const areaH = usableBottom - areaTop - pad;
  const gap = Math.round(pad * 0.8);
  const maxBlockH = Math.round(usableH * 0.26);
  const rawH = Math.floor((areaH - gap * (modes - 1)) / modes);
  const blockH = Math.max(96, Math.min(rawH, maxBlockH));
  const totalH = blockH * modes + gap * (modes - 1);
  const startY = areaTop + Math.max(0, Math.round((areaH - totalH) / 2));
  const blocks = [];
  for (let i = 0; i < modes; i++) {
    blocks.push({
      x: pad,
      y: startY + i * (blockH + gap),
      w: width - pad * 2,
      h: blockH,
    });
  }

  return { width, height, safe, pad, title, blocks, ...corners };
}

/* ─────────────────── 难度：竖排列表 ─────────────────── */

export function computeLevelLayout(width, height, insets = {}, levels = 5, modeName = '') {
  const safe = normalizeInsets(insets);
  const pad = Math.round(Math.min(width, height) * 0.055) || 18;
  const usableTop = safe.top;
  const usableBottom = height - safe.bottom;
  const usableH = usableBottom - usableTop;

  const titleH = Math.round(usableH * 0.17);
  const title = { x: pad, y: usableTop, w: width - pad * 2, h: titleH, modeName };
  const corners = cornerWidgets(width, safe, pad);

  const areaTop = usableTop + titleH;
  const areaH = usableBottom - areaTop - pad;
  const gap = Math.round(pad * 0.5);
  const rowH = Math.min(Math.round(areaH / levels) - gap, Math.round(usableH * 0.1));
  const blockH = levels * rowH + (levels - 1) * gap;
  const startY = areaTop + Math.max(0, Math.round((areaH - blockH) / 2));

  const rows = [];
  for (let i = 0; i < levels; i++) {
    rows.push({ x: pad, y: startY + i * (rowH + gap), w: width - pad * 2, h: rowH });
  }

  return { width, height, safe, pad, title, rows, ...corners };
}

/* ─────────────────── 设置面板 ─────────────────── */

export function computeSettingsLayout(width, height, insets = {}) {
  const safe = normalizeInsets(insets);
  const pad = Math.round(width * 0.08);
  const panelW = Math.min(width - pad * 2, 340);
  const panelH = Math.min(Math.round(panelW * 1.22), height - safe.top - safe.bottom - pad * 2);
  const x = Math.round((width - panelW) / 2);
  const y = Math.round(safe.top + (height - safe.top - safe.bottom - panelH) / 2);

  const sliderH = 8;
  const knobR = 13;
  const sliderW = panelW - pad * 2;
  const sliderX = x + pad;
  const sliderY = y + Math.round(panelH * 0.30);

  // 曲目切换行（◀ 曲名 ▶）
  const trackY = y + Math.round(panelH * 0.60);
  const arrowW = 44;
  const rowH = 44;

  return {
    width, height, safe, pad,
    panel: { x, y, w: panelW, h: panelH },
    slider: { x: sliderX, y: sliderY, w: sliderW, h: sliderH, knobR },
    track: {
      y: trackY,
      prev: { x: sliderX, y: trackY - rowH / 2, w: arrowW, h: rowH },
      next: { x: sliderX + sliderW - arrowW, y: trackY - rowH / 2, w: arrowW, h: rowH },
      name: { x: sliderX + arrowW, y: trackY - rowH / 2, w: sliderW - arrowW * 2, h: rowH },
    },
    close: {
      x: x + panelW - pad - 30,
      y: y + Math.round(panelH * 0.06),
      w: 30, h: 30,
    },
    // 面板内文字位置
    titleY: y + Math.round(panelH * 0.13),
    labelY: y + Math.round(panelH * 0.225),
    valueY: y + Math.round(panelH * 0.425),
    hintY: y + Math.round(panelH * 0.84),
  };
}

/* ─────────────────── 命中测试 ─────────────────── */

export function hitRect(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export function hitButton(layout, x, y) {
  return layout.buttons.findIndex((b) => hitRect(b, x, y));
}

/** 命中卡片/块/行等矩形数组，返回索引（-1 未命中）。 */
export function hitList(list, x, y) {
  return (list ?? []).findIndex((r) => hitRect(r, x, y));
}

export function hitMode(layout, x, y) { return hitList(layout.blocks, x, y); }
export function hitLevel(layout, x, y) { return hitList(layout.rows, x, y); }
export function hitGame(layout, x, y) { return hitList(layout.cards, x, y); }
export function hitBack(layout, x, y) { return hitRect(layout.back, x, y); }
export function hitGear(layout, x, y) { return hitRect(layout.gear, x, y); }

/** 设置面板里命中滑块（返回 0..1 的位置，未命中返回 null）。 */
export function sliderValueAt(layout, x, y) {
  const s = layout.slider;
  const touchPad = 26; // 纵向扩大命中范围，方便手指按住
  if (y < s.y - touchPad || y > s.y + s.h + touchPad) return null;
  if (x < s.x - s.knobR || x > s.x + s.w + s.knobR) return null;
  return Math.max(0, Math.min(1, (x - s.x) / s.w));
}
