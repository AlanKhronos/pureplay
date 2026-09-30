/**
 * 围棋（Go）绘制层：只负责「把状态画出来」，不持有状态、不碰平台 API。
 * 纯 Canvas 2D —— 同一份代码同时供微信小游戏与浏览器预览使用。
 *
 * 内容：木质棋盘（13/19 路网格 + 星位 + 木纹）、黑白立体棋子、最后一手标记、
 *       提子数、数子地盘（半透明小方块）、底部三个木质按钮。
 *
 * 性能（19 路 361 个交叉点）：
 *   静态棋盘层（木框 / 木纹 / 网格线 / 星位）走**离屏画布缓存**，只在路数或几何变化时
 *   重画一次，之后每帧只做一次 drawImage；没有离屏能力时退化为直接绘制，
 *   同时把 2N 条网格线合并成**一条路径一次 stroke**、把 361 个地盘标记合并成
 *   一色一批（最多 4 次 fill/stroke），避免每帧上千次绘制调用。
 *
 * 统一 UI 约定（对局背景已统一为青白渐变，文字必须浅底深字）：
 *   - **不铺全屏底、不清屏**：底色与 clearRect 都是集成层的职责（规范 §10）。
 *     本模块只画棋盘这一块局部材质 + 棋盘附近的柔光。
 *   - **不画结算弹窗**：集成层读 outcome 统一画（规范 §9/§10）。
 *   - **不画左上返回键与右上齿轮**：集成层画，本模块的 HUD 全部居中排版，
 *     避让左上/右上各约 56px 的角区（规范 §10）。
 *   - 文字一律取 theme 令牌（青白底上写死深色主题的浅字会直接隐形）；
 *     棋子上的白色高光/描边是画在棋子上、不是画在背景上，保留。
 *   - 底部按钮统一走集成层导出的 drawWoodButton（规范 §10）。
 */
import { drawWoodButton } from '../../ui/renderer.js';
import { EMPTY, BLACK, WHITE } from './core.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 圆角矩形路径（不调用 beginPath，可在一个路径里拼多个，便于批量填充）。 */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
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

/** 圆角矩形路径（不依赖 ctx.roundRect，兼容小游戏基础库）。 */
export function pathRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 棋盘附近的暖色柔光：让视线聚焦到棋盘中央。
 *
 * ⚠️ 这里**只画棋盘那一块**（fillRect 传的是棋盘矩形，不是全屏矩形）：
 * 全屏青白渐变底由集成层铺（规范 §10）——早先本模块自己用全屏 fillRect 铺了一层底，
 * 既盖住了集成层刚铺好的渐变，也让 clearRect 白清一次（蜘蛛纸牌踩过同样的坑）。
 */
export function drawBoardGlow(ctx, layout, theme) {
  const b = layout.board;
  const glow = ctx.createRadialGradient(
    b.x + b.size / 2, b.y + b.size / 2, b.size * 0.15,
    b.x + b.size / 2, b.y + b.size / 2, b.size * 0.75,
  );
  glow.addColorStop(0, 'rgba(176,125,22,0.10)');
  glow.addColorStop(1, 'rgba(176,125,22,0)');
  ctx.save();
  ctx.fillStyle = glow;
  ctx.fillRect(b.x - b.size * 0.12, b.y - b.size * 0.12, b.size * 1.24, b.size * 1.24);
  ctx.restore();
}

/* ───────────────────────── 棋盘（静态层 + 离屏缓存） ───────────────────────── */

/**
 * 静态棋盘层：木框投影 + 木色渐变 + 木纹 + 内阴影 + 网格 + 星位。
 * 全部坐标相对 (ox, oy) —— 上屏时 ox/oy 是棋盘左上角，离屏时是缓存画布的内边距。
 * 这一层与盘面状态无关，所以天生可缓存。
 */
