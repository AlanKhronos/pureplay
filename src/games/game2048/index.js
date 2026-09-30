/**
 * 2048 模块入口：导出 meta（大厅/难度页读它）与 createSession（集成层唯一调用入口）。
 *
 * 分层：
 *   core.js    纯逻辑（滑行合并、生成、计分、胜负、撤销）——可在 Node 直接跑
 *   render.js  纯绘制（只吃 ctx + layout + view，只画棋盘区域）
 *   本文件     把两者接起来：布局、输入（滑动/点击/键盘）、动画计时、结果上报
 *
 * 交互约定：
 *   在棋盘上滑动   = 朝该方向合并一次（滑动手势是唯一的主要移动方式；键盘方向键由集成层转发到 key）
 *   点底部按钮     = 重新开始 / 撤销
 *
 * 集成约定（新 UI）：
 *   不画全屏背景、不画结算弹窗、不画左上返回与右上齿轮——这些由集成层统一负责，
 *   本模块只把结果通过 outcome / onEvent 交出去。
 *
 * 时间约定（规范 §8）：所有时间都从入口透传到底，内部 fallback 时钟只用 Date.now()，
 * 绝不用 performance.now()（相对毫秒，与绝对时间戳相减会得到天文数字）。
 */
import {
  createGame, move, undo, canUndo, snapshot, statusText, setGrid, coordKey,
  difficultyConfig, DEFAULT_DIFFICULTY, DIFFICULTIES,
  PLAYING, WON, LOST, LEFT, RIGHT, UP, DOWN, DIRECTIONS,
} from './core.js';
import { computeLayout, hitButton, hitRect, renderFrame, directionFor } from './render.js';

export const meta = {
  id: 'game2048',
  name: '2048',
  desc: '滑动合并 · 三档目标',
  glyph: '合',
  ready: true,
  difficulties: [
    { key: 'easy',   name: '简单', desc: '4×4 · 目标 512' },
    { key: 'normal', name: '普通', desc: '4×4 · 目标 2048' },
    { key: 'hard',   name: '困难', desc: '5×5 · 目标 4096' },
  ],
};

/**
 * 可用时钟。
 * ⚠️ 必须与集成层传入的 `now` 同源：集成层用 Date.now()（绝对毫秒时间戳）。
 * 早先用 performance.now() 出过「计时器显示 497361:46:00」的事故，故统一 Date.now()。
 */
function nowMs() {
  return Date.now();
}

/** 取一个随机源。每次重开都调一次，保证长玩不会反复出现同一盘开局。 */
function freshRandom() {
  return Math.random;
}

/**
 * 集成层调用入口（规范 §3 的唯一入口名）。
 *
 * @param options {{width, height, insets, difficulty, theme, onEvent}}
 *   width/height 逻辑像素；insets = { top, bottom } 安全区
 *   difficulty   难度 key（与 meta.difficulties 的 key 一致）
 *   theme        对局主题令牌
 *   onEvent(type, payload)  可选：'win' / 'lose' / 'score' / 'move' / 'undo' / 'restart'
 */
