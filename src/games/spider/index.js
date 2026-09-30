/**
 * 蜘蛛纸牌模块入口：导出 meta（大厅/难度页读它）与 createSession（集成层唯一调用入口）。
 *
 * 分层：
 *   core.js    纯逻辑（发牌 / 移动 / 收牌 / 撤销 / 胜负）——可在 Node 直接跑
 *   render.js  纯绘制（只吃 ctx + layout + view，不持有状态）
 *   本文件     把两者接起来：布局、输入状态机、计时、结果上报
 *
 * 交互约定（移动端点击，不拖拽）：
 *   ① 点尾部「同花降序」牌组里的任意一张 → 选中该牌组（整组上浮高亮）
 *   ② 再点目标列（空列也可）           → 同花降序牌组整体搬过去
 *   ③ 再点同一张                       → 取消选中
 *   ④ 点无效目标列                     → 该列闪红 + 底部提示，选中保持
 *   底部三按钮：重新开始 / 撤销 / 发牌；信息条右侧「提示」胶囊给一步建议。
 *
 * 时间约定（规范 §8）：集成层传入的 now 是 Date.now() 的绝对毫秒时间戳，
 * 所以模块内部的 fallback 时钟也必须是 Date.now()，且 now 必须一路透传到底。
 */
import {
  createSession as createCoreSession, sessionMove, sessionDeal, sessionUndo, sessionReset,
  updateSession, findHint, levelConfig, scoreOf, formatClock,
  movableRunLength,
  PLAYING, WON, STUCK, RUNS_TO_WIN,
} from './core.js';
import { computeLayout, renderFrame, columnAt, hitButton } from './render.js';

/** 点击后的「按错了」提示停留时长（ms）。 */
const REJECT_MS = 420;
/** 小提示文案停留时长（ms）。 */
const TOAST_MS = 1400;
/** 结算后停止推帧的动画时长（ms）。 */
const SETTLE_MS = 1500;

export const meta = {
  id: 'spider',
  name: '蜘蛛纸牌',
  desc: '经典接龙 · 三种花色',
  glyph: '蛛',
  ready: true,
  // 难度页文案：**同时**写清列数、开局空列数（腾挪空间）与花色门数，
  // 三档在这三个维度上都是递增的，玩家一眼知道「难在哪」。
  // （完整配置见 core.js 的 LEVELS[].columns / emptyCols / suits / initialDeal）
  difficulties: [
    { key: 'easy',   name: '简单', desc: '5列 · 2空 · 1花色' },
    { key: 'normal', name: '普通', desc: '7列 · 1空 · 2花色' },
    { key: 'hard',   name: '困难', desc: '9列 · 1空 · 4花色' },
  ],
};

/**
 * 可用时钟。
 * ⚠️ 必须与集成层传入的 `now` 同源：集成层用的是 `Date.now()`（绝对毫秒时间戳）。
 * 早先扫雷用 performance.now()（页面加载后的相对毫秒，可能只有几十），
 * 两者相减得到 1.79e12 这种天文数字，计时器直接显示 497361:46:00。这里统一 Date.now()。
 */
function nowMs() {
  return Date.now();
}

/**
 * 默认随机源（洗牌用）。
 * 与规范第 8 节的「时间要注入」同理：**随机源也必须可注入**，否则测试无法复现牌局。
 * 生产环境每次调用返回 Math.random（每局都不同）；测试里传 mulberry32(seed) 即可完全复现。
 */
function defaultRng() {
  return Math.random;
}

/** 毫秒 → mm:ss（统一走 core 的实现，避免两处各写一份）。 */
function clockText(ms) {
  return formatClock(ms);
}

/**
 * 集成层调用入口（规范 §3 的唯一入口名）。
 *
 * @param options {{width, height, insets, difficulty, theme, onEvent, rng, sfx}}
 *   rng 可选：洗牌随机源。省略时每局退回 Math.random（真机每局不同）；
 *   测试里传 mulberry32(seed) 即可让牌局完全可复现（消除 flaky 测试）。
 *   sfx 可选：集成层的音效实例（src/audio/sfx.js）。**可能不存在**，
 *   且 play() 可能返回 false —— 一律静默降级，绝不让声音影响牌局。
 */
