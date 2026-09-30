/**
 * 数独绘制层：只接收 ctx + layout + view，不持有状态、不碰平台 API。
 *
 * 视觉（新 UI 约定，浅底深字）：
 *   - 木质感盘面：木色底板 + 粗线分隔 3×3 宫（木刻风）
 *   - 给定数字 = 深木墨色；玩家填入 = 木色强调（浅橙棕）；错填 = 危险色
 *   - 选中格高亮 + 同行/同列/同宫淡高亮
 *   - 候选小数字（3×3 迷你格）
 *   - 数字键盘 1–9 + 擦除（不显示数量计数；填完的数字键变淡提示）
 *   - 底部「重新开始 / 提示 / 标记模式」三颗胶囊按钮
 *
 * ⚠️ 新 UI 约定（重要）：
 *   1) **不画全屏背景**——青白渐变底由集成层铺，本文件一圈都不铺；
 *   2) **不画自己的结算弹窗**——集成层统一画，本模块只在 index.js 里给 outcome；
 *   3) **不画左上返回键与右上齿轮**——集成层负责；
 *   4) 底部按钮与数字键盘都留出 insets.bottom + 16 的余量；
 *   5) 文字颜色从传入的 theme 取（拿不到才用本文件的浅底兜底色）。
 */
import { SIZE, BOX, EMPTY, PLAYING, WON, formatTime } from './core.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/** 数字 1–9 的固定配色（玩家填入的主色，木色系；宫内无重复语义靠格位区分）。 */
const DIGIT_COLORS = [
  '',            // 0 不画
  '#8a5a1e',     // 1
  '#1f6f5c',     // 2
  '#2f5aa8',     // 3
  '#8a4a12',     // 4
  '#a8422f',     // 5
  '#0f6f74',     // 6
  '#4a3a8a',     // 7
  '#6b4a20',     // 8
  '#a8407a',     // 9
];

/**
 * 浅底兜底色（新 UI 是青白底深字）。
 * 说明：集成层当前传入的是深色调的 THEME，直接拿它会「深字压青白底」看不清；
 * 因此本文件只把 theme 当**可选覆盖**：theme 里没有的令牌就用这套浅底色。
 * 若集成层将来传入浅色主题，theme 的令牌会自动优先。
 */
const LIGHT = {
  ink: '#3d2a10',            // 深墨（给定数字）
  inkSoft: 'rgba(82,52,18,0.62)',
  boardLine: 'rgba(122,86,38,0.34)',      // 细线
  boardLineStrong: 'rgba(74,46,12,0.80)', // 3×3 粗线
  boardEdge: '#a8783a',
  boardEdgeSoft: 'rgba(255,246,222,0.70)',
  cellEmpty: 'rgba(255,248,232,0.72)',    // 空格：暖白
  cellGiven: 'rgba(238,222,186,0.78)',    // 给定格：略深的木黄，一眼可辨
  selBg: 'rgba(240,150,60,0.34)',         // 选中格
  peerBg: 'rgba(126,170,170,0.20)',       // 同行/列/宫淡高亮
  hoverBg: 'rgba(240,180,41,0.14)',       // 悬停（鼠标环境）
  noteText: 'rgba(96,64,22,0.86)',        // 候选小数字
  btnBg: 'rgba(255,255,255,0.80)',
  btnBgPressed: 'rgba(255,255,255,0.96)',
  btnBorder: 'rgba(150,110,50,0.34)',
  btnText: '#3d5b56',
  btnPrimaryBg: 'rgba(240,180,41,0.22)',
  btnPrimaryBorder: 'rgba(184,132,40,0.62)',
  btnPrimaryText: '#6b4a10',
  keyBg: 'rgba(255,255,255,0.80)',
  keyPressed: 'rgba(255,255,255,0.98)',
  keyBorder: 'rgba(150,110,50,0.28)',
  keyText: '#4a2f08',
  keyTextDim: 'rgba(74,47,8,0.42)',
  boardShadow: 'rgba(90,70,30,0.26)',
  danger: '#c0392b',
  accent: '#d2762a',
  success: '#1f8a5b',
};

/** theme 令牌优先，缺失回落到浅底色。 */
function C(theme, key) {
  const v = theme ? theme[key] : undefined;
  return v === undefined || v === null || v === '' ? LIGHT[key] : v;
}

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

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 文本对齐设置。 */
function setText(ctx, align, baseline) {
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
}

