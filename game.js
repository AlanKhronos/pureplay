/**
 * 微信小游戏入口
 *
 * 关键约束（本平台没有 document / window）：
 *   - 上屏画布只能用 wx.createCanvas()；
 *   - 逻辑分辨率用 wx.getWindowInfo() 的逻辑像素，画布物理像素再乘 pixelRatio，
 *     之后 ctx.setTransform(dpr,...)，后续绘制全部用逻辑像素；
 *   - **必须把上下安全区让出来**：底部手势条 / 导航条会盖住按钮（实机踩过的坑），
 *     顶部状态栏会盖住标题。这里算出 insets 交给布局层处理。
 */
import { createGame } from './src/app.js';
import { createBgm, createAudioContext } from './src/audio/bgm.js';
import { createSfx } from './src/audio/sfx.js';

/** 收集屏幕信息，并换算安全区上下让位量。 */
function screenInfo() {
  const w = typeof wx.getWindowInfo === 'function'
    ? wx.getWindowInfo()
    : wx.getSystemInfoSync();

  const windowWidth = w.windowWidth;
  const windowHeight = w.windowHeight;
  const screenHeight = w.screenHeight ?? windowHeight;
  const statusBarHeight = w.statusBarHeight ?? 0;
  const safe = w.safeArea;

  // 底部被占用高度：屏底到安全区底边的距离（手势条 / 导航条）
  let bottomInset = 0;
  if (safe && typeof safe.bottom === 'number') {
    bottomInset = Math.max(0, Math.round(screenHeight - safe.bottom));
  }

  // 顶部让位：只有当 windowHeight 没排除状态栏时才需要（多数机型已排除，这里保守取 0）
  const topInset = 0;

  // 左右让位：横屏时刘海/圆角在侧边，必须按 screenWidth 与 safeArea 反推（竖屏通常为 0）
  const screenWidth = w.screenWidth ?? windowWidth;
  let leftInset = 0;
  let rightInset = 0;
  if (safe) {
    if (typeof safe.left === 'number') leftInset = Math.max(0, Math.round(safe.left));
    if (typeof safe.right === 'number') rightInset = Math.max(0, Math.round(screenWidth - safe.right));
  }

  return {
    width: windowWidth,
    height: windowHeight,
    dpr: w.pixelRatio || 1,
    insets: { top: topInset, bottom: bottomInset, left: leftInset, right: rightInset },
    debug: { windowWidth, windowHeight, screenWidth, screenHeight, statusBarHeight, safeArea: safe ?? null },
  };
}

const info = screenInfo();
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');

function applySize(width, height, dpr) {
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  // ⚠️ 记下 dpr：集成层每帧恢复「基线变换」时必须用它（而非单位矩阵），
  // 否则真机上内容只占左上角 1/dpr（实测真机对弈界面缩成小屏）。
  canvas.__dpr = dpr;
  if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else ctx.scale(dpr, dpr);
}

applySize(info.width, info.height, info.dpr);

/* ── 运行时屏幕方向切换（麻将/斗地主横屏用） ─────────────────────────────
 * 调研结论（2026-09-28，官方文档 + 社区实证）：
 *   ① API 是 wx.setDeviceOrientation({ value: 'portrait' | 'landscape' })，基础库 2.26.0+（项目 3.17.3 满足）；
 *   ② **转向后画布尺寸不会自动变** —— 必须自己重设 canvas；
 *   ③ safeArea 随方向变（横屏刘海在侧），必须重新取 wx.getWindowInfo()；
 *   ④ ⚠️ onWindowResize 的回调**可能不带 safeArea** —— 回调里主动再查一次，不要依赖事件参数；
 *   ⑤ 事件会抖动/重复触发 → 60ms 去抖；
 *   ⑥ 转向瞬间触摸坐标系与新画布不一致 → 短暂锁输入（80ms）。
 */
const CAN_ROTATE = typeof wx !== 'undefined' && typeof wx.setDeviceOrientation === 'function';

/** 唯一尺寸真源：重设画布 + 重算 insets + 通知游戏换布局。 */
function applyWindowSize() {
  const w = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const width = w.windowWidth;
  const height = w.windowHeight;
  const dpr = w.pixelRatio || 1;
  const screenWidth = w.screenWidth ?? width;
  const screenHeight = w.screenHeight ?? height;
  const safe = w.safeArea;
  let insetsNow = { top: 0, bottom: 0, left: 0, right: 0 };
  if (safe) {
    insetsNow = {
      top: Math.max(0, Math.round(safe.top ?? 0)),
      bottom: Math.max(0, Math.round(screenHeight - (safe.bottom ?? screenHeight))),
      left: Math.max(0, Math.round(safe.left ?? 0)),
      right: Math.max(0, Math.round(screenWidth - (safe.right ?? screenWidth))),
    };
  }
  applySize(width, height, dpr);
  // app.js 的 resize() 会重算全部布局并通知当前游戏会话换尺寸
  try { game.resize(width, height, insetsNow); } catch { /* 布局失败不该拖垮游戏 */ }
}

