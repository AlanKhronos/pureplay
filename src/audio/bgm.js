/**
 * 背景音乐：多曲目、多音色的程序化合成（零音频资源，不占小游戏包体，无版权风险）
 *
 * 为什么不用音频文件：
 *   ① 小游戏主包只有 4MB，一段可循环的曲子通常 1–3MB；
 *   ② 网上下载的成品曲多有版权，商用（上架/广告变现）有被投诉下架的风险。
 *   所以这里用 Web Audio 合成音色与旋律：包体零增长、可复用到其他游戏。
 *
 * 四套音色（VOICES）：
 *   guzheng   古筝 —— 三角波 + 八度/十二度泛音，极快起音 + 指数衰减
 *   dizi      竹笛 —— 正弦 + 二次谐波，柔起音 + 持续音 + 轻微颤音
 *   bianzhong 编钟 —— 非谐泛音叠加 + 长衰减
 *   pipa      琵琶 —— 锯齿波 + 带通，明亮短促
 *
 * 曲目（TRACKS）均为五声音阶、慢速、级进为主，整体"悠扬、平静"。
 * 其他游戏可直接 `import { createBgm, TRACKS } from '../audio/bgm.js'` 复用。
 */

/** 取当前平台的音频上下文（拿不到返回 null，调用方静默降级）。 */
export function createAudioContext() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.createWebAudioContext === 'function') {
      return wx.createWebAudioContext();
    }
    const Ctor = typeof AudioContext !== 'undefined'
      ? AudioContext
      : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}