/* ───────────────────────── 布局 ───────────────────────── */

/**
 * 计算一屏几何信息（纯函数，Node 里可直接单测）。
 *
 * 纵向分段（自上而下）：
 *   留白 → 盘面（正方形，居中于「顶部留白 ~ 键盘上沿」之间） → 数字键盘（5 列 × 2 行） → 底部三颗按钮
 *
 * 底部硬约束（规范 §5）：
 *   键盘底边与按钮底边都不得超过 height − insets.bottom − 16。
 *   矮屏 / 横屏时盘面会先缩小（有下限），保证键盘和按钮永远不进安全区。
 *
 * @param mode 标记模式时键盘下方的提示条高度（默认 0，不占位）
 */
export function computeLayout(width, height, insets = {}, mode = 0) {
  const safeTop = Math.max(0, Math.round(insets?.top ?? 0));
  const safeBottom = Math.max(0, Math.round(insets?.bottom ?? 0));
  const pad = Math.max(10, Math.round(Math.min(width, height) * 0.045));

  // 顶部：集成层在左上/右上画了返回与齿轮，盘面从它们下面开始
  const topPad = safeTop + Math.max(34, Math.round(pad * 2.2));

  // 底部安全线（规范硬约束：insets.bottom + 16）
  const bottomLimit = height - safeBottom - 16;

  // 底部三颗胶囊按钮
  const btnH = Math.max(40, Math.min(52, Math.round(height * 0.062)));
  const btnY = Math.round(bottomLimit - btnH);
  const btnGap = Math.max(6, Math.round(pad * 0.5));
  const totalW = width - pad * 2;
  const btnW = Math.max(40, Math.floor((totalW - btnGap * 2) / 3));
  const buttons = [
    { x: pad, y: btnY, w: btnW, h: btnH, key: 'restart' },
    { x: pad + btnW + btnGap, y: btnY, w: btnW, h: btnH, key: 'hint' },
    { x: pad + btnW * 2 + btnGap * 2, y: btnY, w: btnW, h: btnH, key: 'mark' },
  ];

  // 数字键盘：10 个键排 5×2
  const keyGap = Math.max(5, Math.round(pad * 0.45));
  const keyH = Math.max(32, Math.min(58, Math.round(height * 0.068)));
  const byW = Math.max(28, Math.floor((width - pad * 2 - keyGap * 4) / 5));
  const keyW = Math.min(byW, Math.round(keyH * 1.25));
  const kbW = keyW * 5 + keyGap * 4;
  const kbH = keyH * 2 + keyGap;
  const noteH = mode ? Math.max(13, Math.round(keyH * 0.30)) : 0;
  const gapToBoard = Math.max(8, Math.round(pad * 0.5));

  // 键盘底边 = 按钮上方留白；同时不得越过安全线（矮屏保护）
  const kbBottomWanted = btnY - gapToBoard;
  const kbBottom = Math.min(kbBottomWanted, bottomLimit);
  const kbY = Math.round(kbBottom - noteH - kbH);
  const kbX = Math.round((width - kbW) / 2);

  // 盘面：正方形，塞进「顶部留白 ~ 键盘上沿」之间的空间
  const boardMax = Math.max(96, kbY - gapToBoard - topPad);
  const availW = width - pad * 2;
  const boardSize = Math.max(96, Math.floor(Math.min(availW, boardMax)));
  const boardX = Math.round((width - boardSize) / 2);
  const boardY = Math.round(topPad + Math.max(0, (boardMax - boardSize) / 2));

  const keys = [];
  for (let i = 0; i < 10; i++) {
    const r = Math.floor(i / 5);
    const c = i % 5;
    keys.push({
      x: kbX + c * (keyW + keyGap),
      y: kbY + r * (keyH + keyGap),
      w: keyW,
      h: keyH,
      key: i < 9 ? String(i + 1) : 'erase',
    });
  }

  return {
    width,
    height,
    safe: { top: safeTop, bottom: safeBottom },
    pad,
    topPad,
    hud: { x: pad, y: safeTop + 4, w: width - pad * 2, h: Math.max(28, Math.round(pad * 1.8)) },
    board: { x: boardX, y: boardY, size: boardSize, cell: boardSize / SIZE },
    keyboard: { x: kbX, y: kbY, w: kbW, h: kbH, keyW, keyH, gap: keyGap, keys, noteH, noteY: kbY + kbH + 4 },
    buttons,
    noteBar: { x: pad, y: kbY + kbH + 4, w: width - pad * 2, h: noteH },
    // 自检用：底部按钮与键盘底边必须 ≤ 这条线
    bottomLimit,
  };
}

