/**
 * 围棋（Go）会话模块入口 —— 集成层唯一调用入口
 *
 * 分档（本次改造）：
 *   - **休闲模式 13 路**：简单 / 普通 / 困难（沿用原来的三档休闲 AI）；
 *   - **专业模式 19 路**：1 段 / 5 段 / 9 段（简化启发式 AI，只考虑局部候选点、单步有硬时间预算）。
 *   19 路棋盘底走离屏缓存（render.js），静态木纹/网格/星位只画一次。
 *
 * 交互：点交叉点落子（判定半径 0.46 格宽，避免误触）；
 * 顶部信息由本模块自绘，左上角返回 / 右上角齿轮由集成层绘制（本模块不画）。
 * 底部按钮固定为「重新开始 / 停一手 / 认输」，位置留出 insets.bottom + 16 的余量，
 * 外观统一走集成层导出的 drawWoodButton（浅底深字 + 木质感）。
 *
 * 时间约定（规范 §8）：集成层传进来的 now 是 Date.now() 的绝对毫秒，
 * 本模块内部一律透传 + 缺省回落到 Date.now()，绝不使用 performance.now()。
 * 音效（可选）：options.sfx 可能为 undefined，play() 也可能失败 —— 一律静默降级。
 */
import {
  SIZE, SIZE_CASUAL, SIZE_PRO, EMPTY, BLACK, WHITE, LEVELS, starPoints,
  createBoard, simulate, place, pass, resign, scoreBoard,
  chooseMove, shouldPass, lastMove, resultText,
} from './core.js';
import { renderFrame } from './render.js';

/** 大厅与难度页读取的元信息。 */
export const meta = {
  id: 'go',
  name: '围棋',
  desc: '13/19 路 · 数子定胜负',
  glyph: '围',
  ready: true,
  // 前 3 档＝休闲模式（13 路）；后 3 档＝专业模式（19 路，用段位表示 AI 强度）。
  // 围棋 AI 很难做强：如实标注，别让用户以为是职业水平。
  difficulties: [
    { key: 'lv1', name: '简单', desc: '13 路 · 随手落子' },
    { key: 'lv2', name: '普通', desc: '13 路 · 会吃子围空' },
    { key: 'lv3', name: '困难', desc: '13 路 · 见提必提' },
    { key: 'dan1', name: '1 段', desc: '19 路 · 均衡布局' },
    { key: 'dan5', name: '5 段', desc: '19 路 · 攻杀见长' },
    { key: 'dan9', name: '9 段', desc: '19 路 · 稳健少漏' },
  ],
};

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 左上/右上角区（集成层返回键与齿轮）见方尺寸：HUD 不得侵入。 */
export const CORNER_KEEPOUT = 56;

/* ───────────────────────── 布局 ───────────────────────── */

/**
 * 计算屏幕布局（纯几何，无平台依赖）。
 * 底部按钮底边固定在 height - insets.bottom - 16，实机手势条不会遮挡。
 *
 * 「格子尽量大」的做法：
 *   ① 棋盘左右只留 `boardPad`（约屏宽 3%）用于投影，几乎吃满宽度；
 *   ② 内边距固定为**半格**，于是 cell = 棋盘边长 / 路数（2×半格 + (路数−1) 格 = 边长），
 *      在给定棋盘边长下格子取到理论最大值，棋子直径 ≈ 0.92 格也不会压出木框。
 */
