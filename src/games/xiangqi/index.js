/**
 * 中国象棋模块入口：导出 meta 与 createSession（严格遵守《游戏模块规范》第 2、3 节）。
 *
 * 玩法：玩家执红（下方）先行，AI 执黑。
 *   点自己的棋子 → 显示可走点；点目标位置 → 落子；再点自己另一颗子 → 改选；点空白 → 取消。
 *   底部三个胶囊按钮：重新开始 / 悔棋 / 认输。
 *
 * 边界（规范要求）：
 *   - 左上角返回、右上角齿轮由集成层绘制，本模块不画；
 *   - 自己画的所有内容都从 insets 让位，底部按钮下方留出 insets.bottom + 16。
 */
import {
  createBoard, makeMove, undo, movesOf, pseudoMovesOf, findKing, lastMove as coreLastMove,
  LEVELS, chooseMove, parseLevel, RED, BLACK, EMPTY, sideOf,
} from './core.js';
import { computeLayout, hitButton, pickPoint, renderFrame, ANIM } from './render.js';
import { THEME } from '../../ui/theme.js';

export const meta = {
  id: 'xiangqi',
  name: '中国象棋',
  desc: '人机对弈 · 五档棋力',
  glyph: '象',
  ready: true,
  // 棋类难度 = AI 强度，key 统一用 lv1..lv5
  difficulties: [
    { key: 'lv1', name: '简单', desc: '随手应招，会漏吃漏防' },
    { key: 'lv2', name: '普通', desc: '也算一步，只看眼前吃子' },
    { key: 'lv3', name: '困难', desc: '两步预判，会算反击' },
    { key: 'lv4', name: '地狱', desc: '三步搜杀，少给机会' },
    { key: 'lv5', name: '亚洲', desc: '全盘候选 + 深算，几乎不失误' },
  ],
};