/** 逻辑坐标 → 格子下标；不在盘面内返回 null。 */
export function gridAt(layout, x, y) {
  const b = layout.board;
  if (x < b.x || y < b.y || x >= b.x + b.size || y >= b.y + b.size) return null;
  const c = clamp(Math.floor((x - b.x) / b.cell), 0, SIZE - 1);
  const r = clamp(Math.floor((y - b.y) / b.cell), 0, SIZE - 1);
  return { r, c };
}

/** 命中数字键盘键，返回 '1'..'9' / 'erase' / null。 */
export function hitKey(layout, x, y) {
  for (const k of layout.keyboard.keys) {
    if (x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h) return k.key;
  }
  return null;
}

/** 命中底部按钮，返回 'restart' / 'hint' / 'mark' / null。 */
export function hitButton(layout, x, y) {
  for (const b of layout.buttons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.key;
  }
  return null;
}

/** 取按钮矩形（测试与绘制都用它，避免两处各算一遍）。 */
export function buttonOf(layout, key) {
  return layout.buttons.find((b) => b.key === key) ?? null;
}

/** 取键盘键矩形。 */
export function keyOf(layout, key) {
  return layout.keyboard.keys.find((k) => k.key === key) ?? null;
}

/* ───────────────────────── 盘面 ───────────────────────── */

