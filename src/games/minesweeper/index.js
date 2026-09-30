/**
 * 扫雷模块入口：导出 meta（大厅/难度页读它）与 createSession（集成层唯一调用入口）。
 *
 * 分层：
 *   core.js    纯逻辑（雷局、翻开、连锁、插旗、胜负、计时数据）——可在 Node 直接跑
 *   render.js  纯绘制（只吃 ctx + layout + view）
 *   本文件     把两者接起来：布局、输入、动画计时、结果上报
 *
 * 交互约定（移动端没有右键，所以必须给「标旗模式」开关）：
 *   点按          = 翻开
 *   长按 ≥ 400ms  = 插旗 / 拔旗（手指抖动超阈值则作废）
 *   标旗模式打开后 = 点按即插旗，方便单手连续布雷
 */
import {
  createSession as createCoreSession, sessionReveal, sessionFlag, sessionReset, updateSession,
  elapsedMs, formatTime, levelConfig,
  PLAYING, WON, LOST,
} from './core.js';
import { computeLayout, renderFrame, gridAt, hitButton } from './render.js';

export const meta = {
  id: 'minesweeper',
  name: '扫雷',
  desc: '经典推理 · 三种难度',
  glyph: '雷',
  ready: true,
  difficulties: [
    { key: 'easy', name: '初级', desc: '9×9 · 10 雷' },
    { key: 'medium', name: '中级', desc: '12×12 · 25 雷' },
    { key: 'hard', name: '高级', desc: '16×16 · 50 雷' },
  ],
};

/** 长按判定阈值（ms）。 */
const LONG_PRESS_MS = 400;
/** 按下后允许的抖动（逻辑像素）；超过即视为滑动，不触发长按。 */
const MOVE_SLOP = 14;
/** 结算后的终局动画窗口（ms）：只保证爆炸等动画播完，窗口结束后**不**自动重开。 */
const RESULT_ANIM_MS = 1500;

/**
 * 可用时钟。
 * ⚠️ 必须与集成层传入的 `now` 同源：集成层用的是 `Date.now()`（绝对毫秒时间戳），
 * 早先这里用 `performance.now()`（页面加载后的相对毫秒，可能只有几十），
 * 两者相减会得到 1.79e12 这种天文数字，计时器直接显示 497361:46:00。
 * 所以统一用 Date.now()。
 */
function nowMs() {
  return Date.now();
}

/** 取一个随机源。每次重开都调一次，保证长玩不会反复出现同一套雷局。 */
function freshRandom() {
  return Math.random;
}

/**
 * 集成层调用入口（规范 §3 的唯一入口名）。
 *
 * 坐标约定：tap/press/hover/release 收到的是逻辑像素、已含 insets 让位；
 * 命中判定在 gridAt / hitButton 里做，落在自己的控件外就直接忽略。
 *
 * 时间约定：now 由集成层传（与 requestAnimationFrame 同源）；不传时退回 performance.now()，
 * 保证单测/预览里直接调 tap 也能工作。
 *
 * @param options {{width, height, insets, difficulty, theme, onEvent}}
 */
