/**
 * 国际象棋模块入口（严格遵守 docs/游戏模块规范.md）
 *
 * 对外只有两样东西：meta（大厅/难度页读）与 createSession（集成层唯一调用入口）。
 * 布局全部在这里算，render.js 只负责按 layout + state 画。
 *
 * 交互（按需求）：点自己棋子选中并显示可走点 → 点目标格落子；再点自己另一子改选；点空白取消。
 * 玩家固定执白（先手）；底部三个木质按钮「重新开始 / 悔棋 / 认输」（drawWoodButton，
 * 主操作「重新开始」primary），按钮下方留出 insets.bottom + 16 的余量（实机底部手势条遮挡的坑）。
 * 左上返回与右上齿轮由集成层绘制，本模块不画，顶部 HUD 让开它们所在的角区（见 computeLayout）。
 */
import {
  createBoard, legalMovesFrom, findLegalMove, applyMove, undoMove, gameStatus,
  positionKey, lastMove, colorOf, WHITE, QUEEN, PIECE_NAMES,
  chooseMove, levelName, LEVELS,
} from './core.js';
import { renderGame } from './render.js';
import { THEME } from '../../ui/theme.js';

/** 大厅卡片与难度页数据。 */
export const meta = {
  id: 'chess',
  name: '国际象棋',
  desc: '人机对弈 · 五档棋力',
  glyph: '象',
  ready: true,
  difficulties: [
    { key: 'lv1', name: '简单', desc: '只看一步 · 常看漏' },
    { key: 'lv2', name: '普通', desc: '算两步 · 偶尔下错' },
    { key: 'lv3', name: '困难', desc: '算吃子交换 · 少失误' },
    { key: 'lv4', name: '地狱', desc: '三层搜索 · 几乎不失误' },
    { key: 'lv5', name: '亚洲', desc: '迭代加深 · 限时算最深' },
  ],
};

/** 玩家固定执白。 */
const HUMAN_COLOR = WHITE;

/** 难度 key（lv1..lv5）→ 1..5。 */
function parseLevel(difficulty) {
  const m = /([1-5])/.exec(String(difficulty ?? ''));
  return m ? Number(m[1]) : 2;
}

/**
 * 布局：把屏幕尺寸换算成 HUD / 棋盘 / 底部按钮的几何信息。
 * 顶部让出集成层的返回与齿轮，底部让出 insets.bottom + 16。
 * （额外导出，便于测试与集成层做自检；集成层只需要 meta 与 createSession。）
 */
export function computeLayout(width, height, insets = {}) {
  const safe = {
    top: Math.max(0, Math.round(insets.top ?? 0)),
    bottom: Math.max(0, Math.round(insets.bottom ?? 0)),
  };
  const pad = Math.max(12, Math.round(Math.min(width, height) * 0.045));

  // 顶部让位（规范 §10）：集成层把返回键 / 齿轮画在 insets.top + 4 起、直径约 56px 的角区里
  // （见 src/ui/layout.js 里 back/gear 的 size = max(30, pad*2.1)）。
  // 所以 HUD 从 insets.top + 8 之下、再整体压下一个角区高度：标题居中不受影响，
  // 贴着屏幕左右两侧的那两行文字（左下难度、右上回合）也落在角区之下，不会撞到返回/齿轮。
  // 角区高度取 max(56, 按钮直径 + 8)：手机上是 56，平板等大屏跟着按钮一起放大。
  const cornerTop = Math.max(56, Math.round(pad * 2.1) + 8);
  const contentTop = safe.top + 8 + cornerTop;
  const hudH = Math.max(30, Math.round(Math.min(44, height * 0.058)));

  const btnH = Math.max(38, Math.round(Math.min(52, height * 0.072)));
  const bottomGap = safe.bottom + 16;             // 硬约束：insets.bottom + 16
  // ⚠️ 用 floor 而不是 round：canvas 的逻辑尺寸可能是小数（浏览器预览 rect 就是小数，
  // round 最多会把按钮底边顶出 0.5px，就越过了 insets.bottom + 16 这条硬红线）。
  const btnY = Math.floor(height - bottomGap - btnH);

  const areaTop = contentTop + hudH;
  const areaBottom = btnY - 14;
  const availH = Math.max(120, areaBottom - areaTop);
  const availW = width - pad * 2;
  const size = Math.max(160, Math.floor(Math.min(availW, availH)));
  const bx = Math.round((width - size) / 2);
  const by = Math.round(areaTop + Math.max(0, (availH - size) / 2));

  const framePad = Math.max(9, Math.round(size * 0.036)); // 木框：留给坐标，不占格子
  const inner = size - framePad * 2;
  const cell = inner / 8;

  const gap = Math.round(pad * 0.6);
  const btnW = Math.floor((width - pad * 2 - gap * 2) / 3);
  const buttons = [0, 1, 2].map((i) => ({
    x: pad + i * (btnW + gap), y: btnY, w: btnW, h: btnH,
  }));

  return {
    width,
    height,
    pad,
    safe,
    contentTop,
    hud: { x: pad, y: contentTop, w: width - pad * 2, h: hudH },
    board: {
      x: bx, y: by, size, inner, cell, framePad,
      /** 格子中心（画棋子用）。 */
      toScreen(fx, fy) {
        return { x: bx + framePad + fx * cell + cell / 2, y: by + framePad + fy * cell + cell / 2 };
      },
      /** 格子矩形（画标记用）。 */
      squareRect(fx, fy) {
        return { x: bx + framePad + fx * cell, y: by + framePad + fy * cell, w: cell, h: cell };
      },
      /** 屏幕坐标 → 格子索引；棋盘外返回 null。 */
      fromScreen(px, py) {
        const fx = Math.floor((px - bx - framePad) / cell);
        const fy = Math.floor((py - by - framePad) / cell);
        if (fx < 0 || fy < 0 || fx > 7 || fy > 7) return null;
        return { x: fx, y: fy };
      },
    },
    buttons,
    footer: { y: btnY, h: btnH },
  };
}