export function createSession(options = {}) {
  const sfx = options.sfx ?? null;   // 一次性音效（可为 null，必须静默降级）
  const {
    width = 375,
    height = 667,
    insets = { top: 0, bottom: 0 },
    difficulty = DEFAULT_DIFFICULTY,
    theme = {},
    onEvent = null,
  } = options;

  /* ── 会话状态 ── */
  let cfg = difficultyConfig(difficulty);
  let game = createGame({ difficulty: cfg.key === difficulty ? difficulty : DEFAULT_DIFFICULTY, rng: freshRandom() });
  let layout = computeLayout(width, height, insets, cfg.size);

  let pressButton = null;     // 底部按钮的按压态
  let pressBoard = null;      // 棋盘上的按下点 {x, y, t}
  let frameNow = 0;           // 最近一次 update 的时间戳
  let gain = null;            // 得分飘字 {value, at}
  let settleAt = 0;           // 结算时刻（结果带淡入用）
  let reached = 0;            // 达成的目标值
  let outcome = null;         // 本局结果（集成层读它计分/提示）
  let reported = false;       // 结果是否已上报
  let winReported = false;    // 达成目标是否已上报
  let animUntil = 0;          // 动画截止时刻（过了就不必再推帧）
  let destroyed = false;

  /* ── 内部工具 ── */

  /** 当前时间：优先用集成层透传的 now，没传才退回 Date.now()。 */
  const timeOf = (now) => (Number.isFinite(now) ? now : (frameNow || nowMs()));

  /** 重开一局（沿用当前难度）。 */
  function restart() {
    game = createGame({ difficulty: cfg.key, rng: freshRandom() });
    pressButton = null;
    pressBoard = null;
    gain = null;
    settleAt = 0;
    reached = 0;
    outcome = null;
    reported = false;
    winReported = false;
    animUntil = 0;
    if (typeof onEvent === 'function') onEvent('restart', { difficulty: cfg.key });
  }

  /** 达成目标：只上报一次，对局不锁死（可以继续冲更高分）。 */
  function onReached(value, now) {
    if (winReported) return;
    winReported = true;
    reached = value;
    settleAt = now;
    animUntil = Math.max(animUntil, now + 900);
    if (reported) return;
    reported = true;
    outcome = { result: 'win', score: game.score, target: game.target, moves: game.moves };
    if (typeof onEvent === 'function') {
      onEvent('win', { score: game.score, target: game.target, moves: game.moves });
      onEvent('score', { value: game.score, difficulty: cfg.key });
    }
  }

  /** 判负：无空格且无相邻同值。 */
  function onLost(now) {
    if (reported) return;
    reported = true;
    settleAt = now;
    animUntil = Math.max(animUntil, now + 900);
    outcome = { result: 'lose', score: game.score, target: game.target, moves: game.moves };
    if (typeof onEvent === 'function') onEvent('lose', { score: game.score, target: game.target, moves: game.moves });
  }

  /** 执行一次移动：动画时间起点、飘字、胜负上报都在这里统一处理。 */
  function doMove(dir, now) {
    if (game.result === LOST) return { ok: false, reason: 'over' };
    const t = timeOf(now);
    const r = move(game, dir, t);
    if (!r.ok) return r;

    if (r.gained > 0) gain = { value: r.gained, at: t };
    animUntil = Math.max(animUntil, t + 260);
    if (typeof onEvent === 'function') {
      onEvent('move', { dir, gained: r.gained, score: game.score });
    }
    if (r.reached) onReached(r.reached, t);
    if (game.result === LOST) onLost(t);
    return r;
  }

  /** 撤销一步。 */
  function doUndo(now) {
    if (!canUndo(game)) return { ok: false, reason: 'empty' };
    const t = timeOf(now);
    const r = undo(game);
    if (!r.ok) return r;
    gain = null;
    // 撤销回到未达成状态时要放掉「已上报」的锁，否则重走达成后不再上报
    if (!game.reachedTarget && game.result !== LOST) { reported = false; outcome = null; }
    if (game.result === PLAYING) { winReported = false; reached = 0; settleAt = 0; }
    animUntil = Math.max(animUntil, t + 200);
    if (typeof onEvent === 'function') onEvent('undo', { score: game.score, moves: game.moves });
    return r;
  }

  /** 组装渲染视图（render.js 只读它）。 */
  function buildView(now) {
    const s = snapshot(game, now);
    return {
      size: s.size,
      cells: s.cells,
      score: s.score,
      best: s.best,
      moves: s.moves,
      target: s.target,
      result: s.result,
      reachedTarget: s.reachedTarget,
      canUndo: s.canUndo,
      levelName: cfg.name,
      // 交互态与动画
      pressButton,
      gain,
      settleAt,
      reached,
      now,
    };
  }

  /* ── 对外接口（严格对齐规范） ── */

  return {
    /** 屏幕尺寸变化（旋转 / 不同机型）：自己重算布局。 */
    resize(w, h, ins = null) {
      layout = computeLayout(w, h, ins ?? layout.safe, cfg.size);
      pressButton = null;
      pressBoard = null;
    },

    /** 按下：按钮做按压反馈；棋盘记下起点（滑动判定用）。 */
    press(x, y) {
      const btn = hitButton(layout, x, y);
      if (btn) { pressButton = btn; pressBoard = null; return; }
      pressBoard = hitRect(layout.board, x, y) ? { x, y, t: timeOf(null) } : null;
    },

    /** 抬起：只清按压态（真正的动作在 tap / gesture 里判定）。 */
    release() {
      pressButton = null;
      pressBoard = null;
    },

    /** 悬停：触摸端无悬停，本模块也不需要落点预览，忽略。 */
    hover() {},

    /** 一次点击（抬起）。 */
    tap(x, y, now) {
      const t = timeOf(now);
      const btn = hitButton(layout, x, y);
      pressButton = null;
      pressBoard = null;

      if (btn === 'restart') { restart(); return { type: 'restart' }; }
      if (btn === 'undo') return { type: 'undo', ...doUndo(t) };

      // 点棋盘：手机上没有「键盘」，给一次轻提示（不改变盘面）
      if (hitRect(layout.board, x, y)) return { type: 'board-tap' };
      return { type: 'miss' };
    },

    /**
     * 滑动（触摸滑动 / 鼠标拖拽）。
     * 集成层拿到按下与抬起的坐标后调这里；也可只在抬起时调一次。
     * @returns {{type:'move',dir,moved:boolean}} 或 {type:'miss'}
     */
    gesture(x0, y0, x1, y1, now) {
      const t = timeOf(now);
      const dir = directionFor(x1 - x0, y1 - y0);
      if (!dir) return { type: 'miss', reason: 'tiny' };
      const r = doMove(dir, t);
      return { type: 'move', dir, ...r };
    },

    /**
     * 键盘/方向键输入（集成层的 keydown 或游戏内方向按钮都走这里）。
     * 传 'ArrowLeft' / 'left' / 'Left' 都能识别大小写与别名。
     * @returns {{type:'move',dir,moved:boolean}} 方向无法识别时 {type:'miss'}
     */
    key(name, now) {
      const key = String(name ?? '').toLowerCase().replace('arrow', '');
      const dir = key.includes('left') ? LEFT
        : key.includes('right') ? RIGHT
          : key.includes('up') ? UP
            : key.includes('down') ? DOWN : null;
      if (!dir) return { type: 'miss', reason: 'key' };
      const t = timeOf(now);
      const r = doMove(dir, t);
      return { type: 'move', dir, ...r };
    },

    /** 每帧推进：只在这里做时间相关的事，render 里不做重计算。 */
    update(now) {
      if (destroyed) return;
      frameNow = timeOf(now);
    },

    /** 绘制整屏（背景 / 结算弹窗 / 返回键 / 齿轮都不画，由集成层负责）。 */
    render(ctx, now) {
      const t = timeOf(now);
      frameNow = t;
      renderFrame(ctx, layout, buildView(t), theme, t);
    },

    /** 顶部信息（集成层不画 HUD，这里供外部读取）。 */
    get hud() {
      return {
        title: meta.name,
        status: statusText(game),
        right: `${game.score}`,
      };
    },

    /** 是否需要持续推帧：只有动画/飘字期间才要，静止时不空转。 */
    get busy() {
      if (destroyed) return false;
      if (animUntil && frameNow < animUntil) return true;
      if (gain) return frameNow < gain.at + 700;
      return false;
    },

    /** 本局结果；未出结果时 null。 */
    get outcome() {
      return outcome;
    },

    /** 销毁：清掉交互态，不再上报。 */
    destroy() {
      destroyed = true;
      pressButton = null;
      pressBoard = null;
      gain = null;
      animUntil = 0;
    },

    /* 只读辅助（不在规范里，供集成层/调试取用） */
    get difficulty() { return cfg.key; },
    get snapshot() { return snapshot(game, frameNow); },
    get layoutSize() { return layout.board; },
  };
}

/* 再导出一些常量，方便集成层/测试直接引用（不影响规范要求） */
export { DIFFICULTIES, DIRECTIONS, PLAYING, WON, LOST, setGrid, coordKey };