/** 请求切换方向。带超时兜底：转不成就当没转，绝不让调用方卡住。 */
function setOrientation(value) {
  if (!CAN_ROTATE) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), 800);
    try {
      wx.setDeviceOrientation({
        value,
        // 转向成功后**主动重算画布**：真机上 onWindowResize 不一定触发，
        // 不重算就会出现「退回大厅仍是横屏、触摸坐标错位、无法滑动选游戏」的问题。
        // 延迟 60ms 是等系统转屏动画结束、getWindowInfo() 拿到新尺寸。
        success: () => { setTimeout(applyWindowSize, 60); finish(true); },
        fail: () => finish(false),
      });
    } catch { finish(false); }
  });
}

// 窗口尺寸变化（含转向）→ 去抖后重算
let resizeTimer = 0;
let inputLockUntil = 0;
if (typeof wx.onWindowResize === 'function') {
  wx.onWindowResize(() => {
    inputLockUntil = Date.now() + 80;   // 转向瞬间锁输入，避免坐标错位
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyWindowSize, 60);
  });
}

/* ── 背景音乐（古筝风格，程序化合成；环境不支持则静默降级）── */
const audioCtx = createAudioContext();
const bgm = createBgm({ context: audioCtx, volume: 0.5 });
// 一次性短音效（落子/铲土/爆炸等），与 BGM 共用同一个音频上下文
const sfx = createSfx({ context: audioCtx, volume: 0.6 });

/* ── 游戏实例（从「纯净玩」大厅开始）── */
const game = createGame({
  width: info.width,
  height: info.height,
  insets: info.insets,
  mode: 'casual',
  level: 2,
  humanColor: 1, // 黑先
  bgm,
  sfx,
  settings: { music: 0.5 },
  setOrientation,   // 让集成层能请求横屏（麻将/斗地主用）

});

// 暴露给集成层：进入/退出麻将、斗地主时调用
// ⚠️ 必须放在 createGame **之后**：const 有暂时性死区（TDZ），
// 放前面会在模块加载时抛 "Cannot set properties of undefined"（已踩过）。
game.setOrientation = (value) => setOrientation(value);

/* ── 触摸：按下给反馈，抬起判落子；起止距离过大视为拖动 ── */
let touchStart = null;
const TAP_SLOP = 12;
// 超过这个距离视为「滑动手势」（2048 等靠它操作）
const SLIDE_THRESHOLD = 28;

wx.onTouchStart((e) => {
  const t = e.touches && e.touches[0];
  if (!t) return;
  touchStart = { x: t.clientX, y: t.clientY };
  game.press(t.clientX, t.clientY);
});

wx.onTouchEnd((e) => {
  const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
  game.release();
  // 转向瞬间的抬起事件坐标可能属于旧画布 → 丢弃，避免误点
  if (Date.now() < inputLockUntil) { touchStart = null; return; }
  if (!t || !touchStart) { touchStart = null; return; }
  const start = touchStart;
  const moved = Math.hypot(t.clientX - start.x, t.clientY - start.y);
  touchStart = null;
  // 大距离 = 滑动手势（2048 等游戏靠它操作）
  if (moved >= SLIDE_THRESHOLD) { game.gesture(start.x, start.y, t.clientX, t.clientY, Date.now()); return; }
  if (moved > TAP_SLOP) return;
  game.tap(t.clientX, t.clientY, Date.now());
});

wx.onTouchCancel(() => { game.release(); touchStart = null; });

/* ── 切后台时停音乐，回来再续（省电，也避免后台噪音）── */
if (typeof wx.onHide === 'function') {
  wx.onHide(() => { try { bgm.stop(); } catch { /* ignore */ } });
}
if (typeof wx.onShow === 'function') {
  wx.onShow(() => {
    try {
      if (game.state.settings.music > 0) bgm.start();
    } catch { /* ignore */ }
  });
}

/* ── 渲染循环 ── */
function loop() {
  const now = Date.now();
  game.update(now);
  game.render(ctx, now);
  requestAnimationFrame(loop);
}
loop();

/* 便于在小游戏调试器里观察状态与排查安全区问题 */
if (typeof globalThis !== 'undefined') {
  globalThis.__gomoku = game;
  globalThis.__gomokuScreen = info;
  globalThis.__gomokuBgm = bgm;
  globalThis.__gomokuSfx = sfx;
}