function paintBoardLayers(ctx, layout, theme, ox, oy) {
  const b = layout.board;
  const n = layout.size;
  const r = Math.max(2, Math.round(b.size * 0.05));
  const px = (gx) => ox + b.inner + gx * b.cell;
  const py = (gy) => oy + b.inner + gy * b.cell;

  // 木框投影
  ctx.save();
  ctx.shadowColor = theme.boardShadow;
  ctx.shadowBlur = Math.round(b.size * 0.05);
  ctx.shadowOffsetY = Math.round(b.size * 0.012);
  pathRoundRect(ctx, ox, oy, b.size, b.size, r);
  ctx.fillStyle = theme.boardEdge;
  ctx.fill();
  ctx.restore();

  // 木色渐变
  const wood = ctx.createLinearGradient(0, oy, 0, oy + b.size);
  wood.addColorStop(0, theme.boardTop);
  wood.addColorStop(1, theme.boardBottom);
  pathRoundRect(ctx, ox, oy, b.size, b.size, r);
  ctx.fillStyle = wood;
  ctx.fill();

  // 木纹：极低对比横向细纹，密度随棋盘尺寸自适应
  ctx.save();
  pathRoundRect(ctx, ox, oy, b.size, b.size, r);
  ctx.clip();
  ctx.globalAlpha = 0.032;
  ctx.strokeStyle = '#6b3f12';
  ctx.lineWidth = 1;
  const step = Math.max(2, Math.round(b.size / 150)) * 3;
  for (let y = oy; y < oy + b.size; y += step) {
    const wobble = Math.sin(y * 0.35) * (b.size * 0.004);
    ctx.beginPath();
    ctx.moveTo(ox, y + wobble);
    ctx.lineTo(ox + b.size, y + wobble * 0.4);
    ctx.stroke();
  }
  ctx.restore();

  // 内阴影（木框立体感）
  ctx.save();
  pathRoundRect(ctx, ox, oy, b.size, b.size, r);
  ctx.clip();
  const vig = ctx.createRadialGradient(
    ox + b.size / 2, oy + b.size / 2, b.size * 0.3,
    ox + b.size / 2, oy + b.size / 2, b.size * 0.78,
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(90,52,16,0.22)');
  ctx.fillStyle = vig;
  ctx.fillRect(ox, oy, b.size, b.size);
  ctx.restore();

  // 边框：外深 + 内亮，做出木框倒角
  pathRoundRect(ctx, ox + 0.5, oy + 0.5, b.size - 1, b.size - 1, r);
  ctx.strokeStyle = theme.boardEdge;
  ctx.lineWidth = Math.max(1.2, b.size * 0.0075);
  ctx.stroke();

  pathRoundRect(ctx, ox + b.inner * 0.55, oy + b.inner * 0.55, b.size - b.inner * 1.1, b.size - b.inner * 1.1, r * 0.55);
  ctx.strokeStyle = theme.boardEdgeSoft;
  ctx.lineWidth = Math.max(1, b.size * 0.0028);
  ctx.stroke();

  // 网格线：2N 条线合并成**一条路径一次 stroke**（19 路 38 条线 → 1 次绘制调用）。
  // 线宽：19 路更细但不低于 1 逻辑像素（真机 dpr≥2，1px 对应 ≥2 物理像素，不会糊）。
  ctx.save();
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = Math.max(1, b.size * (n >= 19 ? 0.0026 : 0.0035));
  ctx.lineCap = 'round';
  const x0 = px(0), y0 = py(0), x1 = px(n - 1), y1 = py(n - 1);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const vx = px(i), hy = py(i);
    ctx.moveTo(vx, y0); ctx.lineTo(vx, y1);
    ctx.moveTo(x0, hy); ctx.lineTo(x1, hy);
  }
  ctx.stroke();
  // 最外圈加重，棋盘边缘更挺
  ctx.beginPath();
  ctx.strokeStyle = theme.gridLineStrong;
  ctx.lineWidth = Math.max(1.4, b.size * 0.005);
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();

  // 星位：13 路 5 个 / 19 路 9 个（都由 core.starPoints 给出，渲染不再自己写死）
  ctx.beginPath();
  for (const [gx, gy] of layout.stars) {
    const p = { x: px(gx), y: py(gy) };
    ctx.moveTo(p.x + Math.max(2, b.cell * 0.10), p.y);
    ctx.arc(p.x, p.y, Math.max(2, b.cell * 0.10), 0, Math.PI * 2);
  }
  ctx.fillStyle = theme.starPoint;
  ctx.fill();
}

/**
 * 取（必要时创建）离屏棋盘缓存。
 *
 * 宿主能力探测顺序（全部失败就返回 null，调用方退化为逐帧直接绘制）：
 *   ① layout.createOffscreen —— 集成层注入的工厂（测试也走这条，确定性最好）；
 *   ② globalThis.OffscreenCanvas —— 现代浏览器；
 *   ③ globalThis.wx.createCanvas —— 微信小游戏（第一次调用返回上屏画布，之后是离屏画布）。
 * 探测本身包在 try/catch 里：宿主没有该能力不是错误，只是降级（与 src/audio/bgm.js 同一策略）。
 *
 * 缓存挂在 layout 上（layout 由会话持有），所以本模块自身不持有任何状态。
 */
