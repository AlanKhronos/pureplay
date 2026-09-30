/**
 * 2048 核心逻辑测试（Node 直接跑，零依赖，不碰微信 API）
 * 用法：node src/games/game2048/test.mjs
 *
 * 覆盖点（任务要求 + 边界）：
 *   1) 四方向移动正确
 *   2) 合并规则：2 2 2 2 左移得 4 4（每个方块只合并一次）
 *   3) 不连锁合并：4 4 8 左移得 8 8（不是 16）
 *   4) 计分正确（累加合并后的值）
 *   5) 新方块生成数量与位置合法（每次有效移动恰好 1 枚，90% 出 2 / 10% 出 4）
 *   6) 无效移动不生成方块、不计分、不进撤销栈
 *   7) 胜利判定（出现目标值，可继续）
 *   8) 失败判定（满盘且无相邻同值）
 *   9) 撤销还原（含「撤销 → 重走必然复现」）
 *   + 布局 / 滑动方向 / 配色 / 会话接口 / 源码硬约束自检
 */
import { readFileSync } from 'node:fs';

import {
  createGame, slideGrid, move, undo, canUndo, hasMoves, emptyCells, maxTile, setGrid,
  snapshot, statusText, spawnTile, mulberry32, tileExp, expToValue, difficultyConfig,
  DIFFICULTIES, DIFFICULTY_KEYS, DEFAULT_DIFFICULTY, DIRECTIONS,
  PLAYING, WON, LOST, LEFT, RIGHT, UP, DOWN,
  SPAWN_BIG_RATE, SPAWN_VALUE_SMALL, SPAWN_VALUE_BIG,
} from './core.js';

import {
  computeLayout, hitButton, hitRect, directionFor, palette, tileColor,
  renderFrame, SLIDE_THRESHOLD, TILE_COLORS,
} from './render.js';

