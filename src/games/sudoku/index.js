/**
 * 数独模块入口：导出 meta（大厅/难度页读它）与 createSession（集成层唯一调用入口）。
 *
 * 分层：
 *   core.js    纯逻辑（出题、求解、候选、填充/擦除/标记、错填、胜利、提示、计时数据）
 *   render.js  纯绘制（只吃 ctx + layout + view）
 *   本文件     把两者接起来：布局、输入、计时透传、结果上报
 *
 * 交互约定（移动端）：
 *   点格子       = 选中
 *   点数字键     = 落子（自动跳到下一个空格）
 *   标记模式开   = 点数字键改成「切换候选标记」
 *   擦除键       = 清空该格的数字与标记
 *   底部三键     = 重新开始 / 提示 / 标记模式开
 *
 * ⚠️ 时间约定（规范 §8）：集成层传进来的 now 是 Date.now() 的绝对毫秒时间戳，
 *    本文件一路透传到底（含重开、提示、标记后的脏标记刷新），
 *    内部 fallback 也用 Date.now()，绝不用 performance.now()。
 *
 * ⚠️ 新 UI 约定：本模块只画盘面 + 键盘 + 底部按钮，
 *    不画全屏背景、不画结算弹窗、不画左上返回键与右上齿轮（都由集成层负责）。
 */
import {
  createGameSession, updateGame, sessionPlace, sessionErase, sessionNote, sessionHint,
  restartGame, elapsedMs, formatTime, levelConfig, LEVELS,
  PLAYING, WON, SIZE, EMPTY,
} from './core.js';
import { computeLayout, renderFrame, gridAt, hitKey, hitButton, buttonOf, keyOf } from './render.js';

export const meta = {
  id: 'sudoku',
  name: '数独',
  desc: '经典推理 · 唯一解出题',
  glyph: '数',
  ready: true,
  // 难度 = 挖空数量（每道题都经求解器验证唯一解）
  difficulties: [
    { key: 'easy', name: '简单', desc: '挖空 35 格 · 基础推理' },
    { key: 'normal', name: '普通', desc: '挖空 45 格 · 需要候选数' },
    { key: 'hard', name: '困难', desc: '挖空 52 格 · 步步为营' },
  ],
};

/** 标记模式的提示条文案。 */
const MARK_HINT = '标记模式：点数字 = 切换该格候选';

/** 与集成层同源的时钟 fallback（绝不能换成 performance.now）。 */
function nowMs() {
  return Date.now();
}

/**
 * 集成层调用入口（规范 §3 的唯一入口名）。
 *
 * @param options {{width, height, insets, difficulty, theme, onEvent}}
 */