/** 音名 → 频率（如 D4 / A#4 / Bb3）。 */
export function noteFreq(name) {
  const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(String(name));
  if (!m) return 440;
  let midi = (Number(m[3]) + 1) * 12 + SEMI[m[1]];
  if (m[2] === '#') midi += 1;
  if (m[2] === 'b') midi -= 1;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 音色表：泛音配置 + 包络 + 滤波（+ 可选颤音）。 */
const VOICES = {
  guzheng: {
    partials: [
      { type: 'triangle', mul: 1, gain: 1.0 },
      { type: 'sine', mul: 2, gain: 0.32 },
      { type: 'sine', mul: 3, gain: 0.14 },
    ],
    attack: 0.01, decayShape: 'exp', tail: 0.35, filterFrom: 2600, filterTo: 900,
  },
  dizi: {
    partials: [
      { type: 'sine', mul: 1, gain: 1.0 },
      { type: 'sine', mul: 2, gain: 0.18 },
    ],
    attack: 0.09, decayShape: 'sustain', tail: 0.82, filterFrom: 2200, filterTo: 1500,
    vibrato: { rate: 5.2, depth: 0.006 },
  },
  bianzhong: {
    partials: [
      { type: 'sine', mul: 0.56, gain: 0.9 },   // 钟类特有的非谐泛音
      { type: 'sine', mul: 1, gain: 1.0 },
      { type: 'sine', mul: 1.34, gain: 0.42 },
      { type: 'sine', mul: 2.74, gain: 0.18 },
    ],
    attack: 0.006, decayShape: 'exp', tail: 0.5, filterFrom: 3200, filterTo: 700,
  },
  pipa: {
    partials: [
      { type: 'sawtooth', mul: 1, gain: 0.85 },
      { type: 'sine', mul: 2, gain: 0.25 },
    ],
    attack: 0.005, decayShape: 'exp', tail: 0.28, filterFrom: 3400, filterTo: 1100,
  },
};

/** 曲目表：{ n: 音名, d: 时值(拍) }，n 为 null 表示休止。 */
export const TRACKS = {
  'guzheng-calm': {
    id: 'guzheng-calm',
    name: '古筝 · 云水',
    voice: 'guzheng',
    bpm: 62,
    melody: [
      { n: 'D4', d: 2 }, { n: 'A4', d: 1 }, { n: 'G4', d: 1 },
      { n: 'E4', d: 2 }, { n: 'G4', d: 1 }, { n: 'A4', d: 1 },
      { n: 'D5', d: 2 }, { n: 'B4', d: 1 }, { n: 'A4', d: 1 },
      { n: 'G4', d: 3 }, { n: null, d: 1 },
      { n: 'E4', d: 2 }, { n: 'G4', d: 1 }, { n: 'A4', d: 1 },
      { n: 'B4', d: 2 }, { n: 'A4', d: 1 }, { n: 'G4', d: 1 },
      { n: 'E5', d: 2 }, { n: 'D5', d: 1 }, { n: 'B4', d: 1 },
      { n: 'A4', d: 3 }, { n: null, d: 1 },
    ],
  },

  'dizi-morning': {
    id: 'dizi-morning',
    name: '竹笛 · 晨光',
    voice: 'dizi',
    bpm: 74,
    melody: [
      { n: 'G4', d: 2 }, { n: 'A4', d: 1 }, { n: 'D5', d: 2 }, { n: 'E5', d: 1 },
      { n: 'D5', d: 2 }, { n: 'B4', d: 2 }, { n: 'A4', d: 3 }, { n: null, d: 1 },
      { n: 'B4', d: 2 }, { n: 'D5', d: 1 }, { n: 'E5', d: 2 }, { n: 'G5', d: 1 },
      { n: 'E5', d: 2 }, { n: 'D5', d: 2 }, { n: 'B4', d: 3 }, { n: null, d: 1 },
      { n: 'A4', d: 2 }, { n: 'B4', d: 1 }, { n: 'A4', d: 1 }, { n: 'G4', d: 4 },
    ],
  },

  'bianzhong-ancient': {
    id: 'bianzhong-ancient',
    name: '编钟 · 古意',
    voice: 'bianzhong',
    bpm: 52,
    melody: [
      { n: 'D3', d: 3 }, { n: 'A3', d: 2 }, { n: 'D4', d: 3 }, { n: null, d: 1 },
      { n: 'G3', d: 3 }, { n: 'E4', d: 2 }, { n: 'D4', d: 3 }, { n: null, d: 1 },
      { n: 'A3', d: 2 }, { n: 'D4', d: 2 }, { n: 'G4', d: 4 }, { n: null, d: 2 },
      { n: 'E4', d: 3 }, { n: 'D4', d: 2 }, { n: 'A3', d: 4 },
    ],
  },

  'pipa-flow': {
    id: 'pipa-flow',
    name: '琵琶 · 流光',
    voice: 'pipa',
    bpm: 68,
    melody: [
      { n: 'A3', d: 1 }, { n: 'D4', d: 1 }, { n: 'E4', d: 1 }, { n: 'G4', d: 2 },
      { n: 'E4', d: 1 }, { n: 'D4', d: 1 }, { n: 'B3', d: 2 }, { n: null, d: 1 },
      { n: 'D4', d: 1 }, { n: 'G4', d: 1 }, { n: 'A4', d: 1 }, { n: 'D5', d: 2 },
      { n: 'A4', d: 1 }, { n: 'G4', d: 1 }, { n: 'E4', d: 2 }, { n: null, d: 1 },
      { n: 'G4', d: 1 }, { n: 'A4', d: 1 }, { n: 'B4', d: 1 }, { n: 'A4', d: 3 },
    ],
  },

  /**
   * 取古曲《高山流水》的意境与音型特征重新谱写（非任何演奏录音的复制）。
   * 「高山」用低音区长音与大跳表现巍峨，「流水」用连续级进与短时值音符模拟水声，
   * 开篇的密集上行音符串即古筝刮奏的合成化写法。
   */
  'gaoshan-liushui': {
    id: 'gaoshan-liushui',
    name: '高山流水 · 意',
    voice: 'guzheng',
    bpm: 56,
    melody: [
      // ── 散板起：低音沉钟 + 上行刮奏 ──
      { n: 'D3', d: 4 }, { n: null, d: 1 },
      { n: 'A3', d: 0.25 }, { n: 'B3', d: 0.25 }, { n: 'D4', d: 0.25 }, { n: 'E4', d: 0.25 },
      { n: 'G4', d: 0.25 }, { n: 'A4', d: 0.25 }, { n: 'B4', d: 0.25 }, { n: 'D5', d: 0.75 },
      // ── 高山：庄重、大跳、长音 ──
      { n: 'A4', d: 2 }, { n: 'E4', d: 1 }, { n: 'D4', d: 3 }, { n: null, d: 1 },
      { n: 'G4', d: 2 }, { n: 'D5', d: 1 }, { n: 'B4', d: 3 }, { n: null, d: 1 },
      { n: 'D5', d: 2 }, { n: 'A4', d: 1 }, { n: 'G4', d: 1 }, { n: 'E4', d: 3 }, { n: null, d: 1 },
      // ── 流水：连续级进 + 短音型 ──
      { n: 'D5', d: 0.5 }, { n: 'E5', d: 0.5 }, { n: 'D5', d: 0.5 }, { n: 'B4', d: 0.5 },
      { n: 'A4', d: 0.5 }, { n: 'B4', d: 0.5 }, { n: 'A4', d: 0.5 }, { n: 'G4', d: 0.5 },
      { n: 'E4', d: 0.5 }, { n: 'G4', d: 0.5 }, { n: 'A4', d: 1 }, { n: null, d: 0.5 },
      { n: 'B4', d: 0.5 }, { n: 'D5', d: 0.5 }, { n: 'E5', d: 0.5 }, { n: 'G5', d: 0.5 },
      { n: 'E5', d: 0.5 }, { n: 'D5', d: 0.5 }, { n: 'B4', d: 1 }, { n: null, d: 0.5 },
      // ── 收：回落低音，余韵 ──
      { n: 'D4', d: 3 }, { n: 'A3', d: 2 }, { n: 'D3', d: 4 }, { n: null, d: 1 },
    ],
  },

  /** 取《渔舟唱晚》的意境：夕照、渔歌、由缓至静。 */
  'fisherman-evening': {
    id: 'fisherman-evening',
    name: '渔舟唱晚 · 意',
    voice: 'guzheng',
    bpm: 60,
    melody: [
      { n: 'G4', d: 2 }, { n: 'A4', d: 2 }, { n: 'D5', d: 3 }, { n: null, d: 1 },
      { n: 'E5', d: 2 }, { n: 'D5', d: 1 }, { n: 'B4', d: 3 }, { n: null, d: 1 },
      { n: 'D5', d: 1 }, { n: 'E5', d: 1 }, { n: 'G5', d: 2 }, { n: 'E5', d: 1 }, { n: 'D5', d: 3 },
      { n: null, d: 1 },
      { n: 'B4', d: 2 }, { n: 'A4', d: 2 }, { n: 'G4', d: 4 }, { n: null, d: 2 },
      { n: 'E4', d: 2 }, { n: 'G4', d: 2 }, { n: 'A4', d: 3 }, { n: 'D4', d: 3 }, { n: null, d: 2 },
    ],
  },

  /** 取《梅花三弄》的意境：清冷、三叠递进（用竹笛音色更贴合）。 */
  'plum-blossom': {
    id: 'plum-blossom',
    name: '梅花三弄 · 意',
    voice: 'dizi',
    bpm: 58,
    melody: [
      // 一弄
      { n: 'D5', d: 2 }, { n: 'B4', d: 1 }, { n: 'A4', d: 1 }, { n: 'G4', d: 3 }, { n: null, d: 1 },
      // 二弄（上移一度）
      { n: 'E5', d: 2 }, { n: 'D5', d: 1 }, { n: 'B4', d: 1 }, { n: 'A4', d: 3 }, { n: null, d: 1 },
      // 三弄（再上移，收束）
      { n: 'G5', d: 2 }, { n: 'E5', d: 1 }, { n: 'D5', d: 1 }, { n: 'B4', d: 2 }, { n: 'A4', d: 3 },
      { n: null, d: 1 },
      { n: 'G4', d: 4 }, { n: null, d: 2 },
    ],
  },
};

export const TRACK_IDS = Object.keys(TRACKS);

/**
 * 创建背景音乐播放器。
 * @param options.context 音频上下文（不传则自动探测）
 * @param options.volume  0..1
 * @param options.track   初始曲目 id（默认第一首）
 */
export function createBgm(options = {}) {
  const ctx = options.context ?? createAudioContext();
  const supported = !!ctx;

  let master = null;
  let playing = false;
  let timer = null;
  let volume = options.volume ?? 0.5;
  let trackId = options.track && TRACKS[options.track] ? options.track : TRACK_IDS[0];

  if (supported) {
    master = ctx.createGain();
    master.gain.value = volume * 0.5;
    master.connect(ctx.destination);
  }

  /** 合成一个音（按当前曲目的音色）。 */
  function playNote(freq, at, durSec, level) {
    const voice = VOICES[TRACKS[trackId].voice] ?? VOICES.guzheng;
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';

    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(level, at + voice.attack);
    if (voice.decayShape === 'sustain') {
      env.gain.linearRampToValueAtTime(level * voice.tail, at + durSec * 0.7);
      env.gain.linearRampToValueAtTime(0.0001, at + durSec + 0.08);
    } else {
      env.gain.exponentialRampToValueAtTime(level * voice.tail, at + Math.min(0.4, durSec * 0.4));
      env.gain.exponentialRampToValueAtTime(0.0001, at + durSec);
    }

    filter.frequency.setValueAtTime(voice.filterFrom, at);
    filter.frequency.exponentialRampToValueAtTime(voice.filterTo, at + durSec);

    let lfo = null, lfoGain = null;
    if (voice.vibrato) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = voice.vibrato.rate;
      lfoGain = ctx.createGain();
      lfoGain.gain.value = freq * voice.vibrato.depth;
      lfo.connect(lfoGain);
    }

    for (const part of voice.partials) {
      const osc = ctx.createOscillator();
      osc.type = part.type;
      osc.frequency.value = freq * part.mul;
      const g = ctx.createGain();
      g.gain.value = part.gain;
      osc.connect(g);
      g.connect(env);
      if (lfoGain) lfoGain.connect(osc.frequency);
      osc.start(at);
      osc.stop(at + durSec + 0.35);
    }
    if (lfo) { lfo.start(at); lfo.stop(at + durSec + 0.35); }

    env.connect(filter);
    filter.connect(master);
  }

  /** 调度一整轮曲目，循环续播。 */
  function scheduleLoop() {
    if (!playing || !supported) return;
    const track = TRACKS[trackId];
    const beat = 60 / track.bpm;
    let at = ctx.currentTime + 0.08;
    let total = 0;

    for (const note of track.melody) {
      const dur = note.d * beat;
      if (note.n) {
        const level = note.d >= 3 ? 0.40 : note.d >= 2 ? 0.34 : 0.26;
        playNote(noteFreq(note.n), at, Math.max(0.7, dur * 1.1), level);
      }
      at += dur;
      total += dur;
    }

    timer = setTimeout(scheduleLoop, Math.max(500, (total - 0.25) * 1000));
  }

  return {
    supported,
    isPlaying: () => playing,

    start() {
      if (!supported || playing) return false;
      playing = true;
      try { if (ctx.state === 'suspended') ctx.resume(); } catch { /* ignore */ }
      scheduleLoop();
      return true;
    },

    stop() {
      playing = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },

    /** 切换曲目（播放中切歌会从新曲开头续播）。 */
    setTrack(id) {
      if (!TRACKS[id]) return trackId;
      const wasPlaying = playing;
      this.stop();
      trackId = id;
      if (wasPlaying) this.start();
      return trackId;
    },
    getTrack: () => trackId,
    getTrackName: () => TRACKS[trackId]?.name ?? '',
    listTracks: () => TRACK_IDS.map((id) => ({ id, name: TRACKS[id].name })),

    setVolume(v) {
      volume = Math.max(0, Math.min(1, Number(v) || 0));
      if (master) {
        try { master.gain.value = volume * 0.5; } catch { /* ignore */ }
      }
      return volume;
    },
    getVolume: () => volume,

    resume() {
      if (!supported) return;
      try { if (ctx.state === 'suspended') ctx.resume(); } catch { /* ignore */ }
    },

    dispose() {
      this.stop();
      if (master) { try { master.disconnect(); } catch { /* ignore */ } }
    },
  };
}