export function ensureBoardCache(ctx, layout, theme) {
  const b = layout.board;
  const key = [
    layout.size, Math.round(b.size), Math.round(b.inner * 100),
    theme.boardTop, theme.boardBottom, theme.boardEdge, theme.boardEdgeSoft,
    theme.gridLine, theme.gridLineStrong, theme.starPoint, theme.boardShadow,
  ].join('|');

  const cached = layout.boardCache;
  if (cached && cached.key === key && cached.canvas && cached.ctx) return cached;

  const factory = typeof layout.createOffscreen === 'function'
    ? layout.createOffscreen
    : probeOffscreenFactory();
  if (!factory) { layout.boardCache = null; return null; }

  // 外扩一圈，容纳投影与木框圆角，避免被缓存边界切掉
  const margin = Math.ceil(b.size * 0.06);
  const logical = b.size + margin * 2;
  const dpr = (ctx && ctx.canvas && ctx.canvas.__dpr) || 1;

  try {
    let canvas = cached && cached.canvas ? cached.canvas : factory(logical * dpr, logical * dpr);
    if (!canvas || typeof canvas.getContext !== 'function') { layout.boardCache = null; return null; }
    canvas.width = Math.max(1, Math.ceil(logical * dpr));
    canvas.height = Math.max(1, Math.ceil(logical * dpr));
    const octx = canvas.getContext('2d');
    if (!octx) { layout.boardCache = null; return null; }
    if (typeof octx.setTransform === 'function') octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintBoardLayers(octx, layout, theme, margin, margin);
    layout.boardCache = { canvas, ctx: octx, key, margin };
    return layout.boardCache;
  } catch {
    layout.boardCache = null;
    return null;
  }
}

/** 探测宿主可用的离屏画布工厂（没有就返回 null）。 */
function probeOffscreenFactory() {
  try {
    const g = typeof globalThis === 'undefined' ? null : globalThis;
    if (!g) return null;
    if (typeof g.OffscreenCanvas === 'function') {
      return (w, h) => new g.OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
    }
    if (g.wx && typeof g.wx.createCanvas === 'function') {
      return (w, h) => {
        const c = g.wx.createCanvas();
        if (c) { c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); }
        return c;
      };
    }
  } catch { /* 宿主不提供 → 降级为直接绘制 */ }
  return null;
}

/**
 * 木质棋盘：有离屏缓存就一次 drawImage（19 路每帧不再重画 38 条网格线与 9 个星位），
 * 没有缓存则直接画静态层（外观完全一致）。
 */
export function drawBoard(ctx, layout, theme) {
  const b = layout.board;
  const cache = ensureBoardCache(ctx, layout, theme);
  if (cache) {
    const m = cache.margin;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(cache.canvas, b.x - m, b.y - m, b.size + m * 2, b.size + m * 2);
    ctx.restore();
    return;
  }
  paintBoardLayers(ctx, layout, theme, b.x, b.y);
}

/* ───────────────────────── 棋子 ───────────────────────── */

/** 画一颗立体棋子（高光 + 投影 + 轮廓）。 */
function drawStone(ctx, cx, cy, r, color, theme) {
  ctx.save();
  // 投影
  ctx.beginPath();
  ctx.arc(cx + r * 0.10, cy + r * 0.14, r, 0, Math.PI * 2);
  ctx.fillStyle = theme.stoneShadow;
  ctx.fill();

  // 球体渐变
  const g = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.38, r * 0.06, cx, cy, r * 1.06);
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

/* ───────────────────────── 地盘标记（数子结果） ───────────────────────── */

/**
 * 把数子结果画成半透明小方块：黑地偏亮、白地偏白，一眼看出归属。
 * 批量绘制：同一归属的所有方块合成**一条路径一次 fill/stroke**。
 * （19 路终局最多 361 个方块，逐个 fill+stroke 每帧要上千次调用。）
 */
