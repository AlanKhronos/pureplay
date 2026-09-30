/**
 * 音效模块（SFX）—— 程序化合成一次性短音效，零音频资源
 *
 * 为什么单独一个文件：现有 src/audio/bgm.js 只能播**循环背景音乐**，
 * 它的音高振荡器做不出"落子啪嗒""铲土""爆炸"这类**噪声型**音效
 * （那些需要白噪声 buffer + 滤波 + 快速包络）。所以这里另建一个 SFX 合成器。
 *
 * 设计要点
 *   1. 零资源：全部用 Web Audio 的噪声 buffer + 滤波器 + 包络实时合成。
 *   2. 平台无关：优先 wx.createWebAudioContext()，无 wx 时退回标准 AudioContext。
 *   3. 即发即忘：每次 play() 现场建节点，播完自动断开回收，不进任何循环调度。
 *   4. 失败静默：音频不可用（无 context / 被系统禁）时 play() 返回 false，绝不让游戏崩。
 *
 * 用法：
 *   const sfx = createSfx({ context, volume: 0.6 });
 *   sfx.play('tap');                 // 落子
 *   sfx.play('dig');                 // 扫雷铲土
 *   sfx.play('boom');                // 扫雷失败爆炸
 *   sfx.list();                      // 看有哪些音效
 */

/** 预设音效配方：每种音效 = 噪声 + 滤波 + 包络 [+ 可选音调] 的参数组合。 */
const RECIPES = {
  /** 落子：木质"嗒"——短噪声爆发 + 一点低频体感 */
  tap: { noise: 0.055, filter: 'lowpass', freq: 2600, q: 0.9, gain: 0.55, tone: { freq: 190, decay: 0.07, gain: 0.30 } },
  /** 选中/悬停：更轻更脆 */
  select: { noise: 0.035, filter: 'bandpass', freq: 3200, q: 2.2, gain: 0.32 },
  /** 吃子/撞击：比落子更重 */
  capture: { noise: 0.09, filter: 'lowpass', freq: 1800, q: 1.0, gain: 0.7, tone: { freq: 130, decay: 0.13, gain: 0.45 } },
  /** 铲土：带通噪声 + 向下扫频，像铲子入土 "唰" */
  dig: { noise: 0.16, filter: 'bandpass', freq: 900, q: 1.1, gain: 0.6, sweep: { from: 1500, to: 320 } },
  /** 爆炸：低频下滑 + 宽带噪声 + 长衰减 "轰" */
  boom: {
    noise: 0.72, filter: 'lowpass', freq: 1400, q: 0.8, gain: 0.95,
    sweep: { from: 900, to: 120 },
    tone: { freq: 88, decay: 0.5, gain: 0.75, slideTo: 38 },
  },
  /** UI 点击：极短高频 */
  click: { noise: 0.025, filter: 'highpass', freq: 2600, q: 0.7, gain: 0.3 },
  /** 胜利：上行三音 */
  win: { tones: [{ freq: 523, at: 0, dur: 0.12 }, { freq: 659, at: 0.10, dur: 0.12 }, { freq: 784, at: 0.20, dur: 0.22 }] },
  /** 失败：下行两音 */
  lose: { tones: [{ freq: 392, at: 0, dur: 0.16 }, { freq: 262, at: 0.14, dur: 0.30 }] },
};

/** 造一个音频上下文（优先微信，退回标准）；不可用返回 null。 */
export function createSfxContext() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.createWebAudioContext === 'function') {
      return wx.createWebAudioContext();
    }
  } catch { /* 落到下面 */ }
  try {
    const AC = (typeof globalThis !== 'undefined' && (globalThis.AudioContext || globalThis.webkitAudioContext));
    if (AC) return new AC();
  } catch { /* ignore */ }
  return null;
}

export function createSfx(options = {}) {
  const ctx = options.context ?? createSfxContext();
  let master = null;
  let noiseBuffer = null;
  let volume = typeof options.volume === 'number' ? options.volume : 0.6;
  let disabled = options.enabled === false;

  const supported = !!ctx;

  if (supported) {
    try {
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      // 预生成 1 秒白噪声，所有噪声型音效复用（避免每次播放都造 buffer）
      const len = Math.max(1, Math.floor(ctx.sampleRate * 1.0));
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      noiseBuffer = null;
    }
  }

  const now = () => (ctx && typeof ctx.currentTime === 'number' ? ctx.currentTime : 0);

  /** 播放一段噪声（可选扫频）。 */
  function playNoise(recipe, t0, rate = 1) {
    if (!noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.playbackRate.value = rate;

    const filter = ctx.createBiquadFilter();
    filter.type = recipe.filter ?? 'lowpass';
    filter.frequency.setValueAtTime((recipe.freq ?? 1200) * rate, t0);
    filter.Q.value = recipe.q ?? 1;
    if (recipe.sweep) {
      // 扫频：从 from 滑到 to（乘上 rate 保持一致音色）
      filter.frequency.setValueAtTime(recipe.sweep.from * rate, t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, recipe.sweep.to * rate), t0 + recipe.noise);
    }

    const g = ctx.createGain();
    const peak = (recipe.gain ?? 0.5);
    // 快起音 + 指数衰减（噪声型音效的关键）
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, recipe.noise * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + recipe.noise);

    src.connect(filter); filter.connect(g); g.connect(master);
    src.start(t0);
    src.stop(t0 + recipe.noise + 0.02);
    src.onended = () => { try { src.disconnect(); filter.disconnect(); g.disconnect(); } catch { /* ignore */ } };
  }

  /** 播放一个音调（可下滑）。 */
  function playTone(spec, t0, rate = 1) {
    const osc = ctx.createOscillator();
    osc.type = spec.type ?? 'sine';
    const f = (spec.freq ?? 200) * rate;
    osc.frequency.setValueAtTime(f, t0);
    if (spec.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.slideTo * rate), t0 + (spec.decay ?? spec.dur ?? 0.2));
    const g = ctx.createGain();
    const dur = spec.decay ?? spec.dur ?? 0.15;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(spec.gain ?? 0.4, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch { /* ignore */ } };
  }

  return {
    supported,
    /** 播一个音效；未知 id 或音频不可用时返回 false（静默降级）。 */
    play(id, opts = {}) {
      if (!supported || disabled || !master) return false;
      const recipe = RECIPES[id];
      if (!recipe) return false;
      const rate = typeof opts.rate === 'number' ? opts.rate : 1;
      try {
        // 音频上下文可能被系统挂起（切后台），这里尝试恢复
        if (typeof ctx.resume === 'function' && ctx.state === 'suspended') ctx.resume();
        const t0 = now() + 0.001;
        if (recipe.noise) playNoise(recipe, t0, rate);
        if (recipe.tone) playTone(recipe.tone, t0, rate);
        if (recipe.tones) for (const s of recipe.tones) playTone(s, t0 + (s.at ?? 0), rate);
        return true;
      } catch { return false; }
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      try { if (master) master.gain.value = volume; } catch { /* ignore */ }
      return volume;
    },
    getVolume() { return volume; },
    setEnabled(on) { disabled = !on; return !disabled; },
    list() { return Object.keys(RECIPES); },
    dispose() {
      try { if (master) master.disconnect(); } catch { /* ignore */ }
      master = null;
    },
  };
}