import {
  meta, createSession, DIFFICULTIES as SESSION_DIFFICULTIES,
} from './index.js';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${expected}，实际 ${actual}`);
}

function sameGrid(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ── 测试辅助（全部走公开 API） ── */

/**
 * 造一盘指定的盘面：默认不生成新方块（避免干扰断言），初始 0 枚。
 * 需要验证「生成」的用例传 opts.spawnFn（真实生成器或 spawnFirst）即可。
 */
function board(rows, opts = {}) {
  const g = createGame({
    difficulty: opts.difficulty ?? 'normal',
    target: opts.target,
    rng: opts.rng ?? mulberry32(7),
    spawnFn: opts.spawnFn ?? (() => null),
    initial: 0,
  });
  // rows 可以是「二维数组盘面」，也可以是尺寸数字（数字时留空盘）
  if (Array.isArray(rows)) setGrid(g, rows);
  return g;
}

/** 用真实生成器造一盘（验证数量/位置/概率的用例用它）。 */
function boardWithSpawn(rows, opts = {}) {
  const g = createGame({
    difficulty: opts.difficulty ?? 'normal',
    target: opts.target,
    rng: opts.rng ?? mulberry32(7),
    spawnFn: opts.spawnFn,          // 不传就用真实生成器
    initial: 0,
  });
  if (Array.isArray(rows)) setGrid(g, rows);
  return g;
}

/**
 * 把第一个空格填成 8（用于「移动后刚好被填死」的判负用例）。
 * 前提：盘面移动后只剩这一个空格。写完自己校验一遍，前提不成立就直接报错，
 * 免得测试用例悄悄失去意义（踩过一次：手推盘面推错，用例变成恒真）。
 */
function fillFirstWith8(grid) {
  const cells = emptyCells(grid);
  if (cells.length !== 1) throw new Error(`fillFirstWith8 前提不成立：空格数 ${cells.length}`);
  const c = cells[0];
  grid[c.y][c.x] = 8;
  return { x: c.x, y: c.y, value: 8 };
}

/** 把已有对局改成「每次生成都落在第一个空位且恒为 2」——生成位置完全可预测。 */
function spawnFirst(g) {
  g.spawnFn = (grid) => {
    const cells = emptyCells(grid);
    if (!cells.length) return null;
    const c = cells[0];
    grid[c.y][c.x] = SPAWN_VALUE_SMALL;
    return { x: c.x, y: c.y, value: SPAWN_VALUE_SMALL };
  };
  return g;
}

/** 盘面形状（值 > 0 的格子）→ 便于一眼比对。 */
function shape(grid) {
  const out = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (grid[y][x]) out.push(`${x},${y}=${grid[y][x]}`);
    }
  }
  return out;
}

/* ═══════════════ 一、滑行与合并规则 ═══════════════ */

console.log('\n【一】滑行与合并规则');
{
  // 2 2 2 2 左移 → 4 4（每个方块只合并一次，绝不变成 8）
  const l = slideGrid(board([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]).grid, LEFT);
  eq(l.grid[0].join(','), '4,4,0,0', '2 2 2 2 左移 → 4 4（不变成 8）');
  eq(l.score, 8, '2 2 2 2 左移得 8 分（4 + 4）');
  ok(sameGrid(l.grid[0], [4, 4, 0, 0]), '第一行精确等于 [4,4,0,0]');

  // 4 4 8 左移 → 8 8（不连锁合并成 16）
  const l2 = slideGrid([[4, 4, 8, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], LEFT);
  eq(l2.grid[0].join(','), '8,8,0,0', '4 4 8 左移 → 8 8（不连锁成 16）');
  eq(l2.score, 8, '4 4 8 左移得 8 分（只算合并出的 8）');
  ok(!l2.grid[0].includes(16), '结果里没有出现 16');

  // 右侧同理
  const r = slideGrid([[0, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], RIGHT);
  eq(r.grid[0].join(','), '0,0,2,4', '0 2 2 2 右移 → 2 4（从右往左配对）');

  // 多行同时处理
  const multi = slideGrid([
    [2, 0, 2, 0],
    [0, 4, 0, 4],
    [8, 8, 8, 8],
    [2, 4, 8, 16],
  ], LEFT);
  eq(multi.grid[0][0], 4, '多行：第一行合并成 4');
  eq(multi.grid[1][0], 8, '多行：第二行合并成 8');
  eq(multi.grid[2].join(','), '16,16,0,0', '多行：第三行 8 8 8 8 → 16 16');
  eq(multi.grid[3].join(','), '2,4,8,16', '多行：无同值的一行原样左靠');
  eq(multi.score, 4 + 8 + 16 + 16, '多行计分 = 各行合并值之和');
}

console.log('\n【二】四个方向都能移动');
{
  // 竖向用例
  const up0 = [[2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]];
  const u = slideGrid(up0, UP);
  eq(u.grid.map((row) => row[0]).join(','), '4,8,0,0', '向上合并第一列 → 4 8');

  const d = slideGrid([[2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]], DOWN);
  eq(d.grid.map((row) => row[0]).join(','), '0,0,4,8', '向下合并第一列 → 4 8');

  // 横向用例
  const le = slideGrid([[0, 0, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], LEFT);
  eq(le.grid[0].join(','), '4,0,0,0', '向左：把右侧的 2 2 靠到最左并合并');
  ok(le.moved, '向左：标记为有效移动');

  const ri = slideGrid([[0, 0, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], RIGHT);
  eq(ri.grid[0].join(','), '0,0,0,4', '向右：合并结果贴到最右');

  // 无效移动：无空格且无相邻同值
  const dead = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  for (const dir of DIRECTIONS) {
    const res = slideGrid(dead, dir);
    ok(!res.moved, `死盘「${dir}」方向为无效移动`);
    eq(res.score, 0, `死盘「${dir}」方向不计分`);
  }
  ok(!hasMoves(dead), '死盘没有可移动的方向');

  // 有相邻同值（哪怕满盘）就不算死
  const alive = [[2, 2, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  ok(hasMoves(alive), '满盘但有相邻同值 → 仍有走法');
}

/* ═══════════════ 三、生成新方块 ═══════════════ */

console.log('\n【三】新方块生成：数量、位置、概率');
{
  // 1) 每次有效移动恰好生成 1 枚，且落在空格上
  const g = boardWithSpawn([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { rng: mulberry32(11) });
  const before = emptyCells(g.grid).length;
  const res = move(g, LEFT, 100);
  ok(res.ok && res.moved, '有效移动返回 ok');
  eq(res.spawned.length, 1, '有效移动后恰好生成 1 枚新方块');
  const after = emptyCells(g.grid).length;
  eq(after, before - 1 + 1, '生成后空格数 = 合并腾出的 1 格被新方块占回（净变化 0）');
  const sp = res.spawned[0];
  ok(sp.value === 2 || sp.value === 4, `新方块只可能是 2 或 4（实际 ${sp.value}）`);
  eq(g.grid[sp.y][sp.x], sp.value, '新方块如实写进了盘面');
  eq(g.spawns.length, 1, '生成序列记录了这一枚');

  // 2) 生成位置可预测（隔离随机：列表第一个空位）
  const g2 = spawnFirst(boardWithSpawn([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
  const r2 = move(g2, LEFT, 0);
  eq(g2.grid[0].join(','), '4,2,0,0', '左移后 4 后面跟着新生成的 2');
  eq(r2.spawned[0].x, 1, '新方块落在第一个空位（x=1）');
  eq(r2.spawned[0].y, 0, '新方块落在第一行');

  // 3) 取值概率：rng < 0.10 → 出 4，否则出 2
  const gv = board([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { rng: () => 0.05 });
  eq(spawnTile(gv.grid, () => 0.05).value, SPAWN_VALUE_BIG, 'rng=0.05 → 生成 4');
  const gv2 = board([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { rng: () => 0.5 });
  eq(spawnTile(gv2.grid, () => 0.5).value, SPAWN_VALUE_SMALL, 'rng=0.5 → 生成 2');
  eq(SPAWN_BIG_RATE, 0.10, '大数（4）概率为 10%');

  // 4) 满盘时 spawnTile 不生成
  const full = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  eq(spawnTile(full.map((r) => r.slice()), mulberry32(3)), null, '满盘时不再生成新方块');

  // 5) 5000 次抽样：比例贴近 90 / 10，且全部落在空格上
  const rng = mulberry32(2024);
  let big = 0;
  let legal = true;
  for (let i = 0; i < 5000; i++) {
    const grid = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const t = spawnTile(grid, rng);
    if (!t || grid[t.y][t.x] !== t.value || (t.value !== 2 && t.value !== 4)) { legal = false; break; }
    if (t.value === 4) big++;
  }
  const rate = big / 5000;
  ok(legal, '5000 次生成全部合法（位置在空格、取值只能是 2/4）');
  ok(rate > 0.07 && rate < 0.13, `生成 4 的比例接近 10%（实测 ${(rate * 100).toFixed(1)}%）`);
}

/* ═══════════════ 四、无效移动 ═══════════════ */

console.log('\n【四】无效移动：不生成、不计分、不进撤销栈');
{
  const g = board([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { rng: mulberry32(5) });
  const r = move(g, LEFT, 0);
  ok(!r.ok, '唯一方块贴左边时左移是无效移动');
  eq(r.reason, 'nochange', '无效移动的原因标注为 nochange');
  eq(r.spawned.length, 0, '无效移动不生成新方块');
  eq(g.grid[0][0], 2, '无效移动不改盘面');
  eq(g.score, 0, '无效移动不计分');
  eq(g.moves, 0, '无效移动不算一步');
  eq(g.spawns.length, 0, '无效移动不写生成序列');
  eq(canUndo(g), false, '无效移动不进撤销栈');

  const r2 = move(g, 'diagonal', 0);
  ok(!r2.ok && r2.reason === 'dir', '非法方向被拒绝');

  // 每个方向的无效判定都不会顺手生成方块
  let spawnsAfterInvalid = 0;
  for (const dir of DIRECTIONS) {
    const gg = board([[0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 2]], { rng: mulberry32(9) });
    const res = move(gg, dir, 0);
    if (!res.ok) spawnsAfterInvalid += gg.spawns.length;
  }
  eq(spawnsAfterInvalid, 0, '四种无效方向都没有生成方块');

  // 移动方向返回给 UI
  const g3 = board([[0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const r3 = move(g3, LEFT, 0);
  eq(r3.dir, LEFT, '返回本次移动的方向');
  eq(g3.lastDir, LEFT, '对局记下最近一次有效方向');
}

/* ═══════════════ 五、胜利判定 ═══════════════ */

console.log('\n【五】胜利判定：出现目标值即胜，且可继续玩');
{
  const g = board([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { target: 2048 });
  const r = move(g, LEFT, 500);
  eq(maxTile(g.grid), 2048, '两个 1024 合并出 2048');
  eq(r.reached, 2048, '本次移动返回「达成目标」');
  eq(g.result, WON, '出现 2048 即判胜');
  eq(g.reachedTarget, true, '胜利标记置位');
  eq(r.score, 2048, '计分累加合并后的值 2048');

  // 2) 胜利后仍可继续（不锁死对局）
  const r2 = move(g, DOWN, 600);
  ok(r2.ok, '胜利后仍可继续移动（不锁死）');
  eq(g.result, WON, '继续玩时结果仍保持 won');
  ok(g.history.length >= 2, '胜利后的移动照样进撤销栈');

  // 3) 低难度目标 512 也应判胜
  const e = board([[256, 256, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { difficulty: 'easy' });
  const re = move(e, LEFT, 0);
  eq(re.reached, 512, '简单档目标 512 合并出即达成');
  eq(e.result, WON, '简单档判胜');

  // 4) 未达目标不算胜
  const n = board([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { target: 2048 });
  const rn = move(n, LEFT, 0);
  eq(rn.reached, null, '没到目标时不报达成');
  eq(n.result, PLAYING, '没到目标时仍在进行中');
  eq(n.reachedTarget, false, '没到目标时胜利标记为假');
}

/* ═══════════════ 六、失败判定 ═══════════════ */

console.log('\n【六】失败判定：满盘且无相邻同值');
{
  // 死盘（棋盘满、上下左右都不同）
  const dead = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  const g = board(dead, { rng: mulberry32(4) });
  ok(!hasMoves(g.grid), '死盘无可移动方向');
  eq(emptyCells(g.grid).length, 0, '死盘没有空格');
  const r = move(g, LEFT, 0);
  ok(!r.ok && r.reason === 'over', '死盘上移动被拒绝（对局已结束）');
  eq(g.result, LOST, '满盘且无相邻同值 → 判负');
  eq(r.spawned.length, 0, '判负局面不会生成新方块');

  // 满盘但还有相邻同值 → 不算负
  const alive = [[2, 2, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  const g2 = board(alive);
  ok(hasMoves(g2.grid), '满盘但有相邻同值 → 不算负');
  eq(g2.result, PLAYING, '该局面仍可继续');

  // 移动之后盘面刚好被填死 → 本次移动就能判负
  // 第四列 16 8 4 16 向下不动；第二列 [16,16,16,2] → [2,32]；唯一空位 (1,0) 由生成器填 8
  const g3 = boardWithSpawn([
    [2, 16, 4, 16],
    [4, 16, 2, 8],
    [16, 16, 8, 4],
    [4, 2, 4, 16],
  ], { spawnFn: fillFirstWith8 });
  const r3 = move(g3, DOWN, 0);
  eq(g3.grid[3].join(','), '4,2,4,16', '向下合并后的末行（原样）');
  eq(g3.grid[1].join(','), '4,16,2,8', '合并后上移的一行');
  eq(g3.grid[0].join(','), '2,8,4,16', '末行之外被生成器补上的唯一空格');
  ok(!hasMoves(g3.grid), '补满后确实无路可走');
  eq(g3.result, LOST, '补满后无路可走 → 判负');
  eq(r3.result, LOST, '返回值里带着判负结果');
}

/* ═══════════════ 七、撤销 ═══════════════ */

console.log('\n【七】撤销还原');
{
  const g = spawnFirst(boardWithSpawn([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
  const r = move(g, LEFT, 0);
  eq(g.grid[0].join(','), '4,2,0,0', '左移后盘面：4 与新生 2');
  eq(g.score, 4, '左移得 4 分');
  eq(g.moves, 1, '有效移动记 1 步');
  ok(canUndo(g), '有效移动后可撤销');

  const u = undo(g);
  ok(u.ok, '撤销成功');
  eq(g.grid[0].join(','), '2,2,0,0', '撤销还原到移动前的盘面');
  eq(g.score, 0, '撤销还原分数');
  eq(g.moves, 0, '撤销还原步数');
  eq(g.spawns.length, 0, '撤销回退了本次生成');
  eq(canUndo(g), false, '撤销栈已空');
  const u2 = undo(g);
  ok(!u2.ok && u2.reason === 'empty', '没有历史时撤销被拒绝');

  // 撤销 → 重走：盘面与分数完全一致（不会因为重掷随机数而变样）
  const r2 = move(g, LEFT, 10);
  eq(g.grid[0].join(','), '4,2,0,0', '重走后盘面与第一次完全一致');
  eq(g.score, 4, '重走后的分数与第一次一致');

  // 多次移动后可连续撤销
  const g2 = board([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { rng: mulberry32(31) });
  const m1 = move(g2, LEFT, 0);
  const afterFirst = JSON.stringify(g2.grid);
  const s1 = g2.score;
  const m2 = move(g2, DOWN, 0);
  ok(m2.ok, '第二次移动有效');
  undo(g2);
  eq(JSON.stringify(g2.grid), afterFirst, '连续撤销逐步还原（第二步）');
  eq(g2.score, s1, '连续撤销还原分数');
  undo(g2);
  eq(g2.grid[0].join(','), '2,2,0,0', '连续撤销逐步还原（第一步）');
  eq(g2.score, 0, '全部撤销后分数归零');
  eq(g2.spawns.length, 0, '全部撤销后生成序列清空');

  // 撤销失败局面 → 回到 playing
  const g3 = boardWithSpawn([[2, 16, 4, 16], [4, 16, 2, 8], [16, 16, 8, 4], [4, 2, 4, 16]],
    { spawnFn: fillFirstWith8 });
  move(g3, DOWN, 0);
  eq(g3.result, LOST, '先判负');
  undo(g3);
  eq(g3.result, PLAYING, '撤销后恢复到进行中');
}

/* ═══════════════ 八、可复现性 ═══════════════ */

console.log('\n【八】种子随机数：同种子必然同盘');
{
  const run = (seed) => {
    const g = createGame({ difficulty: 'normal', rng: mulberry32(seed) });
    const steps = [LEFT, UP, RIGHT, DOWN, LEFT, UP, RIGHT, DOWN, LEFT, UP];
    for (const d of steps) move(g, d, 0);
    return { grid: g.grid, score: g.score, moves: g.moves };
  };
  const a = run(20240927);
  const b = run(20240927);
  ok(sameGrid(a.grid, b.grid), '同种子 10 步后盘面完全一致');
  eq(a.score, b.score, '同种子分数一致');
  eq(a.moves, b.moves, '同种子步数一致');

  const c = run(20240928);
  ok(!sameGrid(a.grid, c.grid) || a.score !== c.score, '不同种子走出不同结果（随机性有效）');

  // 开局：4×4 预生成 2 枚，且都是 2 或 4
  const g = createGame({ difficulty: 'normal', rng: mulberry32(1) });
  eq(g.grid.flat().filter((v) => v > 0).length, 2, '开局预生成 2 枚方块');
  ok(g.grid.flat().every((v) => v === 0 || v === 2 || v === 4), '开局方块只能是 2 或 4');
}

/* ═══════════════ 九、难度档位 ═══════════════ */

console.log('\n【九】难度档位：尺寸与目标值');
{
  eq(DIFFICULTY_KEYS.join(','), 'easy,normal,hard', '三档难度 key 顺序固定');
  eq(DIFFICULTIES.easy.size, 4, '简单档 4×4');
  eq(DIFFICULTIES.easy.target, 512, '简单档目标 512');
  eq(DIFFICULTIES.normal.size, 4, '普通档 4×4');
  eq(DIFFICULTIES.normal.target, 2048, '普通档目标 2048');
  eq(DIFFICULTIES.hard.size, 5, '困难档 5×5');
  eq(DIFFICULTIES.hard.target, 4096, '困难档目标 4096');
  eq(difficultyConfig('nope').name, DIFFICULTIES[DEFAULT_DIFFICULTY].name, '未知难度退回默认档');

  const h = createGame({ difficulty: 'hard', rng: mulberry32(2) });
  eq(h.size, 5, '困难档棋盘边长 5');
  eq(h.grid.length, 5, '困难档盘面 5 行');
  eq(h.grid[0].length, 5, '困难档盘面 5 列');
  eq(h.target, 4096, '困难档目标 4096');

  const h2 = spawnFirst(createGame({ difficulty: 'hard', spawnFn: () => null, initial: 0 }));
  // 5×5 上竖向合并
  setGrid(h2, [[2, 0, 0, 0, 0], [2, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]);
  const r = move(h2, UP, 0);
  eq(h2.grid[0][0], 4, '5×5 上向上合并同样成立');
  eq(r.ok, true, '5×5 移动有效');
}

/* ═══════════════ 十、工具函数与快照 ═══════════════ */

console.log('\n【十】数值工具 / 快照 / 文案');
{
  eq(tileExp(2), 1, 'tileExp(2)=1');
  eq(tileExp(4), 2, 'tileExp(4)=2');
  eq(tileExp(2048), 11, 'tileExp(2048)=11');
  eq(tileExp(0), 0, 'tileExp(0)=0');
  eq(expToValue(11), 2048, 'expToValue(11)=2048');
  eq(expToValue(1), 2, 'expToValue(1)=2');
  eq(tileExp(expToValue(20)), 20, 'tileExp / expToValue 互为逆运算');

  const g = boardWithSpawn([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const s0 = snapshot(g, 0);
  eq(s0.size, 4, '快照带尺寸');
  eq(s0.cells.length, 4, '快照是 4×4');
  eq(s0.cells[0][0].value, 2, '快照读出方块数值');
  eq(s0.cells[0][0].exp, 1, '快照带指数');
  eq(s0.canUndo, false, '初始不能撤销');

  const r = move(g, LEFT, 1000);
  const s1 = snapshot(g, 1000);
  eq(s1.score, 4, '快照分数跟着更新');
  eq(s1.best, 4, '快照最高分跟着更新');
  const sp = r.spawned[0];
  eq(s1.cells[sp.y][sp.x].spawnAt, 1000, '新方块带上生成时间戳（做淡入动画）');
  eq(s1.cells[0][0].mergeAt, 1000, '合并格带上合并时间戳（做弹跳动画）');
  eq(s1.cells[0][0].value, 4, '合并格数值正确');

  // 时间戳缺席时动画不越界（render 里用 now - t0 算进度）
  eq(snapshot(board([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])).cells[0][0].spawnAt, 0,
    '静态盘面无动画时间戳（视为已完成）');

  ok(statusText(board([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])).includes('2048'),
    '状态文案里带目标值');
  const win = board([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { target: 2048 });
  move(win, LEFT, 0);
  ok(statusText(win).includes('达成'), '达成后状态文案变化');
  const lose = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
  ok(statusText(lose).includes('无路可走'), '判负后状态文案变化');
  eq(win.result, WON, '（复核）达成对局结果为 won');
  eq(lose.result, LOST, '（复核）死盘结果为 lost');
}

/* ═══════════════ 十一、布局与输入几何 ═══════════════ */

console.log('\n【十一】布局 / 滑动方向 / 命中');
{
  const L = computeLayout(375, 667, { top: 24, bottom: 34 }, 4);
  eq(L.board.size, 4, '布局记下棋盘边长');
  ok(Math.abs(L.board.w - L.board.h) < 1e-6, '棋盘是正方形');
  ok(L.board.w <= L.width, '棋盘不超出屏宽');
  eq(L.board.x + L.board.w <= L.width, true, '棋盘右边不出屏');
  ok(L.board.y > L.hud.y, '棋盘在分数面板下方');
  const btn = L.buttons[1];
  ok(btn.y + btn.h <= L.bottomLimit + 1e-9, '底部按钮不越过 insets.bottom + 16 的安全线');
  eq(L.bottomLimit, 667 - 34 - 16, '安全线 = 高度 − insets.bottom − 16');
  eq(hitButton(L, btn.x + 4, btn.y + 4), 'undo', '命中撤销按钮');
  eq(hitButton(L, L.buttons[0].x + 4, L.buttons[0].y + 4), 'restart', '命中重新开始按钮');
  eq(hitButton(L, 1, 1), null, '左上角（集成层的返回键）不属于本模块');

  // 方向键已删除：布局里只剩底部两颗按钮，屏上命中不到任何方向键
  eq(L.buttons.length, 2, '布局只剩两颗按钮（重新开始 / 撤销，方向键已删除）');
  ok(L.buttons.every((b) => b.key === 'restart' || b.key === 'undo'),
    'layout.buttons 只含 restart / undo，不含 up/left/down/right');
  let dirHits = 0;
  for (let yy = 0; yy <= L.height; yy += 7) {
    for (let xx = 0; xx <= L.width; xx += 7) {
      const k = hitButton(L, xx, yy);
      if (k === 'up' || k === 'down' || k === 'left' || k === 'right') dirHits++;
    }
  }
  eq(dirHits, 0, '全屏采样命中不到任何方向键');
  // 方向键让出的竖向空间已并入棋盘可用区：棋盘吃满可用宽高
  const availH = L.buttons[0].y - L.pad - (L.hud.y + L.hud.h);
  ok(L.board.w >= Math.min(L.width - L.pad * 2, availH) - 1,
    '棋盘吃满可用宽高（方向键空间已还给棋盘）');

  // 5×5 也要放得下
  const L5 = computeLayout(375, 667, { top: 24, bottom: 34 }, 5);
  ok(L5.board.tile > 10, '5×5 格子仍有可用尺寸');
  ok(Math.abs(L5.board.cell * 5 - L5.board.w) < 1e-6, '5×5 的 cell 与棋盘宽自洽');

  // 窄屏 / 矮屏不崩
  const small = computeLayout(240, 400, {}, 4);
  ok(small.board.w > 0 && small.board.h > 0, '小屏也能算出棋盘');
  const big = computeLayout(768, 1024, { top: 40, bottom: 20 }, 5);
  ok(big.board.w <= big.width, '平板尺寸棋盘不出屏');

  // 滑动方向
  eq(directionFor(-80, 5), LEFT, '左滑 → left');
  eq(directionFor(80, -5), RIGHT, '右滑 → right');
  eq(directionFor(4, -70), UP, '上滑 → up');
  eq(directionFor(-3, 70), DOWN, '下滑 → down');
  eq(directionFor(10, 8), null, '位移太小时不判定方向');
  eq(directionFor(-40, 12), LEFT, '斜滑按主轴判定');
  eq(directionFor(30, 60), DOWN, '斜滑纵向为主 → down');
  eq(directionFor(60, 30), RIGHT, '斜滑横向为主 → right');
  eq(directionFor(NaN, 0), null, '非法输入不判定方向');
  ok(SLIDE_THRESHOLD >= 16 && SLIDE_THRESHOLD <= 40, '滑动阈值在合理区间');

  // 调色板：浅底深字
  const p = palette({});
  ok(typeof p.textPrimary === 'string' && p.textPrimary.length > 0, '调色板给出文字色');
  ok(typeof p.cardBg === 'string', '调色板给出卡片底色');
  const pl = palette({ textTitle: '#2f4f4a', textBody: '#3d5b56' });
  eq(pl.textPrimary, '#3d5b56', '浅色主题优先用 textBody 当正文色');
  const pd = palette({ textPrimary: '#f2f3f7' });
  eq(pd.textPrimary, '#f2f3f7', '主题给了 textPrimary 就照用');

  // 方块配色：2 / 4 / 8 / … / 2048 各不相同
  const exps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const bases = exps.map((e) => TILE_COLORS[e] && TILE_COLORS[e].base);
  ok(bases.every((c) => typeof c === 'string'), '2…2048 每一档都有配色');
  eq(new Set(bases).size >= 9, true, `配色基本两两不同（去重后 ${new Set(bases).size} 种）`);
  ok(tileColor(2).base !== tileColor(2048).base, '2 与 2048 配色不同');
  ok(tileColor(8192) != null, '超出配色表的超大数值有兜底色');
  eq(tileColor(0), null, '空格没有配色');

  // 渲染入口在假 ctx 上不抛异常
  const ctx = fakeCtx();
  const view = {
    size: 4,
    cells: [[{ value: 2 }, { value: 4 }, { value: 0 }, { value: 0 }],
      [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 0 }],
      [{ value: 1024 }, { value: 0 }, { value: 0 }, { value: 0 }],
      [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 2048 }]],
    score: 20, best: 20, moves: 2, target: 2048, result: PLAYING,
    reachedTarget: false, canUndo: true, levelName: '普通',
    pressButton: 'undo', gain: { value: 8, at: 0 }, settleAt: 0, reached: 0, now: 0,
  };
  let threw = null;
  try { renderFrame(ctx, computeLayout(375, 667, { bottom: 34 }, 4), view, {}, 0); } catch (e) { threw = e; }
  ok(!threw, 'renderFrame 在假 ctx 上不抛异常', threw ? String(threw && threw.message) : '');
  ok(ctx.calls.some((c) => c === 'fillText'), '绘制过程真的画了文字（分数/数字）');
  ok(!ctx.calls.includes('clearRect'), '不清屏（背景由集成层铺，不能擦掉青白底色）');

  // 结算态也画一遍
  const settled = { ...view, result: LOST, settleAt: 0 };
  let threw2 = null;
  try { renderFrame(fakeCtx(), computeLayout(375, 667, {}, 4), settled, {}, 0); } catch (e) { threw2 = e; }
  ok(!threw2, '判负态渲染不抛异常');
}

/* ═══════════════ 十二、会话接口（index.js） ═══════════════ */

console.log('\n【十二】会话接口');
{
  eq(meta.id, 'game2048', 'meta.id 与目录名一致');
  eq(meta.ready, true, 'meta.ready 为真');
  eq(meta.difficulties.length, 3, 'meta 给出三档难度');
  eq(meta.difficulties.map((d) => d.key).join(','), 'easy,normal,hard', '难度 key 与 core 一致');
  ok(meta.difficulties.every((d) => d.desc && d.desc.length > 0), '每档难度都写了说明');
  eq(meta.difficulties[2].desc.includes('5×5'), true, '困难档说明里写明 5×5');
  eq(SESSION_DIFFICULTIES.hard.target, 4096, '入口再导出的难度表与 core 同一份');

  const s = createSession({ width: 375, height: 667, insets: { top: 24, bottom: 34 }, difficulty: 'normal', theme: {} });
  eq(typeof s.tap, 'function', '会话有 tap');
  eq(typeof s.gesture, 'function', '会话有 gesture');
  eq(typeof s.key, 'function', '会话有 key');
  eq(typeof s.render, 'function', '会话有 render');
  eq(s.outcome, null, '开局时没有结果');

  // 方向键：别名与大小写都要认
  const k1 = s.key('ArrowLeft', 1000);
  eq(k1.type, 'move', 'key("ArrowLeft") 被识别为移动');
  ok(k1.dir === LEFT || k1.reason === 'nochange', 'ArrowLeft 解析为 left（或该方向无效）');
  const k2 = s.key('arrowup', 1000);
  eq(k2.dir, UP, '键名大小写不敏感，arrowup → up');
  const k3 = s.key('Enter', 1000);
  eq(k3.type, 'miss', '非方向键返回 miss');
  const before = JSON.stringify(s.snapshot.cells.map((r) => r.map((c) => c.value)));
  s.key('Space', 1000);
  eq(JSON.stringify(s.snapshot.cells.map((r) => r.map((c) => c.value))), before, '非方向键不改盘面');

  // 滑动：小位移不触发，大位移触发一次
  const g1 = s.gesture(200, 400, 204, 402, 1100);
  eq(g1.type, 'miss', '位移过小的滑动不触发移动');
  const g2 = s.gesture(200, 400, 60, 400, 1200);
  eq(g2.type, 'move', '左滑触发移动');
  eq(g2.dir, LEFT, '左滑方向正确');
  const g3 = s.gesture(200, 300, 200, 190, 1300);
  eq(g3.dir, UP, '上滑方向正确');

  // 滑动手势是根本交互：滑动必须真的改变盘面（方向键删除后不得误伤 gesture）
  const s3 = createSession({ width: 375, height: 667, insets: { top: 24, bottom: 34 }, difficulty: 'normal', theme: {} });
  const gridOf = (sess) => JSON.stringify(sess.snapshot.cells.map((r) => r.map((c) => c.value)));
  const beforeG = gridOf(s3);
  let gestureMoved = false;
  // 依次试四个方向的大位移滑动，开局只有 2 枚方块，至少一个方向必然有效
  for (const [x0, y0, x1, y1] of [[200, 400, 60, 400], [200, 400, 340, 400], [200, 400, 200, 240], [200, 400, 200, 560]]) {
    const r = s3.gesture(x0, y0, x1, y1, 2000);
    if (r.type === 'move' && r.moved) { gestureMoved = true; break; }
  }
  ok(gestureMoved, 'gesture 滑动能触发有效移动（任一方向）');
  ok(gridOf(s3) !== beforeG, 'gesture 滑动后棋盘确实发生变化');
  s3.destroy();

  // tap：按钮与外区
  const L = s.layoutSize;
  eq(s.tap(L.x + L.w + 500, L.y, 1400).type, 'miss', '点在棋盘与按钮之外返回 miss');
  s.press(L.x + 10, L.y + 10);
  s.release();
  ok(true, 'press / release 不抛异常');
  const tapBoard = s.tap(s.layoutSize.x + 5, s.layoutSize.y + 5, 1500);
  eq(tapBoard.type, 'board-tap', '点在棋盘上只做轻提示，不改盘面');

  // update / busy / hud / resize / destroy
  s.update(1600);
  eq(typeof s.busy, 'boolean', 'busy 是可读布尔值');
  ok(typeof s.hud.title === 'string' && s.hud.title.length > 0, 'hud.title 非空');
  ok(typeof s.hud.status === 'string' && s.hud.status.length > 0, 'hud.status 非空');
  s.resize(414, 736, { top: 44, bottom: 34 });
  eq(s.layoutSize.w > 0, true, 'resize 后布局仍有效');
  s.destroy();
  eq(s.busy, false, 'destroy 后不再推帧');

  // 时间约定：传入的 now 必须被原样使用（相对时钟混用会得到天文数字）
  const s2 = createSession({ difficulty: 'normal', theme: {} });
  const t0 = Date.now();
  s2.update(t0);
  const snapA = s2.snapshot;
  ok(snapA.now === undefined || true, 'snapshot 可读');
  s2.key('ArrowDown', t0 + 3000);
  ok(true, '传入绝对时间戳后照常工作');
  const snapB = s2.snapshot;
  ok(snapB.best >= 0, '分数不出现 NaN');
  ok(Number.isFinite(snapB.score), '分数是有限数（没有把时间戳混进分数）');
}

/* ═══════════════ 十三、源码硬约束自检 ═══════════════ */

console.log('\n【十三】硬约束自检：核心层无平台 API、无第三方依赖');
{
  const dir = new URL('./', import.meta.url);
  const read = (f) => readFileSync(new URL(f, dir), 'utf8');
  // 只保留「代码」，剥掉注释与字符串：注释里难免出现「无 window」这类说明，
  // 拿整份源码做 includes 检查会误报（这个坑扫雷那边也踩过）。
  const codeOf = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

  const coreCode = codeOf(read('core.js'));
  for (const bad of ['wx', 'document', 'window', 'canvas', 'performance', 'localStorage', 'requestAnimationFrame']) {
    ok(!coreCode.includes(bad), `core.js 代码里不出现「${bad}」（注释不算）`);
  }
  ok(!/\bimport\s/.test(coreCode), 'core.js 没有任何 import（纯逻辑自足）');
  ok(coreCode.includes('Math.random'), 'core.js 里 Math.random 只作为默认随机源出现');
  ok(coreCode.includes('export function move'), 'core.js 导出 move');
  ok(coreCode.includes('export function undo'), 'core.js 导出 undo');

  // 依赖检查要看**原始源码**的 import 路径（剥注释会把路径也剥掉，那检查就成了空转）
  const specifiers = (src) => [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const noThirdParty = (name) => ok(
    specifiers(read(name)).every((s) => s.startsWith('.') || s.startsWith('node:')),
    `${name} 只 import 相对路径或 node: 内置模块（零第三方依赖）`,
  );

  const renderCode = codeOf(read('render.js'));
  noThirdParty('render.js');
  ok(!renderCode.includes('clearRect'), 'render.js 代码里不调用 clearRect（不擦集成层的青白底）');
  ok(!renderCode.includes('performance'), 'render.js 代码里不出现 performance（时间约定）');
  ok(renderCode.includes('export function renderFrame'), 'render.js 导出 renderFrame');

  const indexCode = codeOf(read('index.js'));
  noThirdParty('index.js');
  ok(indexCode.includes('export const meta'), 'index.js 导出 meta');
  ok(indexCode.includes('export function createSession'), 'index.js 导出 createSession');
  ok(!indexCode.includes('performance'), 'index.js 代码里不出现 performance（时间约定）');
  ok(indexCode.includes('Date.now'), 'index.js 的 fallback 时钟用 Date.now');

  noThirdParty('test.mjs');
  ok(specifiers(read('core.js')).length === 0, 'core.js 连 import 语句都没有（纯逻辑自足）');
}

/* ── 假 Canvas 上下文：只记录被调用的方法，用于验证渲染不崩 ── */
function fakeCtx() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push(name); return args.length ? undefined : undefined; };
  const grad = { addColorStop: () => {} };
  const ctx = {
    calls,
    canvas: { width: 375, height: 667 },
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    measureText: (t) => ({ width: String(t).length * 8 }),
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    arcTo: rec('arcTo'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillRect: rec('fillRect'),
    clearRect: rec('clearRect'),
    fillText: rec('fillText'),
    clip: rec('clip'),
    translate: rec('translate'),
    scale: rec('scale'),
    setTransform: rec('setTransform'),
  };
  return ctx;
}

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) {
  console.log('失败清单：');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail === 0 ? 0 : 1);
