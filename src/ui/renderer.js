/**
 * 绘制层：只负责「把状态画出来」，不持有状态、不碰平台 API。
 * 同一份代码同时供微信小游戏（ctx from wx.createCanvas）与浏览器预览使用。
 */
import { BOARD_SIZE, EMPTY, BLACK, WHITE } from '../core/board.js';
import { RULE_LABELS } from '../core/rules.js';
import { LEVELS } from '../core/ai.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

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

/** easeOutBack：落子弹出用的轻微过冲曲线。 */
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ───────────────────────── 背景 ───────────────────────── */

export function drawBackground(ctx, layout, theme) {
  const g = ctx.createLinearGradient(0, 0, 0, layout.height);
  g.addColorStop(0, theme.bgTop);
  g.addColorStop(1, theme.bgBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // 棋盘后方的柔光，让视线聚焦中央（青白底上用极淡的暖光）
  const b = layout.board;
  const glow = ctx.createRadialGradient(
    b.x + b.size / 2, b.y + b.size / 2, b.size * 0.15,
    b.x + b.size / 2, b.y + b.size / 2, b.size * 0.95,
  );
  glow.addColorStop(0, 'rgba(255,252,240,0.75)');
  glow.addColorStop(1, 'rgba(255,252,240,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, layout.width, layout.height);
}

/* ───────────────────────── 棋盘 ───────────────────────── */

export function drawBoard(ctx, layout, theme) {
  const b = layout.board;
  const r = Math.round(b.size * 0.05);

  // 木框投影
  ctx.save();
  ctx.shadowColor = theme.boardShadow;
  ctx.shadowBlur = Math.round(b.size * 0.05);
  ctx.shadowOffsetY = Math.round(b.size * 0.012);
  pathRoundRect(ctx, b.x, b.y, b.size, b.size, r);
  ctx.fillStyle = theme.boardDark;
  ctx.fill();
  ctx.restore();

  // 木色：垂直柔和渐变（早先用对角三色标，会产生"棋盘分块"的错觉，已替换）
  const wood = ctx.createLinearGradient(0, b.y, 0, b.y + b.size);
  wood.addColorStop(0, theme.boardTop);
  wood.addColorStop(1, theme.boardBottom);
  pathRoundRect(ctx, b.x, b.y, b.size, b.size, r);
  ctx.fillStyle = wood;
  ctx.fill();

  // 木纹：极低对比的横向细纹，密度随棋盘尺寸自适应
  ctx.save();
  pathRoundRect(ctx, b.x, b.y, b.size, b.size, r);
  ctx.clip();
  ctx.globalAlpha = 0.032;
  ctx.strokeStyle = '#6b3f12';
  ctx.lineWidth = 1;
  const step = Math.max(2, Math.round(b.size / 150));
  for (let y = b.y; y < b.y + b.size; y += step * 3) {
    const wobble = Math.sin(y * 0.35) * (b.size * 0.004);
    ctx.beginPath();
    ctx.moveTo(b.x, y + wobble);
    ctx.lineTo(b.x + b.size, y + wobble * 0.4);
    ctx.stroke();
  }
  ctx.restore();

  // 内阴影（木框立体感）
  ctx.save();
  pathRoundRect(ctx, b.x, b.y, b.size, b.size, r);
  ctx.clip();
  const vig = ctx.createRadialGradient(
    b.x + b.size / 2, b.y + b.size / 2, b.size * 0.3,
    b.x + b.size / 2, b.y + b.size / 2, b.size * 0.78,
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(90,52,16,0.22)');
  ctx.fillStyle = vig;
  ctx.fillRect(b.x, b.y, b.size, b.size);
  ctx.restore();

  // 边框：外深 + 内亮，做出木框倒角
  pathRoundRect(ctx, b.x + 0.5, b.y + 0.5, b.size - 1, b.size - 1, r);
  ctx.strokeStyle = theme.boardEdge;
  ctx.lineWidth = Math.max(1.2, b.size * 0.0075);
  ctx.stroke();

  pathRoundRect(ctx, b.x + b.inner * 0.55, b.y + b.inner * 0.55, b.size - b.inner * 1.1, b.size - b.inner * 1.1, r * 0.55);
  ctx.strokeStyle = theme.boardEdgeSoft;
  ctx.lineWidth = Math.max(1, b.size * 0.0028);
  ctx.stroke();

  // 网格线（内部细线）
  ctx.save();
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = Math.max(1, b.size * 0.0035);
  ctx.lineCap = 'round';
  const p0 = b.toScreen(0, 0);
  const pN = b.toScreen(BOARD_SIZE - 1, BOARD_SIZE - 1);
  for (let i = 0; i < BOARD_SIZE; i++) {
    const v = b.toScreen(i, 0);
    const h = b.toScreen(0, i);
    ctx.beginPath(); ctx.moveTo(v.x, p0.y); ctx.lineTo(v.x, pN.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p0.x, h.y); ctx.lineTo(pN.x, h.y); ctx.stroke();
  }
  // 最外圈加重，棋盘边缘更挺
  ctx.strokeStyle = theme.gridLineStrong;
  ctx.lineWidth = Math.max(1.4, b.size * 0.005);
  ctx.strokeRect(p0.x, p0.y, pN.x - p0.x, pN.y - p0.y);
  ctx.restore();

  // 星位（天元 + 四角星）
  const stars = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
  ctx.fillStyle = theme.starPoint;
  for (const [gx, gy] of stars) {
    const p = b.toScreen(gx, gy);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(2, b.cell * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ───────────────────────── 棋子 ───────────────────────── */

/** 画一颗棋子（带立体感的高光与投影）。 */
function drawStone(ctx, cx, cy, r, color, theme) {
  ctx.save();
  // 投影
  ctx.beginPath();
  ctx.arc(cx + r * 0.10, cy + r * 0.14, r, 0, Math.PI * 2);
  ctx.fillStyle = theme.stoneShadow;
  ctx.fill();

  // 球体渐变
  const g = ctx.createRadialGradient(
    cx - r * 0.34, cy - r * 0.38, r * 0.06,
    cx, cy, r * 1.06,
  );
  if (color === BLACK) {
    g.addColorStop(0, theme.stoneBlackHi);
    g.addColorStop(0.45, theme.stoneBlackMid);
    g.addColorStop(1, theme.stoneBlackLo);
  } else {
    g.addColorStop(0, theme.stoneWhiteHi);
    g.addColorStop(0.55, theme.stoneWhiteMid);
    g.addColorStop(1, theme.stoneWhiteLo);
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  // 高光小点
  ctx.beginPath();
  ctx.arc(cx - r * 0.34, cy - r * 0.38, r * 0.20, 0, Math.PI * 2);
  ctx.fillStyle = color === BLACK ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.95)';
  ctx.fill();

  // 轮廓
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = color === BLACK ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.18)';
  ctx.lineWidth = Math.max(1, r * 0.06);
  ctx.stroke();
  ctx.restore();
}

export function drawStones(ctx, layout, state, theme, now) {
  const b = layout.board;
  const anim = state.anim ?? {};

  for (let gy = 0; gy < BOARD_SIZE; gy++) {
    for (let gx = 0; gx < BOARD_SIZE; gx++) {
      const v = state.board.grid[gy][gx];
      if (v === EMPTY) continue;
      const p = b.toScreen(gx, gy);

      // 落子弹出动画（只对最近落下的子生效）
      let scale = 1;
      const t0 = anim.stones && anim.stones.get(`${gx},${gy}`);
      if (t0 !== undefined) {
        const t = clamp01((now - t0) / theme.placeAnimMs);
        scale = t >= 1 ? 1 : Math.max(0.05, easeOutBack(t));
      }
      drawStone(ctx, p.x, p.y, b.stoneR * scale, v, theme);
    }
  }
}

/* ───────────────────────── 最后一手 / 胜利 ───────────────────────── */

export function drawLastMarker(ctx, layout, state, theme, now) {
  const last = state.board.moves[state.board.moves.length - 1];
  if (!last || state.board.winner !== EMPTY) return;
  const p = layout.board.toScreen(last.x, last.y);
  const r = layout.board.stoneR;

  // 呼吸光环
  const pulse = 0.5 + 0.5 * Math.sin((now ?? 0) / 420);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * (1.12 + pulse * 0.10), 0, Math.PI * 2);
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.55 + pulse * 0.35;
  ctx.lineWidth = Math.max(1.2, r * 0.14);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 中心小点（与棋子反色）
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = last.player === BLACK ? theme.accent : '#8a5a10';
  ctx.fill();
}

export function drawWin(ctx, layout, state, theme, now) {
  const line = state.board.winLine;
  if (!line || state.board.winner === EMPTY || state.board.winner === -1) return;
  const b = layout.board;
  const pulse = 0.5 + 0.5 * Math.sin((now ?? 0) / 300);

  // 连线
  const a = b.toScreen(line[0][0], line[0][1]);
  const z = b.toScreen(line[line.length - 1][0], line[line.length - 1][1]);
  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.45 + pulse * 0.35;
  ctx.lineWidth = Math.max(2, b.stoneR * 0.5);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(z.x, z.y);
  ctx.stroke();
  ctx.restore();

  // 五子高亮环
  for (const [gx, gy] of line) {
    const p = b.toScreen(gx, gy);
    ctx.beginPath();
    ctx.arc(p.x, p.y, b.stoneR * (1.18 + pulse * 0.12), 0, Math.PI * 2);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = Math.max(2, b.stoneR * 0.22);
    ctx.stroke();
  }
}

/* ───────────────────────── HUD ───────────────────────── */

/** 小棋子图标（HUD 里表示当前执子）。黑子加亮描边，否则在深色底上看不见。 */
function drawMiniStone(ctx, cx, cy, r, color, theme) {
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  if (color === BLACK) {
    g.addColorStop(0, theme.stoneBlackHi); g.addColorStop(1, theme.stoneBlackLo);
  } else {
    g.addColorStop(0, theme.stoneWhiteHi); g.addColorStop(0.6, theme.stoneWhiteMid); g.addColorStop(1, theme.stoneWhiteLo);
  }
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = color === BLACK ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = Math.max(1, r * 0.24);
  ctx.stroke();
}

/** 悬停/按下时的半透明预告棋子（浏览器有鼠标，小游戏无此交互）。 */
export function drawHoverGhost(ctx, layout, state, theme) {
  const hv = state.hover;
  if (!hv || state.board.winner !== EMPTY) return;
  if (!hv.valid) return;
  const p = layout.board.toScreen(hv.x, hv.y);
  const r = layout.board.stoneR;
  ctx.save();
  ctx.globalAlpha = 0.42;
  drawStone(ctx, p.x, p.y, r * 0.94, state.board.current, theme);
  ctx.restore();
  // 十字准心，指明落点
  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 1.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawHud(ctx, layout, state, theme, now) {
  const hud = layout.hud;
  const cx = layout.width / 2;

  // 标题
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.textPrimary;
  ctx.font = `700 ${theme.fontTitle}px ${FONT}`;
  ctx.fillText('五子棋', cx, hud.y + hud.h * 0.30);

  // 副标题：当前状态
  const board = state.board;
  let sub = '';
  if (board.winner === BLACK || board.winner === WHITE) {
    sub = `${board.winner === BLACK ? '黑棋' : '白棋'}获胜`;
  } else if (board.winner === -1) {
    sub = '和棋';
  } else if (state.aiThinking) {
    sub = 'AI 思考中';
  } else if (state.mode === 'pve') {
    sub = board.current === state.humanColor ? '轮到你落子' : 'AI 回合';
  } else {
    sub = board.current === BLACK ? '黑棋回合' : '白棋回合';
  }

  ctx.font = `500 ${theme.fontHud}px ${FONT}`;
  ctx.fillStyle = state.aiThinking ? theme.accent : theme.textMuted;

  // 执子小图标 + 文案（整体居中）
  const showStone = !state.aiThinking && board.winner === EMPTY;
  const textW = ctx.measureText(sub).width;
  const iconR = theme.fontHud * 0.42;
  const gap = showStone ? iconR * 2.4 : 0;
  const totalW = textW + gap;
  const startX = cx - totalW / 2;
  if (showStone) {
    drawMiniStone(ctx, startX + iconR, hud.y + hud.h * 0.60, iconR, board.current, theme);
    // ⚠️ drawMiniStone 内部会把 fillStyle 改成棋子的径向渐变，
    // 所以画完棋子必须**重设文字颜色**，否则这一行文案会用棋子渐变末端色绘制
    //（白子档 #b9b9c6 在青白底上几乎看不见）。围棋模块也踩过同一个坑。
    ctx.fillStyle = state.aiThinking ? theme.accent : theme.textMuted;
  }
  ctx.textAlign = 'left';
  ctx.fillText(sub, startX + gap, hud.y + hud.h * 0.60);

  // AI 思考的三个跳动点
  if (state.aiThinking) {
    const baseX = startX + textW + 12;
    for (let i = 0; i < 3; i++) {
      const phase = ((now ?? 0) / 260 + i * 0.6) % (Math.PI * 2);
      const dy = Math.sin(phase) * 3;
      ctx.beginPath();
      ctx.arc(baseX + i * 8, hud.y + hud.h * 0.60 + dy, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = theme.accent;
      ctx.fill();
    }
  }

  // 步数（右上角）
  ctx.textAlign = 'right';
  ctx.font = `500 ${theme.fontSmall}px ${FONT}`;
  ctx.fillStyle = theme.textMuted;
  ctx.fillText(`${board.moves.length} 手`, layout.width - hud.x, hud.y + hud.h * 0.30);

  // 战绩（右下角，PVE 时显示）
  if (state.mode === 'pve' && state.score) {
    ctx.fillText(`你 ${state.score.win} : ${state.score.lose} AI`, layout.width - hud.x, hud.y + hud.h * 0.62);
  }
  ctx.textAlign = 'left';

  // 规则 · 难度（居中第三行，弱化显示）
  // ⚠️ 必须用主题令牌：早先这里写死 rgba(242,243,247,0.40)（深色主题的浅字），
  // 换成青白底后直接看不见了。
  const ruleName = RULE_LABELS[state.mode]?.name ?? '';
  const levelName = LEVELS[state.level]?.name ?? '';
  if (ruleName || levelName) {
    ctx.textAlign = 'center';
    ctx.font = `500 ${theme.fontSmall}px ${FONT}`;
    ctx.fillStyle = theme.textMuted;
    ctx.fillText(`${ruleName} · ${levelName}`, layout.width / 2, hud.y + hud.h * 0.88);
    ctx.textAlign = 'left';
  }
}

/** 左上角返回主界面按钮（浅色底：白圆 + 木色箭头）。 */
export function drawBackButton(ctx, layout, state, theme) {
  const b = layout.back;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(90,70,30,0.18)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, b.w / 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, b.w / 2, 0, Math.PI * 2);
  ctx.strokeStyle = theme.btnBorder ?? 'rgba(170,135,80,0.45)';
  ctx.lineWidth = 1.3;
  ctx.stroke();

  // 左箭头（木色）
  ctx.beginPath();
  ctx.moveTo(cx + b.w * 0.10, cy - b.w * 0.17);
  ctx.lineTo(cx - b.w * 0.13, cy);
  ctx.lineTo(cx + b.w * 0.10, cy + b.w * 0.17);
  ctx.strokeStyle = theme.woodDeep ?? '#8a5f22';
  ctx.lineWidth = Math.max(1.6, b.w * 0.075);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** 右上角设置齿轮（浅色底：白圆 + 木色齿）。 */
export function drawGearButton(ctx, layout, state, theme) {
  const b = layout.gear;
  if (!b) return;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const R = b.w * 0.28;
  ctx.save();
  ctx.shadowColor = 'rgba(90,70,30,0.18)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, b.w / 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, b.w / 2, 0, Math.PI * 2);
  ctx.strokeStyle = theme.btnBorder ?? 'rgba(170,135,80,0.45)';
  ctx.lineWidth = 1.3;
  ctx.stroke();

  // ⚠️ translate 必须包在 save/restore 里：早先这里漏了 save，
  // 而函数末尾有一次 restore，导致变换栈不平衡、平移逐帧累积（实测涨到千万像素）。
  ctx.save();
  ctx.translate(cx, cy);
  const gearColor = theme.woodDeep ?? '#8a5f22';
  ctx.fillStyle = gearColor;
  for (let i = 0; i < 8; i++) {
    ctx.save();
    ctx.rotate((Math.PI / 4) * i);
    ctx.fillRect(-R * 0.17, -R * 1.32, R * 0.34, R * 0.5);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.40, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
  ctx.restore();
}

/** 浮动提示（禁手 / 非法落子）。 */
export function drawToast(ctx, layout, state, theme, now) {
  const t = state.toast;
  if (!t) return;
  const age = (now ?? 0) - t.t0;
  if (age > t.ms) { state.toast = null; return; }
  const fade = age < 160 ? age / 160 : age > t.ms - 320 ? Math.max(0, (t.ms - age) / 320) : 1;

  const text = t.text;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.font = `600 ${theme.fontHud}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const padX = 18, h = 38;
  const w = Math.min(layout.width - layout.pad * 3, tw + padX * 2);
  const x = (layout.width - w) / 2;
  const y = layout.buttons[0].y - h - 12;

  pathRoundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(20,14,8,0.88)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(240,180,41,0.55)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.accent;
  ctx.fillText(text, layout.width / 2, y + h / 2 + 0.5);
  ctx.textAlign = 'left';
  ctx.restore();
}

/* ───────────────────────── 按钮 ───────────────────────── */

/**
 * 底部按钮。labels 与 layout.buttons 一一对应。
 * 统一走 drawWoodButton，保证全站按键木质感一致。
 */
export function drawButtons(ctx, layout, state, theme, labels, disabled = []) {
  layout.buttons.forEach((btn, i) => {
    drawWoodButton(ctx, btn, labels[i], {
      pressed: state.pressIndex === i,
      primary: i === 0,
      disabled: disabled[i] === true,
      fontSize: theme.fontBtn ?? 15,
    });
  });
}

/* ───────────────────────── 结算浮层 ───────────────────────── */

export function drawOverlay(ctx, layout, state, theme, now) {
  const board = state.board;
  const over = board.winner !== EMPTY;
  if (!over) return;

  const fade = clamp01(((now ?? 0) - (state.anim?.overT0 ?? now)) / 260);
  ctx.save();
  ctx.globalAlpha = fade * 0.5;   // 遮罩减淡，让胜负连线仍然看得见
  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.restore();

  const b = layout.board;
  const cx = layout.width / 2;
  // 卡片放在棋盘偏下位置，避免盖住中上部的棋形与连线
  const cy = b.y + b.size * 0.70;
  const cardW = Math.min(b.size * 0.84, layout.width - layout.pad * 4);
  const cardH = Math.round(cardW * 0.40);

  ctx.save();
  ctx.globalAlpha = fade;
  // 卡片
  pathRoundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, Math.round(cardH * 0.16));
  ctx.fillStyle = 'rgba(28,32,44,0.96)';
  ctx.fill();
  ctx.strokeStyle = theme.panelBorder;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 结果大标题
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const winner = board.winner;
  let title = '和棋';
  let color = theme.textPrimary;
  if (winner === BLACK || winner === WHITE) {
    if (state.mode === 'pve') {
      const humanWon = winner === state.humanColor;
      title = humanWon ? '你赢了' : 'AI 获胜';
      color = humanWon ? theme.success : theme.danger;
    } else {
      title = winner === BLACK ? '黑棋获胜' : '白棋获胜';
      color = theme.accent;
    }
  }
  ctx.font = `800 ${theme.fontBig}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.fillText(title, cx, cy - cardH * 0.22);

  // 补充信息
  ctx.font = `500 ${theme.fontHud}px ${FONT}`;
  ctx.fillStyle = theme.textMuted;
  ctx.fillText(`共 ${board.moves.length} 手`, cx, cy + cardH * 0.02);

  // 提示：点按钮继续
  const pulse = 0.6 + 0.4 * Math.sin((now ?? 0) / 420);
  ctx.globalAlpha = fade * pulse;
  ctx.font = `500 ${theme.fontSmall}px ${FONT}`;
  ctx.fillStyle = theme.accent;
  ctx.fillText('点下方按钮开新局', cx, cy + cardH * 0.26);
  ctx.restore();
  ctx.textAlign = 'left';
}

/* ───────────────────────── 统一木质按钮（供各游戏复用） ───────────────────────── */

/**
 * 木质胶囊按钮。各游戏画自己的操作按钮时调它，保证全站按键风格统一。
 * @param rect {x,y,w,h}
 * @param label 按钮文字
 * @param opts { pressed, primary, disabled, fontSize }
 */
export function drawWoodButton(ctx, rect, label, opts = {}) {
  const { pressed = false, primary = false, disabled = false, fontSize = 15 } = opts;
  const r = Math.round(rect.h / 2);

  ctx.save();
  if (!disabled) {
    ctx.shadowColor = 'rgba(120,90,30,0.30)';
    ctx.shadowBlur = pressed ? 3 : 8;
    ctx.shadowOffsetY = pressed ? 1 : 3;
  }
  pathRoundRect(ctx, rect.x, rect.y, rect.w, rect.h, r);
  if (disabled) {
    ctx.fillStyle = 'rgba(185,180,165,0.55)';
    ctx.fill();
  } else {
    const g = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
    if (primary) {
      g.addColorStop(0, pressed ? '#dfae63' : '#eec98f');
      g.addColorStop(1, pressed ? '#c08f42' : '#d9a95f');
    } else {
      g.addColorStop(0, pressed ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.94)');
      g.addColorStop(1, pressed ? 'rgba(240,232,215,0.82)' : 'rgba(248,242,230,0.96)');
    }
    // ⚠️ 必须把渐变赋给 fillStyle：漏掉这行会让按钮用上一个绘制的残留颜色
    //（实测表现为"再来一局"发青、"回到主界面"发褐）
    ctx.fillStyle = g;
    ctx.fill();
  }
  ctx.restore();

  pathRoundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, r);
  ctx.strokeStyle = disabled ? 'rgba(140,135,120,0.4)' : (primary ? 'rgba(150,105,40,0.55)' : 'rgba(170,135,80,0.45)');
  ctx.lineWidth = 1.3;
  ctx.stroke();

  if (!disabled) {
    ctx.save();
    pathRoundRect(ctx, rect.x, rect.y, rect.w, rect.h, r);
    ctx.clip();
    const hi = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h * 0.5);
    hi.addColorStop(0, 'rgba(255,255,255,0.55)');
    hi.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hi;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h * 0.5);
    ctx.restore();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${fontSize}px ${FONT}`;
  ctx.fillStyle = disabled ? 'rgba(90,90,85,0.5)' : (primary ? '#4a2f08' : '#4d4436');
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5);
  ctx.textAlign = 'left';
}

/* ───────────────────────── 统一结算弹窗（集成层画，各游戏不画） ───────────────────────── */

/** 结算弹窗布局：卡片 + 「再来一局」「回到主界面」+ 右上角关闭。 */
export function computeResultLayout(width, height, insets = {}) {
  const safeTop = insets.top ?? 0;
  const safeBottom = insets.bottom ?? 0;
  const cardW = Math.min(width - 48, 340);
  const cardH = Math.round(cardW * 0.74);
  const x = Math.round((width - cardW) / 2);
  const y = Math.round(safeTop + (height - safeTop - safeBottom - cardH) / 2);

  const btnH = Math.max(42, Math.round(cardW * 0.135));
  const btnW = cardW - Math.round(cardW * 0.22);
  const btnX = x + Math.round(cardW * 0.11);
  const gap = Math.round(cardH * 0.05);

  return {
    card: { x, y, w: cardW, h: cardH },
    again: { x: btnX, y: y + Math.round(cardH * 0.52), w: btnW, h: btnH },
    home: { x: btnX, y: y + Math.round(cardH * 0.52) + btnH + gap, w: btnW, h: btnH },
    close: {
      x: x + cardW - Math.round(cardW * 0.14),
      y: y + Math.round(cardW * 0.05),
      w: Math.round(cardW * 0.1),
      h: Math.round(cardW * 0.1),
    },
  };
}

/**
 * 统一结算弹窗。各游戏只需返回 outcome，弹窗由这里画。
 * @param info { title, subtitle, color }
 * @param rects computeResultLayout 的结果
 * @param state 读 state.resultPress 做按压反馈、state.anim.overT0 做淡入
 */
export function drawResultDialog(ctx, layout, info, rects, state, theme, now) {
  const t0 = state.anim?.overT0 || (now ?? 0);
  const fade = Math.max(0, Math.min(1, ((now ?? 0) - t0) / 240));

  ctx.save();
  ctx.globalAlpha = fade * 0.42;
  ctx.fillStyle = '#0b1210';
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.restore();

  const card = rects.card;
  const r = Math.round(card.w * 0.07);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.shadowColor = 'rgba(70,50,15,0.35)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  pathRoundRect(ctx, card.x, card.y, card.w, card.h, r);
  ctx.fillStyle = '#fdfbf6';
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = fade;
  pathRoundRect(ctx, card.x + 0.5, card.y + 0.5, card.w - 1, card.h - 1, r);
  ctx.strokeStyle = 'rgba(160,120,60,0.45)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${Math.round(card.w * 0.115)}px ${FONT}`;
  ctx.fillStyle = info.color ?? '#2f4f4a';
  ctx.fillText(info.title, card.x + card.w / 2, card.y + card.h * 0.21);

  if (info.subtitle) {
    ctx.font = `500 ${Math.round(card.w * 0.052)}px ${FONT}`;
    ctx.fillStyle = 'rgba(61,91,86,0.72)';
    ctx.fillText(info.subtitle, card.x + card.w / 2, card.y + card.h * 0.38);
  }

  drawWoodButton(ctx, rects.again, '再来一局', {
    primary: true,
    pressed: state.resultPress === 'again',
    fontSize: Math.round(card.w * 0.058),
  });
  drawWoodButton(ctx, rects.home, '回到主界面', {
    pressed: state.resultPress === 'home',
    fontSize: Math.round(card.w * 0.058),
  });

  const c = rects.close;
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, c.w / 2, 0, Math.PI * 2);
  ctx.fillStyle = state.resultPress === 'close' ? 'rgba(120,140,135,0.32)' : 'rgba(120,140,135,0.16)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(74,47,8,0.5)';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  const d = c.w * 0.21;
  ctx.beginPath();
  ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
  ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
  ctx.stroke();
  ctx.restore();
  ctx.textAlign = 'left';
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一次完整绘制。
 * @param ctx Canvas 2D 上下文
 * @param layout computeLayout 的结果
 * @param state 游戏状态（见 app.js）
 * @param theme THEME
 * @param now 当前时间（ms，用于动画）
 */
export function renderFrame(ctx, layout, state, theme, now) {
  // 防御：任何一处 save/restore 不平衡都会让变换逐帧累积，所以每帧开始时恢复"基线变换"。
  // ⚠️ 基线**必须是 dpr 缩放**，不能是单位矩阵！
  // 真机上 canvas 物理尺寸 = 逻辑尺寸 × dpr（如 375×3=1125），若重置为 1,0,0,1,0,0，
  // 绘制坐标会被当成物理像素 → 内容只占左上角 1/dpr（实测真机对弈界面缩成小屏，预览页 dpr=1 所以没暴露）。
  ctx.save();
  const dpr = (ctx.canvas && ctx.canvas.__dpr) || 1;
  if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, layout.width, layout.height);
  drawBackground(ctx, layout, theme);
  drawBoard(ctx, layout, theme);
  drawHoverGhost(ctx, layout, state, theme);
  drawStones(ctx, layout, state, theme, now);
  drawLastMarker(ctx, layout, state, theme, now);
  drawWin(ctx, layout, state, theme, now);
  drawHud(ctx, layout, state, theme, now);
  drawBackButton(ctx, layout, state, theme);
  drawGearButton(ctx, layout, state, theme);
  drawButtons(
    ctx, layout, state, theme,
    state.buttonLabels ?? ['重新开始', '悔棋', '认输'],
    [false, state.board.moves.length === 0 || state.aiThinking, false],
  );
  drawOverlay(ctx, layout, state, theme, now);
  drawToast(ctx, layout, state, theme, now);
  ctx.restore();   // 对应函数开头的 save（变换/透明度防御）
}