export function createSession(options = {}) {
  const {
    width = 375,
    height = 667,
    insets = { top: 0, bottom: 0 },
    difficulty = 'easy',
    theme = {},
    onEvent = null,
    rng = null,
    sfx = null,
  } = options;

  /**
   * 播一个音效。三种情况都要静默吞掉（不能抛）：
   *   ① 集成层没传 sfx（undefined/null）；② 传了但没有 play 方法；③ play 自己抛异常。
   */
  function playSfx(name) {
    if (!sfx || typeof sfx.play !== 'function') return;
    try { sfx.play(name); } catch (e) { /* 音效失败绝不影响牌局 */ }
  }

  /* ── 会话与视图状态 ── */
  // 注入的随机源：写死一个函数就容易忘记用，所以统一走 pickRng()
  const injectedRng = typeof rng === 'function' ? rng : null;
  const pickRng = () => injectedRng ?? defaultRng();
  let session = createCoreSession(difficulty, pickRng());
  let cfg = levelConfig(difficulty);

  /** 交互态：选中 / 按压 / 提示 / 拒绝反馈 / 文案。 */
  let selection = null;      // { col, index }
  let pressButton = null;    // 底部按钮或提示胶囊的按压态
  let pressCard = null;      // 牌面按压态 { col, index }
  let hint = null;           // { from, index, to, count, until }
  let rejectCol = null;      // 无效落点所在的列
  let rejectAt = 0;
  let toast = null;          // { text, at }
  let lastCollectAt = 0;     // 最近一次收牌的时刻（动效）
  let outcome = null;        // 本局结果（供集成层计分/提示）
  let reported = false;      // 结果是否已上报
  let settleAt = 0;          // 结算动画截止时刻
  let frameNow = 0;          // 最近一次 update 的时间戳
  let dealAnim = null;       // 发牌动画 { startedAt, total }：render 层据此让牌从发牌堆按列序串行飞向各列
  let moveAnim = null;       // 移动动画 { fromCol, toCol, at }：render 层据此做「抬起-滞空-落下」三段动画
  let startAt = 0;           // 首次操作时刻（计时起点）
  let elapsedFrozen = 0;     // 结束时冻结的用时

  /** 当前布局：先不含 view（保守估），首帧后再按真实列高精修。列数按难度传进去（5/7/9）。 */
  let layout = computeLayout(width, height, insets, null, cfg.columns);
  let layoutCounts = null;   // 布局精修用的「各列暗/明张数」，避免每帧重算

  const snap = () => (session.snap ?? updateSession(session, frameNow));

  /** 用时：开始后随帧推进，结束后冻结。 */
  function elapsed() {
    if (elapsedFrozen) return elapsedFrozen;
    if (!startAt) return 0;
    return Math.max(0, frameNow - startAt);
  }

  /** 首次有效操作时开始计时。 */
  function ensureStarted(t) {
    if (!startAt) startAt = t;
  }

  /** 结算：冻结用时、上报集成层、安排动画收尾。 */
  function settle(result, t) {
    if (result !== WON && result !== STUCK) return;
    if (!elapsedFrozen) elapsedFrozen = startAt ? Math.max(0, t - startAt) : 0;
    settleAt = t + SETTLE_MS;
    if (reported) return;
    reported = true;

    const score = result === WON
      ? scoreOf(session.game, elapsedFrozen)
      : Math.round(scoreOf(session.game, elapsedFrozen) * 0.35);
    outcome = {
      result: result === WON ? 'win' : 'lose',
      score,
      detail: {
        collected: session.game.collected,
        moves: session.game.moves,
        elapsedMs: Math.round(elapsedFrozen),
        difficulty: cfg.key,
      },
    };
    if (typeof onEvent === 'function') {
      onEvent(result === WON ? 'win' : 'lose', {
        collected: session.game.collected,
        moves: session.game.moves,
        elapsedMs: Math.round(elapsedFrozen),
        difficulty: cfg.key,
        score,
      });
      onEvent('score', { value: score, difficulty: cfg.key });
    }
    // 音效时机：判负（无路可走且牌堆已空）→ lose。胜局不重复出声（最后一次收牌已出 win）。
    if (result === STUCK) playSfx('lose');
  }

  /** 收牌动效 + 结算判定 + 音效（每次走子/发牌后统一走这里）。 */
  function afterAction(r, t) {
    if (!r.ok) return;
    ensureStarted(t);
    if (r.collected > 0) lastCollectAt = t;
    updateSession(session, t);
    settle(session.game.result, t);
    // 音效时机：收走一组 → win；普通移动/发牌 → tap（一次操作只出一个声，避免叠音）
    playSfx(r.collected > 0 ? 'win' : 'tap');
  }

  /** 清掉一次性的视觉反馈。 */
  function clearFeedback() {
    hint = null;
    rejectCol = null;
    rejectAt = 0;
  }

  /** 显示一句小提示。 */
  function say(text, t) {
    toast = { text, at: t };
  }

  /** 重新开始（不传难度则沿用当前难度）。 */
  function restart(nextKey, t) {
    sessionReset(session, nextKey ?? session.game.key, pickRng());
    cfg = levelConfig(session.game.key);
    selection = null;
    pressButton = null;
    pressCard = null;
    clearFeedback();
    toast = null;
    lastCollectAt = 0;
    outcome = null;
    reported = false;
    settleAt = 0;
    startAt = 0;
    elapsedFrozen = 0;
    layoutCounts = null;
    updateSession(session, t ?? frameNow);
  }

  /** 撤销（撤销到底自然就没有历史，回不到别的局面）。 */
  function doUndo(t) {
    const r = sessionUndo(session);
    selection = null;
    clearFeedback();
    if (!r.ok) { say('没有可撤销的操作了', t); return; }
    updateSession(session, t);
    say('已撤销上一步', t);
  }

  /**
   * 发牌（规则变更：空列不再是障碍 —— 只要发牌堆够一整轮就能发，
   * 空列也会收到牌并被自然填上。见 core.js 的 canDeal/deal 注释）。
   */
  function doDeal(t) {
    const r = sessionDeal(session);
    selection = null;
    clearFeedback();
    if (!r.ok) {
      say(r.reason === 'stock' ? '发牌堆不够一轮了' : '现在不能发牌', t);
      return;
    }
    // 记录发牌动画起点：render 层据此让新发的牌从发牌堆（发牌按钮处）
    // 按列序串行飞向第 1..N 列，每张错开 DEAL_STEP_MS（见 render.js）
    dealAnim = { startedAt: t, total: session.game.columns.length };
    afterAction(r, t);
    if (r.collected > 0) say(`收走一组！还差 ${Math.max(0, RUNS_TO_WIN - session.game.collected)} 组`, t);
  }

  /** 点提示：第一次给出建议，1.6 秒内再点就照着走一步。 */
  function doHint(t) {
    const h = findHint(session.game);
    if (!h) { say('没有可走的牌了，试试发牌或撤销', t); return; }
    if (hint && hint.from === h.from && hint.index === h.index && hint.to === h.to && t < hint.until) {
      const r = sessionMove(session, h.from, h.index, h.to);
      selection = null;
      clearFeedback();
      afterAction(r, t);
      return;
    }
    hint = { ...h, until: t + 1600 };
    say('再点一次「提示」就照走', t);
  }

  /** 选中尾巴牌组：index 必须落在「可整体搬动」的区间里。 */
  function selectFrom(colIndex, cardIndex, t) {
    const col = session.game.columns[colIndex];
    const len = movableRunLength(col, cardIndex);
    if (len <= 0) {
      const topLen = movableRunLength(col, col.length - 1);
      say(topLen > 0 ? '只能搬动同花色且降序的连牌' : '这一列没有可搬动的牌组', t);
      return;
    }
    selection = { col: colIndex, index: cardIndex };
    playSfx('select');   // 音效时机：选中一段可搬的牌组
  }

  /** 尝试把选中的牌组落到目标列。 */
  function tryMove(colIndex, t) {
    const sel = selection;
    if (!sel || sel.col === colIndex) return false;
    const r = sessionMove(session, sel.col, sel.index, colIndex);
    if (!r.ok) {
      // 无效落点：选中保持，只做闪红与提示，避免手一抖就丢选中
      rejectCol = colIndex;
      rejectAt = t;
      const reasonText = r.reason === 'rank'
        ? '点数要小 1 才能压上去'
        : (r.reason === 'suit' ? '这一档难度必须同花色' : '这里放不了');
      say(reasonText, t);
      return false;
    }
    selection = null;
    clearFeedback();
    moveAnim = { fromCol: sel.col, toCol: colIndex, at: t };
    afterAction(r, t);
    return true;
  }

  /** 组装渲染视图（render.js 只读它）。 */
  function buildView() {
    const s = snap();
    return {
      key: s.key,
      columns: s.columns,
      stock: s.stock,
      dealsLeft: s.dealsLeft,
      canDeal: s.canDeal,
      collected: s.collected,
      remainingRuns: s.remainingRuns,
      moves: s.moves,
      canUndo: s.canUndo,
      undoLeft: (session.game.history ? session.game.history.length : 0),
      result: s.result,
      cardsLeft: s.cardsLeft,
      // 本节信息
      levelName: cfg.name,
      requireSameSuit: s.requireSameSuit,
      elapsedMs: elapsed(),
      // 交互态
      selection,
      pressButton,
      pressCard,
      // 发牌动画（render 层据此让新发的牌飞入；null 表示无动画）
      dealAnim,
      // 移动动画（render 层据此让整叠牌飞过去；null 表示无动画）
      moveAnim,
      hint: hint && frameNow < hint.until ? hint : null,
      rejectCol,
      rejectAt,
      toast,
      lastCollectAt,
      winAt: session.winAt,
      stuckAt: session.stuckAt,
    };
  }

  /**
   * 布局精修：列越堆越高时要压缩间距，所以得拿真实快照重算一次。
   * 用「各列暗牌/明牌张数」判断要不要重算——render 每帧都会走到这里，
   * 所以**不拼字符串**（旧版每帧 20+ 次字符串拼接 + 分配），改成逐列比数字，
   * 结构没变就直接返回（O(列数)，零分配）。
   */
  function refreshLayout(s) {
    const cols = s.columns;
    let changed = !layoutCounts || layoutCounts.length !== cols.length * 2;
    if (!changed) {
      for (let i = 0; i < cols.length; i++) {
        if (layoutCounts[i * 2] !== cols[i].faceDown || layoutCounts[i * 2 + 1] !== cols[i].faceUp) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    if (!layoutCounts || layoutCounts.length !== cols.length * 2) layoutCounts = new Array(cols.length * 2);
    for (let i = 0; i < cols.length; i++) {
      layoutCounts[i * 2] = cols[i].faceDown;
      layoutCounts[i * 2 + 1] = cols[i].faceUp;
    }
    layout = computeLayout(layout.width, layout.height, layout.safe, s, cfg.columns);
  }

  /* ── 对外接口（严格对齐规范 §3） ── */
  return {
    /** 屏幕尺寸变化（旋转 / 不同机型）：自己重算布局。 */
    resize(w, h, ins = null) {
      layout = computeLayout(w, h, ins ?? layout.safe, snap(), cfg.columns);
      layoutCounts = null;
      selection = null;
      pressButton = null;
      pressCard = null;
    },

    /** 按下：记录起点（按钮按压 / 牌面按压反馈）。 */
    press(x, y) {
      const btn = hitButton(layout, x, y);
      if (btn) { pressButton = btn; pressCard = null; return; }
      pressButton = null;
      const hit = columnAt(layout, snap(), x, y);
      pressCard = hit ? { col: hit.col, index: hit.index } : null;
    },

    /** 抬起：清除按压态（真正的动作在 tap 里判定）。 */
    release() {
      pressButton = null;
      pressCard = null;
    },

    /** 悬停（鼠标环境）：移动端没有，这里只在牌面上做轻微反馈。 */
    hover(x, y) {
      const hit = columnAt(layout, snap(), x, y);
      pressCard = hit ? { col: hit.col, index: hit.index, hover: true } : null;
    },

    /** 一次点击（抬起）。 */
    tap(x, y, now) {
      const t = typeof now === 'number' ? now : nowMs();
      frameNow = t;
      pressButton = null;
      pressCard = null;

      // 1) 底部按钮与提示胶囊
      const btn = hitButton(layout, x, y);
      if (btn) {
        if (btn === 'restart') { playSfx('click'); restart(null, t); return; }
        if (session.game.result !== PLAYING) return;   // 终局后只允许重开
        if (btn === 'undo') { playSfx('click'); doUndo(t); }
        else if (btn === 'deal') doDeal(t);            // 发牌音效在 afterAction 里统一出
        else if (btn === 'hint') { playSfx('click'); doHint(t); }
        return;
      }

      // 2) 终局后点牌桌 → 直接重开（比找按钮顺手）
      if (session.game.result !== PLAYING) { restart(null, t); return; }

      const hit = columnAt(layout, snap(), x, y);
      if (!hit) { selection = null; clearFeedback(); return; }

      hint = null;   // 玩家自己动手了，提示退场

      // 点中已选中的那张 = 取消选中；点同列的别的牌 = 改选那一段
      if (selection && selection.col === hit.col) {
        if (selection.index === hit.index) {
          selection = null;
          return;
        }
        selectFrom(hit.col, hit.index, t);
        return;
      }
      // 已选中且点了别的列 → 尝试落牌（选中保持，方便换个落点再试）
      if (selection) {
        tryMove(hit.col, t);
        return;
      }
      selectFrom(hit.col, hit.index, t);
    },

    /** 每帧推进（计时 / 提示过期 / 结算动画）。 */
    update(now) {
      const t = typeof now === 'number' ? now : nowMs();
      frameNow = t;
      session.now = t;
      const s = updateSession(session, t);
      refreshLayout(s);
      if (hint && t >= hint.until) hint = null;
      if (rejectCol != null && t - rejectAt > REJECT_MS) { rejectCol = null; rejectAt = 0; }
      if (toast && t - toast.at > TOAST_MS) toast = null;
      if (session.game.result !== PLAYING) settle(session.game.result, t);
    },

    /** 绘制自己那一块（牌桌 / 牌叠 / 收集区 / 按钮）。背景与结算弹窗由集成层画。 */
    render(ctx, now) {
      const t = typeof now === 'number' ? now : frameNow;
      renderFrame(ctx, layout, buildView(), theme, t);
    },

    /** 顶部信息（集成层不画 HUD，这里供外部读取）。 */
    get hud() {
      const g = session.game;
      const s = snap();
      const status = g.result === WON ? `完成 · ${RUNS_TO_WIN} 组`
        : g.result === STUCK ? '无路可走'
          : `已收 ${g.collected}/${RUNS_TO_WIN} 组 · 牌堆 ${s.stock}`;
      return { title: meta.name, status, right: clockText(elapsed()) };
    },

    /** 是否需要持续推帧：有动效或交互反馈时需要，静置时不需要。 */
    get busy() {
      if (pressButton || pressCard || selection || hint || toast) return true;
      if (rejectCol != null) return true;
      if (session.game.result !== PLAYING) return settleAt === 0 || frameNow < settleAt;
      if (lastCollectAt && frameNow - lastCollectAt < 800) return true;
      return startAt > 0 && !elapsedFrozen;   // 计时在走
    },
    /** 本局结果（没有结果时 null）。 */
    get outcome() {
      return outcome;
    },

    /** 销毁：清掉交互态，不再上报。 */
    destroy() {
      selection = null;
      pressButton = null;
      pressCard = null;
      clearFeedback();
      toast = null;
      settleAt = 0;
      outcome = null;
      reported = true;
    },

    /* 只读辅助（不在规范里，供调试/集成层取用） */
    get difficulty() { return session.game.key; },
    get snapshot() { return snap(); },
    get layoutSize() { return { cardW: layout.cardW, cardH: layout.cardH, table: layout.table }; },
  };
}
