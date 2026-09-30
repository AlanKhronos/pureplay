/**
 * 游戏装配层：场景状态机（大厅 → 模式 → 难度 → 对局）、输入分发、AI 调度、音频控制。
 * 平台无关——小游戏入口与浏览器预览共用这份代码。
 *
 * 场景流转：
 *   hall（纯净玩大厅：选游戏）
 *     → mode（选规则：休闲 / 专业，上下并排）
 *       → level（选难度 1..5）
 *         → game（对局；可随时返回或认输回大厅）
 *   任意场景右上角齿轮 → 设置面板（背景音乐音量）
 */
import { createBoard, place, undo, canPlace, EMPTY, BLACK, WHITE, BOARD_SIZE } from './core/board.js';
import { chooseMove, LEVELS } from './core/ai.js';
import { checkMove, RULE_CASUAL, RULE_PRO, RULE_LABELS } from './core/rules.js';
import {
  computeLayout, computeHallLayout, computeModeLayout, computeLevelLayout, computeSettingsLayout,
  hitButton, hitGame, hitMode, hitLevel, hitBack, hitGear, hitRect, sliderValueAt,
} from './ui/layout.js';
import { THEME, MENU } from './ui/theme.js';
import { renderFrame, drawBackButton, drawGearButton, computeResultLayout, drawResultDialog, drawBackground } from './ui/renderer.js';
import { renderHall, renderMode, renderLevel, renderSettings, MODE_ORDER, LEVEL_ORDER, LEVEL_DESC } from './ui/screens.js';
import { GAMES, findGame } from './games/registry.js';

export const SCENE_HALL = 'hall';
export const SCENE_MODE = 'mode';
export const SCENE_LEVEL = 'level';
export const SCENE_GAME = 'game';

/**
 * module 类游戏的统一外框：左上返回键 + 右上齿轮。
 * 会话自己只画游戏本体，这两颗由集成层叠加，保证位置、命中区、安全区一致。
 */
function drawSessionChrome(ctx, layout, state, theme) {
  drawBackButton(ctx, layout, state, theme);
  drawGearButton(ctx, layout, state, theme);
}

/** 由会话的 outcome 组装统一结算弹窗的文案。 */
function resultInfo(outcome, state) {
  const gameName = state.currentGame?.name ?? '';
  const r = outcome?.result;
  if (r === 'win') return { title: '胜利', subtitle: `${gameName} · 干得漂亮`, color: '#2e7d4f' };
  if (r === 'lose') return { title: '失败', subtitle: `${gameName} · 再来一局`, color: '#c0392b' };
  return { title: '平局', subtitle: gameName, color: '#2f4f4a' };
}

/**
 * @param options.width/height 逻辑像素尺寸
 * @param options.insets { top, bottom } 安全区（必须传，否则底部按钮被系统栏遮挡）
 * @param options.mode/level 初始规则与难度
 * @param options.bgm 背景音乐实例（可选；不传则静音运行）
 * @param options.settings 初始设置（music 0..1）
 */
