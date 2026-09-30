/**
 * 俄罗斯方块 · 模块入口
 *
 * 遵守《游戏模块规范》：只导出 meta 与 createSession；
 * 本模块自己不画左上角返回 / 右上角齿轮（由集成层绘制），
 * 也不读写任何平台 API——所有平台差异都由集成层注入。
 */
import {
  createState, start, togglePause, moveLeft, moveRight, rotate, softDrop,
  hardDrop, tick, restart, statusText,
} from './core.js';
import { computeLayout, hitButton, renderFrame } from './render.js';
export const meta = {
  id: 'tetris',
  name: '俄罗斯方块',
  desc: '经典落块 · 四种速度',
  glyph: '块',
  ready: true,
  difficulties: [
    { key: 'chill',  name: '悠闲', desc: '900ms · 慢慢想' },
    { key: 'normal', name: '普通', desc: '650ms · 经典速度' },
    { key: 'fast',   name: '快速', desc: '420ms · 手要快' },
    { key: 'turbo',  name: '极速', desc: '260ms · 眼疾手快' },
  ],
};

/**
 * 创建一局俄罗斯方块。
 * @param options { width, height, insets, difficulty, theme, onEvent }
 * @returns 规范里的会话对象（resize / tap / press / release / hover / update / render / hud / busy / outcome / destroy）
 */
