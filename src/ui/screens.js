/**
 * 各场景渲染：大厅（游戏列表）/ 模式选择 / 难度选择 / 设置面板
 * 全部为纯绘制函数（接收 ctx + layout + state + 主题），不持有状态。
 *
 * 视觉基调：青白渐变底 + 木质感卡片，与棋盘同一套木色，保持整体统一。
 */
import { pathRoundRect } from './renderer.js';
import { RULE_LABELS, RULE_CASUAL, RULE_PRO } from '../core/rules.js';
import { LEVELS } from '../core/ai.js';
import { GAMES } from '../games/registry.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

// 游戏清单来自注册表（新增游戏只需改 src/games/registry.js）
export { GAMES };

export const MODE_ORDER = [RULE_CASUAL, RULE_PRO];
export const LEVEL_ORDER = [1, 2, 3, 4, 5];

/** 五档难度的一句话说明（五子棋用；其他游戏由各自 meta.difficulties 提供）。 */
export const LEVEL_DESC = {
  1: '只看进攻，容易漏防',
  2: '攻防兼顾，会堵冲四',
  3: '带一步预判，会设陷阱',
  4: '主动制造双威胁',
  5: '近乎不失误',
};

/* ─────────────────── 背景与基础件 ─────────────────── */

function drawPaperBackground(ctx, layout, M) {
  const g = ctx.createLinearGradient(0, 0, 0, layout.height);
  g.addColorStop(0, M.bgTop);
  g.addColorStop(0.45, M.bgMid);
  g.addColorStop(1, M.bgBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, layout.width, layout.height);

  const glow = ctx.createRadialGradient(
    layout.width * 0.5, layout.safe.top + layout.height * 0.06, 10,
    layout.width * 0.5, layout.safe.top + layout.height * 0.06, layout.width * 0.95,
  );
  glow.addColorStop(0, 'rgba(255,255,255,0.85)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, layout.width, layout.height * 0.5);
}

function woodFill(ctx, x, y, w, h, r, M, strong) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, strong ? M.selectedTop : M.woodTop);
  g.addColorStop(1, strong ? M.selectedBottom : M.woodBottom);
  pathRoundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  pathRoundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const hi = ctx.createLinearGradient(0, y, 0, y + h * 0.5);
  hi.addColorStop(0, 'rgba(255,255,255,0.5)');
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hi;
  ctx.fillRect(x, y, w, h * 0.5);
  ctx.restore();
}

function cardFill(ctx, x, y, w, h, r, M, opts = {}) {
  const { pressed = false, dim = false } = opts;
  ctx.save();
  ctx.shadowColor = M.cardShadow;
  ctx.shadowBlur = pressed ? 4 : 10;
  ctx.shadowOffsetY = pressed ? 1 : 3;
  pathRoundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = dim ? 'rgba(255,255,255,0.5)' : M.cardBg;
  ctx.fill();
  ctx.restore();

  pathRoundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = M.cardBorder;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

/** 左上角返回箭头。 */
function drawBackIcon(ctx, rect, M, pressed) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rect.w / 2, 0, Math.PI * 2);
  ctx.fillStyle = pressed ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.62)';
  ctx.fill();
  ctx.strokeStyle = M.cardBorder;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const s = rect.w;
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.11, cy - s * 0.16);
  ctx.lineTo(cx - s * 0.12, cy);
  ctx.lineTo(cx + s * 0.11, cy + s * 0.16);
  ctx.strokeStyle = M.woodDeep;
  ctx.lineWidth = Math.max(1.6, s * 0.08);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

/** 右上角设置齿轮。 */
function drawGearIcon(ctx, rect, M, pressed) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const R = rect.w * 0.30;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rect.w / 2, 0, Math.PI * 2);
  ctx.fillStyle = pressed ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.62)';
  ctx.fill();
  ctx.strokeStyle = M.cardBorder;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 齿（8 个矩形）
  ctx.translate(cx, cy);
  ctx.fillStyle = M.woodDeep;
  for (let i = 0; i < 8; i++) {
    ctx.save();
    ctx.rotate((Math.PI / 4) * i);
    ctx.fillRect(-R * 0.16, -R * 1.34, R * 0.32, R * 0.5);
    ctx.restore();
  }
  // 盘 + 中心孔
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = M.woodDeep;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = pressed ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.8)';
  ctx.fill();
  ctx.restore();
}