export function drawTerritory(ctx, layout, state, theme) {
  const s = state.territory;
  if (!s || !s.owner) return;
  const b = layout.board;
  const n = layout.size;
  const half = b.cell * 0.34;
  for (const who of [BLACK, WHITE]) {
    let any = false;
    ctx.save();
    ctx.beginPath();
    for (let y = 0; y < n; y++) {
      const row = s.owner[y];
      if (!row) continue;
      for (let x = 0; x < n; x++) {
        if (row[x] !== who) continue;
        const p = b.toScreen(x, y);
        roundRectPath(ctx, p.x - half, p.y - half, half * 2, half * 2, half * 0.45);
        any = true;
      }
    }
    if (any) {
      ctx.globalAlpha = who === BLACK ? 0.30 : 0.34;
      ctx.fillStyle = who === BLACK ? '#111318' : '#ffffff';
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = who === BLACK ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ───────────────────────── 棋子 / 标记 ───────────────────────── */

export function drawStones(ctx, layout, state, theme, now) {
  const b = layout.board;
  const board = state.board;
  const n = board.size;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const v = board.grid[gy][gx];
      if (v === EMPTY) continue;
      const p = b.toScreen(gx, gy);

      // 刚落下的子弹出（只对最近几手生效）
      let scale = 1;
      const t0 = state.animStones && state.animStones[`${gx},${gy}`];
      if (t0 !== undefined) {
        const t = clamp01((now - t0) / theme.placeAnimMs);
        scale = t >= 1 ? 1 : 0.55 + 0.45 * t;
      }
      drawStone(ctx, p.x, p.y, b.stoneR * scale, v, theme);
    }
  }
}

/** 被提子时的小爆闪（提子点上有余韵）。 */
export function drawCapturePops(ctx, layout, state, theme, now) {
  const pops = state.animPops;
  if (!pops || pops.length === 0) return;
  const b = layout.board;
  ctx.save();
  for (const pop of pops) {
    const t = clamp01((now - pop.t0) / 340);
    if (t >= 1) continue;
    const p = b.toScreen(pop.x, pop.y);
    ctx.globalAlpha = (1 - t) * 0.7;
    ctx.beginPath();
    ctx.arc(p.x, p.y, b.stoneR * (0.6 + t * 0.9), 0, Math.PI * 2);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = Math.max(1.5, b.stoneR * 0.18);
    ctx.stroke();
  }
  ctx.restore();
}

/** 最后一手标记：呼吸光环 + 中心点（虚手时在 HUD 里提示，不画盘上）。 */
export function drawLastMarker(ctx, layout, state, theme, now) {
  const board = state.board;
  const last = board.moves[board.moves.length - 1];
  if (!last || last.pass) return;
  const p = layout.board.toScreen(last.x, last.y);
  const r = layout.board.stoneR;
  const pulse = 0.5 + 0.5 * Math.sin((now ?? 0) / 420);

  ctx.beginPath();
  ctx.arc(p.x, p.y, r * (1.10 + pulse * 0.10), 0, Math.PI * 2);
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.55 + pulse * 0.35;
  ctx.lineWidth = Math.max(1.2, r * 0.14);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 0.17, 0, Math.PI * 2);
  ctx.fillStyle = last.player === BLACK ? theme.accent : '#8a5a10';
  ctx.fill();
}

/** 打劫禁着点：画一个红叉，玩家点到会收到提示。 */
export function drawKoMark(ctx, layout, state, theme, now) {
  const ko = state.board.ko;
  if (!ko || state.board.over) return;
  const p = layout.board.toScreen(ko.x, ko.y);
  const r = layout.board.stoneR * 0.7;
  const pulse = 0.6 + 0.4 * Math.sin((now ?? 0) / 360);
  ctx.save();
  ctx.globalAlpha = 0.55 + pulse * 0.35;
  ctx.strokeStyle = theme.danger;
  ctx.lineWidth = Math.max(1.6, r * 0.22);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(p.x - r, p.y - r); ctx.lineTo(p.x + r, p.y + r);
  ctx.moveTo(p.x + r, p.y - r); ctx.lineTo(p.x - r, p.y + r);
  ctx.stroke();
  ctx.restore();
}