export function createSession(options = {}) {
  const { onEvent } = options;
  const difficulty = options.difficulty ?? 'normal';
  const theme = options.theme ?? {};
  const insets = options.insets ?? {};
  const width = options.width ?? 375;
  const height = options.height ?? 667;

  const state = createState({ difficulty });
  start(state);

  let layout = computeLayout(width, height, insets);
  let pressKey = null;     // 当前按下的按钮 key（做按压反馈）
  let lastNow = 0;
  let lastFrame = 0;       // 上一帧的墙钟时间，用来算 dt
  let reported = false;    // 本局结果只上报一次
  let softHoldKey = null;  // 正被按住的加速键（null = 没按住）
  let softHoldDropped = false;  // 本次按住期间是否已经真的落过格（判断"点一下"）

  /** 消行时给渲染层一个墙钟时间戳（core 的 elapsed 与墙钟不同源）。 */
  const syncFlash = (res) => {
    if (res && res.cleared > 0) state.flashWallAt = lastNow;
  };

  const doRestart = () => {
    reported = false;
    restart(state, Math.floor(Math.random() * 1e9));
    start(state);
    state.overAt = 0;
    state.flashWallAt = 0;
    state.pausedAt = undefined;
    pressKey = null;
    softHoldKey = null;      // 别把上一局的「按住加速」带进新一局
    softHoldDropped = false;
  };

  /**
   * 按下加速键：开始「按住加速」。
   * core 里的 tick 一看到 state.softDropping 就把下落间隔缩到 1/10，
   * 所以这里只需要开关这个标记，不用自己维护第二套计时（那才是容易跑偏的写法）。
   */
  const beginSoftHold = () => {
    state.softDropping = true;
    softHoldKey = 'soft';
    softHoldDropped = false;
  };

  const press = (x, y) => {
    const key = hitButton(layout, x, y);
    pressKey = key;
    if (!key) return;                       // 落在棋盘上不触发任何动作
    // 未开局或刚结束时：任意按钮先开一局，避免玩家对着死界面点
    if (state.status === 'over') doRestart();
    else if (state.status === 'ready') start(state);
    if (key === 'soft') beginSoftHold();     // 加速键是"按住生效"的，见 release()
  };

  const tap = (x, y) => {
    const key = hitButton(layout, x, y);
    pressKey = null;
    if (!key) return;
    if (state.status === 'over') { doRestart(); return; }

    switch (key) {
      case 'left':
        moveLeft(state);
        break;
      case 'right':
        moveRight(state);
        break;
      case 'rotate':
        rotate(state, 1);
        break;
      case 'soft':
        // 加速键完全由 press/release 处理（按住加速 + 短按补一格），
        // 这里故意不重复触发，否则一次点击会掉两格。
        break;
      case 'drop': {
        // 「到底」：一步落到底并立即锁定
        const res = hardDrop(state);
        syncFlash(res);
        if (state.status === 'over') finish();   // 硬降锁块后可能直接顶死
        break;
      }
      case 'pause':
        if (state.status === 'ready') start(state);
        else togglePause(state);
        if (state.status === 'paused') state.pausedAt = lastNow;
        break;
      default:
        break;
    }
  };

  /** 游戏结束：上报一次。 */
  const finish = () => {
    if (reported) return;
    reported = true;
    state.overAt = lastNow;
    if (typeof onEvent === 'function') {
      onEvent('lose', { score: state.score, lines: state.lines, level: state.level });
    }
  };

  return {
    /** 屏幕尺寸变化（旋转 / 不同机型）：重算内部布局。 */
    resize(w, h, nextInsets = {}) {
      layout = computeLayout(w, h, nextInsets);
      pressKey = null;
    },

    tap,
    press,

    release() {
      // 加速键松开：① 关掉加速；② 若这次按住短到「一格都没落」（浏览器/触屏点一下就是
      // 这种情形：press 与 release 落在同一帧里），补落一格——否则玩家会觉得按钮没反应。
      // 补的这一格走 core 的 softDrop（同样是软降、同样只加 SOFT_DROP_SCORE 分），不额外造规则。
      if (softHoldKey === 'soft') {
        state.softDropping = false;
        if (!softHoldDropped && state.status === 'playing') softDrop(state);
        softHoldKey = null;
      }
      pressKey = null;
    },

    hover() {
      // 触摸端无悬停；浏览器预览也不做落点预览，忽略。
    },

    /** 每帧推进：只在这里做计时与状态机，render 里不做重计算。 */
    update(now) {
      const t = now > 0 ? now : lastNow;
      const dt = lastFrame > 0 ? Math.min(200, Math.max(0, t - lastFrame)) : 0;
      lastFrame = t;
      lastNow = t;
      if (state.status === 'over') { finish(); return; }
      if (state.status !== 'playing') return;
      const res = tick(state, dt);
      // 按住加速期间只要真的推进过（落格或锁定），就记一笔：
      // release() 靠它判断这一按是不是"短到没落格"，决定要不要补一格。
      if (res.steps > 0 && softHoldKey === 'soft') softHoldDropped = true;
      if (res.cleared > 0) state.flashWallAt = t;
      // tick 内部可能因为「新块出生即被堵」而结束，所以要按状态判断而不是看返回值
      if (state.status === 'over') finish();
    },

    /** 绘制整屏（背景 / 棋盘 / HUD / 按钮 / 浮层都由本模块画）。 */
    render(ctx, now) {
      state.pressKey = pressKey;
      // 规范 §8：动画一律用**传入的 now**（与集成层的 Date.now 同源）。
      // 旧写法这里传的是 lastNow（update 里记的），一旦集成层 update/render 不同源就会跑偏；
      // 现在以 render 收到的 now 为准，只在没传时退回 lastNow。
      // 下落插值不需要另算：它是 core 的 dropAcc（由传入 now 累加出来）算出来的。
      const t = typeof now === 'number' && now > 0 ? now : lastNow;
      if (state.status === 'paused' && state.pausedAt === undefined) state.pausedAt = t;
      if (state.status === 'over' && !state.overAt) state.overAt = t;
      renderFrame(ctx, layout, state, theme, t);
    },

    /** 顶部信息（集成层不画 HUD，这里给外部读取用）。 */
    get hud() {
      const mm = Math.floor(state.elapsed / 60000);
      const ss = Math.floor((state.elapsed % 60000) / 1000);
      const time = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      return {
        title: meta.name,
        status: `${statusText(state)} · 分数 ${state.score}`,
        right: time,
      };
    },

    /** 需要持续推帧（下落是时间驱动的，任何非销毁状态都吃帧）。 */
    get busy() {
      return true;
    },

    /** 本局结果；未结束返回 null。 */
    get outcome() {
      if (state.status !== 'over') return null;
      return { result: 'lose', score: state.score, lines: state.lines, level: state.level };
    },

    /** 可选：销毁（本模块没有定时器，直接标记即可）。 */
    destroy() {
      state.destroyed = true;
    },
  };
}