function computeGoLayout(width, height, insets = {}, boardSize = SIZE_CASUAL) {
  const safeTop = Math.max(0, Math.round(insets.top ?? 0));
  const safeBottom = Math.max(0, Math.round(insets.bottom ?? 0));
  const pad = Math.round(Math.min(width, height) * 0.045) || 16;
  const boardPad = Math.max(10, Math.round(width * 0.03));

  const usableTop = safeTop;
  const usableBottom = height - safeBottom;
  const usableH = usableBottom - usableTop;

  // 顶部信息区（齿轮/返回键也在这一带，故 HUD 三行全部居中排版）
  const hudH = Math.round(Math.min(104, usableH * 0.14));

  // 底部按钮区：btnH + 上下留白，最后的 16px + insets.bottom 是硬性余量
  const btnH = Math.max(38, Math.round(Math.min(56, usableH * 0.072)));
  const footerH = btnH + 52;

  const availW = width - boardPad * 2;
  const availH = usableH - hudH - footerH;
  const boardOuter = Math.max(140, Math.round(Math.min(availW, availH)));
  const boardX = Math.round((width - boardOuter) / 2);
  const boardY = Math.round(usableTop + hudH + Math.max(0, (availH - boardOuter) / 2));

  // 内边距 = 半格宽 → cell = boardOuter / boardSize（格子取到最大）
  const cell = boardOuter / boardSize;
  const inner = cell * 0.5;
  const stoneR = cell * 0.46;

  const gap = Math.round(pad * 0.6);
  const btnW = Math.floor((width - pad * 2 - gap * 2) / 3);
  // 硬约束：按钮底边 ≤ height - insets.bottom - 16
  const btnY = Math.round(usableBottom - 16 - btnH);
  const buttons = [];
  for (let i = 0; i < 3; i++) {
    buttons.push({ x: pad + i * (btnW + gap), y: btnY, w: btnW, h: btnH });
  }

  return {
    width, height, pad,
    size: boardSize,                 // 棋盘路数（13 / 19），渲染层据此画网格与棋子
    safe: { top: safeTop, bottom: safeBottom },
    // HUD 从 insets.top + 8 往下排（规范 §10）。
    // 左/右上角各 56px 是集成层返回键与齿轮的地盘，本模块的 HUD 全部居中排版避让。
    hud: { x: pad, y: usableTop + 8, w: width - pad * 2, h: hudH },
    board: {
      x: boardX, y: boardY, size: boardOuter, inner, cell, stoneR,
      toScreen(gx, gy) { return { x: boardX + inner + gx * cell, y: boardY + inner + gy * cell }; },
      fromScreen(px, py) {
        return {
          x: Math.round((px - boardX - inner) / cell),
          y: Math.round((py - boardY - inner) / cell),
        };
      },
    },
    stars: starPoints(boardSize),
    buttons,
    footer: { y: usableBottom - footerH, h: footerH },
  };
}