export function createSession(options = {}) {
  const {
    width = 375,
    height = 667,
    insets = { top: 0, bottom: 0 },
    difficulty = 'normal',
    theme = {},
    onEvent = null,
  } = options;

  /* ── 会话与视图状态 ── */
  let session = createGameSession(difficulty);
  let cfg = levelConfig(difficulty);
  let layout = computeLayout(width, height, insets, 0);

  let selected = null;      // 选中格 {r, c}
  let markMode = false;     // 标记模式开关
  let hover = null;         // 悬停态（鼠标环境）
  let pressCell = null;     // 盘面按压态
  let pressKey = null;      // 数字键按压态
  let pressButton = null;   // 底部按钮按压态
  let frameNow = 0;         // 最近一次 update 的时间戳
  let outcome = null;       // 本局结果（供集成层结算）
  let reported = false;     // 结果是否已上报
  let winAt = 0;            // 胜利时刻（供集成层做动效）
  let flash = null;         // 落子闪现 {r, c, at}（错填时给一眼提示）
  let lastFeedback = '';    // 最近一次操作的简短反馈（hud 用）

  /* ── 布局重算（标记模式要占一条提示位置） ── */
  function relayout(w = layout.width, h = layout.height, ins = layout.safe) {
    layout = computeLayout(w, h, ins, markMode ? 1 : 0);
  }
  relayout();

  /* ── 内部工具 ── */

  const snap = () => (session.game.snap ?? updateGame(session, frameNow));

  /** 组装渲染视图（render.js 只读它）。 */
  function buildView() {
    const s = snap();
    const g = session.game;
    return {
      grid: s.grid,
      given: s.given,
      wrong: s.wrong,
      notes: s.notes,
      remaining: s.remaining,
      filled: s.filled,
      empty: s.empty,
      wrongCount: s.wrongCount,
      hints: s.hints,
      status: s.status,
      difficulty: s.difficulty,
      difficultyName: cfg.name,
      elapsed: elapsedMs(g.timer, frameNow),
      // 交互态
      selected,
      hover,
      pressCell,
      pressKey,
      pressButton,
      markMode,
      flash,
    };
  }

  /** 当前选中格的候选数（给 hud / 调试用）。 */
  function hintText() {
    if (session.game.status === WON) return '已完成';
    if (markMode) return MARK_HINT;
    if (!selected) return `${cfg.name} · 点格子开始`;
    return `已选 R${selected.r + 1}C${selected.c + 1}`;
  }

  /** 状态栏文案（hud 供集成层读）。 */
  function statusText() {
    const ms = elapsedMs(session.game.timer, frameNow);
    if (session.game.status === WON) return `完成 · ${formatTime(ms)}`;
    return `空 ${snap().empty} 格 · ${formatTime(ms)}`;
  }

  /** 结算：上报集成层（弹窗由集成层画，本模块只给 outcome）。 */
  function settle(now) {
    if (reported) return;
    reported = true;
    winAt = now;
    const res = session.outcome;
    outcome = res ?? {
      result: 'win',
      score: 0,
      detail: { difficulty: cfg.key },
    };
    if (typeof onEvent === 'function') {
      onEvent('win', { ...(outcome.detail ?? {}) });
      onEvent('score', { value: outcome.score ?? 0, difficulty: cfg.key });
    }
  }

  /** 重新开始（不传难度则沿用当前难度）。 */
  function restart(nextKey) {
    const key = nextKey ?? session.game.puzzle.difficulty;
    restartGame(session, key, null);
    cfg = levelConfig(key);
    selected = null;
    hover = null;
    pressCell = null;
    pressKey = null;
    pressButton = null;
    flash = null;
    lastFeedback = '';
    winAt = 0;
    outcome = null;
    reported = false;
    markMode = false;          // 重开回到「落子」模式，避免用户还停在标记模式
    relayout();                // 标记模式关了，提示条位置也要收掉
    updateGame(session, frameNow);
  }

  /** 落子后跳到下一个空格（同行优先，再全盘行主序），返回新选中格或 null。 */
  function nextEmptyFrom(r, c) {
    const grid = session.game.grid;
    if (c + 1 < SIZE) {
      for (let cc = c + 1; cc < SIZE; cc++) if (grid[r][cc] === EMPTY) return { r, c: cc };
    }
    for (let rr = 0; rr < SIZE; rr++) {
      for (let cc = 0; cc < SIZE; cc++) if (grid[rr][cc] === EMPTY) return { r: rr, c: cc };
    }
    return null;
  }

  /** 一次落子。 */
  function doPlace(v, now) {
    if (!selected) { lastFeedback = '先点一个格子'; return; }
    const { r, c } = selected;
    const res = sessionPlace(session, r, c, v, now);
    if (!res.ok) {
      if (res.reason === 'given') lastFeedback = '这是题面数字';
      else if (res.reason === 'occupied') lastFeedback = '先擦掉再填';
      else if (res.reason === 'over') lastFeedback = '本局已结束';
      return;
    }
    flash = { r, c, at: now, bad: !!res.wrong };
    if (res.wrong) lastFeedback = `${v} 不对`;
    else lastFeedback = '';
    if (res.win) {
      settle(now);
      return;                                  // 胜利后不再跳格
    }
    const nxt = nextEmptyFrom(r, c);
    selected = nxt;
  }

  /* ── 对外接口（严格对齐规范） ── */
  return {
    /** 屏幕尺寸变化（旋转 / 不同机型）：自己重算布局。 */
    resize(w, h, ins = null) {
      relayout(w, h, ins ?? layout.safe);
      pressCell = null;
      pressKey = null;
      pressButton = null;
    },

    /** 按下：给盘面格 / 数字键 / 底部按钮做按压反馈。 */
    press(x, y) {
      const btn = hitButton(layout, x, y);
      if (btn) { pressButton = btn; pressCell = null; pressKey = null; return; }
      const key = hitKey(layout, x, y);
      if (key) { pressKey = key; pressCell = null; pressButton = null; return; }
      pressCell = gridAt(layout, x, y);
      pressKey = null;
      pressButton = null;
    },

    /** 抬起：清除按压态（真正的动作在 tap 里判定）。 */
    release() {
      pressCell = null;
      pressKey = null;
      pressButton = null;
    },

    /** 悬停（鼠标环境）：只做高亮。 */
    hover(x, y) {
      hover = gridAt(layout, x, y);
    },

    /** 清除悬停（集成层在指针离开画布时调）。 */
    clearHover() {
      hover = null;
    },

    /** 一次点击（抬起）。now 由集成层传入，必须一路透传。 */
    tap(x, y, now) {
      const t = typeof now === 'number' && Number.isFinite(now) ? now : nowMs();

      // 1) 底部按钮
      const btn = hitButton(layout, x, y);
      if (btn) {
        pressButton = null;
        pressCell = null;
        pressKey = null;
        if (btn === 'restart') {
          restart();
        } else if (btn === 'hint') {
          if (session.game.status !== PLAYING) { lastFeedback = '本局已结束'; return; }
          const res = sessionHint(session, selected ? selected.r : -1, selected ? selected.c : -1, t);
          if (res.ok) {
            flash = { r: res.r, c: res.c, at: t, bad: false, hint: true };
            selected = res.win ? null : nextEmptyFrom(res.r, res.c);
            lastFeedback = '';
            if (res.win) settle(t);
          } else {
            lastFeedback = res.reason === 'full' ? '已经填满了' : '没有可提示的格子';
          }
        } else if (btn === 'mark') {
          markMode = !markMode;
          relayout();
          lastFeedback = '';
        }
        updateGame(session, t);
        return;
      }

      // 2) 数字键盘
      const key = hitKey(layout, x, y);
      pressKey = null;
      pressCell = null;
      pressButton = null;
      if (key) {
        if (session.game.status !== PLAYING) return;
        if (key === 'erase') {
          if (!selected) { lastFeedback = '先点一个格子'; return; }
          const res = sessionErase(session, selected.r, selected.c, t);
          lastFeedback = res.ok ? '' : (res.reason === 'given' ? '这是题面数字' : '');
          updateGame(session, t);
          return;
        }
        const v = Number(key);
        if (markMode) {
          if (!selected) { lastFeedback = '先点一个格子'; return; }
          const res = sessionNote(session, selected.r, selected.c, v, t);
          lastFeedback = res.ok ? '' : (res.reason === 'given' ? '题面数字不能标记' : res.reason === 'occupied' ? '先擦掉再标记' : '');
          updateGame(session, t);
          return;
        }
        doPlace(v, t);
        updateGame(session, t);
        return;
      }

      // 3) 盘面：点格子选中；**再点同一格 = 取消选中**（用户要求：填错后能回到"无选中"状态，
      //    否则光标一直挂着，看起来像消不掉）
      const cell = gridAt(layout, x, y);
      hover = cell;
      if (!cell) return;
      if (selected && selected.r === cell.r && selected.c === cell.c) {
        selected = null;
        lastFeedback = '';
        return;
      }
      selected = cell;
      lastFeedback = '';
    },

    /** 每帧推进（计时刷新 + 脏快照重建）。 */
    update(now) {
      const t = typeof now === 'number' && Number.isFinite(now) ? now : nowMs();
      frameNow = t;
      updateGame(session, t);
      // 落子闪现 260ms 后自动消失
      if (flash && t - flash.at > 260) flash = null;
    },

    /** 绘制整屏（盘面 + 键盘 + 底部按钮；不含背景/弹窗/返回齿轮）。 */
    render(ctx, now) {
      const t = typeof now === 'number' && Number.isFinite(now) ? now : frameNow;
      renderFrame(ctx, layout, buildView(), theme, t);
    },

    /** 顶部信息（集成层不画 HUD，这里供外部读取）。 */
    get hud() {
      return {
        title: '数独',
        status: statusText(),
        right: hintText(),
      };
    },

    /** 是否需要持续推帧：计时在走、或有闪现动效时需要。 */
    get busy() {
      if (session.game.status === PLAYING) return true;   // 计时在走
      return !!flash || (winAt > 0 && frameNow - winAt < 1200);
    },

    /** 本局结果（没有结果时 null）。 */
    get outcome() {
      return outcome;
    },

    /** 销毁：清掉交互态，不再上报。 */
    destroy() {
      selected = null;
      hover = null;
      pressCell = null;
      pressKey = null;
      pressButton = null;
      flash = null;
      outcome = null;
      reported = true;
    },

    /* 只读辅助（不在规范里，供调试/测试取用） */
    get difficulty() { return session.game.puzzle.difficulty; },
    get snapshot() { return snap(); },
    get layoutRef() { return layout; },
    get currentPuzzle() { return session.game.puzzle; },
    get markMode() { return markMode; },
    get selectedCell() { return selected; },
  };
}

/* 便于测试与集成层引用 */
export { LEVELS, SIZE, buttonOf, keyOf };