export function createGame(options = {}) {
  let width = options.width ?? 375;
  let height = options.height ?? 667;
  let insets = options.insets ?? { top: 0, bottom: 0 };
  const theme = options.theme ?? THEME;
  const menuTheme = options.menuTheme ?? MENU;
  const bgm = options.bgm ?? null;
  const sfx = options.sfx ?? null;   // 一次性音效（落子/铲土/爆炸…），由 game.js 创建后注入
  // 屏幕方向：能力由 game.js 注入（真机才支持 setDeviceOrientation），这里只负责在进/出对局时请求
  const requestOrientation = typeof options.setOrientation === 'function' ? options.setOrientation : () => Promise.resolve(false);
  // 需要横屏的游戏（其余保持竖屏）
  const LANDSCAPE_GAMES = [];   // 目前没有需要横屏的游戏（麻将/斗地主已移入 F:\游戏\shelf\）

  const state = {
    scene: SCENE_HALL,
    // 当前选中的游戏
    gameId: GAMES[0].id,
    currentGame: GAMES[0],
    difficulties: GAMES[0].difficulties ?? [],
    sessionSettled: false,
    // 统一结算弹窗
    resultDismissed: false,
    resultPress: null,
    resultT0: 0,
    // 选择项
    mode: options.mode ?? RULE_CASUAL,
    level: options.level ?? 2,
    // 通用按压反馈 { kind, index }
    press: null,
    // 设置
    settings: { music: options.settings?.music ?? 0.5, track: null, trackName: '' },
    settingsOpen: false,
    settingsLayout: null,
    // 对局
    board: createBoard(),
    humanColor: options.humanColor ?? BLACK,
    aiThinking: false,
    pressIndex: -1,
    score: { win: 0, lose: 0, draw: 0 },
    anim: { stones: new Map(), overT0: 0 },
    hover: null,
    toast: null,
    buttonLabels: ['重新开始', '悔棋', '认输'],
  };

  // 布局
  let gameLayout = computeLayout(width, height, insets);
  let hallLayout = computeHallLayout(width, height, insets, GAMES.length);
  let modeLayout = computeModeLayout(width, height, insets, MODE_ORDER.length);
  let levelLayout = computeLevelLayout(width, height, insets, GAMES[0].difficulties?.length ?? 5);
  let settingsLayout = computeSettingsLayout(width, height, insets);
  let resultLayout = computeResultLayout(width, height, insets);

  let pendingAiAt = 0;
  let counted = false;
  let audioPrimed = false;
  let session = null;   // module 类游戏的会话对象（src/games/<id>/createSession 的返回值）

  // 初始化曲目信息（设置面板需要显示当前曲名；函数声明会提升，此处调用安全）
  syncTrack();

  /* ── 内部工具 ── */

  const isHumanTurn = () => state.board.winner === EMPTY && state.board.current === state.humanColor;

  function showToast(text, now, ms = 1600) {
    state.toast = { text, t0: now ?? Date.now(), ms };
  }

  function markStoneAnim(x, y, now) {
    state.anim.stones.set(`${x},${y}`, now);
    if (state.anim.stones.size > 12) {
      state.anim.stones.delete(state.anim.stones.keys().next().value);
    }
  }

  function settleScore() {
    if (counted) return;
    counted = true;
    const w = state.board.winner;
    if (w === EMPTY) return;
    if (w === state.humanColor) state.score.win++;
    else if (w === -1) state.score.draw++;
    else state.score.lose++;
  }

  function afterMove(now) {
    if (state.board.winner !== EMPTY) {
      state.aiThinking = false;
      pendingAiAt = 0;
      state.anim.overT0 = now;
      state.hover = null;
      settleScore();
      return;
    }
    if (state.board.current !== state.humanColor) {
      state.aiThinking = true;
      pendingAiAt = now + theme.aiThinkMinMs;
    }
  }

  function resetBoard(now = 0) {
    state.board = createBoard();
    state.aiThinking = false;
    state.pressIndex = -1;
    state.anim.stones.clear();
    state.anim.overT0 = 0;
    state.hover = null;
    state.toast = null;
    pendingAiAt = 0;
    counted = false;
    if (state.humanColor === WHITE) {
      state.aiThinking = true;
      pendingAiAt = now + theme.aiThinkMinMs;
    }
  }

  /**
   * 开始一局：按当前游戏的实现方式走两条路。
   *   - kind 'module'  → 调 src/games/<id>/createSession，之后交互/渲染全部委托给它
   *   - kind 'builtin' → 使用集成层内嵌的五子棋实现
   */
  function startMatch(now = 0) {
    const g = state.currentGame;
    if (!g || !g.ready) return { type: 'error' };

    if (g.kind === 'module' && typeof g.create === 'function') {
      endSession();
      try {
        session = g.create({
        sfx,   // 各游戏用 options.sfx 播一次性音效（可为 null，必须静默降级）
          width, height, insets,
          difficulty: state.level,
          theme,
          onEvent: () => {},
        });
        state.sessionSettled = false;
        state.resultDismissed = false;
        state.resultPress = null;
        state.resultT0 = 0;
        state.scene = SCENE_GAME;
        // 进入对局：麻将/斗地主请求横屏，其余请求竖屏（失败也不影响，setOrientation 自带 800ms 超时兜底）
        try { requestOrientation(LANDSCAPE_GAMES.includes(g.id) ? 'landscape' : 'portrait'); } catch { /* ignore */ }
        return { type: 'start', id: g.id, level: state.level, via: 'module' };
      } catch (e) {
        session = null;
        showToast('这个游戏暂时打不开', now);
        return { type: 'error', message: String(e && e.message) };
      }
    }

    endSession();
    state.scene = SCENE_GAME;
    resetBoard(now);
    return { type: 'start', id: g.id, mode: state.mode, level: state.level, via: 'builtin' };
  }

  /** 结束并销毁当前 module 会话。 */
  function endSession() {
    if (session && typeof session.destroy === 'function') {
      try { session.destroy(); } catch { /* ignore */ }
    }
    session = null;
    state.sessionSettled = false;
  }

  /** 首次交互时启动音频（多数平台要求用户手势后才能出声）。 */
  function primeAudio() {
    if (audioPrimed || !bgm) return;
    audioPrimed = true;
    try {
      bgm.setVolume(state.settings.music);
      if (state.settings.music > 0) bgm.start();
    } catch { /* 音频不可用则静默 */ }
  }

  function applyMusicVolume(v) {
    state.settings.music = Math.max(0, Math.min(1, v));
    if (!bgm) return;
    try {
      bgm.setVolume(state.settings.music);
      if (state.settings.music > 0 && !bgm.isPlaying()) bgm.start();
      if (state.settings.music === 0) bgm.stop();
    } catch { /* ignore */ }
  }

  /** 同步曲目信息到 state（供设置面板显示）。 */
  function syncTrack() {
    if (!bgm) { state.settings.trackName = '（无音频）'; return; }
    state.settings.track = bgm.getTrack();
    state.settings.trackName = bgm.getTrackName();
  }

  /** 切换曲目：dir = -1 上一首 / +1 下一首。 */
  function switchTrack(dir) {
    if (!bgm || typeof bgm.listTracks !== 'function') return;
    const list = bgm.listTracks();
    if (!list.length) return;
    const cur = list.findIndex((t) => t.id === bgm.getTrack());
    const next = ((cur < 0 ? 0 : cur) + dir + list.length) % list.length;
    bgm.setTrack(list[next].id);
    // 静音状态下切歌不自动出声，避免"调了音量却是静音"的困惑
    if (state.settings.music > 0 && !bgm.isPlaying()) bgm.start();
    syncTrack();
  }

  /* ── 对外 API ── */

  const api = {
    get scene() { return state.scene; },
    get state() { return state; },
    get theme() { return theme; },
    get menuTheme() { return menuTheme; },

    /** 当前场景的布局（渲染与命中都用它）。 */
    get activeLayout() {
      switch (state.scene) {
        case SCENE_HALL: return hallLayout;
        case SCENE_MODE: return modeLayout;
        case SCENE_LEVEL: return levelLayout;
        default: return gameLayout;
      }
    },
    get layout() { return api.activeLayout; },
    get boardLayout() { return gameLayout; },
    get settingsLayoutRef() { return settingsLayout; },
    /** 调试/自动化用：当前 module 会话（浏览器控制台可拿来驱动测试）。 */
    get sessionRef() { return session; },
    get resultLayoutRef() { return resultLayout; },

    resize(w, h, ins = insets) {
      width = w; height = h; insets = ins;
      gameLayout = computeLayout(w, h, ins);
      hallLayout = computeHallLayout(w, h, ins, GAMES.length);
      modeLayout = computeModeLayout(w, h, ins, MODE_ORDER.length);
      levelLayout = computeLevelLayout(w, h, ins, (state.difficulties?.length) || 5);
      settingsLayout = computeSettingsLayout(w, h, ins);
      resultLayout = computeResultLayout(w, h, ins);
      state.settingsLayout = settingsLayout;
      // 会话也要跟着换尺寸（各游戏自己算内部布局）
      if (session && typeof session.resize === 'function') {
        try { session.resize(w, h, ins); } catch { /* ignore */ }
      }
    },

    reset(now = 0) {
      if (session) {
        // module 游戏：重建会话即重开
        return startMatch(now);
      }
      resetBoard(now);
    },
    back() {
      endSession();
      // 回大厅一律竖屏
      try { requestOrientation('portrait'); } catch { /* ignore */ }
      state.scene = SCENE_HALL;
      state.press = null;
      state.toast = null;
      pendingAiAt = 0;
      state.aiThinking = false;
    },

    /** 认输：判负、记分，然后回大厅。 */
    resign(now = 0) {
      if (state.board.winner === EMPTY) {
        state.board.winner = state.humanColor === BLACK ? WHITE : BLACK;
        settleScore();
      }
      state.aiThinking = false;
      pendingAiAt = 0;
      showToast('已认输，返回大厅', now, 1200);
      requestOrientation('portrait');   // 回大厅一律竖屏（否则从横屏游戏退出会留在横屏）
      setTimeout(() => { state.scene = SCENE_HALL; state.toast = null; }, 700);
      return { type: 'resign' };
    },

    undoMove() {
      if (state.aiThinking) return { ok: false, reason: 'thinking' };
      let done = 0;
      for (let i = 0; i < 2; i++) {
        const r = undo(state.board);
        if (!r.ok) break;
        state.anim.stones.delete(`${r.undone.x},${r.undone.y}`);
        done++;
      }
      state.anim.overT0 = 0;
      state.toast = null;
      counted = false;
      pendingAiAt = 0;
      if (state.board.winner === EMPTY && state.board.current !== state.humanColor) {
        state.aiThinking = true;
        pendingAiAt = 0;
      }
      return { ok: done > 0, steps: done };
    },

    /** 触摸结束：按场景分发。 */
    tap(px, py, now = 0) {
      primeAudio();

      /* ── 设置面板：优先拦截（模态） ── */
      if (state.settingsOpen) {
        // 曲目切换
        if (hitRect(settingsLayout.track.prev, px, py)) { switchTrack(-1); return { type: 'track', id: state.settings.track }; }
        if (hitRect(settingsLayout.track.next, px, py)) { switchTrack(1); return { type: 'track', id: state.settings.track }; }
        const sv = sliderValueAt(settingsLayout, px, py);
        if (sv !== null) { applyMusicVolume(sv); return { type: 'volume', value: state.settings.music }; }
        if (hitRect(settingsLayout.close, px, py) || !hitRect(settingsLayout.panel, px, py)) {
          state.settingsOpen = false;
          return { type: 'settings-close' };
        }
        return { type: 'settings-noop' };
      }

      const L = api.activeLayout;

      /* ── 齿轮（各场景通用） ── */
      if (hitGear(L, px, py)) {
        state.settingsOpen = true;
        state.settingsLayout = settingsLayout;
        syncTrack();
        state.press = null;
        return { type: 'settings-open' };
      }

      switch (state.scene) {
        case SCENE_HALL: {
          const i = hitGame(hallLayout, px, py);
          const g = GAMES[i];
          state.press = null;
          if (!g) return { type: 'hall-miss' };
          if (!g.ready) { showToast(`${g.name}还在制作中`, now); return { type: 'coming-soon', id: g.id }; }
          state.gameId = g.id;
          state.currentGame = g;
          state.difficulties = g.difficulties ?? [];
    // ⚠️ 必须在这里按本游戏的档位数**重算难度页布局**。
    // 否则 levelLayout 仍是初始化时按 GAMES[0]（五子棋 5 档）算出的 5 行，
    // 任何 >5 档的游戏（如围棋的 6 档）第 6 档在界面上不可见、点不到。
    // （resize() 里也有重算，但真机没有 wx.onWindowResize，等于不触发。）
    levelLayout = computeLevelLayout(width, height, insets, state.difficulties.length || 5);
          // 有「模式」层的游戏（如五子棋的休闲/专业）先选模式，否则直接进难度
          state.scene = g.hasModes ? SCENE_MODE : SCENE_LEVEL;
          return { type: 'pick-game', id: g.id };
        }

        case SCENE_MODE: {
          if (hitBack(modeLayout, px, py)) { requestOrientation('portrait'); state.scene = SCENE_HALL; state.press = null; return { type: 'back' }; }
          const i = hitMode(modeLayout, px, py);
          if (i >= 0) {
            state.mode = MODE_ORDER[i];
            state.scene = SCENE_LEVEL;
            state.press = null;
            return { type: 'pick-mode', mode: state.mode };
          }
          return { type: 'mode-miss' };
        }

        case SCENE_LEVEL: {
          // 返回：有模式层的回模式页，否则回大厅
          if (hitBack(levelLayout, px, py)) {
            state.scene = state.currentGame?.hasModes ? SCENE_MODE : SCENE_HALL;
            state.press = null;
            return { type: 'back' };
          }
          const i = hitLevel(levelLayout, px, py);
          const d = state.difficulties[i];
          if (d) {
            state.level = d.key;
            state.press = null;
            return startMatch(now);
          }
          return { type: 'level-miss' };
        }

        default: {
          /* ── 对局 ── */
          if (hitBack(gameLayout, px, py)) {
            // 取消对局：不计分直接回大厅
            endSession();
            requestOrientation('portrait');   // 回大厅一律竖屏
            state.scene = SCENE_HALL;
            state.toast = null;
            pendingAiAt = 0;
            state.aiThinking = false;
            return { type: 'cancel' };
          }

          /* ── 统一结算弹窗：显示时优先拦截点击（可叉掉 / 再来一局 / 回主界面）── */
          if (session && session.outcome && !state.resultDismissed) {
            if (hitRect(resultLayout.again, px, py)) {
              state.resultPress = null;
              return startMatch(now);                      // 再来一局
            }
            if (hitRect(resultLayout.home, px, py)) {
              state.resultPress = null;
              endSession();
              requestOrientation('portrait');   // 回大厅一律竖屏
              state.scene = SCENE_HALL;
              state.toast = null;
              return { type: 'result-home' };              // 回到主界面
            }
            if (hitRect(resultLayout.close, px, py)) {
              state.resultPress = null;
              state.resultDismissed = true;                // 叉掉，继续看棋盘
              return { type: 'result-dismiss' };
            }
            return { type: 'result-noop' };                // 弹窗挡住其他点击
          }

          // ── module 游戏：交互全部委托给会话 ──
          if (session) {
            let r;
            try { r = session.tap(px, py, now); } catch (e) { r = { type: 'error', message: String(e && e.message) }; }
            if (session.outcome && !state.sessionSettled) {
              state.sessionSettled = true;
              const res = session.outcome.result;
              if (res === 'win') state.score.win++;
              else if (res === 'lose') state.score.lose++;
              else if (res === 'draw') state.score.draw++;
            }
            return r ?? { type: 'session-tap' };
          }

          const idx = hitButton(gameLayout, px, py);
          if (idx >= 0) {
            state.pressIndex = -1;
            if (idx === 0) { resetBoard(now); return { type: 'reset' }; }
            if (idx === 1) return { type: 'undo', ...api.undoMove() };
            if (idx === 2) return api.resign(now);
          }

          if (!isHumanTurn()) return { type: 'blocked', reason: state.aiThinking ? 'thinking' : 'not-your-turn' };

          const { x, y } = gameLayout.board.fromScreen(px, py);
          if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) return { type: 'miss' };

          const p = gameLayout.board.toScreen(x, y);
          if (Math.hypot(px - p.x, py - p.y) > gameLayout.board.cell * 0.62) return { type: 'miss' };
          if (!canPlace(state.board, x, y)) return { type: 'occupied' };

          const verdict = checkMove(state.board.grid, state.board.size, x, y, state.board.current, state.mode);
          if (!verdict.ok) {
            showToast(verdict.reason, now);
            return { type: 'forbidden', reason: verdict.reason };
          }

          const r = place(state.board, x, y);
          if (!r.ok) return { type: 'reject', reason: r.reason };
          state.hover = null;
          markStoneAnim(x, y, now);
          afterMove(now);
          return { type: 'placed', x, y };
        }
      }
    },

    /** 按下反馈。 */
    press(px, py) {
      if (state.settingsOpen) return;
      const L = api.activeLayout;
      if (hitGear(L, px, py)) { state.press = { kind: 'gear' }; return; }
      switch (state.scene) {
        case SCENE_HALL: {
          const i = hitGame(hallLayout, px, py);
          state.press = i >= 0 ? { kind: 'game', index: i } : null;
          return;
        }
        case SCENE_MODE: {
          if (hitBack(modeLayout, px, py)) { state.press = { kind: 'back' }; return; }
          const i = hitMode(modeLayout, px, py);
          state.press = i >= 0 ? { kind: 'mode', index: i } : null;
          return;
        }
        case SCENE_LEVEL: {
          if (hitBack(levelLayout, px, py)) { state.press = { kind: 'back' }; return; }
          const i = hitLevel(levelLayout, px, py);
          state.press = i >= 0 ? { kind: 'level', index: i } : null;
          return;
        }
        default:
          // 结算弹窗的按压反馈
          if (session && session.outcome && !state.resultDismissed) {
            if (hitRect(resultLayout.again, px, py)) state.resultPress = 'again';
            else if (hitRect(resultLayout.home, px, py)) state.resultPress = 'home';
            else if (hitRect(resultLayout.close, px, py)) state.resultPress = 'close';
            else state.resultPress = null;
            return;
          }
          // module 游戏：按压反馈也交给会话（它自己知道按钮在哪）
          if (session) { if (typeof session.press === 'function') session.press(px, py); return; }
          state.pressIndex = hitButton(gameLayout, px, py);
      }
    },
    release() {
      state.pressIndex = -1;
      state.press = null;
      if (session && typeof session.release === 'function') { try { session.release(); } catch { /* ignore */ } }
    },

    /** 滑动手势（2048 这类游戏靠它操作）。此前集成层漏了这个入口，导致滑动完全没反应。 */
    gesture(x0, y0, x1, y1, now) {
      if (state.settingsOpen) return;
      if (state.scene !== SCENE_GAME) return;
      if (!session || typeof session.gesture !== 'function') return;
      if (session.outcome && !state.resultDismissed) return;
      try { session.gesture(x0, y0, x1, y1, now ?? Date.now()); } catch { /* ignore */ }
    },

    /** 悬停预告（同时用于拖动音量滑块时的实时更新）。 */
    hover(px, py) {
      if (state.settingsOpen) {
        const sv = sliderValueAt(settingsLayout, px, py);
        if (sv !== null) applyMusicVolume(sv);
        return;
      }
      if (state.scene !== SCENE_GAME) { state.hover = null; return; }
      if (session) { if (typeof session.hover === 'function') session.hover(px, py); return; }
      if (!isHumanTurn()) { state.hover = null; return; }
      const { x, y } = gameLayout.board.fromScreen(px, py);
      if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) { state.hover = null; return; }
      const p = gameLayout.board.toScreen(x, y);
      if (Math.hypot(px - p.x, py - p.y) > gameLayout.board.cell * 0.62) { state.hover = null; return; }
      state.hover = { x, y, valid: canPlace(state.board, x, y) };
    },
    clearHover() {
      state.hover = null;
      if (session && typeof session.clearHover === 'function') { try { session.clearHover(); } catch { /* ignore */ } }
    },

    update(now) {
      if (state.scene !== SCENE_GAME) return;
      // module 游戏：帧推进交给会话
      if (session) { if (typeof session.update === 'function') session.update(now); return; }
      if (state.board.winner !== EMPTY && (state.aiThinking || pendingAiAt !== 0)) {
        state.aiThinking = false;
        pendingAiAt = 0;
      }
      if (pendingAiAt !== 0 && now >= pendingAiAt && state.board.winner === EMPTY) {
        pendingAiAt = 0;
        const move = chooseMove(state.board, state.board.current, {
          level: state.level,
          mode: state.mode,
        });
        if (move) {
          const r = place(state.board, move.x, move.y);
          if (r.ok) markStoneAnim(move.x, move.y, now);
          if (state.board.winner !== EMPTY) {
            state.anim.overT0 = now;
            settleScore();
          }
        }
        state.aiThinking = false;
      }
    },

    get busy() {
      if (session && typeof session.busy === 'boolean') return session.busy;
      return state.aiThinking || state.anim.stones.size > 0;
    },

    /** 当前游戏 · 规则 · 难度（HUD 用）。 */
    get matchLabel() {
      const g = state.currentGame?.name ?? '';
      if (state.currentGame?.kind === 'module') {
        const d = (state.difficulties ?? []).find((x) => x.key === state.level);
        return d ? `${g} · ${d.name}` : g;
      }
      const lv = LEVELS[state.level] ?? LEVELS[2];
      return `${g} · ${RULE_LABELS[state.mode].name} · ${lv.name}`;
    },

    render(ctx, now) {
      state.settingsLayout = settingsLayout;
      switch (state.scene) {
        case SCENE_HALL: renderHall(ctx, hallLayout, state, menuTheme); break;
        case SCENE_MODE: renderMode(ctx, modeLayout, state, menuTheme); break;
        case SCENE_LEVEL: renderLevel(ctx, levelLayout, state, menuTheme); break;
        default:
          // module 游戏：整屏交给会话；会话只画游戏本体，
          // 返回键/齿轮仍由集成层叠加（保证位置与安全区统一）
          if (session) {
            // 防御：把变换与透明度拉回基线，避免任何游戏模块的 save/restore 不平衡逐帧累积
            try {
              if (typeof ctx.setTransform === 'function') { const d = (ctx.canvas && ctx.canvas.__dpr) || 1; ctx.setTransform(d, 0, 0, d, 0, 0); }
              ctx.globalAlpha = 1;
            } catch { /* ignore */ }
            // 集成层负责铺底：清屏 + 青白渐变背景。
            // 按规范第 10 节，游戏模块不画全屏背景；如果这里不铺，
            // 严格遵守约定的模块（如数独）就会露出上一帧残影。
            try {
              ctx.clearRect(0, 0, gameLayout.width, gameLayout.height);
              drawBackground(ctx, gameLayout, theme);
            } catch { /* ignore */ }
            try { session.render(ctx, now); } catch { /* 单帧异常不拖垮整局 */ }
            try {
              if (typeof ctx.setTransform === 'function') { const d = (ctx.canvas && ctx.canvas.__dpr) || 1; ctx.setTransform(d, 0, 0, d, 0, 0); }
              ctx.globalAlpha = 1;
            } catch { /* ignore */ }
            drawSessionChrome(ctx, gameLayout, state, theme);
            // 统一结算弹窗（各游戏只需返回 outcome，不自己画）
            const oc = session.outcome;
            if (oc && !state.resultDismissed) {
              if (!state.resultT0) state.resultT0 = now;
              state.anim.overT0 = state.resultT0;
              drawResultDialog(ctx, gameLayout, resultInfo(oc, state), resultLayout, state, theme, now);
            }
          } else {
            renderFrame(ctx, gameLayout, state, theme, now);
          }
          break;
      }
      if (state.settingsOpen) renderSettings(ctx, api.activeLayout, state, menuTheme, now);
    },
  };

  return api;
}

export { EMPTY, BLACK, WHITE, BOARD_SIZE, RULE_CASUAL, RULE_PRO, LEVELS, MODE_ORDER, LEVEL_ORDER, LEVEL_DESC };