/** 矩形命中。 */
function hitRect(r, x, y) {
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 按钮命中，返回索引（-1 未命中）。 */
function hitButton(layout, x, y) {
  return layout.buttons.findIndex((b) => hitRect(b, x, y));
}

/** 解析注入的时间戳：集成层传 Date.now() 绝对毫秒；缺省/非法时回落 Date.now()（规范 §8）。 */
function resolveNow(now) {
  return typeof now === 'number' && Number.isFinite(now) && now > 0 ? now : Date.now();
}

/** 毫秒 → mm:ss（对局用时，HUD 第 3 行显示；也供测试断言）。 */
function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ───────────────────────── 会话 ───────────────────────── */

/**
 * 创建一局围棋会话。
 * @param options { width, height, insets, difficulty, theme, onEvent, humanColor, sfx, createOffscreen }
 */
export function createSession(options = {}) {
  const theme = options.theme ?? {};
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  // 音效是可选能力：不存在、play 不是函数、play 抛异常，三种情况都静默降级（绝不打断对局）
  const sfx = options.sfx;
  const playSfx = (name) => {
    try {
      if (sfx && typeof sfx.play === 'function') sfx.play(name);
    } catch { /* 音效失败不影响对局 */ }
  };

  const levelKey = LEVELS[options.difficulty] ? options.difficulty : 'lv2';
  const levelCfg = LEVELS[levelKey];
  const boardSize = levelCfg.size;

  const state = {
    board: createBoard(boardSize),
    level: levelKey,
    levelName: levelCfg.name,
    boardSize,           // 13 / 19
    mode: levelCfg.mode, // casual / pro
    humanColor: options.humanColor === WHITE ? WHITE : BLACK,
    aiThinking: false,
    pressIndex: -1,
    hover: null,
    toast: null,
    overT0: 0,
    animStones: {},
    animPops: [],
    territory: null,     // 终局后：数子地盘标记
    resultText: '',
    aiPending: false,    // 待 AI 行动（update 里处理）
    aiAt: 0,             // AI 最早行动时间（让"思考中"有观感）
    startedAt: 0,        // 对局开始时刻（集成层注入的绝对毫秒）
    elapsedMs: 0,        // 对局用时
    clockText: '00:00',  // 对局用时（mm:ss），HUD 直接画它
    aiLastMs: 0,         // AI 上一手的实际耗时（单步时间上限的自证数据）
    seq: 0,
  };

  let layout = computeGoLayout(options.width ?? 375, options.height ?? 667, options.insets ?? {}, boardSize);
  // 离屏画布工厂（宿主能力）：集成层可注入；没注入时 render.js 自己探测宿主环境并降级
  if (typeof options.createOffscreen === 'function') layout.createOffscreen = options.createOffscreen;
  let settled = false;
  let destroyed = false;

  /* ── 工具 ── */

  const isHumanTurn = () =>
    !state.board.over && !state.aiThinking && state.board.current === state.humanColor;

  function fire(type, payload = {}) {
    if (onEvent) { try { onEvent(type, payload); } catch { /* 集成层异常不影响对局 */ } }
  }

  function showToast(text, now, ms = 1500) {
    state.toast = { text, t0: now, ms };
    state.seq++;
  }

  /** 推进对局用时（时间注入：now 一律从入口透传，规范 §8）。 */
  function syncClock(now) {
    const t = resolveNow(now);
    if (!state.startedAt) state.startedAt = t;
    state.elapsedMs = Math.max(0, t - state.startedAt);
    state.clockText = formatClock(state.elapsedMs);
    return t;
  }

  function markStone(x, y, now) {
    state.animStones[`${x},${y}`] = now;
    const keys = Object.keys(state.animStones);
    if (keys.length > 12) delete state.animStones[keys[0]];
  }

  function popCaptures(captured, now) {
    for (const [x, y] of captured) state.animPops.push({ x, y, t0: now });
    if (state.animPops.length > 24) state.animPops = state.animPops.slice(-24);
  }

  /** 终局结算：算清数子、准备地盘标记、上报结果。 */
  function settle(now) {
    const b = state.board;
    state.territory = scoreBoard(b);
    state.resultText = resultText(b);
    state.overT0 = now;
    state.aiThinking = false;
    state.aiPending = false;
    state.hover = null;
    if (settled) return;
    settled = true;
    const res = b.result ?? { reason: 'two-passes', winner: EMPTY, margin: 0 };
    const result = res.winner === EMPTY || res.winner === -1
      ? 'draw'
      : (res.winner === state.humanColor ? 'win' : 'lose');
    fire('end', { result, winner: res.winner, reason: res.reason, margin: res.margin });
    fire(result, { margin: res.margin, reason: res.reason });
  }

  /** 落一手并处理提子/终局。 */
  function doPlace(x, y, now) {
    const r = place(state.board, x, y);
    if (!r.ok) return r;
    markStone(x, y, now);
    if (r.captured && r.captured.length) {
      popCaptures(r.captured, now);
      playSfx('capture');                  // 有子被提：吃子音
    } else {
      playSfx('tap');                      // 普通落子
    }
    fire('move', { x, y, color: state.board.grid[y][x], captured: (r.captured ?? []).length });
    if (state.board.over) settle(now);
    state.seq++;
    return r;
  }

  /** 停一手（人类或 AI 共用）。 */
  function doPass(now, byAi = false) {
    const r = pass(state.board);
    if (!r.ok) return r;
    showToast(byAi ? 'AI 停一手' : '你选择停一手', now, 1300);
    if (!byAi) playSfx('click');           // 自己按「停一手」：按钮音
    fire('pass', { color: state.board.current });
    if (state.board.over) settle(now);
    state.seq++;
    return r;
  }

  /** 把 AI 的一步落到盘上（含单步耗时统计，19 路也不许卡 UI）。 */
  function aiStep(now) {
    const b = state.board;
    state.aiThinking = false;
    state.aiPending = false;
    if (b.over) { settle(now); return; }

    const me = b.current;
    // 对方刚停一手：若 AI 已领先且盘面进入收官，就回停一手结束对局
    const last = lastMove(b);
    if (last && last.pass && shouldPass(b, me, { level: state.level })) {
      doPass(now, true);
      return;
    }

    const t0 = Date.now();
    let mv = chooseMove(b, me, { level: state.level });
    state.aiLastMs = Math.max(0, Date.now() - t0);
    // 兜底：AI 给的落点不合法时（理论不该发生）退化为第一个合法点
    if (!mv || (!mv.pass && !simulate(b, mv.x, mv.y, me).ok)) {
      let found = null;
      for (let y = 0; y < b.size && !found; y++) {
        for (let x = 0; x < b.size && !found; x++) {
          if (simulate(b, x, y, me).ok) found = { x, y };
        }
      }
      mv = found ?? { x: -1, y: -1, pass: true };
    }

    if (mv.pass) doPass(now, true);
    else doPlace(mv.x, mv.y, now);
  }

  /** 人类落子后：判断是否该轮到 AI。 */
  function afterHuman(now) {
    if (state.board.over) { settle(now); return; }
    if (state.board.current !== state.humanColor) {
      state.aiThinking = true;
      state.aiPending = true;
      state.aiAt = now + (theme.aiThinkMinMs ?? 260);
    }
  }

  function reset(now = 0) {
    state.board = createBoard(boardSize);
    state.animStones = {};
    state.animPops = [];
    state.territory = null;
    state.resultText = '';
    state.overT0 = 0;
    state.toast = null;
    state.hover = null;
    state.pressIndex = -1;
    state.aiThinking = false;
    state.aiPending = false;
    state.aiLastMs = 0;
    settled = false;
    state.startedAt = resolveNow(now);
    state.elapsedMs = 0;
    state.clockText = '00:00';
    if (state.humanColor === WHITE) {
      state.aiThinking = true;
      state.aiPending = true;
      state.aiAt = state.startedAt + (theme.aiThinkMinMs ?? 260);
    }
    state.seq++;
  }

  /* ── 对外 API ── */

  return {
    get state() { return state; },
    get layout() { return layout; },

    resize(width, height, insets = {}) {
      const keep = layout.createOffscreen;
      layout = computeGoLayout(width, height, insets, boardSize);
      if (keep) layout.createOffscreen = keep;
      // 棋盘几何变了：离屏缓存必须作废（render.js 会按 key 自然重建）
      if (layout.boardCache) layout.boardCache = null;
    },

    tap(x, y, now = 0) {
      if (destroyed) return;
      const t = syncClock(now);

      // ① 底部按钮优先（终局后也保留「重新开始」）
      const idx = hitButton(layout, x, y);
      if (idx >= 0) {
        state.pressIndex = -1;
        if (idx === 0) { playSfx('click'); reset(t); return; }
        if (idx === 1) {
          if (state.board.over || state.aiThinking) { showToast(state.board.over ? '对局已结束' : 'AI 思考中，请稍候', t); return; }
          if (!isHumanTurn()) { showToast('还没轮到你', t); return; }
          doPass(t, false);
          if (!state.board.over) {
            state.aiThinking = true;
            state.aiPending = true;
            state.aiAt = t + (theme.aiThinkMinMs ?? 260);
          } else settle(t);
          return;
        }
        if (idx === 2) {
          if (state.board.over) { showToast('对局已结束', t); return; }
          playSfx('click');
          const r = resign(state.board, state.humanColor);
          if (r.ok) { showToast('你认输了', t, 1200); settle(t); }
          return;
        }
      }

      // ② 盘面
      if (state.board.over) return;
      if (state.aiThinking) { showToast('AI 思考中，请稍候', t); return; }
      if (!isHumanTurn()) { showToast('还没轮到你', t); return; }

      const { x: gx, y: gy } = layout.board.fromScreen(x, y);
      if (gx < 0 || gy < 0 || gx >= boardSize || gy >= boardSize) { state.hover = null; return; }
      const p = layout.board.toScreen(gx, gy);
      if (Math.hypot(x - p.x, y - p.y) > layout.board.cell * 0.46) { state.hover = null; return; }

      if (state.board.grid[gy][gx] !== EMPTY) { showToast('这里已有棋子', t, 1100); return; }

      const sim = simulate(state.board, gx, gy, state.board.current);
      if (!sim.ok) {
        if (sim.reason === 'suicide') showToast('不能自杀（落子后自己无气）', t);
        else if (sim.reason === 'ko') showToast('打劫：不能立即回提', t);
        else showToast('这一手不合法', t);
        return;
      }

      const r = doPlace(gx, gy, t);
      if (!r.ok) return;
      state.hover = null;
      afterHuman(t);
    },

    press(x, y) {
      if (destroyed) return;
      state.pressIndex = hitButton(layout, x, y);
    },

    release() { state.pressIndex = -1; },

    hover(x, y) {
      if (destroyed) return;
      if (state.board.over || !isHumanTurn()) { state.hover = null; return; }
      const { x: gx, y: gy } = layout.board.fromScreen(x, y);
      if (gx < 0 || gy < 0 || gx >= boardSize || gy >= boardSize) { state.hover = null; return; }
      const p = layout.board.toScreen(gx, gy);
      if (Math.hypot(x - p.x, y - p.y) > layout.board.cell * 0.46) { state.hover = null; return; }
      state.hover = { x: gx, y: gy, valid: simulate(state.board, gx, gy, state.board.current).ok };
    },

    update(now) {
      if (destroyed) return;
      const t = syncClock(now);
      // 提示过期即清（重绘时才清，避免 drawToast 内部偷偷改状态）
      if (state.toast && t - state.toast.t0 > state.toast.ms) state.toast = null;
      // 提子爆闪过期清理
      if (state.animPops.length) state.animPops = state.animPops.filter((pp) => t - pp.t0 < 340);
      // AI 行动
      if (state.aiPending && !state.board.over && t >= state.aiAt) aiStep(t);
    },

    render(ctx, now = 0) {
      const board = state.board;
      const labels = ['重新开始', '停一手', '认输'];
      const disabled = [false, board.over || state.aiThinking, board.over];
      renderFrame(ctx, layout, state, theme, now, { labels, disabled });
    },

    get hud() {
      const b = state.board;
      const status = b.over
        ? (state.resultText || '对局结束')
        : (state.aiThinking ? 'AI 思考中' : (b.current === state.humanColor ? '轮到你落子' : 'AI 回合'));
      return {
        title: `围棋 · ${state.boardSize} 路`,
        status,
        right: state.clockText,
        level: state.levelName,
        elapsed: state.clockText,
        elapsedMs: state.elapsedMs,
      };
    },

    get busy() { return state.aiThinking || state.animPops.length > 0; },

    get outcome() {
      const b = state.board;
      if (!b.over || !b.result) return null;
      const res = b.result;
      if (res.reason === 'resign') {
        return { result: res.winner === state.humanColor ? 'win' : 'lose', score: 0 };
      }
      if (res.winner === EMPTY || res.winner === -1) return { result: 'draw', score: 0 };
      return {
        result: res.winner === state.humanColor ? 'win' : 'lose',
        score: Math.max(0, Math.round(res.margin ?? 0)),
      };
    },

    destroy() { destroyed = true; state.animStones = {}; state.animPops = []; },
  };
}

export { SIZE, SIZE_CASUAL, SIZE_PRO, BLACK, WHITE, EMPTY, FONT, DIRS };
