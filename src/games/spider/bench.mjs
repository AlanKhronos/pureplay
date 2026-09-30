/**
 * 蜘蛛纸牌渲染基准（临时工具，非交付物）
 *
 * 目的：把「卡不卡」变成可复现的数字。用桩 Canvas 2D 上下文连渲 N 帧，统计
 *   ① 每帧墙钟耗时（均值 / 中位数 / p95）
 *   ② 关键绘制调用次数（createLinearGradient / 路径段 / fill / stroke / fillText / save）
 *
 * 桩 ctx 有**两种成本模型**，因为「渐变对象贵」这件事在纯 JS 桩上体现不出来：
 *   - cheap  ：createLinearGradient 直接返回同一个替身对象（只量我们自己的 JS 开销）
 *   - native ：createLinearGradient 每次真的分配并填一张 64 项采样表
 *              （模拟浏览器/小游戏里那个原生对象的构造代价，是**模型**不是真实测量）
 * 两个模型都要看：前者证明算法与分配变少了，后者证明「每个牌面一个渐变」的代价真的被消掉。
 *
 * 用法：node src/games/spider/bench.mjs [帧数]
 */
import { createSession } from './index.js';
import { computeLayout } from './render.js';
import { mulberry32 } from './core.js';

const FRAMES = Math.max(60, Number(process.argv[2]) || 600);
const W = 420, H = 805, INSETS = { top: 44, bottom: 34 };

/** 桩 Canvas 2D 上下文；只记录调用次数，不做真实绘制。 */
function makeCtx(nativeCost) {
  const n = {
    grad: 0, path: 0, seg: 0, arc: 0, fill: 0, stroke: 0, text: 0,
    save: 0, restore: 0, dash: 0,
  };
  const grad = { addColorStop() {} };
  return {
    n,
    save() { n.save++; }, restore() { n.restore++; },
    beginPath() { n.path++; }, closePath() {},
    moveTo() { n.seg++; }, lineTo() { n.seg++; }, arcTo() { n.seg++; },
    arc() { n.arc++; },
    fill() { n.fill++; }, stroke() { n.stroke++; },
    fillRect() {}, clearRect() {}, strokeRect() {}, clip() {},
    setLineDash() { n.dash++; }, translate() {}, rotate() {},
    fillText() { n.text++; }, strokeText() {},
    measureText: () => ({ width: 10 }),
    createLinearGradient() {
      n.grad++;
      if (nativeCost) { const t = new Float64Array(64); for (let i = 0; i < 64; i++) t[i] = i * 0.5; }
      return grad;
    },
    createRadialGradient() { n.grad++; return grad; },
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: '#000', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
  };
}

/** 造一个「发满 5 轮」的会话：104 张牌全在桌上，是最重的一帧。 */
function makeLoadedSession() {
  const s = createSession({
    width: W, height: H, insets: INSETS, difficulty: 'hard', theme: {}, rng: mulberry32(20260807),
  });
  const NOW = 1790000000000;
  s.update(NOW);
  for (let i = 0; i < 5; i++) {
    const lay = computeLayout(W, H, INSETS, s.snapshot);
    const btn = lay.buttons.find((b) => b.key === 'deal');
    s.tap(btn.x + btn.w / 2, btn.y + btn.h / 2, NOW);
    s.update(NOW);
  }
  return { s, now: NOW };
}

/** 渲染 N 帧，返回统计。 */
function run(label, nativeCost) {
  const { s, now } = makeLoadedSession();
  const ctx = makeCtx(nativeCost);
  const cards = s.snapshot.columns.reduce((a, c) => a + c.cards.length, 0);
  const faceUp = s.snapshot.columns.reduce((a, c) => a + c.faceUp, 0);

  for (let i = 0; i < 80; i++) s.render(ctx, now);          // 预热（渐变缓存第一帧建）
  const before = { ...ctx.n };

  // 冷启动单帧：换一个「什么都没缓存」的 ctx，量第一帧（要现建渐变/字体/颜色串）
  const coldCtx = makeCtx(nativeCost);
  const c0 = process.hrtime.bigint();
  s.render(coldCtx, now);
  const coldMs = Number(process.hrtime.bigint() - c0) / 1e6;

  const t0 = process.hrtime.bigint();
  const samples = new Float64Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    const a = process.hrtime.bigint();
    s.render(ctx, now);
    samples[i] = Number(process.hrtime.bigint() - a) / 1e6;
  }
  const total = Number(process.hrtime.bigint() - t0) / 1e6;
  const sorted = Array.from(samples).sort((x, y) => x - y);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const ops = {};
  for (const k of Object.keys(ctx.n)) ops[k] = ctx.n[k] - before[k];
  s.destroy();
  return {
    label, cards, faceUp, frames: FRAMES,
    totalMs: +total.toFixed(1),
    coldMs: +coldMs.toFixed(3),
    meanMs: +(total / FRAMES).toFixed(3),
    p50Ms: +pick(0.5).toFixed(3),
    p95Ms: +pick(0.95).toFixed(3),
    minMs: +sorted[0].toFixed(3),
    maxMs: +sorted[sorted.length - 1].toFixed(3),
    perFrame: ops,
  };
}

function report(r) {
  const p = r.perFrame;
  console.log(
    `${r.label.padEnd(22)} 牌 ${String(r.cards).padStart(3)} 张(明 ${String(r.faceUp).padStart(3)})  `
    + `${r.frames} 帧 合计 ${String(r.totalMs).padStart(7)}ms  `
    + `中位 ${String(r.p50Ms).padStart(6)}ms 最小 ${String(r.minMs).padStart(6)}ms p95 ${String(r.p95Ms).padStart(6)}ms  `
    + `冷启动单帧 ${String(r.coldMs).padStart(6)}ms`);
  console.log(
    `  每帧调用：渐变 ${p.grad}  路径 ${p.path} 线段 ${p.seg}  填充 ${p.fill}  描边 ${p.stroke}  `
    + `文字 ${p.text}  save ${p.save}/restore ${p.restore}  虚线 ${p.dash}`);
}

console.log(`\n蜘蛛纸牌渲染基准（${W}×${H}，桌面 ${FRAMES} 帧）`);
console.log('─'.repeat(112));
const native = run('桩 ctx（native 成本模型）', true);
report(native);
const cheap = run('桩 ctx（cheap）', false);
report(cheap);
console.log('─'.repeat(112));
console.log('说明：cheap = 只量本模块的 JS 开销；native = 每次 createLinearGradient 真分配一张采样表（模型，非真实 GPU 测量）。');
console.log('      稳态下两者应当几乎一致 —— 因为渐变已经不在每帧创建了（冷启动那一帧才会建）。');