/** 悬停/按下预告（浏览器鼠标环境；触摸设备上没有）。 */
export function drawHoverGhost(ctx, layout, state, theme) {
  const hv = state.hover;
  if (!hv || state.board.over) return;
  const p = layout.board.toScreen(hv.x, hv.y);
  const r = layout.board.stoneR;
  ctx.save();
  ctx.globalAlpha = 0.40;
  drawStone(ctx, p.x, p.y, r * 0.94, state.board.current, theme);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = hv.valid === false ? theme.danger : theme.accent;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 1.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/* ───────────────────────── HUD ───────────────────────── */

/** 小棋子图标（HUD 里表示执子方）。 */
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

/** 统计某方盘面上的子数（HUD 显示用，纯绘制期轻量统计）。 */
function countStones(board, color) {
  const n = board.size;
  let c = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (board.grid[y][x] === color) c++;
  return c;
}

/** 按可用宽度裁剪「· 」拼接的信息串（从尾部丢最不重要的部分）。 */
function fitParts(ctx, parts, maxW) {
  const list = parts.slice();
  let text = list.join(' · ');
  while (list.length > 1 && ctx.measureText(text).width > maxW) {
    list.pop();
    text = list.join(' · ');
  }
  return text;
}

/**
 * 顶部信息三行：标题（`围棋 · 13 路`）/ 当前状态 / 汇总（难度 · 手数 · 用时 · 提子）。
 *
 * 排版铁律：**全部居中**。左上角返回键与右上角齿轮由集成层画在左右各约 56px 的角区里，
 * 早先这里把「手数」右对齐贴到 `width - pad`、「难度」左对齐贴到 `pad`，
 * 结果两颗按钮正好压在这两段文字上（截图可见重叠）。居中排版天然避开两个角区。
 */
export function drawHud(ctx, layout, state, theme, now) {
  const hud = layout.hud;
  const board = state.board;
  const cx = layout.width / 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 第 1 行：标题（含路数：13 / 19）
  ctx.fillStyle = theme.textPrimary;
  ctx.font = `700 ${theme.fontTitle}px ${FONT}`;
  ctx.fillText(`围棋 · ${layout.size} 路`, cx, hud.y + hud.h * 0.24);

  // 第 2 行：状态副标题（执子方小棋子 + 文案，整体居中）
  let sub = '';
  if (board.over) sub = state.resultText || '对局结束';
  else if (state.aiThinking) sub = 'AI 思考中';
  else if (board.current === state.humanColor) sub = '轮到你落子';
  else sub = 'AI 回合';
  const last = board.moves[board.moves.length - 1];
  if (!board.over && last && last.pass && board.current === state.humanColor) sub = 'AI 停一手 · 轮到你';

  ctx.font = `500 ${theme.fontHud}px ${FONT}`;
  const subColor = state.aiThinking ? theme.accent : theme.textMuted;
  const showStone = !board.over;
  const textW = ctx.measureText(sub).width;
  const iconR = theme.fontHud * 0.42;
  const gap = showStone ? iconR * 2.4 : 0;
  const startX = cx - (textW + gap) / 2;
  if (showStone) drawMiniStone(ctx, startX + iconR, hud.y + hud.h * 0.56, iconR, board.current, theme);
  ctx.textAlign = 'left';
  // ⚠️ fillStyle 必须放在 drawMiniStone **之后**：那颗小棋子会把 fillStyle 改成径向渐变，
  // 早先这里先设色再画棋子，结果这句文案被棋子的渐变上了色（白子时那一档几乎全白，等于隐形）。
  ctx.fillStyle = subColor;
  ctx.fillText(sub, startX + gap, hud.y + hud.h * 0.56);

  // 第 3 行：汇总信息（居中，弱化显示）
  // ⚠️ 必须用主题令牌：早先这三处写死了深色主题的浅灰字（242/243/247 那组 + 低透明度），
  // 换成青白底后直接看不见了。
  const clock = state.clockText ?? '00:00';
  let parts;
  const sc = board.result && board.result.reason !== 'resign' ? board.result.score : null;
  if (board.over && sc) {
    // 终局：改成数子明细（结算弹窗由集成层画，这里只留一行硬数据）
    parts = [`数子 黑 ${sc.black}`, `用时 ${clock}`, `白合计 ${sc.whiteScore.toFixed(1)}`, `贴目 ${sc.komi}`];
  } else {
    parts = [];
    if (state.levelName) parts.push(state.levelName);
    parts.push(`${board.moves.length} 手`);
    parts.push(`用时 ${clock}`);
    parts.push(`黑提 ${board.captures[BLACK]} · 白提 ${board.captures[WHITE]}`);
    if (board.over) parts.push(`盘面 黑 ${countStones(board, BLACK)} · 白 ${countStones(board, WHITE)}`);
  }
  ctx.textAlign = 'center';
  ctx.font = `500 ${theme.fontSmall}px ${FONT}`;
  ctx.fillStyle = theme.textMuted;
  ctx.fillText(fitParts(ctx, parts, hud.w * 0.96), cx, hud.y + hud.h * 0.85);
  ctx.textAlign = 'left';
}

/* ───────────────────────── 按钮 ───────────────────────── */

/**
 * 底部按钮：labels 与 layout.buttons 一一对应。
 *
 * 统一走集成层导出的 drawWoodButton（规范 §10）——早先这里自己画胶囊按钮，
 * 颜色与全站木质风格不一致；而且禁用态的文案色写死成深色主题的浅灰字（242/243/247 那组），
 * 青白底上等于隐形。
 */
export function drawButtons(ctx, layout, state, theme, labels, disabled = []) {
  layout.buttons.forEach((btn, i) => {
    drawWoodButton(ctx, btn, labels[i], {
      pressed: state.pressIndex === i,
      primary: i === 0,                       // 主操作：重新开始
      disabled: disabled[i] === true,
      fontSize: theme.fontBtn ?? 15,
    });
  });
}

/* ───────────────────────── 结算 ───────────────────────── */

/**
 * 终局**不再自绘结算层**（规范 §9/§10）：
 *   - 统一结算弹窗由集成层读 `session.outcome` 后画（`src/ui/renderer.js` 的 drawResultDialog）；
 *   - 本模块原来那层是深色写法（`#05070c` 全屏遮罩 + `rgba(28,32,44,0.96)` 深色卡片），
 *     既会盖住集成层的青白底，又会和统一弹窗叠成两张卡；全屏遮罩还会命中
 *     `tools/audit-games.mjs` 的 fullscreen-bg 规则。
 * 终局信息改由 HUD 第 3 行给硬数据（数子 / 贴目 / 用时），棋盘上保留地盘标记。
 * 注意结算后**不自动重开**：保持终局画面并持续返回 outcome，直到集成层重建会话。
 */

/** 浮动提示（非法落子 / 打劫 / 自杀）。 */
export function drawToast(ctx, layout, state, theme, now) {
  const t = state.toast;
  if (!t) return;
  const age = (now ?? 0) - t.t0;
  if (age > t.ms) return;
  const fade = age < 160 ? age / 160 : age > t.ms - 320 ? Math.max(0, (t.ms - age) / 320) : 1;

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.font = `600 ${theme.fontHud}px ${FONT}`;
  const tw = ctx.measureText(t.text).width;
  const h = 38;
  const w = Math.min(layout.width - layout.pad * 3, tw + 36);
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
  ctx.fillText(t.text, layout.width / 2, y + h / 2 + 0.5);
  ctx.textAlign = 'left';
  ctx.restore();
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一次完整绘制。
 *
 * ⚠️ 不在这里 clearRect、也不铺全屏底：清屏与青白渐变底是**集成层**的职责（规范 §10）。
 * 早先这里有一句 ctx.clearRect(0,0,w,h) 紧跟一层自带渐变底，会把集成层刚铺好的底色清掉。
 * 现在顺序是：棋盘柔光（局部）→ 棋盘（离屏缓存 blit）→ 地盘 → 棋子/标记 → HUD → 木质按钮 → 提示。
 *
 * @param ctx Canvas 2D 上下文
 * @param layout createSession 内的布局对象
 * @param state 会话状态（index.js 持有）
 * @param theme THEME 令牌
 * @param now 当前时间（ms，用于动画）
 * @param ui { labels, disabled } 由会话传入的按钮文案与禁用态
 */
export function renderFrame(ctx, layout, state, theme, now, ui = {}) {
  drawBoardGlow(ctx, layout, theme);
  drawBoard(ctx, layout, theme);
  drawTerritory(ctx, layout, state, theme);
  drawHoverGhost(ctx, layout, state, theme);
  drawStones(ctx, layout, state, theme, now);
  drawCapturePops(ctx, layout, state, theme, now);
  drawLastMarker(ctx, layout, state, theme, now);
  drawKoMark(ctx, layout, state, theme, now);
  drawHud(ctx, layout, state, theme, now);
  drawButtons(ctx, layout, state, theme, ui.labels ?? ['重新开始', '停一手', '认输'], ui.disabled ?? []);
  drawToast(ctx, layout, state, theme, now);
}