export function createSession(options = {}) {
  const sfx = options.sfx ?? null;   // 一次性音效（用户要：翻格=铲土、失败=爆炸）；可为 null，必须静默降级
  const {
    width = 375,
    height = 667,
    insets = { top: 0, bottom: 0 },
    difficulty = 'easy',
    theme = {},
    onEvent = null,
  } = options;

  /* ── 会话与视图状态 ── */
  let session = createCoreSession(difficulty, freshRandom());
  let cfg = levelConfig(difficulty);
  let layout = computeLayout(width, height, insets, cfg.cols, cfg.rows);

  let flagMode = false;     // 标旗模式开关
  let press = null;         // 网格按压态 {x, y, t, longFired}
  let hover = null;         // 悬停态（鼠标环境）
  let pressButton = null;   // 底部按钮按压态
  let revealT0 = 0;         // 首点翻开时刻（整体点亮动效）
  let winT0 = 0;
  let loseT0 = 0;
  let outcome = null;       // 本局结果（供集成层计分/提示）
  let reported = false;     // 结果是否已上报
  let animUntil = 0;        // 动画/自动重开的截止时刻
  let frameNow = 0;         // 最近一次 update 的时间戳

  /* ── 内部工具 ── */

  const snap = () => (session.snap ?? updateSession(session, frameNow));

  /** 剩余雷数文案。 */
  function statusText() {
    const ms = elapsedMs(session.timer, frameNow);
    if (session.board.result === WON) return `排雷成功 · ${formatTime(ms)}`;
    if (session.board.result === LOST) return `踩雷了 · ${formatTime(ms)}`;
    return `剩余 ${snap().remaining} 雷 · ${formatTime(ms)}`;
  }

  /** 简易计分：越快越高，难度加成（仅供集成层展示）。 */
  function scoreOf(ms) {
    const factor = cfg.key === 'hard' ? 3 : cfg.key === 'medium' ? 2 : 1;
    return Math.max(10, 1000 - Math.round(ms / 100)) * factor;
  }

  /** 结算：记录时间点、上报集成层；只安排终局动画窗口，不自动重开。 */
  function settle(result, now) {
    if (result === WON) { winT0 = now; animUntil = now + RESULT_ANIM_MS; }
    else { loseT0 = now; animUntil = now + Math.max(RESULT_ANIM_MS, 900); }

    if (reported) return;
    reported = true;

    const ms = elapsedMs(session.timer, now);
    const score = result === WON ? scoreOf(ms) : 0;
    outcome = {
      result: result === WON ? 'win' : 'lose',
      score,
      detail: { elapsedMs: Math.round(ms), difficulty: cfg.key },
    };
    if (typeof onEvent === 'function') {
      onEvent(result === WON ? 'win' : 'lose', {
        elapsedMs: Math.round(ms),
        difficulty: cfg.key,
        score,
      });
      onEvent('score', { value: score, difficulty: cfg.key });
    }
  }

  /** 重新开始（不传难度则沿用当前难度）。 */
  function restart(nextKey) {
    const key = nextKey ?? session.board.key;
    sessionReset(session, key, freshRandom());
    cfg = levelConfig(key);
    layout = computeLayout(layout.width, layout.height, layout.safe, cfg.cols, cfg.rows);
    flagMode = false;
    press = null;
    hover = null;
    pressButton = null;
    revealT0 = 0;
    winT0 = 0;
    loseT0 = 0;
    animUntil = 0;
    outcome = null;
    reported = false;
    updateSession(session, frameNow);
  }

  /** 在网格上落一次操作：isLong 为真表示插旗，否则按当前模式决定。 */
  function actOnGrid(gx, gy, isLong, now) {
    if (session.board.result !== PLAYING) return;

    const wantFlag = isLong || flagMode;
    const wasFirstOpen = !session.board.planted && !wantFlag;

    // ⚠️ now 必须一路透传到底：sessionReveal 内部首点会 startTimer(now)，
    // 漏传就会用默认值 0，计时起点变成 1970 年（实机表现为 497361:46:00）。
    const r = wantFlag
      ? sessionFlag(session, gx, gy, now)
      : sessionReveal(session, gx, gy, now);
    if (!r.ok) return;

    // 音效（用户要求：点击=铲土声、失败=爆炸声）
    if (sfx) {
      if (wantFlag) sfx.play('click');
      else if (r.win) sfx.play('win');
      else if (r.lose) sfx.play('boom');
      else sfx.play('dig');
    }

    if (wasFirstOpen) revealT0 = now;   // 首点翻开 → 点亮动效
    updateSession(session, now);

    if (r.win) settle(WON, now);
    else if (r.lose) settle(LOST, now);
  }

  /** 组装渲染视图：快照 + 交互态 + 动画时间戳（render.js 只读它）。 */
  function buildView() {
    const s = snap();
    return {
      // 棋盘（只读快照）
      cols: s.cols,
      rows: s.rows,
      grid: s.grid,
      mineTotal: s.mineTotal,
      remaining: s.remaining,
      flags: s.flags,
      revealedCount: s.revealedCount,
      progress: s.progress,
      result: s.result,
      boom: s.boom,
      safeTotal: s.rows * s.cols - s.mineTotal,
      // 本节信息
      levelName: cfg.name,
      flagMode,
      elapsed: elapsedMs(session.timer, frameNow),
      // 交互态
      press,
      hover,
      pressButton,
      // 动画起点
      revealT0,
      winT0,
      loseT0,
    };
  }

  /* ── 对外接口（严格对齐规范） ── */
  return {
    /** 屏幕尺寸变化（旋转 / 不同机型）：自己重算布局。 */
    resize(w, h, ins = null) {
      layout = computeLayout(w, h, ins ?? layout.safe, layout.grid.cols, layout.grid.rows);
      press = null;
      hover = null;
      pressButton = null;
    },

    /** 按下：记录起点（长按判定 + 按压反馈）。 */
    press(x, y) {
      const btn = hitButton(layout, x, y);
      if (btn) { pressButton = btn; press = null; return; }
      const cell = gridAt(layout, x, y);
      press = cell
        ? { x: cell.x, y: cell.y, px: x, py: y, t: nowMs(), longFired: false }
        : null;
    },

    /** 抬起：清除按压态（真正的动作在 tap 里判定）。 */
    release() {
      press = null;
      pressButton = null;
    },

    /** 悬停（鼠标环境）：只做高亮 + 记录手指是否滑出了按压格（滑出即作废这次操作）。 */
    hover(x, y) {
      const cell = gridAt(layout, x, y);
      hover = cell;
      if (press && (!cell || cell.x !== press.x || cell.y !== press.y)) press.moved = true;
    },

    /** 一次点击（抬起）。 */
    tap(x, y, now) {
      const t = typeof now === 'number' ? now : nowMs();

      // 1) 底部按钮
      const btn = hitButton(layout, x, y);
      if (btn) {
        pressButton = null;
        press = null;
        if (btn === 'restart') restart();
        else if (btn === 'flagMode' && session.board.result === PLAYING) flagMode = !flagMode;
        return;
      }

      // 2) 网格
      const cell = gridAt(layout, x, y);
      const sameCell = !!(press && cell && press.x === cell.x && press.y === cell.y && !press.moved);
      const isLong = !!(sameCell && t - press.t >= LONG_PRESS_MS);
      press = null;
      pressButton = null;
      hover = cell;
      if (!cell) return;

      // 结算后点网格 = 立刻重开（比等自动重开顺手）
      if (session.board.result !== PLAYING) {
        restart();
        return;
      }
      actOnGrid(cell.x, cell.y, isLong, t);
    },

    /** 每帧推进（计时 / 长按判定 / 自动重开）。 */
    update(now) {
      const t = typeof now === 'number' ? now : nowMs();
      frameNow = t;
      session.now = t;
      if (session.dirty || !session.snap) updateSession(session, t);

      // 长按到点即插旗（不等抬手，手感更跟手）；首点之前长按不布雷，必须先有一次翻开
      if (press && !press.longFired && !press.moved && session.board.result === PLAYING) {
        if (session.board.planted && t - press.t >= LONG_PRESS_MS) {
          press.longFired = true;
          actOnGrid(press.x, press.y, true, t);
          press = null;
        }
      }

      // ⚠️ 不再自动重开：结算后由集成层统一弹窗决定（「再来一局 / 回到主界面」）。
      // 早先这里 1.5 秒后自动 restart()，会把集成层的结算弹窗顶掉，用户根本来不及点。
      // animUntil 仅保留给结算动画（见 busy 的判定）。
    },

    /** 绘制本模块负责的部分（网格 / HUD / 爆炸特效 / 按钮）；背景与统一结算弹窗由集成层画。 */
    render(ctx, now) {
      const t = typeof now === 'number' ? now : frameNow;
      renderFrame(ctx, layout, buildView(), theme, t);
    },

    /** 顶部信息（集成层不画 HUD，这里供外部读取）。 */
    get hud() {
      return {
        title: '扫雷',
        status: statusText(),
        right: formatTime(elapsedMs(session.timer, frameNow)),
      };
    },

    /** 是否需要持续推帧。 */
    get busy() {
      if (session.board.result !== PLAYING) {
        return animUntil === 0 || frameNow < animUntil;   // 结算动画期间持续推帧
      }
      if (session.board.planted) return true;             // 开局后计时在走
      return !!press || !!hover || flagMode;              // 待开局时只有交互态需要刷
    },

    /** 本局结果（没有结果时 null）。 */
    get outcome() {
      return outcome;
    },

    /** 销毁：清掉交互态，不再上报。 */
    destroy() {
      press = null;
      hover = null;
      pressButton = null;
      animUntil = 0;
      outcome = null;
      reported = true;
    },

    /* 只读辅助（不在规范里，供调试/集成层取用） */
    get difficulty() { return session.board.key; },
    get snapshot() { return snap(); },
    get layoutSize() { return layout.grid; },
  };
}