/** 标题 + 副标题（各界面共用）。 */
function drawTitle(ctx, t, M, main, sub) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cy = t.y + t.h * 0.44;
  ctx.font = `800 ${M.fontTitle}px ${FONT}`;
  ctx.fillStyle = M.textTitle;
  ctx.fillText(main, t.x + t.w / 2, cy);

  const lineW = Math.min(120, t.w * 0.3);
  ctx.beginPath();
  ctx.moveTo(t.x + t.w / 2 - lineW / 2, cy + M.fontTitle * 0.82);
  ctx.lineTo(t.x + t.w / 2 + lineW / 2, cy + M.fontTitle * 0.82);
  ctx.strokeStyle = M.accentLine;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.stroke();

  if (sub) {
    ctx.font = `500 ${M.fontSub}px ${FONT}`;
    ctx.fillStyle = M.textMuted;
    ctx.fillText(sub, t.x + t.w / 2, cy + M.fontTitle * 1.36);
  }
  ctx.textAlign = 'left';
}

/* ─────────────────── ① 大厅：游戏列表 ─────────────────── */

export function renderHall(ctx, layout, state, M) {
  drawPaperBackground(ctx, layout, M);

  drawTitle(ctx, layout.title, M, '棋子纯净腾玩', '棋类小游戏合集 · 无广告 · 随手一局');

  // 游戏卡片
  GAMES.forEach((game, i) => {
    const c = layout.cards[i];
    if (!c) return;
    const pressed = state.press?.kind === 'game' && state.press.index === i;
    const r = Math.round(Math.min(c.w, c.h) * 0.14);
    cardFill(ctx, c.x, c.y, c.w, c.h, r, M, { pressed, dim: !game.ready });

    // 图标圆
    const iconR = Math.round(Math.min(c.w, c.h) * 0.22);
    const icx = c.x + c.w / 2, icy = c.y + c.h * 0.36;
    const g = ctx.createLinearGradient(0, icy - iconR, 0, icy + iconR);
    g.addColorStop(0, game.ready ? M.woodTop : '#dfe6e6');
    g.addColorStop(1, game.ready ? M.woodBottom : '#c8d2d2');
    ctx.beginPath();
    ctx.arc(icx, icy, iconR, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = M.cardBorder;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(iconR * 1.05)}px ${FONT}`;
    ctx.fillStyle = game.ready ? M.textOnWood : 'rgba(61,91,86,0.45)';
    ctx.fillText(game.glyph, icx, icy + 1);

    // 名称与说明
    ctx.font = `700 ${M.fontCard}px ${FONT}`;
    ctx.fillStyle = game.ready ? M.textBody : 'rgba(61,91,86,0.45)';
    ctx.fillText(game.name, c.x + c.w / 2, c.y + c.h * 0.68);

    ctx.font = `500 ${M.fontCardSub}px ${FONT}`;
    ctx.fillStyle = M.textMuted;
    ctx.fillText(game.desc, c.x + c.w / 2, c.y + c.h * 0.84);
    ctx.textAlign = 'left';
  });

  // 齿轮 + 底部说明
  drawGearIcon(ctx, layout.gear, M, state.press?.kind === 'gear');
  ctx.textAlign = 'center';
  ctx.font = `500 ${M.fontCardSub}px ${FONT}`;
  ctx.fillStyle = M.textMuted;
  ctx.fillText('更多棋类陆续加入', layout.hint.x + layout.hint.w / 2, layout.hint.y + layout.hint.h / 2);
  ctx.textAlign = 'left';
}

/* ─────────────────── ② 模式：上下两大块 ─────────────────── */

export function renderMode(ctx, layout, state, M) {
  drawPaperBackground(ctx, layout, M);
  drawTitle(ctx, layout.title, M, '选择模式', '五子棋');

  MODE_ORDER.forEach((key, i) => {
    const b = layout.blocks[i];
    if (!b) return;
    const pressed = state.press?.kind === 'mode' && state.press.index === i;
    const r = Math.round(Math.min(b.w, b.h) * 0.14);
    woodFill(ctx, b.x, b.y, b.w, b.h, r, M, true);
    if (pressed) {
      pathRoundRect(ctx, b.x, b.y, b.w, b.h, r);
      ctx.fillStyle = 'rgba(0,0,0,0.06)';
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // 字号按「宽度」推导并夹紧（早先按块高算，在长屏上会大到 70px 并溢出）
    const nameSize = Math.max(20, Math.min(30, Math.round(b.w * 0.085)));
    const descSize = Math.max(11, Math.min(14, Math.round(b.w * 0.036)));

    // 名称
    ctx.font = `800 ${nameSize}px ${FONT}`;
    ctx.fillStyle = M.selectedText;
    ctx.fillText(RULE_LABELS[key].name, b.x + b.w * 0.08, b.y + b.h * 0.40);

    // 说明（文案已缩短，确保不越过箭头区）
    ctx.font = `500 ${descSize}px ${FONT}`;
    ctx.fillStyle = 'rgba(66,41,6,0.86)';
    const brief = key === RULE_CASUAL
      ? '无禁手 · 先成五者胜'
      : '黑棋三三 / 四四 / 长连禁手';
    ctx.fillText(brief, b.x + b.w * 0.08, b.y + b.h * 0.70);

    // 右侧箭头
    const ax = b.x + b.w - b.w * 0.07, ay = b.y + b.h / 2;
    ctx.beginPath();
    ctx.moveTo(ax - 9, ay - 11);
    ctx.lineTo(ax + 4, ay);
    ctx.lineTo(ax - 9, ay + 11);
    ctx.strokeStyle = 'rgba(74,47,8,0.85)';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  });

  drawBackIcon(ctx, layout.back, M, state.press?.kind === 'back');
  drawGearIcon(ctx, layout.gear, M, state.press?.kind === 'gear');
}

/* ─────────────────── ③ 难度：竖排列表 ─────────────────── */

export function renderLevel(ctx, layout, state, M) {
  drawPaperBackground(ctx, layout, M);
  const modeName = RULE_LABELS[state.mode]?.name ?? '';
  const gameName = state.currentGame?.name ?? '';
  drawTitle(ctx, layout.title, M, '选择难度', modeName ? `${gameName} · ${modeName}` : gameName);

  // 难度档位由当前游戏提供（棋类=AI 强度；扫雷=盘面大小）
  const diffs = state.difficulties ?? [];
  diffs.forEach((d, i) => {
    const r0 = layout.rows[i];
    if (!r0) return;
    const pressed = state.press?.kind === 'level' && state.press.index === i;
    const r = Math.round(r0.h / 2);
    cardFill(ctx, r0.x, r0.y, r0.w, r0.h, r, M, { pressed });

    // 难度名
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${M.fontLevel}px ${FONT}`;
    ctx.fillStyle = M.textBody;
    ctx.fillText(d.name ?? '', r0.x + r0.w * 0.06, r0.y + r0.h / 2);

    // 说明
    ctx.font = `500 ${M.fontCardSub}px ${FONT}`;
    ctx.fillStyle = M.textMuted;
    ctx.fillText(d.desc ?? '', r0.x + r0.w * 0.28, r0.y + r0.h / 2);

    // 右侧强度条：档位越多越靠右，档位总数即满格数
    const total = Math.max(1, diffs.length);
    const barW = Math.max(3, Math.round(r0.w * 0.018));
    const gap = Math.max(2, Math.round(barW * 0.8));
    const totalW = total * barW + (total - 1) * gap;
    const bx = r0.x + r0.w - r0.w * 0.06 - totalW;
    for (let k = 0; k < total; k++) {
      const full = k <= i;
      const bh = r0.h * (0.34 + (k / Math.max(1, total - 1)) * 0.32);
      pathRoundRect(
        ctx,
        bx + k * (barW + gap), r0.y + r0.h / 2 - bh / 2,
        barW, bh, barW / 2,
      );
      ctx.fillStyle = full ? M.selectedBottom : 'rgba(120,110,90,0.20)';
      ctx.fill();
    }
  });

  drawBackIcon(ctx, layout.back, M, state.press?.kind === 'back');
  drawGearIcon(ctx, layout.gear, M, state.press?.kind === 'gear');
}

