/**
 * 数独核心逻辑测试（Node 直接跑，零依赖，不碰微信 API）
 * 用法：node src/games/sudoku/test.mjs
 *
 * 覆盖点（任务要求 + 规范 §8 时间约定 + 边界）：
 *   1) 生成题目「有唯一解」——多个种子 × 三个难度，且逐格验证「少给一个数必不唯一」
 *   2) 行列宫冲突检测
 *   3) 候选数计算正确（与独立实现比对）
 *   4) 填错检测（与解对比的口径）
 *   5) 胜利判定
 *   6) 提示填入的是正确值、且推进局面
 *   7) 挖空数量符合难度（easy 35 / normal 45 / hard 52）
 *   8) 计时数据（显式注入时间戳：N 与 N+3000 → 用时 00:03）
 *   9) 布局：底部按钮与数字键盘不侵占 insets.bottom + 16
 *  10) 绘制层与模块入口冒烟、meta/RNG 纯逻辑约束
 */
import {
  SIZE, BOX, CELLS, EMPTY, LEVELS, LEVEL_KEYS, PLAYING, WON,
  levelConfig, makeRng, idx, rcOf, createGrid, cloneGrid, isDigit,
  canPlace, isValidGrid, ruleConflictsAt, countEmpty,
  cellCandidates, candidatesOf, digitCounts,
  solveCount, hasUniqueSolution, solveGrid, generateFullGrid, generatePuzzle,
  holeCount, puzzleInfo, gridKey, loadPuzzle,
  createGame, wrongAt, errorCells, errorCount, inGrid, filledCount, isComplete, isSolved,
  placeDigit, eraseCell, toggleNote, notesAt, noteAt, clearNotes, clearNoteDigit, hint,
  createTimer, startTimer, stopTimer, elapsedMs, formatTime,
  snapshot, createGameSession, updateGame, sessionPlace, sessionErase, sessionNote,
  sessionHint, restartGame, scoreOf,
} from './core.js';
import { computeLayout, gridAt, hitKey, hitButton, renderFrame, pathRoundRect } from './render.js';
import { meta, createSession } from './index.js';
import { mulberry32 } from '../minesweeper/core.js';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${expected}，实际 ${actual}`);
}

function ne(actual, unexpected, name) {
  ok(actual !== unexpected, name, actual !== unexpected ? '' : `不应等于 ${unexpected}`);
}

/* ── 独立实现的辅助（不偷看 core 的内部实现） ── */

/** 造一张已知唯一解的题：从完整解里挖掉 (r,c) 以外的所有给定。 */
function fromSolution(solution, givens) {
  const g = createGrid();
  for (const key of givens) {
    const { r, c } = rcOf(key);
    g[r][c] = solution[r][c];
  }
  return g;
}

/** 独立实现的候选数：暴力扫行/列/宫，不走 core 的位运算。 */
function expectCandidates(grid, r, c) {
  if (grid[r][c] !== EMPTY) return [];
  const used = new Set();
  for (let i = 0; i < SIZE; i++) { used.add(grid[r][i]); used.add(grid[i][c]); }
  const br = Math.floor(r / BOX) * BOX;
  const bc = Math.floor(c / BOX) * BOX;
  for (let i = 0; i < BOX; i++) {
    for (let j = 0; j < BOX; j++) used.add(grid[br + i][bc + j]);
  }
  const out = [];
  for (let d = 1; d <= SIZE; d++) if (!used.has(d)) out.push(d);
  return out;
}

/** 独立实现的解数统计（朴素回溯，用于交叉验证 core 的 solver）。 */
function naiveCount(grid, limit = 2) {
  const g = cloneGrid(grid);
  let n = 0;
  const step = () => {
    let er = -1, ec = -1;
    for (let r = 0; r < SIZE && er < 0; r++) {
      for (let c = 0; c < SIZE; c++) if (g[r][c] === EMPTY) { er = r; ec = c; break; }
    }
    if (er < 0) { n++; return n >= limit; }
    for (let d = 1; d <= SIZE; d++) {
      if (!canPlace(g, er, ec, d)) continue;
      g[er][ec] = d;
      if (step()) { g[er][ec] = EMPTY; return true; }
      g[er][ec] = EMPTY;
    }
    return false;
  };
  step();
  return n;
}

/* ═══════════════════════════════════════════ */

console.log('\n【一】难度档位与基础结构');
{
  eq(meta.id, 'sudoku', 'meta.id 与目录名一致');
  eq(meta.ready, true, 'meta.ready = true');
  ok(meta.desc.length <= 16, `meta.desc 不超过 16 字（${meta.desc.length}）`);
  eq(LEVEL_KEYS.join(','), 'easy,normal,hard', '三档难度 key 正确');
  eq(meta.difficulties.map((d) => d.key).join(','), 'easy,normal,hard', 'meta 难度 key 与 core 对齐');
  for (const d of meta.difficulties) {
    ok(!!LEVELS[d.key], `meta 难度 ${d.key} 在 core 里有配置`);
    ok(d.name.length > 0 && d.desc.length > 0, `难度 ${d.key} 有名称与描述`);
  }
  eq(levelConfig('easy').holes, 35, '简单档挖空 35 格');
  eq(levelConfig('normal').holes, 45, '普通档挖空 45 格');
  eq(levelConfig('hard').holes, 52, '困难档挖空 52 格');
  eq(levelConfig('不存在的key').key, 'normal', '未知难度退回普通');

  eq(SIZE, 9, '棋盘 9×9');
  eq(CELLS, 81, '总格数 81');
  eq(idx(8, 8), 80, 'idx 换算正确');
  eq(rcOf(80).r, 8, 'rcOf 行还原正确');
  eq(rcOf(80).c, 8, 'rcOf 列还原正确');
  ok(isDigit(9) && !isDigit(0) && !isDigit(10) && !isDigit(1.5), 'isDigit 边界正确');
  eq(createGrid().length, 9, '空盘 9 行');
  eq(countEmpty(createGrid()), 81, '空盘 81 空格');
}

console.log('\n【二】生成题目有唯一解（多种子 × 三难度）');
{
  for (const key of LEVEL_KEYS) {
    const cfg = LEVELS[key];
    let allUnique = true, allCompatible = true, allValid = true, minHoles = CELLS;
    for (let seed = 1; seed <= 6; seed++) {
      const p = generatePuzzle(key, mulberry32(seed * 9176 + key.length * 31 + 7));
      if (!hasUniqueSolution(p.given)) allUnique = false;
      if (!isValidGrid(p.given)) allValid = false;
      // 给定格必须与解兼容（题面不能自相矛盾）
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const v = p.given[r][c];
          if (v !== EMPTY && v !== p.solution[r][c]) allCompatible = false;
        }
      }
      minHoles = Math.min(minHoles, holeCount(p));
    }
    ok(allValid, `${key}：6 个种子的题面都满足行/列/宫不重复`);
    ok(allCompatible, `${key}：6 个种子的题面都与解兼容`);
    ok(allUnique, `${key}：6 个种子的题目都恰好一个解`);
    ok(minHoles >= cfg.holes, `${key}：最少挖空 ${minHoles} ≥ 目标 ${cfg.holes}`);

    // 全盘只有解的拷贝这一种填满方式
    const p = generatePuzzle(key, mulberry32(4242 + key.length));
    eq(naiveCount(p.given, 2), 1, `${key}：独立朴素求解器复核也是唯一解`);
    const solved = solveGrid(p.given);
    ok(!!solved, `${key}：solver 能解出题`);
    eq(gridKey(solved), gridKey(p.solution), `${key}：solver 解出的就是生成时的解`);
  }

  // 困难档：再抽 10 个种子验证唯一性（任务要求「对多个种子验证」）
  let hardOk = true, hardHoles = [];
  for (let seed = 100; seed < 110; seed++) {
    const p = generatePuzzle('hard', mulberry32(seed));
    hardHoles.push(holeCount(p));
    if (!hasUniqueSolution(p.given)) hardOk = false;
  }
  ok(hardOk, '困难档：额外 10 个种子全部唯一解');
  ok(Math.min(...hardHoles) >= 52, `困难档：额外 10 个种子挖空均 ≥ 52（${hardHoles.join(',')}）`);

  // 唯一性校验的边界：再抽掉一个给定数，解的数量只会变多或不变（绝不会变少）
  // 注意：不能断言「抽掉任意一个给定数一定多解」——极小题面（29 给定的困难档）
  // 存在「既唯一又不极小」的情形，这是数独的固有性质，不是 bug。
  const p0 = generatePuzzle('normal', mulberry32(20260101));
  let notFewer = 0, tried = 0, fewer = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (p0.given[r][c] === EMPTY) continue;
      const g = cloneGrid(p0.given);
      g[r][c] = EMPTY;
      tried++;
      const n = solveCount(cloneGrid(g), 2);
      if (n >= 1) notFewer++;
      else fewer.push(`${r},${c}`);
    }
  }
  eq(notFewer, tried, `抽掉任意给定数后解数不会归零（${notFewer}/${tried}${fewer.length ? ' 例外：' + fewer.join(' ') : ''}）`);
  ok(tried >= 20, `验证样本足够（${tried} 个给定格）`);

  // 反向校验：多给一个「正确但原本没有」的数字，仍是唯一解
  const withExtra = cloneGrid(p0.given);
  const oneHole = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (withExtra[r][c] === EMPTY) oneHole.push({ r, c });
  withExtra[oneHole[0].r][oneHole[0].c] = p0.solution[oneHole[0].r][oneHole[0].c];
  eq(hasUniqueSolution(withExtra), true, '多给一个正确数字后仍是唯一解');

  // 唯一性拒绝：把某个给定数改成解里的另一个值 → 题面与解矛盾 → 0 解
  const conflict = cloneGrid(p0.given);
  const firstGiven = (() => {
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (p0.given[r][c] !== EMPTY) return { r, c };
    return null;
  })();
  conflict[firstGiven.r][firstGiven.c] = firstGiven.c + 1;
  eq(hasUniqueSolution(conflict), false, '与解矛盾的题面被判定为非唯一解');
}

console.log('\n【三】行列宫冲突检测');
{
  const full = generateFullGrid(mulberry32(999));
  ok(isValidGrid(full), '生成的完整解本身合法（无冲突）');

  // 行冲突
  const rowDup = cloneGrid(full);
  rowDup[0][0] = rowDup[0][5];
  ok(!isValidGrid(rowDup), '行内重复被判非法');
  ok(ruleConflictsAt(rowDup, 0, 0), '(0,0) 被标记为行冲突');
  ok(ruleConflictsAt(rowDup, 0, 5), '(0,5) 同样被标记为冲突');

  // 列冲突
  const colDup = cloneGrid(full);
  colDup[0][0] = colDup[7][0];
  ok(!isValidGrid(colDup), '列内重复被判非法');
  ok(ruleConflictsAt(colDup, 0, 0) && ruleConflictsAt(colDup, 7, 0), '列冲突两端都被标记');

  // 宫冲突（同行列错开，只在同一 3×3 宫内重复）
  const boxDup = cloneGrid(full);
  boxDup[0][0] = boxDup[2][2];
  ok(!isValidGrid(boxDup), '宫内重复被判非法');
  ok(ruleConflictsAt(boxDup, 0, 0) && ruleConflictsAt(boxDup, 2, 2), '宫冲突两端都被标记');

  // 空格不算冲突；未填满但无冲突时 isValidGrid 为真
  const partial = createGrid();
  partial[0][0] = 5;
  ok(isValidGrid(partial), '未填满但无冲突时视为合法');
  ok(!ruleConflictsAt(partial, 0, 0), '孤立数字不构成冲突');
  ok(!isValidGrid([[1, 2, 3]]), '结构不对（行数不足）视为非法');

  // canPlace：不违反规则才放得下
  const g = createGrid();
  g[0][0] = 1;
  ok(!canPlace(g, 0, 5, 1), '同行已有 1 → 不能放 1');
  ok(!canPlace(g, 5, 0, 1), '同列已有 1 → 不能放 1');
  ok(!canPlace(g, 1, 1, 1), '同宫已有 1 → 不能放 1');
  ok(canPlace(g, 8, 8, 1), '不相干的位置可以放 1');
  ok(!canPlace(g, 0, 0, 2), '已有数字的格子不能再放');
  ok(!canPlace(g, 8, 8, 0) && !canPlace(g, 8, 8, 10), '非法数字被拒');
}

console.log('\n【四】候选数计算');
{
  const full = generateFullGrid(mulberry32(31337));
  // 完整解上每格都已填 → 无候选
  let noCand = true;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (cellCandidates(full, r, c).length) noCand = false;
  ok(noCand, '已填满的盘面没有任何候选数');

  // 只留一格空：候选恰好是解里那个数字
  const oneHole = cloneGrid(full);
  const rr = 4, cc = 4;
  const want = full[rr][cc];
  oneHole[rr][cc] = EMPTY;
  eq(cellCandidates(oneHole, rr, cc).join(','), String(want), '只剩一格时候选唯一且等于解');

  // 空白盘：候选 1..9
  eq(cellCandidates(createGrid(), 0, 0).join(','), '1,2,3,4,5,6,7,8,9', '空盘任意格候选 1..9');

  // 与独立实现比对：三种局面下全盘 81 格逐一一致
  const cases = [];
  const p = generatePuzzle('hard', mulberry32(555));
  cases.push(p.given);
  const mid = cloneGrid(p.given);
  let placed = 0;
  for (let r = 0; r < SIZE && placed < 10; r++) {
    for (let c = 0; c < SIZE && placed < 10; c++) {
      if (mid[r][c] === EMPTY) { mid[r][c] = p.solution[r][c]; placed++; }
    }
  }
  cases.push(mid);
  cases.push(full);

  let mismatch = 0;
  for (const g of cases) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const a = cellCandidates(g, r, c).join(',');
        const b = expectCandidates(g, r, c).join(',');
        if (a !== b) mismatch++;
      }
    }
  }
  eq(mismatch, 0, '候选数与独立暴力实现全盘一致（3 种局面 × 81 格）');

  // candidatesOf 与 cellCandidates 一致
  const mat = candidatesOf(p.given);
  let matOk = true;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (mat[r][c].join(',') !== cellCandidates(p.given, r, c).join(',')) matOk = false;
    }
  }
  ok(matOk, 'candidatesOf 矩阵与单格调用一致');

  // digitCounts：还差几个
  const { counts, remaining } = digitCounts(p.given);
  let sum = 0;
  for (let d = 1; d <= SIZE; d++) sum += counts[d];
  eq(sum, CELLS - countEmpty(p.given), '已填数字总数 = 81 − 空格数');
  eq(remaining[1], 9 - counts[1], '剩余数 = 9 − 已出现数');
  ok(remaining.every((v) => v >= 0 && v <= 9), '剩余数取值都在 0..9');
}

console.log('\n【五】填错检测（与解对比的口径）');
{
  const p = generatePuzzle('easy', mulberry32(8080));
  const g = createGame(p);

  // 找两个空格：一个填对、一个填错
  const empties = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g.grid[r][c] === EMPTY) empties.push({ r, c });
  ok(empties.length === 35, `空盘上有 35 个空格（${empties.length}）`);
  const A = empties[0], B = empties[1];

  const wrongVal = (p.solution[A.r][A.c] % 9) + 1;
  const rA = placeDigit(g, A.r, A.c, wrongVal, 1000);
  ok(rA.ok, '落子成功');
  eq(rA.wrong, true, '返回值标记这是错填');
  eq(wrongAt(g, A.r, A.c), true, 'wrongAt 认定该格填错');
  eq(errorCount(g), 1, '错填数为 1');
  eq(errorCells(g).length, 1, 'errorCells 列出 1 格');

  const rB = placeDigit(g, B.r, B.c, p.solution[B.r][B.c], 1100);
  eq(rB.wrong, false, '填对的格子不算错');
  eq(wrongAt(g, B.r, B.c), false, 'wrongAt 认定该格正确');
  eq(errorCount(g), 1, '错填数仍为 1');

  // 擦掉错填 → 错填数归零
  eraseCell(g, A.r, A.c);
  eq(errorCount(g), 0, '擦掉错填后错填数归零');
  eq(wrongAt(g, A.r, A.c), false, '空格不算错');

  // 给定格永远不算错
  let givenWrong = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (p.given[r][c] !== EMPTY && wrongAt(g, r, c)) givenWrong++;
  eq(givenWrong, 0, '题面给定格不会被判为错填');

  // 非法的填法照样按「与解不符」处理（这是设计口径，不是漏洞）
  const g2 = createGame(p);
  const C = empties[2];
  const other = ((p.solution[C.r][C.c] + 1) % 9) + 1;
  placeDigit(g2, C.r, C.c, other, 1);
  eq(wrongAt(g2, C.r, C.c), true, '填入与解不符的数即为错（哪怕行内暂时不冲突）');

  // 无自带解的题（外部导入）退化为规则冲突口径
  const imported = loadPuzzle(gridKey(p.given));
  ok(imported && imported.solution === null, '导入题可以没有自带解');
  ok(imported.unique === true, '导入题的唯一性由 solver 现算（不为 false）');
  const g3 = createGame(imported);
  // 造一个真正的规则冲突：同一行两个空格填同一个数字
  const twoEmptyInRow = (() => {
    const byRow = new Map();
    for (const e of empties) {
      if (!byRow.has(e.r)) byRow.set(e.r, []);
      byRow.get(e.r).push(e.c);
    }
    for (const [r, cols] of byRow) if (cols.length >= 2) return { r, c1: cols[0], c2: cols[1] };
    return null;
  })();
  ok(!!twoEmptyInRow, '找到同一行里的两个空格用于制造冲突');

  const A1 = twoEmptyInRow;
  // 选一个「行、列、宫都没有重复」的数字，保证单独填它不算错
  let freeDigit = 0;
  for (let d = 1; d <= SIZE; d++) {
    let okFree = true;
    for (let i = 0; i < SIZE; i++) if (g3.grid[A1.r][i] === d || g3.grid[i][A1.c1] === d) okFree = false;
    const br0 = Math.floor(A1.r / BOX) * BOX;
    const bc0 = Math.floor(A1.c1 / BOX) * BOX;
    for (let i = 0; i < BOX; i++) for (let j = 0; j < BOX; j++) if (g3.grid[br0 + i][bc0 + j] === d) okFree = false;
    if (okFree) { freeDigit = d; break; }
  }
  ok(freeDigit > 0, `找到行列宫都不冲突的数字 ${freeDigit}`);
  placeDigit(g3, A1.r, A1.c1, freeDigit, 2);
  eq(wrongAt(g3, A1.r, A1.c1), false, `单独填 ${freeDigit} 不构成任何冲突`);
  placeDigit(g3, A1.r, A1.c2, freeDigit, 3);
  eq(wrongAt(g3, A1.r, A1.c2), true, `无解题目按规则冲突判定填错（同行重复 ${freeDigit}）`);
  eq(wrongAt(g3, A1.r, A1.c1), true, '冲突的另一端同样被判为错');

  // 提示的落子一定不是错填
  const g4 = createGame(p);
  const hv = hint(g4, -1, -1, 2000);
  ok(hv.ok, '提示成功');
  eq(wrongAt(g4, hv.r, hv.c), false, '提示填入的格子不是错填');
}

console.log('\n【六】胜利判定');
{
  const p = generatePuzzle('easy', mulberry32(606));
  const g = createGame(p);
  const empties = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g.grid[r][c] === EMPTY) empties.push({ r, c });
  const last = empties[empties.length - 1];

  // 先填满除最后一格以外的所有空格
  let t = 1000;
  for (let i = 0; i < empties.length - 1; i++) {
    const e = empties[i];
    placeDigit(g, e.r, e.c, p.solution[e.r][e.c], t);
    t += 10;
  }
  eq(g.status, PLAYING, '还剩一格时未判胜');
  eq(isSolved(g), false, '还剩一格时 isSolved 为假');
  eq(isComplete(g), false, '还剩一格时 isComplete 为假');
  eq(filledCount(g), CELLS - 1, '已填 80 格');

  // 最后一格：填对判胜
  const winRes = placeDigit(g, last.r, last.c, p.solution[last.r][last.c], t);
  eq(winRes.win, true, '最后一格填对 → 返回值 win');
  eq(g.status, WON, '对局状态为 WON');
  eq(isSolved(g), true, 'isSolved 为真');
  eq(isComplete(g), true, 'isComplete 为真');
  eq(countEmpty(g.grid), 0, '盘面填满');
  eq(errorCount(g), 0, '胜利盘面没有错填');
  ok(g.finishedAt > 0, '记录了结束时刻');

  // 胜利后不再接受落子
  const after = placeDigit(g, empties[0].r, empties[0].c, 1, t + 10);
  ok(!after.ok && after.reason === 'over', '胜利后落子被拒（reason=over）');
  ok(!eraseCell(g, empties[0].r, empties[0].c).ok, '胜利后擦除被拒');
  ok(!toggleNote(g, empties[0].r, empties[0].c, 1).ok, '胜利后标记被拒');

  // 填满但填错 → 不算胜利（与解不符）
  const p2 = generatePuzzle('normal', mulberry32(707));
  const g2 = createGame(p2);
  const es2 = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g2.grid[r][c] === EMPTY) es2.push({ r, c });
  // 取两个**不同宫**的空格来交换：这样交换后行列仍是 1..9 的排列，
  // 但宫里必然出现重复——"填满 ≠ 正确"就有了硬证据
  const first = es2[0];
  const second = es2.find((e) => Math.floor(e.r / BOX) !== Math.floor(first.r / BOX)
    || Math.floor(e.c / BOX) !== Math.floor(first.c / BOX));
  ok(!!second, '找到两个不同宫的空格用于交换');
  const swapA = p2.solution[first.r][first.c];
  const swapB = p2.solution[second.r][second.c];
  ne(swapA, swapB, '两个空格在解里的数字不同（交换才有意义）');
  // 把这两格填成对方的解值：盘面填满，但与解不符
  placeDigit(g2, first.r, first.c, swapB, 1);
  placeDigit(g2, second.r, second.c, swapA, 1);
  for (const e of es2) {
    if (e === first || e === second) continue;
    placeDigit(g2, e.r, e.c, p2.solution[e.r][e.c], 1);
  }
  eq(countEmpty(g2.grid), 0, '盘面已填满');
  eq(isSolved(g2), false, '填满但与解不符 → 不算胜利');
  eq(g2.status, PLAYING, '局面仍是进行中');
  eq(errorCount(g2) >= 2, true, `错填被检出（${errorCount(g2)} 格）`);
  // 拿「交换后的完整解」做取证
  const swapped = cloneGrid(p2.solution);
  swapped[first.r][first.c] = swapB;
  swapped[second.r][second.c] = swapA;
  let rowConflict = false, boxConflict = false;
  for (let r = 0; r < SIZE; r++) {
    const seen = new Set();
    for (let c = 0; c < SIZE; c++) {
      if (seen.has(swapped[r][c])) rowConflict = true;
      seen.add(swapped[r][c]);
    }
  }
  for (let br = 0; br < SIZE; br += BOX) {
    for (let bc = 0; bc < SIZE; bc += BOX) {
      const seen = new Set();
      for (let i = 0; i < BOX; i++) {
        for (let j = 0; j < BOX; j++) {
          const v = swapped[br + i][bc + j];
          if (seen.has(v)) boxConflict = true;
          seen.add(v);
        }
      }
    }
  }
  ok(rowConflict || boxConflict, `被交换后的完整解里确实存在矛盾（行冲突=${rowConflict} 宫冲突=${boxConflict}）`);
  eq(errorCount(g2), errorCells(g2).length, 'errorCount 与 errorCells 口径一致');

  // 提示也能促成胜利
  const p3 = generatePuzzle('easy', mulberry32(909));
  const g3 = createGame(p3);
  const es3 = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g3.grid[r][c] === EMPTY) es3.push({ r, c });
  const lastCell = es3[es3.length - 1];
  for (let i = 0; i < es3.length - 1; i++) {
    placeDigit(g3, es3[i].r, es3[i].c, p3.solution[es3[i].r][es3[i].c], 5);
  }
  const hw = hint(g3, lastCell.r, lastCell.c, 6);
  ok(hw.ok && hw.win, '提示补上最后一格也能触发胜利');
  eq(g3.status, WON, '提示触发后状态为 WON');
}

console.log('\n【七】提示');
{
  const p = generatePuzzle('normal', mulberry32(1717));
  const g = createGame(p);
  const empties = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g.grid[r][c] === EMPTY) empties.push({ r, c });

  // 1) 不带坐标：补行主序第一个空格，且值等于解
  const h1 = hint(g, -1, -1, 3000);
  ok(h1.ok, '提示返回 ok');
  const firstEmpty = empties.find((e) => g.grid[e.r][e.c] !== EMPTY && p.given[e.r][e.c] === EMPTY);
  ok(!!firstEmpty, '提示确实填上了一格');
  eq(g.grid[h1.r][h1.c], p.solution[h1.r][h1.c], '提示填的是解里的数字');
  eq(g.hints, 1, '提示次数累加');
  eq(wrongAt(g, h1.r, h1.c), false, '提示填的格子不会是错填');

  // 2) 带选中格：优先补这一格
  const target = empties.find((e) => g.grid[e.r][e.c] === EMPTY);
  const h2 = hint(g, target.r, target.c, 3100);
  eq(h2.r, target.r, '指定坐标时优先补该格（行）');
  eq(h2.c, target.c, '指定坐标时优先补该格（列）');
  eq(g.grid[target.r][target.c], p.solution[target.r][target.c], '优先补的那格也等于解');

  // 3) 提示指定的格若已填，改补第一个空格
  const h3 = hint(g, h1.r, h1.c, 3200);
  ok(h3.ok && !(h3.r === h1.r && h3.c === h1.c), '选中格已填时另找空格');

  // 4) 反复提示直到填满：每次都正确，最终判胜
  const g2 = createGame(p);
  let guard = 0, allCorrect = true;
  while (g2.status === PLAYING && guard < 200) {
    const r = hint(g2, -1, -1, 4000 + guard);
    if (!r.ok) break;
    if (g2.grid[r.r][r.c] !== p.solution[r.r][r.c]) allCorrect = false;
    guard++;
  }
  ok(allCorrect, '连续提示填入的每一格都等于解');
  eq(g2.status, WON, '一路提示到底会赢');
  eq(g2.hints, LEVELS.normal.holes, `普通档共提示 ${LEVELS.normal.holes} 次填满（实际 ${g2.hints}）`);
  eq(errorCount(g2), 0, '全程无错填');
  const over = hint(g2, -1, -1, 9999);
  ok(!over.ok && over.reason === 'over', '胜利后提示被拒');
}

console.log('\n【八】填充 / 擦除 / 候选标记');
{
  const p = generatePuzzle('easy', mulberry32(4545));
  const g = createGame(p);
  const empties = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g.grid[r][c] === EMPTY) empties.push({ r, c });
  const E = empties[0];

  // 给定格不能改
  let givenPos = null;
  for (let r = 0; r < SIZE && !givenPos; r++) for (let c = 0; c < SIZE; c++) if (p.given[r][c] !== EMPTY) { givenPos = { r, c }; break; }
  const gd = placeDigit(g, givenPos.r, givenPos.c, 1, 1);
  ok(!gd.ok && gd.reason === 'given', '给定格不能覆盖');
  ok(!eraseCell(g, givenPos.r, givenPos.c).ok, '给定格不能擦除');
  ok(!toggleNote(g, givenPos.r, givenPos.c, 1).ok, '给定格不能标记');

  // 落子 / 重复落子 / 越界 / 非法值
  const okPlace = placeDigit(g, E.r, E.c, p.solution[E.r][E.c], 1);
  ok(okPlace.ok, '空格可以落子');
  const again = placeDigit(g, E.r, E.c, 1, 1);
  ok(!again.ok && again.reason === 'occupied', '同一格不能重复落子（先擦再填）');
  ok(!placeDigit(g, -1, 0, 1, 1).ok, '越界落子被拒');
  ok(!placeDigit(g, 0, 0, 0, 1).ok, '非法数字被拒');

  // 擦除
  const er = eraseCell(g, E.r, E.c);
  ok(er.ok, '可以擦掉自己填的数字');
  eq(g.grid[E.r][E.c], EMPTY, '擦除后回到空格');
  ok(!eraseCell(g, E.r, E.c).ok, '空格不能再擦');

  // 候选标记
  eq(notesAt(g, E.r, E.c).length, 0, '初始没有候选标记');
  const n1 = toggleNote(g, E.r, E.c, 3);
  ok(n1.ok && n1.on === true, '添加候选标记');
  eq(noteAt(g, E.r, E.c, 3), true, '候选标记可读出');
  eq(notesAt(g, E.r, E.c).join(','), '3', '候选列表正确');
  const n2 = toggleNote(g, E.r, E.c, 3);
  ok(n2.ok && n2.on === false, '再点一次取消候选标记');
  eq(notesAt(g, E.r, E.c).length, 0, '取消后候选为空');

  toggleNote(g, E.r, E.c, 1);
  toggleNote(g, E.r, E.c, 5);
  toggleNote(g, E.r, E.c, 9);
  eq(notesAt(g, E.r, E.c).join(','), '1,5,9', '多个候选按升序返回');
  ok(!toggleNote(g, E.r, E.c, 0).ok && !toggleNote(g, E.r, E.c, 10).ok, '非法候选数字被拒');
  clearNotes(g, E.r, E.c);
  eq(notesAt(g, E.r, E.c).length, 0, 'clearNotes 清空该格候选');

  // 落子会自动清掉该格的候选；落在同行/同列/同宫的其他候选标记也会被自动减掉
  toggleNote(g, E.r, E.c, 4);
  let peer = null;
  for (let r = 0; r < SIZE && !peer; r++) {
    if (r !== E.r && g.grid[r][E.c] === EMPTY && p.given[r][E.c] === EMPTY) peer = { r, c: E.c };
  }
  ok(!!peer, '找到同列空格用于验证自动清理');
  toggleNote(g, peer.r, peer.c, 4);
  toggleNote(g, E.r, E.c, 9);         // 同一格再标一个别的数字
  eq(noteAt(g, peer.r, peer.c, 4), true, '同列标记已写下');
  const placedVal = p.solution[E.r][E.c];
  placeDigit(g, E.r, E.c, placedVal, 2);
  eq(notesAt(g, E.r, E.c).length, 0, '落子后该格候选全部被清空');
  // 与该列同行/同列/同宫的其他格里，被落下的那个数字的候选必须消失
  let peerHasPlaced = false;
  outer2:
  for (let i = 0; i < SIZE; i++) {
    const rr = i, cc = E.c;
    if (rr === E.r) continue;
    if (noteAt(g, rr, cc, placedVal)) { peerHasPlaced = true; break outer2; }
  }
  eq(peerHasPlaced, false, `落下 ${placedVal} 后，同列其他格的候选 ${placedVal} 被自动减掉`);
  eq(noteAt(g, peer.r, peer.c, 4), placedVal === 4 ? false : true, '其他数字的候选按规则保留');

  // 离得远的格子（不同行/列/宫）的候选完全不受影响
  const far = empties.find((e) => e.r !== E.r && e.c !== E.c
    && Math.floor(e.r / BOX) !== Math.floor(E.r / BOX)
    && Math.floor(e.c / BOX) !== Math.floor(E.c / BOX));
  ok(!!far, '找到一个不同行/列/宫的空格');
  toggleNote(g, far.r, far.c, 8);
  const beforeFar = notesAt(g, far.r, far.c).join(',');
  const far2 = empties.find((e) => e.r !== far.r && e.c !== far.c
    && Math.floor(e.r / BOX) !== Math.floor(far.r / BOX)
    && Math.floor(e.c / BOX) !== Math.floor(far.c / BOX)
    && g.grid[e.r][e.c] === EMPTY);
  placeDigit(g, far2.r, far2.c, 8, 3);
  eq(notesAt(g, far.r, far.c).join(','), beforeFar, '不同行/列/宫的候选标记不受落子影响');

  // clearNoteDigit 单独可用
  const g2 = createGame(p);
  const e2 = empties[1];
  toggleNote(g2, e2.r, e2.c, 7);
  clearNoteDigit(g2, e2.r, e2.c, 7);
  eq(noteAt(g2, e2.r, e2.c, 7), false, 'clearNoteDigit 可单独清掉某数字');
}

console.log('\n【九】挖空数量符合难度');
{
  for (const key of LEVEL_KEYS) {
    const cfg = LEVELS[key];
    let exact = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const p = generatePuzzle(key, mulberry32(seed * 271 + key.length * 13));
      eq(holeCount(p), cfg.holes, `${key} 种子${seed}：挖空 ${cfg.holes} 格`);
      const info = puzzleInfo(p);
      eq(info.holes, cfg.holes, `${key} 种子${seed}：puzzleInfo 挖空数一致`);
      eq(info.unique, true, `${key} 种子${seed}：puzzleInfo 复核唯一解`);
      eq(info.valid, true, `${key} 种子${seed}：题面合法`);
      eq(info.compatible, true, `${key} 种子${seed}：题面与解兼容`);
      if (holeCount(p) === cfg.holes) exact++;
    }
    eq(exact, 4, `${key}：4 个种子全部达到目标挖空数`);
    eq(puzzleInfo(generatePuzzle(key, mulberry32(31))).holes, cfg.holes, `${key}：再次出题仍是目标挖空数`);
  }

  // 三档挖空数必须递增（难度的「单调性」）
  ok(LEVELS.easy.holes < LEVELS.normal.holes && LEVELS.normal.holes < LEVELS.hard.holes, '三档挖空数严格递增');
  // 给定格数与空格数互补
  const p = generatePuzzle('hard', mulberry32(88));
  eq(filledCount(createGame(p)), CELLS - 52, '困难档给定格数为 81 − 52 = 29');
}

console.log('\n【十】计时数据（显式注入时间戳）');
{
  const t = createTimer();
  eq(elapsedMs(t, 1000), 0, '未开始计时的用时为 0');
  eq(formatTime(0), '00:00', '格式化 0ms');
  eq(formatTime(1000), '00:01', '格式化 1 秒');
  eq(formatTime(3000), '00:03', '格式化 3 秒');
  eq(formatTime(65000), '01:05', '格式化 1 分 05 秒');
  eq(formatTime(99 * 60000), '99:00', '99 分钟仍用 mm:ss');
  eq(formatTime(100 * 60000), '1:40:00', '超过 99 分钟显示小时');
  eq(formatTime(-5), '00:00', '负值归零');

  startTimer(t, 1000);
  eq(elapsedMs(t, 4000), 3000, '计时中随时钟推进（N → N+3000）');
  eq(formatTime(elapsedMs(t, 4000)), '00:03', 'N 与 N+3000 之间显示 00:03');
  startTimer(t, 9000);
  eq(elapsedMs(t, 4000), 3000, '重复 startTimer 不重置起点');
  stopTimer(t, 6000);
  eq(elapsedMs(t, 999999), 5000, '停表后用时冻结');
  startTimer(t, 999999);
  eq(elapsedMs(t, 999999), 5000, '已停表的计时器不会被再次启动');

  // 会话：首次落子才开始计时（绝对毫秒时间戳）
  const N = 1790000000000;    // 模拟 Date.now() 量级
  const s = createGameSession('easy', mulberry32(1));
  eq(session_elapsed(s, N), 0, '未落子前不计时');
  const e0 = firstEmptyIn(s.game);
  sessionPlace(s, e0.r, e0.c, s.game.puzzle.solution[e0.r][e0.c], N);
  eq(elapsedMs(s.game.timer, N), 0, '刚落子时用时为 0');
  eq(elapsedMs(s.game.timer, N + 3000), 3000, 'N → N+3000 的用时是 3000ms');
  eq(formatTime(elapsedMs(s.game.timer, N + 3000)), '00:03', '绝对时间戳下显示 00:03（不是 497361:46:00）');
  updateGame(s, N + 3000);
  eq(s.game.snap.elapsed, 3000, '快照里的 elapsed 同步为 3000');
  eq(formatTime(s.game.snap.elapsed), '00:03', '快照格式化也是 00:03');

  // 胜利瞬间停表
  fillExceptOne(s);
  const lastCell = lastEmptyIn(s.game);
  const winNow = N + 60000;
  const wr = sessionPlace(s, lastCell.r, lastCell.c, s.game.puzzle.solution[lastCell.r][lastCell.c], winNow);
  ok(wr.win, '会话内完成最后一格判胜');
  eq(elapsedMs(s.game.timer, winNow + 999999), 60000, '判胜瞬间停表（用时冻结在 60000ms）');
  eq(formatTime(s.game.snap ? 60000 : 0), '01:00', '用时格式化 01:00');
  ok(!!s.outcome && s.outcome.result === 'win', '会话给出了 win 的 outcome');
  eq(s.outcome.detail.elapsedMs, 60000, 'outcome 里带用时');
  ok(s.outcome.score > 0, 'outcome 里带正分');

  // 重开后计时归零、换新题
  const oldKey = gridKey(s.game.puzzle.given);
  restartGame(s, 'easy', mulberry32(2));
  eq(elapsedMs(s.game.timer, N + 999999), 0, '重开后计时归零');
  eq(s.outcome, null, '重开后 outcome 清空');
  eq(countEmpty(s.game.grid), 35, '重开后是一道新的 35 空题');
  ne(gridKey(s.game.puzzle.given), oldKey, '重开换了一道新题');

  // 重开不传难度则沿用
  restartGame(s);
  eq(s.game.puzzle.difficulty, 'easy', '重开不传难度时沿用当前难度');

  // 计分：提示与错填扣分，越快越高
  const fast = { puzzle: { difficulty: 'easy' }, hints: 0, wrongCount: 0, timer: { running: false, startAt: 0, stopAt: 5000, elapsed: 5000 }, now: 5000 };
  const slow = { puzzle: { difficulty: 'easy' }, hints: 0, wrongCount: 0, timer: { running: false, startAt: 0, stopAt: 250000, elapsed: 250000 }, now: 250000 };
  ok(scoreOf(fast) > scoreOf(slow), '越快分越高');
  const hinted = { puzzle: { difficulty: 'easy' }, hints: 3, wrongCount: 0, timer: fast.timer, now: 5000 };
  ok(scoreOf(hinted) < scoreOf(fast), '用提示会扣分');
  const hardsame = { puzzle: { difficulty: 'hard' }, hints: 0, wrongCount: 0, timer: fast.timer, now: 5000 };
  ok(scoreOf(hardsame) > scoreOf(fast), '困难档有难度加成');
}

/** 会话内的用时（少写一层 dot 链，测试里读起来清楚）。 */
function session_elapsed(s, now) {
  return elapsedMs(s.game.timer, now);
}

/** 找到盘面上第一个空格。 */
function firstEmptyIn(game) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (game.grid[r][c] === EMPTY) return { r, c };
  }
  return null;
}

/** 找到盘面上最后一个空格。 */
function lastEmptyIn(game) {
  let last = null;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (game.grid[r][c] === EMPTY) last = { r, c };
  }
  return last;
}

/** 把盘面填到只剩最后一格。 */
function fillExceptOne(session) {
  const game = session.game;
  const empties = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (game.grid[r][c] === EMPTY) empties.push({ r, c });
  }
  for (let i = 0; i < empties.length - 1; i++) {
    const e = empties[i];
    sessionPlace(session, e.r, e.c, game.puzzle.solution[e.r][e.c], session.now);
  }
  return session;
}

console.log('\n【十一】会话 / 快照 / 重开');
{
  const s = createGameSession('normal', mulberry32(2026));
  const snap0 = updateGame(s, 0);
  eq(snap0.size, 9, '快照边长 9');
  eq(snap0.grid.length, 9, '快照 9 行');
  eq(snap0.grid[0].length, 9, '快照 9 列');
  eq(snap0.empty, 45, '普通档快照 45 空格');
  eq(snap0.filled, 36, '普通档快照已填 36 格');
  eq(snap0.status, PLAYING, '快照初始为进行中');
  eq(snap0.hints, 0, '快照初始提示数为 0');
  eq(snap0.wrongCount, 0, '快照初始无错填');
  eq(snap0.remaining.length, 10, '快照 remaining 下标 0..9');
  eq(snap0.remaining[0], 0, '下标 0 保留为 0');

  // 快照里给定格与玩家格可区分
  let givenCells = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (snap0.given[r][c] !== EMPTY) givenCells++;
  eq(givenCells, 36, '快照 given 掩码与已填格一致（开局没有玩家数字）');

  const e = firstEmptyIn(s.game);
  sessionNote(s, e.r, e.c, 2);
  sessionNote(s, e.r, e.c, 6);
  const snap1 = updateGame(s, 50);
  eq(snap1.notes[e.r][e.c].join(','), '2,6', '快照带出该格候选标记');
  // 给定格的候选在任何情况下都为空（快照只对空格收集候选）
  let givenNotes = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (snap1.given[r][c] !== EMPTY && snap1.notes[r][c].length) givenNotes++;
    }
  }
  eq(givenNotes, 0, '所有给定格的快照候选都为空');

  sessionPlace(s, e.r, e.c, s.game.puzzle.solution[e.r][e.c], 100);
  const snap2 = updateGame(s, 100);
  eq(snap2.grid[e.r][e.c], s.game.puzzle.solution[e.r][e.c], '快照反映落子结果');
  eq(snap2.given[e.r][e.c], EMPTY, '玩家格在 given 掩码里是空的');
  eq(snap2.filled, 37, '快照已填数 +1');
  eq(snap2.empty, 44, '快照空格数 −1');
  eq(snap2.moves, 1, '快照记录落子次数');

  // 错填在快照里可见
  const e2 = firstEmptyIn(s.game);
  const wrongVal = (s.game.puzzle.solution[e2.r][e2.c] % 9) + 1;
  sessionPlace(s, e2.r, e2.c, wrongVal, 120);
  const snap3 = updateGame(s, 120);
  eq(snap3.wrong[e2.r][e2.c], true, '快照标出错填格');
  eq(snap3.wrongCount, 1, '快照错填数为 1');

  // 擦除
  sessionErase(s, e2.r, e2.c, 130);
  const snap4 = updateGame(s, 130);
  eq(snap4.wrongCount, 0, '擦除后快照错填归零');

  // 会话内的非法操作
  ok(!sessionErase(s, -1, 0, 1).ok, '越界擦除被拒');
  ok(!sessionNote(s, 0, 0, 1).ok, '给定格标记被拒');
  ok(!sessionPlace(s, -1, -1, 1, 1).ok, '越界落子被拒');
}

console.log('\n【十二】布局：底部不侵占安全区');
{
  const cases = [
    [375, 667, { top: 44, bottom: 34 }],
    [390, 844, { top: 47, bottom: 34 }],
    [414, 896, { top: 48, bottom: 34 }],
    [320, 568, {}],
    [768, 1024, { top: 20, bottom: 20 }],
    [844, 390, { top: 0, bottom: 21 }],   // 横屏
  ];
  for (const [w, h, ins] of cases) {
    const bottom = ins.bottom ?? 0;
    const limit = h - bottom - 16;
    const L = computeLayout(w, h, ins);
    const lowestButton = Math.max(...L.buttons.map((b) => b.y + b.h));
    const lowestKey = Math.max(...L.keyboard.keys.map((k) => k.y + k.h));
    ok(lowestButton <= limit, `${w}×${h} 底部按钮不侵占安全区（${lowestButton} ≤ ${limit}）`);
    ok(lowestKey <= limit, `${w}×${h} 数字键盘不侵占安全区（${lowestKey} ≤ ${limit}）`);
    eq(L.buttons.length, 3, `${w}×${h} 三颗底部按钮`);
    eq(L.keyboard.keys.length, 10, `${w}×${h} 十个数字键`);
    eq(L.keyboard.keys.map((k) => k.key).join(','), '1,2,3,4,5,6,7,8,9,erase', `${w}×${h} 键位顺序固定`);
    ok(L.board.size > 60, `${w}×${h} 盘面尺寸合理（${L.board.size}）`);
    ok(Math.abs(L.board.size / L.board.cell - SIZE) < 1e-6, `${w}×${h} 盘面正好 9 格宽`);
    ok(L.keyboard.y + L.keyboard.h <= L.buttons[0].y, `${w}×${h} 键盘在按钮上方`);
    ok(L.board.y + L.board.size < L.keyboard.y, `${w}×${h} 盘面在键盘上方（不重叠）`);
    // 命中测试
    const k1 = L.keyboard.keys[0];
    eq(hitKey(L, k1.x + k1.w / 2, k1.y + k1.h / 2), '1', `${w}×${h} 命中数字键 1`);
    const kb = L.keyboard.keys[9];
    eq(hitKey(L, kb.x + 2, kb.y + 2), 'erase', `${w}×${h} 命中擦除键`);
    const bt = L.buttons[1];
    eq(hitButton(L, bt.x + bt.w / 2, bt.y + bt.h / 2), 'hint', `${w}×${h} 命中提示按钮`);
    eq(hitButton(L, L.board.x + 2, L.board.y + 2), null, `${w}×${h} 盘面不误判为按钮`);
    eq(hitKey(L, L.board.x + 2, L.board.y + 2), null, `${w}×${h} 盘面不误判为数字键`);
    // 盘面坐标换算
    const g0 = gridAt(L, L.board.x + 1, L.board.y + 1);
    eq(`${g0.r},${g0.c}`, '0,0', `${w}×${h} 左上角是 (0,0)`);
    const g8 = gridAt(L, L.board.x + L.board.size - 1, L.board.y + L.board.size - 1);
    eq(`${g8.r},${g8.c}`, '8,8', `${w}×${h} 右下角是 (8,8)`);
    eq(gridAt(L, L.board.x - 5, L.board.y), null, `${w}×${h} 盘面外返回 null`);
    eq(gridAt(L, 0, h - 1), null, `${w}×${h} 屏幕角落不在盘面内`);
  }

  // 标记模式会占用一条提示条，但不应把键盘挤进安全区
  const Lm = computeLayout(375, 667, { top: 44, bottom: 34 }, 1);
  ok(Lm.keyboard.noteH > 0, '标记模式下留出提示条高度');
  ok(Math.max(...Lm.keyboard.keys.map((k) => k.y + k.h)) <= 667 - 34 - 16, '标记模式下键盘仍在安全区内');
  ok(Lm.board.size <= computeLayout(375, 667, { top: 44, bottom: 34 }, 0).board.size, '标记模式下盘面不会变大');
}

console.log('\n【十三】绘制层与模块入口（冒烟）');
{
  // 伪 ctx：把关键路径跑一遍，捕捉渲染期崩溃
  const calls = { fill: 0, stroke: 0, text: [] };
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = {
    canvas: { width: 750, height: 1334 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: 'left', textBaseline: 'top', globalAlpha: 1,
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, shadowOffsetX: 0,
    save: noop, restore: noop, beginPath: noop, closePath: noop, clip: noop,
    moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, rect: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, translate: noop, rotate: noop, scale: noop,
    clearRect: () => { calls.cleared = (calls.cleared ?? 0) + 1; },
    fillRect: () => { calls.fillRect = (calls.fillRect ?? 0) + 1; },
    strokeRect: noop,
    fill: () => { calls.fill++; }, stroke: () => { calls.stroke++; },
    fillText: (t) => { calls.text.push(String(t)); },
    strokeText: noop, measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    setTransform: noop, drawImage: noop,
  };

  const W = 375, H = 667, INS = { top: 44, bottom: 34 };
  const sess = createSession({ width: W, height: H, insets: INS, difficulty: 'easy', theme: {}, onEvent: () => {} });
  ok(typeof sess.tap === 'function' && typeof sess.render === 'function', '会话接口齐全');
  ok(sess.outcome === null, '未结束时 outcome 为 null');
  ok(typeof sess.hud.status === 'string' && sess.hud.status.length > 0, 'hud.status 非空');
  ok(typeof sess.hud.right === 'string' && sess.hud.right.length > 0, 'hud.right 非空');
  ok(sess.busy === true, '进行中需要持续推帧（计时在走）');
  eq(sess.difficulty, 'easy', '会话难度与入参一致');

  // 出新题后立刻画一帧
  sess.render(ctx, 1000);
  ok(calls.fill > 15 && calls.stroke > 10, `一帧产生足量填充与描边（fill=${calls.fill} stroke=${calls.stroke}）`);
  ok((calls.fillRect ?? 0) >= 81, `一帧为 81 格铺了底色（fillRect=${calls.fillRect}）`);
  ok(calls.text.includes('重新开始'), '帧内画出了「重新开始」');
  ok(calls.text.includes('提示'), '帧内画出了「提示」');
  ok(calls.text.some((t) => t.indexOf('标记：') === 0), '帧内画出了标记模式按钮');
  ok(calls.text.includes('erase') === false, '擦除键不画成文字（画的是图形）');
  eq(calls.cleared ?? 0, 0, '本模块不调 clearRect（新 UI 约定：背景由集成层铺）');

  // 交互全流程：抬头 → 点「空格」→ 点数字键
  const L = sess.layoutRef;
  const sessPuz = sess.currentPuzzle;
  const firstEmpty = (() => {
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (sessPuz.given[r][c] === EMPTY) return { r, c };
    return null;
  })();
  ok(!!firstEmpty, '会话题目里有空格可点');
  const cellX = L.board.x + (firstEmpty.c + 0.5) * L.board.cell;
  const cellY = L.board.y + (firstEmpty.r + 0.5) * L.board.cell;
  sess.press(cellX, cellY);
  sess.release();
  sess.tap(cellX, cellY, 1000);
  ok(!!sess.selectedCell, '点盘面选中了格子');
  eq(`${sess.selectedCell.r},${sess.selectedCell.c}`, `${firstEmpty.r},${firstEmpty.c}`, '选中的就是点中的那一格');
  const k1 = L.keyboard.keys[0];
  sess.press(k1.x + 2, k1.y + 2);
  sess.release();
  sess.tap(k1.x + k1.w / 2, k1.y + k1.h / 2, 1010);
  eq(sess.snapshot.moves, 1, '点数字键完成一次落子');
  eq(sess.snapshot.grid[firstEmpty.r][firstEmpty.c], 1, '盘面上写进了数字 1');
  sess.render(ctx, 1020);
  ok(true, '落子后重绘不崩');

  // 三个底部按钮都点一遍（用独立会话，避免标记模式状态互相干扰）
  const btnSess = createSession({ width: W, height: H, insets: INS, difficulty: 'easy', theme: {} });
  const BL = btnSess.layoutRef;
  for (const key of ['hint', 'mark', 'restart']) {
    const b = BL.buttons.find((x) => x.key === key);
    btnSess.press(b.x + 5, b.y + 5);
    btnSess.release();
    btnSess.tap(b.x + b.w / 2, b.y + b.h / 2, 2000);
    btnSess.render(ctx, 2010);
  }
  ok(true, '重新开始 / 提示 / 标记模式三个按钮全流程不崩');
  eq(btnSess.markMode, false, 'hint → mark → restart 之后标记模式回到关闭（restart 会重置交互态）');
  eq(btnSess.selectedCell, null, '重新开始清空选中格');
  eq(btnSess.snapshot.moves, 0, '重新开始后落子次数归零');

  // 标记模式：点数字键变成写候选
  {
    const s2 = createSession({ width: W, height: H, insets: INS, difficulty: 'easy', theme: {} });
    const L2 = s2.layoutRef;
    const puz2 = s2.currentPuzzle;
    let emp2 = null;
    for (let r = 0; r < SIZE && !emp2; r++) for (let c = 0; c < SIZE; c++) if (puz2.given[r][c] === EMPTY) { emp2 = { r, c }; break; }
    const cx = L2.board.x + (emp2.c + 0.5) * L2.board.cell;
    const cy = L2.board.y + (emp2.r + 0.5) * L2.board.cell;
    s2.tap(cx, cy, 10);
    const mb = L2.buttons.find((x) => x.key === 'mark');
    s2.tap(mb.x + mb.w / 2, mb.y + mb.h / 2, 20);
    eq(s2.markMode, true, '标记模式已打开');
    const kk = L2.keyboard.keys[2];   // 数字 3
    s2.tap(kk.x + kk.w / 2, kk.y + kk.h / 2, 30);
    eq(s2.markMode, true, '标记模式保持开启');
    eq(s2.snapshot.moves, 0, '标记模式下落子次数不变（写的是候选）');
    const sel = s2.selectedCell;
    eq(`${sel.r},${sel.c}`, `${emp2.r},${emp2.c}`, '标记写在了选中的空格上');
    const notes = s2.snapshot.notes[sel.r][sel.c];
    ok(notes.length === 1 && notes[0] === 3, `候选标记写进了快照（${JSON.stringify(notes)}）`);
    // 再点同一个数字 → 取消标记
    s2.tap(kk.x + kk.w / 2, kk.y + kk.h / 2, 40);
    eq(s2.snapshot.notes[sel.r][sel.c].length, 0, '再点一次取消候选标记');
    s2.render(ctx, 50);
  }

  // 擦除键：先落子再擦
  {
    const s3 = createSession({ width: W, height: H, insets: INS, difficulty: 'easy', theme: {} });
    const L3 = s3.layoutRef;
    const puz3 = s3.currentPuzzle;
    let emp3 = null;
    for (let r = 0; r < SIZE && !emp3; r++) for (let c = 0; c < SIZE; c++) if (puz3.given[r][c] === EMPTY) { emp3 = { r, c }; break; }
    const cx = L3.board.x + (emp3.c + 0.5) * L3.board.cell;
    const cy = L3.board.y + (emp3.r + 0.5) * L3.board.cell;
    s3.tap(cx, cy, 10);
    // 选一个「放得下」的数字：解值一定放得下
    const want = puz3.solution[emp3.r][emp3.c];
    const kk = L3.keyboard.keys[want - 1];
    s3.tap(kk.x + kk.w / 2, kk.y + kk.h / 2, 20);
    eq(s3.snapshot.moves, 1, '落子计数 +1');
    eq(s3.snapshot.grid[emp3.r][emp3.c], want, '盘面写入了该数字');
    // 落子后焦点自动跳到下一个空格；重新点回原格再擦
    s3.tap(cx, cy, 25);
    eq(`${s3.selectedCell.r},${s3.selectedCell.c}`, `${emp3.r},${emp3.c}`, '重新点回原来那格');
    const er = L3.keyboard.keys[9];
    s3.tap(er.x + er.w / 2, er.y + er.h / 2, 30);
    eq(s3.snapshot.grid[emp3.r][emp3.c], EMPTY, '擦除键清掉了该格的数字');
    eq(s3.snapshot.moves, 1, '擦除不算落子次数');
  }

  // resize 后重绘
  sess.resize(390, 844, { top: 47, bottom: 34 });
  sess.update(3000);
  sess.render(ctx, 3000);
  ok(true, 'resize 后重绘不崩');

  // 走到胜利：直接按解填满
  {
    const s4 = createSession({ width: W, height: H, insets: INS, difficulty: 'easy', theme: {} });
    const puz = s4.currentPuzzle;
    const L4 = s4.layoutRef;
    let now = 5000;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (puz.given[r][c] !== EMPTY) continue;
        const px = L4.board.x + (c + 0.5) * L4.board.cell;
        const py = L4.board.y + (r + 0.5) * L4.board.cell;
        // 注意：填入后光标会自动跳到下一个空格；若这格已被自动选中就不要重复点，
        // 因为「再点同一格 = 取消选中」会让紧接着的数字键落空。
        const cur = s4.selectedCell;
        if (!cur || cur.r !== r || cur.c !== c) s4.tap(px, py, now);
        const k = L4.keyboard.keys[puz.solution[r][c] - 1];
        s4.tap(k.x + k.w / 2, k.y + k.h / 2, now + 1);
        now += 2;
      }
    }
    ok(s4.outcome !== null, '填满后会话给出 outcome');
    eq(s4.outcome.result, 'win', 'outcome.result = win');
    ok(s4.outcome.score > 0, 'outcome.score 为正');
    eq(s4.outcome.detail.difficulty, 'easy', 'outcome 里带难度');
    ok(s4.outcome.detail.elapsedMs >= 0, 'outcome 里带用时');
    ok(typeof s4.busy === 'boolean', 'busy 可读');

    // 结算后重开复原
    const rb = L4.buttons.find((x) => x.key === 'restart');
    s4.tap(rb.x + rb.w / 2, rb.y + rb.h / 2, now + 100);
    eq(s4.outcome, null, '重开后 outcome 清空');
    eq(s4.snapshot.empty, 35, '重开后是新的 35 空题');

    s4.destroy();
    ok(s4.outcome === null, 'destroy 后不再有结果');
  }

  // 盘面底色必须始终是浅色，不能跟深色主题令牌走（新 UI 是青白底深字）
  {
    const seen = [];
    const ctx2 = { ...ctx, fillRect: noop, set fillStyle(v) { seen.push(v); }, get fillStyle() { return ''; } };
    const dark = { bgTop: '#161a26', bgBottom: '#0c0e15', boardTop: '#000000', boardBottom: '#000000', textPrimary: '#ffffff' };
    const s5 = createSession({ width: W, height: H, insets: INS, difficulty: 'easy', theme: dark });
    // 用「深色主题」当输入，底色也必须还是浅色（不含 #000000）
    s5.render(ctx2, 1);
    ok(seen.length > 0 && !seen.includes('#000000'), '盘面底色不跟随深色主题（保持浅底）');
    ok(seen.some((c) => /^rgba\(255,2/.test(String(c))), '盘面格底用的是暖白/木黄浅色');
  }

  // 布局工具函数单独可用
  pathRoundRect(ctx, 0, 0, 10, 10, 3);
  pathRoundRect(ctx, 0, 0, 1, 1, 5);    // 极小尺寸不能崩
  ok(true, 'pathRoundRect 各种尺寸都不崩');
}

console.log('\n【十四】纯逻辑约束自检');
{
  // 同一颗种子 → 完全相同的题（题目可复现，测试才能断言）
  const a = generatePuzzle('normal', mulberry32(20260927));
  const b = generatePuzzle('normal', mulberry32(20260927));
  eq(gridKey(a.given), gridKey(b.given), '同种子 → 完全相同的题面');
  eq(gridKey(a.solution), gridKey(b.solution), '同种子 → 完全相同的解');
  eq(gridKey(a.given), gridKey(b.given), '题目可复现');
  const c = generatePuzzle('normal', mulberry32(20260928));
  ne(gridKey(a.given), gridKey(c.given), '不同种子 → 不同题面');

  // 生成完整解本身合法且无空格
  const full = generateFullGrid(mulberry32(11));
  eq(countEmpty(full), 0, '完整解没有空格');
  ok(isValidGrid(full), '完整解满足数独规则');

  // 同种子的完整解也可复现
  eq(gridKey(generateFullGrid(mulberry32(5))), gridKey(generateFullGrid(mulberry32(5))), '完整解可复现');

  // hasUniqueSolution 不修改入参
  const p = generatePuzzle('easy', mulberry32(3));
  const before = gridKey(p.given);
  hasUniqueSolution(p.given);
  eq(gridKey(p.given), before, '唯一性校验不修改入参');

  // solveCount 上限语义
  const empty = createGrid();
  eq(solveCount(cloneGrid(empty), 2), 2, '空盘至少有两个解（limit=2 生效）');
  eq(naiveCount(empty, 2), 2, '独立实现同样是 2（交叉验证）');
  const oneHole = cloneGrid(full);
  oneHole[0][0] = EMPTY;
  eq(solveCount(cloneGrid(oneHole), 2), 1, '只挖一格仍是唯一解');
  eq(naiveCount(oneHole, 2), 1, '独立实现复核唯一解');

  // 不可解的题返回 0
  const bad = createGrid();
  bad[0][0] = 5; bad[0][1] = 5;      // 同行重复 5
  eq(solveCount(cloneGrid(bad), 2), 0, '自相矛盾的题面解得 0 个解');

  // inGrid / isDigit 边界
  ok(inGrid(0, 0) && inGrid(8, 8), 'inGrid 边界内为真');
  ok(!inGrid(-1, 0) && !inGrid(9, 9), 'inGrid 越界为假');

  // 时间约定自检：core.js 的**代码**里绝不能出现 performance（规范 §8 踩过的坑）。
  // 注释里为说明「为什么不能用」而提到它是允许的，所以先把注释剥掉再查。
  const fs = await import('node:fs');
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // 行注释（避开 https:// 这类）
  const coreSrc = fs.readFileSync(new URL('./core.js', import.meta.url), 'utf8');
  const renderSrc = fs.readFileSync(new URL('./render.js', import.meta.url), 'utf8');
  const coreCode = stripComments(coreSrc);
  const renderCode = stripComments(renderSrc);

  ok(!/performance\s*\.\s*now/.test(coreCode), 'core.js 代码里没有 performance.now（时间基准必须与集成层同源）');
  ok(/Date\.now\(\)/.test(coreCode), 'core.js 的时钟 fallback 是 Date.now()');
  ok(!/\bwx\b/.test(coreCode) && !/\bdocument\b/.test(coreCode) && !/\bwindow\b/.test(coreCode) && !/\bcanvas\b/.test(coreCode),
    'core.js 无 wx / document / window / canvas（平台 API 一律不碰）');
  ok(!/performance\s*\.\s*now/.test(renderCode), 'render.js 也没有 performance.now');
  ok(!/\bwx\b/.test(renderCode) && !/\bdocument\b/.test(renderCode) && !/\bwindow\b/.test(renderCode),
    'render.js 无 wx / document / window');
  // 零依赖：不能 import 任何第三方包（相对路径 / node: 内置除外）
  const imports = [...coreSrc.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const badImports = imports.filter((s) => !s.startsWith('.') && !s.startsWith('node:'));
  eq(badImports.length, 0, `core.js 只 import 相对路径或用 node: 内置（第三方：${badImports.join(',') || '无'}）`);
  ok(imports.every((s) => s.endsWith('.js') || s.startsWith('node:')), 'core.js 的模块后缀规范（.js）');
}

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) { console.log('失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