/** 盘面底板：木色圆角板 + 投影 + 外缘亮边。 */
function drawBoardBase(ctx, layout, theme) {
  const b = layout.board;
  const r = Math.max(6, Math.round(b.size * 0.035));
  const inset = Math.max(3, Math.round(b.cell * 0.22));

  ctx.save();
  ctx.shadowColor = C(theme, 'boardShadow');
  ctx.shadowBlur = Math.round(b.size * 0.05);
  ctx.shadowOffsetY = Math.round(b.size * 0.012);
  pathRoundRect(ctx, b.x - inset, b.y - inset, b.size + inset * 2, b.size + inset * 2, r);
  ctx.fillStyle = C(theme, 'boardEdge');
  ctx.fill();
  ctx.restore();

  // 底板木色：拿 theme 的木色做渐变（缺失才用浅底兜底）
  const top = C(theme, 'boardTop') || '#f3e0bd';
  const bottom = C(theme, 'boardBottom') || '#e2c894';
  const g = ctx.createLinearGradient(0, b.y - inset, 0, b.y + b.size + inset);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  pathRoundRect(ctx, b.x - inset, b.y - inset, b.size + inset * 2, b.size + inset * 2, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = C(theme, 'boardEdgeSoft');
  ctx.lineWidth = Math.max(1, b.size * 0.004);
  ctx.stroke();
}

/** 一格底色：空格偏暖白、给定格略深，用来区分「题面」与「我填的」。
 *  刻意不跟 theme 走：浅底深字的新 UI 里，格子底色必须保持浅色，
 *  若跟随深色主题的令牌会让整块盘面变暗、深字看不清。 */
function drawCellFill(ctx, layout, r, c, given, theme) {
  const b = layout.board;
  const x = b.x + c * b.cell;
  const y = b.y + r * b.cell;
  ctx.fillStyle = given ? LIGHT.cellGiven : LIGHT.cellEmpty;
  ctx.fillRect(x, y, b.cell + 0.5, b.cell + 0.5);
}

/** 网格线：8 条细线 + 3 宫边界的粗线（木刻感）。 */
function drawGridLines(ctx, layout, theme) {
  const b = layout.board;
  ctx.save();
  ctx.lineCap = 'butt';

  // 细线
  ctx.strokeStyle = C(theme, 'boardLine');
  ctx.lineWidth = Math.max(1, b.size * 0.0035);
  for (let i = 1; i < SIZE; i++) {
    if (i % BOX === 0) continue;
    const p = Math.round(b.x + i * b.cell) + 0.5;
    const q = Math.round(b.y + i * b.cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, b.y);
    ctx.lineTo(p, b.y + b.size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, q);
    ctx.lineTo(b.x + b.size, q);
    ctx.stroke();
  }

  // 3×3 粗线
  ctx.strokeStyle = C(theme, 'boardLineStrong');
  ctx.lineWidth = Math.max(2, b.size * 0.009);
  for (const i of [BOX, BOX * 2]) {
    const p = Math.round(b.x + i * b.cell) + 0.5;
    const q = Math.round(b.y + i * b.cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, b.y);
    ctx.lineTo(p, b.y + b.size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, q);
    ctx.lineTo(b.x + b.size, q);
    ctx.stroke();
  }

  // 外框
  ctx.strokeStyle = C(theme, 'boardLineStrong');
  ctx.lineWidth = Math.max(2, b.size * 0.010);
  ctx.strokeRect(b.x + 1, b.y + 1, b.size - 2, b.size - 2);
  ctx.restore();
}

/** 选中格 + 同行/列/宫淡高亮。 */
function drawHighlights(ctx, layout, view, theme) {
  const b = layout.board;
  const sel = view.selected;
  if (!sel) return;
  const { r: sr, c: sc } = sel;
  const br = Math.floor(sr / BOX) * BOX;
  const bc = Math.floor(sc / BOX) * BOX;

  ctx.save();
  // 同行 / 同列 / 同宫（不含选中格本身）
  ctx.fillStyle = LIGHT.peerBg;
  for (let i = 0; i < SIZE; i++) {
    if (i !== sc) ctx.fillRect(b.x + i * b.cell, b.y + sr * b.cell, b.cell + 0.5, b.cell + 0.5);
    if (i !== sr) ctx.fillRect(b.x + sc * b.cell, b.y + i * b.cell, b.cell + 0.5, b.cell + 0.5);
  }
  for (let i = 0; i < BOX; i++) {
    for (let j = 0; j < BOX; j++) {
      const rr = br + i, cc = bc + j;
      if (rr === sr || cc === sc) continue;
      ctx.fillRect(b.x + cc * b.cell, b.y + rr * b.cell, b.cell + 0.5, b.cell + 0.5);
    }
  }

  // 选中格
  const x = b.x + sc * b.cell;
  const y = b.y + sr * b.cell;
  ctx.fillStyle = LIGHT.selBg;
  ctx.fillRect(x, y, b.cell + 0.5, b.cell + 0.5);
  ctx.strokeStyle = C(theme, 'accent');
  ctx.lineWidth = Math.max(2, b.cell * 0.075);
  ctx.strokeRect(x + 1, y + 1, b.cell - 2, b.cell - 2);
  ctx.restore();
}

/** 悬停格（鼠标环境）与按下的轻微反馈，画在最上层。 */
function drawHover(ctx, layout, view, theme) {
  const b = layout.board;
  const h = view.hover;
  const pressed = view.pressCell;
  if (h && (!view.selected || view.selected.r !== h.r || view.selected.c !== h.c)) {
    ctx.fillStyle = LIGHT.hoverBg;
    ctx.fillRect(b.x + h.c * b.cell, b.y + h.r * b.cell, b.cell + 0.5, b.cell + 0.5);
  }
  if (pressed) {
    ctx.strokeStyle = C(theme, 'accent');
    ctx.lineWidth = Math.max(1.5, b.cell * 0.05);
    ctx.strokeRect(
      b.x + pressed.c * b.cell + 1,
      b.y + pressed.r * b.cell + 1,
      b.cell - 2,
      b.cell - 2,
    );
  }
}

/** 候选小数字：3×3 迷你格（左上 1 右上 3 … 右下 9）。 */
function drawNotes(ctx, x, y, cell, notes) {
  const s = cell * 0.30;
  ctx.font = `600 ${Math.max(7, Math.round(cell * 0.27))}px ${FONT}`;
  setText(ctx, 'center', 'middle');
  for (const d of notes) {
    const i = d - 1;
    const col = i % BOX;
    const row = (i / BOX) | 0;
    ctx.fillText(
      String(d),
      x + (col + 0.5) * (cell / BOX),
      y + (row + 0.5) * (cell / BOX) + s * 0.05,
    );
  }
}

/** 主题里的木墨色 / 强调色，拿不到就用浅底兜底。 */
function inkColor(theme) {
  return C(theme, 'textOnWood') || C(theme, 'ink');
}

/** 盘面总绘：底板 → 格底色 → 高亮 → 网格线 → 数字/候选。 */
export function drawBoard(ctx, layout, view, theme) {
  const b = layout.board;
  drawBoardBase(ctx, layout, theme);

  const grid = view.grid;
  const given = view.given;

  // 1) 格底色
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) drawCellFill(ctx, layout, r, c, given[r][c] !== EMPTY, theme);
  }

  // 2) 选中与关联高亮
  drawHighlights(ctx, layout, view, theme);

  // 3) 网格线
  drawGridLines(ctx, layout, theme);

  // 4) 数字与候选
  setText(ctx, 'center', 'middle');  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = grid[r][c];
      const x = b.x + c * b.cell;
      const y = b.y + r * b.cell;
      if (v === EMPTY) {
        const notes = view.notes?.[r]?.[c];
        if (notes && notes.length) {
          ctx.fillStyle = C(theme, 'noteText');
          drawNotes(ctx, x, y, b.cell, notes);
        }
        continue;
      }
      const isGiven = given[r][c] !== EMPTY;
      const bad = !isGiven && view.wrong?.[r]?.[c];
      ctx.font = `800 ${Math.round(b.cell * (isGiven ? 0.60 : 0.58))}px ${FONT}`;
      ctx.fillStyle = bad ? C(theme, 'danger') : (isGiven ? inkColor(theme) : (DIGIT_COLORS[v] || inkColor(theme)));
      ctx.fillText(String(v), x + b.cell / 2, y + b.cell / 2 + b.cell * 0.03);

      // 错填格右下角画一个小三角，别只靠颜色传达（色弱也能看出来）
      if (bad) {
        const s = Math.max(5, b.cell * 0.20);
        ctx.beginPath();
        ctx.moveTo(x + b.cell - 1, y + b.cell - 1);
        ctx.lineTo(x + b.cell - 1 - s, y + b.cell - 1);
        ctx.lineTo(x + b.cell - 1, y + b.cell - 1 - s);
        ctx.closePath();
        ctx.fillStyle = C(theme, 'danger');
        ctx.fill();
      }
    }
  }

  // 5) 悬停 / 按压反馈画在最上层
  drawHover(ctx, layout, view, theme);
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 数字键盘 ───────────────────────── */