/* ─────────────────── ④ 设置面板 ─────────────────── */

/**
 * @param state.settings { music: 0..1, open: bool }
 */
export function renderSettings(ctx, layout, state, M, now) {
  const s = state.settings ?? { music: 0.5 };
  const L = state.settingsLayout;
  if (!L) return;

  // 遮罩
  ctx.save();
  ctx.fillStyle = 'rgba(18,28,26,0.45)';
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.restore();

  const p = L.panel;
  const r = Math.round(p.w * 0.08);
  ctx.save();
  ctx.shadowColor = 'rgba(60,50,20,0.28)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 8;
  pathRoundRect(ctx, p.x, p.y, p.w, p.h, r);
  ctx.fillStyle = '#f6faf9';
  ctx.fill();
  ctx.restore();
  pathRoundRect(ctx, p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1, r);
  ctx.strokeStyle = M.cardBorder;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // 标题
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${Math.round(p.w * 0.075)}px ${FONT}`;
  ctx.fillStyle = M.textTitle;
  ctx.fillText('设置', p.x + p.w / 2, L.titleY);

  // 标签
  ctx.font = `600 ${M.fontLevel}px ${FONT}`;
  ctx.fillStyle = M.textBody;
  ctx.textAlign = 'left';
  ctx.fillText('背景音乐', L.slider.x, L.labelY);

  // 数值
  ctx.textAlign = 'right';
  ctx.fillStyle = M.textMuted;
  const pct = Math.round(s.music * 100);
  ctx.fillText(pct === 0 ? '静音' : `${pct}%`, L.slider.x + L.slider.w, L.labelY);
  ctx.textAlign = 'left';

  // 滑轨
  const sl = L.slider;
  pathRoundRect(ctx, sl.x, sl.y, sl.w, sl.h, sl.h / 2);
  ctx.fillStyle = 'rgba(120,140,135,0.25)';
  ctx.fill();

  // 已选部分
  const filled = Math.max(0, Math.min(1, s.music)) * sl.w;
  if (filled > 0) {
    pathRoundRect(ctx, sl.x, sl.y, Math.max(sl.h, filled), sl.h, sl.h / 2);
    const g = ctx.createLinearGradient(sl.x, 0, sl.x + sl.w, 0);
    g.addColorStop(0, M.woodTop);
    g.addColorStop(1, M.woodBottom);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,100,40,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 滑块
  const kx = sl.x + filled;
  const ky = sl.y + sl.h / 2;
  ctx.beginPath();
  ctx.arc(kx, ky, sl.knobR, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = M.woodEdge;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(kx, ky, sl.knobR * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = M.selectedBottom;
  ctx.fill();

  // 音量说明
  ctx.textAlign = 'center';
  ctx.font = `500 ${M.fontCardSub}px ${FONT}`;
  ctx.fillStyle = M.textMuted;
  ctx.fillText('拖动滑块调节，0 为静音', p.x + p.w / 2, L.valueY);

  /* ── 曲目切换：◀ 曲名 ▶ ── */
  const tr = L.track;
  const trackName = state.settings?.trackName ?? '—';

  // 左侧箭头
  const drawArrow = (rect, dir) => {
    const acx = rect.x + rect.w / 2, acy = rect.y + rect.h / 2;
    ctx.beginPath();
    ctx.arc(acx, acy, Math.min(rect.w, rect.h) * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,140,135,0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(74,47,8,0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    const s = Math.min(rect.w, rect.h) * 0.16;
    ctx.beginPath();
    if (dir < 0) {
      ctx.moveTo(acx + s * 0.7, acy - s);
      ctx.lineTo(acx - s * 0.7, acy);
      ctx.lineTo(acx + s * 0.7, acy + s);
    } else {
      ctx.moveTo(acx - s * 0.7, acy - s);
      ctx.lineTo(acx + s * 0.7, acy);
      ctx.lineTo(acx - s * 0.7, acy + s);
    }
    ctx.strokeStyle = M.woodDeep;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  drawArrow(tr.prev, -1);
  drawArrow(tr.next, 1);

  // 曲名（木质胶囊底）
  const nameRect = tr.name;
  pathRoundRect(ctx, nameRect.x + 4, nameRect.y + 5, nameRect.w - 8, nameRect.h - 10, (nameRect.h - 10) / 2);
  ctx.fillStyle = 'rgba(233,189,117,0.42)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,110,50,0.32)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = `700 ${M.fontLevel}px ${FONT}`;
  ctx.fillStyle = M.textBody;
  ctx.fillText(trackName, nameRect.x + nameRect.w / 2, nameRect.y + nameRect.h / 2);

  // 底部说明（版权口径写清楚）
  ctx.font = `500 ${M.fontCardSub}px ${FONT}`;
  ctx.fillStyle = M.textMuted;
  ctx.fillText('曲目均为原创合成音色，无版权顾虑', p.x + p.w / 2, L.hintY);

  // 关闭按钮
  const c = L.close;
  ctx.beginPath();
  ctx.arc(c.x + c.w / 2, c.y + c.h / 2, c.w / 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120,140,135,0.18)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(74,47,8,0.55)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2, d = c.w * 0.22;
  ctx.beginPath();
  ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
  ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
  ctx.stroke();

  ctx.textAlign = 'left';
}