export function createSession(options = {}) {
  const theme = options.theme ?? THEME;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

  // 一次性音效（选中/落子/吃子）。集成层可能不注入（浏览器预览、静音环境），
  // 所以统一走 playSfx：没有实例、没有 play 方法、play 抛异常——三种情况一律静默降级，
  // 音效绝不能把对局搞崩（与 chess 模块保持同一套写法，全站行为一致）。
  const sfx = options.sfx ?? null;
  const playSfx = (name) => {
    if (!sfx || typeof sfx.play !== 'function') return;
    try { sfx.play(name); } catch { /* 音效失败静默降级 */ }
  };

  let width = options.width ?? 375;
  let height = options.height ?? 667;
  let insets = options.insets ?? { top: 0, bottom: 0 };
  let layout = computeLayout(width, height, insets);

  const MIN_THINK_MS = theme.aiThinkMinMs ?? 260;          // AI 至少"想"这么久，避免瞬间落子
  const MOVE_ANIM_MS = (theme.placeAnimMs ?? 160) + 80;

  const state = {
    // 牌面
    board: createBoard(),
    humanSide: RED,
    aiSide: BLACK,
    level: parseLevel(options.difficulty ?? 2),
    // 交互
    selected: null,
    targets: [],
    pressIndex: -1,
    thinking: false,
    pendingAiAt: 0,
    toast: null,
    overT0: 0,
    busyUntil: 0,
    // 派生（每帧渲染前刷新，供绘制层读取）
    lastMove: null,
    check: false,
    checkKing: null,
    statusText: '轮到你走',
    buttonLabels: ['重新开始', '悔棋', '认输'],
    buttonDisabled: [false, true, false],
    /**
     * 动画状态（渲染层只读，进度由传入的 now 推算，本会话只负责"什么时候开始"）：
     *   pick   选中上浮：{ x, y, t0 } —— 一直保持抬起，直到落子或取消
     *   settle 取消/换选后落回原位：{ x, y, t0 }
     *   drop   落子飞行：{ fx, fy, tx, ty, piece, cap, t0, lift0 }
     * 早前只有一个 pieces:Map 做"落子弹一下"，现由 drop 动画替代（形态更完整）。
     */
    anim: { pick: null, settle: null, drop: null },
  };

  let emitted = false;   // 本局结果是否已上报（重开/悔棋后复位）

  /* ───────── 内部工具 ───────── */

  function showToast(text, now = 0, ms = 1500) {
    state.toast = { text, t0: now || Date.now(), ms };
  }

  /** 清空全部动画状态：重开 / 悔棋 / 认输 / 销毁时用，避免旧动画作用到新局面上。 */
  function clearAnim() {
    state.anim.pick = null;
    state.anim.settle = null;
    state.anim.drop = null;
  }

  /**
   * 把「抬起的那颗子」平滑放回原位。
   * 为什么不是直接清掉 pick：直接清会让棋子"啪"地瞬移回棋盘，
   * 所以把抬起量交给 settle 用 170ms 收回——玩家看到的是它自己落回去。
   */
  function releasePick(now) {
    const p = state.anim.pick;
    state.anim.pick = null;
    if (!p) return;
    state.anim.settle = { x: p.x, y: p.y, t0: now };
    state.busyUntil = Math.max(state.busyUntil, now + ANIM.settleMs);
  }

  /**
   * 起一次落子动画。
   * @param piece 移动的棋子编码；cap 被吃掉的棋子编码（没有传 0）
   * @param lift0 起点抬起量（0~1）：玩家落子时棋子本来就抬着，传 1；AI 落子传 0
   * 位移终点恒为目标格——盘面已经按规则落定了，动画只影响"看得见的飞行"。
   */
  function startDrop(fromX, fromY, toX, toY, piece, cap, now, lift0 = 0) {
    if (!piece) return;
    state.anim.drop = {
      fx: fromX, fy: fromY, tx: toX, ty: toY,
      piece, cap: cap || 0, t0: now, lift0,
    };
    state.busyUntil = Math.max(state.busyUntil, now + ANIM.dropTotalMs);
  }

  /** 取消选择：抬起的棋子平滑放回（换选也走这里，先把上一颗放回去）。 */
  function clearSelection(now) {
    releasePick(now);
    state.selected = null;
    state.targets = [];
  }

  function statusText() {
    const b = state.board;
    if (b.status.over) {
      if (b.status.reason === 'draw') return '和棋';
      if (b.status.reason === 'resign') return '你认输了';
      return b.status.winner === state.humanSide ? '你赢了' : '你输了';
    }
    if (state.thinking) return 'AI 思考中…';
    if (b.check) return b.turn === state.humanSide ? '将军！请应将' : '将军！AI 应将';
    return b.turn === state.humanSide ? '轮到你走' : 'AI 走棋';
  }

  function computeOutcome() {
    const b = state.board;
    if (!b.status.over) return null;
    if (b.status.reason === 'draw' || b.status.winner === EMPTY) return { result: 'draw', score: 0 };
    return { result: b.status.winner === state.humanSide ? 'win' : 'lose', score: b.status.winner === state.humanSide ? 1 : 0 };
  }

  /** 每帧渲染前刷新派生字段（渲染层只读，不自己算）。 */
  function syncDerived(now) {
    const b = state.board;
    state.lastMove = coreLastMove(b);
    state.check = !!b.check;
    state.checkKing = b.check ? findKing(b, b.turn) : null;
    state.statusText = statusText();
    state.buttonDisabled = [false, state.thinking || b.history.length === 0, false];
    if (state.toast && now - state.toast.t0 > state.toast.ms) state.toast = null;

    // 过期的一次性动画清掉。
    // ⚠️ pick 不在清理之列——它必须在落子/取消之前一直保持（那正是"棋子被举着"的状态）。
    const a = state.anim;
    if (a.settle && now - a.settle.t0 > ANIM.settleMs) a.settle = null;
    if (a.drop && now - a.drop.t0 > ANIM.dropTotalMs) a.drop = null;
  }

  function finish(now) {
    state.thinking = false;
    state.pendingAiAt = 0;
    state.overT0 = now || Date.now();
    // 结算后仍然推帧 900ms：集成层的统一结算弹窗有淡入动画（本模块自己不再画浮层）
    state.busyUntil = state.overT0 + 900;
    if (!emitted) {
      emitted = true;
      const out = computeOutcome();
      if (onEvent && out) {
        try { onEvent(out.result, { ...out, moves: state.board.history.length }); } catch { /* 上报失败不影响对局 */ }
      }
    }
  }

  function restart(now = 0) {
    state.board = createBoard();
    state.selected = null;
    state.targets = [];
    state.toast = null;
    state.thinking = false;
    state.pendingAiAt = 0;
    state.pressIndex = -1;
    state.overT0 = 0;
    state.busyUntil = now + MOVE_ANIM_MS;
    clearAnim();
    emitted = false;
    syncDerived(now);
    return { ok: true };
  }

  function doUndo(now = 0) {
    if (state.thinking) return { ok: false, reason: 'thinking' };
    if (state.board.history.length === 0) return { ok: false, reason: 'empty' };

    // 回退到轮到自己走（最多两手：AI 的应招 + 自己那一手）
    let steps = 0;
    while (steps < 2 && state.board.history.length > 0) {
      undo(state.board);
      steps++;
      if (state.board.turn === state.humanSide) break;
    }

    state.selected = null;
    state.targets = [];
    state.toast = null;
    state.thinking = false;
    state.pendingAiAt = 0;
    state.overT0 = 0;
    state.busyUntil = now + MOVE_ANIM_MS;
    clearAnim();
    emitted = false;
    syncDerived(now);
    return { ok: true, steps };
  }

  function doResign(now = 0) {
    if (state.board.status.over) return { ok: false, reason: 'over' };
    state.board.status = { over: true, winner: state.aiSide, reason: 'resign', text: '认输' };
    state.selected = null;
    state.targets = [];
    clearAnim();
    finish(now);
    syncDerived(now);
    return { ok: true };
  }

  function selectAt(x, y, now) {
    releasePick(now);                     // 换选：先把上一颗平滑放回棋盘
    state.selected = { x, y };
    state.targets = movesOf(state.board, x, y);
    // 选中即"抬手"：上浮动画从这里开始，一直保持到落子/取消
    state.anim.pick = { x, y, t0: now };
    state.busyUntil = Math.max(state.busyUntil, now + ANIM.pickMs);
    playSfx('select');                    // 抬手的同时出声，视听同步
    if (state.targets.length === 0) showToast('这颗子没有可走的点', now);
    return state.targets.length;
  }

  /** 玩家落子。 */
  function play(move, now) {
    // 动画要用的信息必须在 makeMove **之前**取：走子之后原格已空、目标格也已换人
    const mover = state.board.grid[move.fy]?.[move.fx] ?? EMPTY;
    const cap = state.board.grid[move.ty]?.[move.tx] ?? EMPTY;
    // 玩家点的是自己抬起来的那颗子时，落子动画从"抬起态"起飞（lift0=1），才有抬高再落下的连续感
    const p = state.anim.pick;
    const lift0 = p && p.x === move.fx && p.y === move.fy ? 1 : 0;

    const r = makeMove(state.board, move.fx, move.fy, move.tx, move.ty);
    if (!r.ok) {
      showToast('这一步走不了', now);
      return { type: 'illegal', reason: r.reason };
    }
    state.selected = null;
    state.targets = [];
    state.toast = null;
    state.anim.pick = null;               // 抬手态交给落子动画接管，不再单独绘制
    state.anim.settle = null;
    startDrop(move.fx, move.fy, move.tx, move.ty, mover, cap, now, lift0);
    playSfx(cap !== EMPTY ? 'capture' : 'tap');   // 吃子撞一下，普通落子一声脆响

    if (state.board.status.over) {
      finish(now);
    } else if (state.board.turn !== state.humanSide) {
      state.thinking = true;
      state.pendingAiAt = now + MIN_THINK_MS;
    }
    syncDerived(now);
    return { type: 'move', fx: move.fx, fy: move.fy, tx: move.tx, ty: move.ty };
  }

  /* ───────── 对外 API ───────── */

  const api = {
    resize(w, h, ins = insets) {
      width = w;
      height = h;
      insets = ins ?? insets;
      layout = computeLayout(width, height, insets);
    },

    tap(x, y, now = 0) {
      // ① 底部按钮优先（结算后仍然可用）
      const idx = hitButton(layout, x, y);
      if (idx >= 0) {
        state.pressIndex = -1;
        if (idx === 0) return { type: 'restart', ...restart(now) };
        if (idx === 1) return { type: 'undo', ...doUndo(now) };
        return { type: 'resign', ...doResign(now) };
      }

      if (state.board.status.over) return { type: 'over' };
      if (state.thinking || state.board.turn !== state.humanSide) return { type: 'blocked' };

      const g = pickPoint(layout, x, y);
      if (!g) {
        // 点棋盘外/离交叉点太远：取消选择（抬起的子平滑落回）
        clearSelection(now);
        return { type: 'cancel' };
      }

      const piece = state.board.grid[g.y][g.x];

      // ② 点自己的棋子：改选；再点同一颗：取消
      if (piece !== EMPTY && sideOf(piece) === state.humanSide) {
        if (state.selected && state.selected.x === g.x && state.selected.y === g.y) {
          clearSelection(now);
          return { type: 'deselect' };
        }
        selectAt(g.x, g.y, now);
        return { type: 'select', x: g.x, y: g.y, targets: state.targets.length };
      }

      // ③ 已选中时点目标位置：落子
      if (state.selected) {
        const target = state.targets.find((m) => m.tx === g.x && m.ty === g.y);
        if (target) return play(target, now);

        // 规则允许但会送将：给一句提示再取消
        const raw = pseudoMovesOf(state.board, state.selected.x, state.selected.y)
          .some((m) => m.tx === g.x && m.ty === g.y);
        if (raw) showToast(state.board.check ? '被将军，必须应将' : '这一步会让自己被将军', now);
        clearSelection(now);
        return { type: 'cancel' };
      }

      return { type: 'miss' };
    },

    press(x, y) {
      state.pressIndex = hitButton(layout, x, y);
    },

    release() {
      state.pressIndex = -1;
    },

    hover(x, y) {
      // 鼠标环境：仅记录悬停点，绘制层暂不依赖它（触屏无此事件）
      const g = pickPoint(layout, x, y);
      state.hover = g ? { x: g.x, y: g.y } : null;
    },

    update(now = 0) {
      if (!state.thinking) return;
      if (state.board.status.over) { state.thinking = false; return; }
      if (now < state.pendingAiAt) return;

      state.pendingAiAt = 0;
      const move = chooseMove(state.board, state.aiSide, { level: state.level });
      state.thinking = false;

      if (move) {
        // 同样是「先取动画素材、再走子」：走完盘面就变了
        const mover = state.board.grid[move.fy]?.[move.fx] ?? EMPTY;
        const cap = state.board.grid[move.ty]?.[move.tx] ?? EMPTY;
        const r = makeMove(state.board, move.fx, move.fy, move.tx, move.ty);
        // AI 的子本来贴地放着，lift0=0：让它从棋盘上"提起来"飞过去再落下
        if (r.ok) {
          startDrop(move.fx, move.fy, move.tx, move.ty, mover, cap, now, 0);
          playSfx(cap !== EMPTY ? 'capture' : 'tap');   // AI 落子同样出声（吃子撞一下）
        }
      }
      if (state.board.status.over) finish(now);
      syncDerived(now);
    },

    render(ctx, now = 0) {
      syncDerived(now);
      renderFrame(ctx, layout, state, theme, now);
    },

    /** 顶部信息（集成层不画 HUD，这里只给外部读取）。 */
    get hud() {
      const lv = LEVELS[state.level] ?? LEVELS[2];
      return {
        title: '中国象棋',
        status: statusText(),
        right: `${state.board.history.length} 手 · ${lv.name}`,
      };
    },

    /**
     * 是否需要持续推帧：思考中、被将军的呼吸环、刚结算的动画，
     * 以及**正在进行的棋子动画**（选中上浮 / 取消落回 / 落子飞行）。
     * 靠 busyUntil 统一兜：上面三处 startDrop / releasePick / selectAt 都会把它往后推。
     */
    get busy() {
      const b = state.board;
      return state.thinking || (b.check && !b.status.over) || Date.now() < state.busyUntil;
    },

    /** 本局结果（未分胜负时返回 null）。 */
    get outcome() {
      return computeOutcome();
    },

    get board() { return state.board; },
    get layout() { return layout; },

    destroy() {
      clearAnim();
      state.thinking = false;
      state.pendingAiAt = 0;
    },
  };

  syncDerived(0);
  return api;
}