/**
 * 创建一个对局会话。
 * @param options { width, height, insets, difficulty, theme, onEvent }
 */
export function createSession(options = {}) {
  const theme = options.theme ?? THEME;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const level = parseLevel(options.difficulty);
  // 一次性音效实例由集成层注入（可能为 undefined / 方法可能不存在）。
  // 这里统一走 playSfx：任何异常都吞掉 —— 音效绝不能把对局搞崩。
  const sfx = options.sfx ?? null;
  const playSfx = (name) => {
    if (!sfx || typeof sfx.play !== 'function') return;
    try { sfx.play(name); } catch { /* 音效失败静默降级 */ }
  };
  let layout = computeLayout(
    options.width ?? 375,
    options.height ?? 667,
    options.insets ?? { top: 0, bottom: 0 },
  );

  const state = {
    board: createBoard(),
    selected: null,      // {x, y}
    targets: [],         // [{x, y, capture}]
    lastMove: null,
    status: null,        // gameStatus 的返回值
    statusText: '',
    aiThinking: false,
    outcome: null,       // { result, title, detail, score }
    pressIndex: -1,
    hover: null,
    toast: null,
    animT0: 0,           // 落子动画起点（绝对 ms；0 = 本帧不做落子动画）
    animMove: null,      // 正在做落子动画的那一手（给 render.js 判被吃子/易位落点）
    liftT0: 0,           // 选中的子开始抬高的时刻（绝对 ms；0 = 没抬）
    levelName: levelName(level),
  };

  const repKeys = [positionKey(state.board)]; // 局面指纹（三次重复判和）
  let aiAt = 0;       // AI 落子的时间点（0 = 无待办）
  let settled = false;

  /* ── 内部工具 ── */

  const repCount = (key) => {
    let n = 0;
    for (const k of repKeys) if (k === key) n++;
    return n;
  };

  function refreshStatus() {
    const st = gameStatus(state.board, { repetitions: repCount(positionKey(state.board)) });
    state.status = st;
    return st;
  }

  function setToast(text, now, ms = 1400) {
    state.toast = { text, t0: now ?? 0, ms };
  }

  /** 取消选中：连带把「抬起动画」的起点清掉（否则棋子会一直悬着）。 */
  function deselect() {
    state.selected = null;
    state.targets = [];
    state.liftT0 = 0;
  }

  function statusTextNow() {
    if (state.outcome) {
      return state.outcome.title + (state.outcome.detail ? ` · ${state.outcome.detail}` : '');
    }
    if (state.aiThinking) return 'AI 思考中…';
    const st = state.status;
    if (st?.check) {
      return state.board.turn === HUMAN_COLOR ? '被将军，必须应将' : 'AI 被将军';
    }
    return state.board.turn === HUMAN_COLOR ? '轮到你走' : 'AI 回合';
  }

  /** 一局结束：记录结果并上报集成层（只上报一次）。 */
  function settle(st) {
    if (settled) return;
    settled = true;
    const result = st.result === 'draw' ? 'draw' : (st.result === 'white' ? 'win' : 'lose');
    const title = result === 'win' ? '你赢了' : result === 'draw' ? '和棋' : 'AI 获胜';
    const detail = `${st.text || ''} · 共 ${Math.ceil(state.board.history.length / 2)} 回合`;
    state.outcome = {
      result,
      title,
      detail,
      score: result === 'win' ? level * 100 : result === 'draw' ? level * 30 : 0,
    };
    state.aiThinking = false;
    aiAt = 0;
    onEvent(result, { reason: st.reason, moves: state.board.history.length });
  }

  /** 落子后的统一收尾：判胜负 / 排 AI / 提示将军。 */
  function afterMove(now) {
    repKeys.push(positionKey(state.board));
    const st = refreshStatus();
    if (st.over) { settle(st); return; }
    if (state.board.turn !== HUMAN_COLOR) {
      state.aiThinking = true;
      aiAt = (now ?? 0) + (theme.aiThinkMinMs ?? 260);
    } else if (st.check) {
      setToast('将军！', now, 1100);
    }
  }

  function restart(now) {
    state.board = createBoard();
    deselect();
    state.lastMove = null;
    state.outcome = null;
    state.aiThinking = false;
    state.pressIndex = -1;
    state.hover = null;
    state.toast = null;
    state.animT0 = 0;
    state.animMove = null;
    repKeys.length = 0;
    repKeys.push(positionKey(state.board));
    aiAt = 0;
    settled = false;
    refreshStatus();
    setToast('新的一局，你执白先行', now, 1200);
  }

  /** 悔棋：退回玩家回合（通常撤两手：AI 一手 + 自己一手）。 */
  function undoHuman(now) {
    if (state.aiThinking) { setToast('AI 正在思考，稍候再悔', now); return false; }
    if (state.board.history.length === 0) { setToast('还没有可悔的棋', now); return false; }
    let steps = 0;
    while (state.board.history.length > 0 && steps < 2) {
      undoMove(state.board);
      repKeys.pop();
      steps++;
      if (state.board.turn === HUMAN_COLOR) break;
    }
    settled = false;
    state.outcome = null;
    deselect();
    state.animT0 = 0;
    state.animMove = null;
    aiAt = 0;
    state.aiThinking = false;
    state.lastMove = lastMove(state.board) ?? null;
    refreshStatus();
    setToast(`已悔 ${steps} 手`, now, 1100);
    return true;
  }

  /** 认输：直接判负。 */
  function resign(now) {
    if (state.outcome) return;
    settled = true;
    state.aiThinking = false;
    aiAt = 0;
    deselect();
    state.status = { over: true, result: 'black', reason: 'resign', check: false, text: '认输' };
    state.outcome = {
      result: 'lose',
      title: '你认输了',
      detail: 'AI 获胜 · 点「重新开始」再战',
      score: 0,
    };
    onEvent('lose', { reason: 'resign', moves: state.board.history.length });
  }

  /**
   * 选中一格：算出可走点（同一终点只提示一次）。
   * now 用来记「抬起动画」的起点 —— 渲染层据此把选中的子做上浮 + 阴影加大的动画。
   */
  function selectSquare(x, y, now) {
    state.selected = { x, y };
    state.liftT0 = now ?? 0;
    const map = new Map();
    for (const m of legalMovesFrom(state.board, x, y)) {
      const key = `${m.tx},${m.ty}`;
      const capture = !!m.capture;
      const prev = map.get(key);
      if (!prev || (capture && !prev.capture)) map.set(key, { x: m.tx, y: m.ty, capture });
    }
    state.targets = [...map.values()];
    return state.targets.length;
  }

  /** 玩家落子（升变默认升后，findLegalMove 已保留其他升变接口）。 */
  function playHuman(fx, fy, tx, ty, now) {
    const move = findLegalMove(state.board, fx, fy, tx, ty, QUEEN);
    if (!move) return false;
    applyMove(state.board, move);
    deselect();                        // 抬起态立刻结束，接下来交给「落下」动画
    state.lastMove = move;
    state.animMove = move;
    state.animT0 = now ?? 0;
    playSfx(move.capture ? 'capture' : 'tap');   // 吃子撞一下，普通落子一声脆响
    afterMove(now);
    return true;
  }

  /* ── 对外 API ── */

  return {
    /** 屏幕尺寸变化（旋转 / 不同机型）。 */
    resize(width, height, insets = {}) {
      layout = computeLayout(width, height, insets);
    },

    /** 一次点击（抬起）。 */
    tap(x, y, now = 0) {
      // ① 底部按钮优先
      const bi = layout.buttons.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (bi >= 0) {
        state.pressIndex = -1;
        if (bi === 0) restart(now);
        else if (bi === 1) undoHuman(now);
        else if (!state.outcome) resign(now);
        return;
      }

      if (state.outcome) return;                       // 结算后只认「重新开始」
      if (state.aiThinking || state.board.turn !== HUMAN_COLOR) {
        setToast('AI 正在思考…', now, 900);
        return;
      }

      const sq = layout.board.fromScreen(x, y);
      if (!sq) { deselect(); return; } // 点棋盘外 = 取消

      const code = state.board.grid[sq.y][sq.x];
      const mine = code && colorOf(code) === HUMAN_COLOR;
      const sel = state.selected;

      // ② 已选中且有目标 → 落子
      if (sel && state.targets.some((t) => t.x === sq.x && t.y === sq.y)) {
        playHuman(sel.x, sel.y, sq.x, sq.y, now);
        return;
      }

      // ③ 点自己另一个子 → 改选（同格再点则取消）
      if (mine) {
        if (sel && sel.x === sq.x && sel.y === sq.y) {
          deselect();
          return;
        }
        const n = selectSquare(sq.x, sq.y, now);
        if (n === 0) setToast('这个子动不了（可能被牵制）', now, 1300);
        else playSfx('select');          // 真选中（棋子开始抬高）才出声
        return;
      }

      // ④ 点空白 / 对方子（且不是可吃点）→ 取消选择
      if (sel) setToast('这一手走不了', now, 1000);
      deselect();
    },

    /** 按下（做按压反馈）。 */
    press(x, y) {
      state.pressIndex = layout.buttons.findIndex(
        (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h,
      );
    },

    /** 抬起（清除按压态）。 */
    release() {
      state.pressIndex = -1;
    },

    /** 悬停（鼠标环境；小游戏可忽略）。 */
    hover(x, y) {
      state.hover = layout.board.fromScreen(x, y);
    },

    /** 每帧推进：到点了就让 AI 落子（搜索在这里做，不放在 render 里）。 */
    update(now = 0) {
      if (aiAt !== 0 && now >= aiAt && !state.outcome) {
        aiAt = 0;
        const move = chooseMove(state.board, { level });
        state.aiThinking = false;
        if (move) {
          applyMove(state.board, move);
          state.lastMove = move;
          state.animMove = move;
          state.animT0 = now;
          playSfx(move.capture ? 'capture' : 'tap');   // AI 落子同样出声（吃子撞一下）
          afterMove(now);
        }
      }
    },

    /** 绘制整屏。 */
    render(ctx, now = 0) {
      state.statusText = statusTextNow();
      state.levelName = levelName(level);
      renderGame(ctx, layout, state, theme, now);
    },

    /** 顶部信息（集成层不画 HUD，这里供外部读取）。 */
    get hud() {
      const st = state.status;
      let status;
      if (state.outcome) status = state.outcome.title;
      else if (state.aiThinking) status = 'AI 思考中';
      else if (st?.check) status = state.board.turn === HUMAN_COLOR ? '被将军' : 'AI 被将军';
      else status = state.board.turn === HUMAN_COLOR ? '轮到你走' : 'AI 回合';
      const round = Math.max(1, Math.ceil(state.board.history.length / 2));
      return { title: '国际象棋', status, right: `第 ${round} 回合` };
    },

    /** 是否需要持续推帧。 */
    get busy() {
      return state.aiThinking;
    },

    /** 本局结果；未结束返回 null。 */
    get outcome() {
      if (!state.outcome) return null;
      return { result: state.outcome.result, score: state.outcome.score };
    },

    /** 只读调试视图（集成层一般不需要）。 */
    get state() {
      return state;
    },

    /** 销毁：本模块没有定时器，只需清掉待办的 AI 时间点。 */
    destroy() {
      aiAt = 0;
      state.aiThinking = false;
    },
  };
}

export { LEVELS, PIECE_NAMES };