/**
 * 数字键盘：1–9 + 擦除，5 列 × 2 行。
 * 不画任何「还差几个」的数量计数；某数字填完后键面数字变淡（纯颜色状态）。
 */
export function drawKeyboard(ctx, layout, view, theme) {
  const kb = layout.keyboard;
  setText(ctx, 'center', 'middle');
  for (const k of kb.keys) {
    const isErase = k.key === 'erase';
    const pressed = view.pressKey === k.key;
    // 该数字是否已填完（9 个全放对）：只用于键面数字变淡，不画数量
    const done = !isErase && (view.remaining?.[Number(k.key)] ?? 0) === 0;

    pathRoundRect(ctx, k.x, k.y, k.w, k.h, Math.max(6, k.h * 0.24));
    ctx.fillStyle = pressed ? C(theme, 'keyPressed') : C(theme, 'keyBg');
    ctx.fill();
    ctx.strokeStyle = C(theme, 'keyBorder');
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (isErase) {
      // 橡皮：一个方块加两道斜线，比文字更像按钮
      const s = k.h * 0.34;
      const cx = k.x + k.w / 2;
      const cy = k.y + k.h / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 4);
      pathRoundRect(ctx, -s / 2, -s / 2, s, s, s * 0.22);
      ctx.fillStyle = C(theme, 'keyText');
      ctx.fill();
      ctx.strokeStyle = C(theme, 'keyBg');
      ctx.lineWidth = Math.max(1.4, s * 0.14);
      ctx.beginPath();
      ctx.moveTo(-s * 0.18, -s * 0.18);
      ctx.lineTo(s * 0.18, s * 0.18);
      ctx.moveTo(s * 0.18, -s * 0.18);
      ctx.lineTo(-s * 0.18, s * 0.18);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.font = `800 ${Math.round(k.h * 0.46)}px ${FONT}`;
      ctx.fillStyle = done ? C(theme, 'keyTextDim') : C(theme, 'keyText');
      ctx.fillText(k.key, k.x + k.w / 2, k.y + k.h / 2 + 0.5);
    }
  }
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 底部按钮 ───────────────────────── */

/** 「重新开始 / 提示 / 标记模式」三颗胶囊按钮。 */
export function drawButtons(ctx, layout, view, theme) {
  setText(ctx, 'center', 'middle');
  for (const btn of layout.buttons) {
    const pressed = view.pressButton === btn.key;
    const active = btn.key === 'mark' && view.markMode;
    const label = btn.key === 'restart' ? '重新开始'
      : btn.key === 'hint' ? '提示'
        : `标记：${view.markMode ? '开' : '关'}`;

    pathRoundRect(ctx, btn.x, btn.y, btn.w, btn.h, btn.h / 2);
    ctx.fillStyle = pressed ? C(theme, 'btnBgPressed') : (active ? C(theme, 'btnPrimaryBg') : C(theme, 'btnBg'));
    ctx.fill();
    ctx.strokeStyle = active ? C(theme, 'btnPrimaryBorder') : C(theme, 'btnBorder');
    ctx.lineWidth = active ? 1.8 : 1.2;
    ctx.stroke();

    ctx.font = `600 ${Math.round(theme?.fontBtn ?? 15)}px ${FONT}`;
    ctx.fillStyle = active ? C(theme, 'btnPrimaryText') : C(theme, 'btnText');
    ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 0.5);
  }
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 状态条（只在本模块的占位区，不铺全屏） ───────────────────────── */

/**
 * 键盘下方的一行状态文字（难度 · 用时 · 错填 · 提示）。
 * 这是本模块自己的信息条，不是集成层的 HUD，位置留白由布局算好。
 */
export function drawStatus(ctx, layout, view, theme) {
  const kb = layout.keyboard;
  const boardBottom = layout.board ? layout.board.y + layout.board.size : 0;
  const btnTop = layout.buttons[0]?.y ?? layout.height;

  // 优先放在「盘面下沿 ~ 键盘上沿」这段较大的空隙里（空间充足、不挤按钮）；
  // 若那里太窄，再退回到「键盘下沿 ~ 按钮上沿」的小空隙。
  // ⚠️ 早先紧贴键盘下沿画（且守卫只判 noteY 不判 noteY+6），会擦边压到按钮上（截图可见）。
  let gapTop = boardBottom;
  let gapBottom = kb.y;
  if (gapBottom - gapTop < 16) {
    gapTop = kb.y + kb.h;
    gapBottom = btnTop;
  }
  const gapH = gapBottom - gapTop;
  if (gapH < 14) return;                      // 实在没地方就不画，绝不压到别的东西上
  const y = gapTop + gapH / 2;

  ctx.font = `600 ${Math.round(theme?.fontSmall ?? 12)}px ${FONT}`;
  setText(ctx, 'center', 'middle');

  const ms = view.elapsed ?? 0;
  const over = view.status === WON;
  const parts = [
    view.difficultyName ?? '',
    formatTime(ms),
    `错 ${view.wrongCount ?? 0}`,
    `提示 ${view.hints ?? 0}`,
  ];
  ctx.fillStyle = over ? C(theme, 'success') : (view.wrongCount > 0 ? C(theme, 'danger') : C(theme, 'inkSoft'));
  ctx.fillText(parts.filter(Boolean).join('  ·  '), layout.width / 2, y);
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一帧完整绘制：盘面 → 数字键盘 → 状态条 → 底部按钮。
 *
 * 不画的东西（新 UI 约定）：全屏青白渐变底、结算弹窗、左上返回键、右上齿轮。
 * 也不调 ctx.clearRect —— 集成层每帧负责铺底清屏，本模块不越界。
 *
 * @param ctx    Canvas 2D 上下文
 * @param layout computeLayout 的结果
 * @param view   渲染视图（index.js 组装）
 * @param theme  主题令牌（可缺省，缺省用浅底兜底色）
 * @param now    当前时间（ms，本层不做计时，留着给将来的动效用）
 */
export function renderFrame(ctx, layout, view, theme, now) {
  drawBoard(ctx, layout, view, theme);
  drawKeyboard(ctx, layout, view, theme);
  drawStatus(ctx, layout, view, theme);
  drawButtons(ctx, layout, view, theme);
}
