/**
 * 五子棋核心逻辑测试（Node 直接跑，零依赖，不碰微信 API）
 * 用法：node tools/test-core.mjs
 */
import {
  createBoard, place, undo, findWinLine, canPlace, candidates,
  lastMove, resultText, cloneBoard, BOARD_SIZE, BLACK, WHITE, EMPTY,
} from '../src/core/board.js';
import { chooseMove, LEVELS } from '../src/core/ai.js';
import { checkForbidden, checkMove, RULE_PRO } from '../src/core/rules.js';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${expected}，实际 ${actual}`);
}

console.log('\n【一】棋盘基础');
{
  const b = createBoard();
  eq(b.size, 15, '默认 15×15');
  eq(b.current, BLACK, '黑先手');
  eq(b.moves.length, 0, '初始无落子历史');
  eq(b.winner, EMPTY, '初始未分胜负');

  const r1 = place(b, 7, 7);
  ok(r1.ok, '天元可落子');
  eq(b.grid[7][7], BLACK, '黑子写入正确');
  eq(b.current, WHITE, '落子后轮到白棋');

  const r2 = place(b, 7, 7);
  ok(!r2.ok && r2.reason === 'occupied', '同点不能重复落子');

  const r3 = place(b, -1, 0);
  ok(!r3.ok, '越界落子被拒');
}

console.log('\n【二】五连判定（四个方向）');
{
  // 横向
  const h = createBoard();
  for (let i = 0; i < 4; i++) { place(h, 3 + i, 5); place(h, 3 + i, 9); }
  place(h, 7, 5);
  eq(h.winner, BLACK, '横向五连判定');
  eq(h.winLine.length, 5, '横线返回 5 个点');

  // 纵向
  const v = createBoard();
  for (let i = 0; i < 4; i++) { place(v, 2, 2 + i); place(v, 8, 2 + i); }
  place(v, 2, 6);
  eq(v.winner, BLACK, '纵向五连判定');

  // 主对角
  const d1 = createBoard();
  for (let i = 0; i < 4; i++) { place(d1, 1 + i, 1 + i); place(d1, 10, 1 + i); }
  place(d1, 5, 5);
  eq(d1.winner, BLACK, '主对角五连判定');

  // 副对角
  const d2 = createBoard();
  for (let i = 0; i < 4; i++) { place(d2, 10 - i, 1 + i); place(d2, 0, 1 + i); }
  place(d2, 6, 5);
  eq(d2.winner, BLACK, '副对角五连判定');

  // 四连不算赢
  const four = createBoard();
  for (let i = 0; i < 3; i++) { place(four, 3 + i, 5); place(four, 3 + i, 9); }
  place(four, 6, 5);
  eq(four.winner, EMPTY, '四连不算胜（但已是被判满）');
}

console.log('\n【三】悔棋与状态回滚');
{
  const b = createBoard();
  place(b, 7, 7); place(b, 8, 8); place(b, 7, 8);
  eq(b.moves.length, 3, '落子历史累积');
  const u = undo(b);
  ok(u.ok && u.undone.x === 7 && u.undone.y === 8, '悔棋撤回最后一手');
  eq(b.grid[8][7], EMPTY, '悔棋后该点恢复空');
  eq(b.current, BLACK, '悔棋后轮次回退给原落子方');
  eq(b.moves.length, 2, '历史长度减一');

  const empty = createBoard();
  ok(!undo(empty).ok, '空棋盘不能悔棋');
}

console.log('\n【四】胜负后锁定');
{
  const b = createBoard();
  for (let i = 0; i < 4; i++) { place(b, i, 0); place(b, i, 5); }
  place(b, 4, 0);
  eq(b.winner, BLACK, '黑棋获胜');
  eq(resultText(b), '黑棋胜', '结果文案正确');
  const after = place(b, 10, 10);
  ok(!after.ok && after.reason === 'over', '分出胜负后禁止继续落子');
  ok(!canPlace(b, 9, 9), 'canPlace 也拒绝');
}

console.log('\n【五】候选点生成');
{
  const b = createBoard();
  const c0 = candidates(b);
  eq(c0.length, 1, '空棋盘只给天元一个候选');
  eq(c0[0][0], 7, '天元 x');
  eq(c0[0][1], 7, '天元 y');

  place(b, 7, 7);
  const c1 = candidates(b);
  ok(c1.length > 1, '有子后候选点展开');
  ok(c1.every(([x, y]) => b.grid[y][x] === EMPTY), '候选点全部为空位');
  ok(!c1.some(([x, y]) => x === 7 && y === 7), '已占点不在候选中');
}

console.log('\n【六】AI 基本棋力');
{
  // 1) 空盘开局下天元
  const b1 = createBoard();
  const m1 = chooseMove(b1, BLACK, { level: 1 });
  ok(m1 && m1.x === 7 && m1.y === 7, '空盘开局落天元');

  // 2) 自己四连时能收官取胜
  const b2 = createBoard();
  b2.grid[7][3] = BLACK; b2.grid[7][4] = BLACK; b2.grid[7][5] = BLACK; b2.grid[7][6] = BLACK;
  b2.current = BLACK;
  b2.moves.push({ x: 3, y: 7, player: BLACK }, { x: 4, y: 7, player: BLACK },
                { x: 5, y: 7, player: BLACK }, { x: 6, y: 7, player: BLACK });
  const m2 = chooseMove(b2, BLACK, { level: 1 });
  ok(m2 && ((m2.x === 2 && m2.y === 7) || (m2.x === 7 && m2.y === 7)), '四连时能补成五连', JSON.stringify(m2));

  // 3) 对手活四/冲四：普通档及以上必须堵（简单档允许漏防，那是它的设计）
  const b3 = createBoard();
  for (const x of [3, 4, 5, 6]) { b3.grid[7][x] = WHITE; }
  b3.grid[7][2] = BLACK; // 一端已被黑占，只剩一端要堵
  b3.current = BLACK;
  b3.moves.push({ x: 2, y: 7, player: BLACK });
  const m3 = chooseMove(b3, BLACK, { level: 2, random: () => 0.5 });
  ok(m3 && m3.x === 7 && m3.y === 7, '对手冲四时堵住唯一缺口', JSON.stringify(m3));

  // 4) 对手活三时必须应对（堵或反攻）
  const b4 = createBoard();
  for (const x of [5, 6, 7]) { b4.grid[7][x] = WHITE; }
  b4.grid[0][0] = BLACK; b4.current = BLACK;
  b4.moves.push({ x: 0, y: 0, player: BLACK });
  const m4 = chooseMove(b4, BLACK, { level: 2, random: () => 0.5 });
  const responded = m4 && ((m4.y === 7 && (m4.x === 4 || m4.x === 8)));
  ok(responded, '对手活三时在延线上应对', JSON.stringify(m4));

  // 5) 永不返回已占点
  const b5 = createBoard();
  place(b5, 7, 7); place(b5, 7, 8);
  for (let i = 0; i < 20; i++) {
    const m = chooseMove(b5, b5.current, { level: 1 });
    if (!m) break;
    if (b5.grid[m.y][m.x] !== EMPTY) { ok(false, 'AI 落在空位', JSON.stringify(m)); break; }
    place(b5, m.x, m.y);
    if (b5.winner !== EMPTY) break;
  }
  ok(b5.winner !== EMPTY || b5.moves.length > 5, 'AI 能连续对弈多手');

  // 6) 与自身对战不崩（模拟 40 手）
  const b6 = createBoard();
  let steps = 0;
  while (b6.winner === EMPTY && steps < 40) {
    const m = chooseMove(b6, b6.current, { level: 0 });
    if (!m) break;
    place(b6, m.x, m.y);
    steps++;
  }
  ok(steps > 0 && b6.moves.length === steps, 'AI 自对弈 40 手无异常', `实际 ${steps} 手`);
}

console.log('\n【七】克隆不影响原棋盘');
{
  const b = createBoard();
  place(b, 7, 7);
  const c = cloneBoard(b);
  place(c, 8, 8);
  eq(b.moves.length, 1, '克隆体落子不影响原棋盘');
  eq(c.moves.length, 2, '克隆体自身推进');
  eq(b.grid[8][8], EMPTY, '原棋盘该点仍为空');
}

console.log('\n【八】规则层：禁手判定');
{
  const size = 15;

  // 三三禁手：落 (7,7) 后横向与纵向各成一个活三
  const b33 = [];
  for (let y = 0; y < size; y++) b33.push(new Array(size).fill(EMPTY));
  b33[7][6] = BLACK; b33[7][8] = BLACK;   // 横向 ●_● → 落中间成活三
  b33[6][7] = BLACK; b33[8][7] = BLACK;   // 纵向同理
  const r33 = checkForbidden(b33, size, 7, 7);
  ok(r33.forbidden && r33.reasons.includes('三三'), '三三禁手被识别', JSON.stringify(r33));

  // 四四禁手：落 (7,7) 后横向与纵向各成一个四
  const b44 = [];
  for (let y = 0; y < size; y++) b44.push(new Array(size).fill(EMPTY));
  b44[7][4] = BLACK; b44[7][5] = BLACK; b44[7][6] = BLACK;
  b44[4][7] = BLACK; b44[5][7] = BLACK; b44[6][7] = BLACK;
  const r44 = checkForbidden(b44, size, 7, 7);
  ok(r44.forbidden && r44.reasons.includes('四四'), '四四禁手被识别', JSON.stringify(r44));

  // 长连禁手：落 (7,7) 后横向连成 6 子
  const b66 = [];
  for (let y = 0; y < size; y++) b66.push(new Array(size).fill(EMPTY));
  for (const x of [3, 4, 5, 6, 8]) b66[7][x] = BLACK;
  const r66 = checkForbidden(b66, size, 7, 7);
  ok(r66.forbidden && r66.reasons.includes('长连'), '长连禁手被识别', JSON.stringify(r66));

  // 同一点：黑棋判禁手、白棋放行
  const biz = [];
  for (let y = 0; y < size; y++) biz.push(new Array(size).fill(EMPTY));
  biz[7][6] = BLACK; biz[7][8] = BLACK; biz[6][7] = BLACK; biz[8][7] = BLACK;
  const rb = checkMove(biz, size, 7, 7, BLACK, 'pro');
  ok(!rb.ok, '专业版黑棋在(7,7)被判三三禁手', JSON.stringify(rb));
  const rw = checkMove(biz, size, 7, 7, WHITE, 'pro');
  ok(rw.ok, '专业版白棋无禁手（同点放行）', JSON.stringify(rw));

  // 休闲版：完全不禁手
  const rc = checkMove(biz, size, 7, 7, BLACK, 'casual');
  ok(rc.ok, '休闲版不做禁手判定');

  // 正常点不误判
  const bnorm = [];
  for (let y = 0; y < size; y++) bnorm.push(new Array(size).fill(EMPTY));
  bnorm[7][7] = WHITE;
  const rn = checkForbidden(bnorm, size, 0, 0);
  ok(!rn.forbidden, '孤立点不误判为禁手', JSON.stringify(rn));
}

console.log('\n【九】五档难度：都能给出合法落点且基本棋力在线');
{
  for (const lv of [1, 2, 3, 4, 5]) {
    const b = createBoard();
    const m = chooseMove(b, BLACK, { level: lv, mode: 'casual', random: () => 0.5 });
    ok(m && m.x === 7 && m.y === 7, `难度${lv}(${LEVELS[lv].name}) 空盘落天元`, JSON.stringify(m));
  }

  // 对手冲四：普通档及以上必须堵
  for (const lv of [2, 3, 4, 5]) {
    const b = createBoard();
    for (const x of [3, 4, 5, 6]) b.grid[7][x] = WHITE;
    b.grid[7][2] = BLACK;
    b.current = BLACK;
    b.moves.push({ x: 2, y: 7, player: BLACK });
    const m = chooseMove(b, BLACK, { level: lv, mode: 'casual', random: () => 0.5 });
    ok(m && m.x === 7 && m.y === 7, `难度${lv} 堵住对手冲四`, JSON.stringify(m));
  }

  // 对手活四：高难度应尽量制造/延阻（不强求，只验证不崩且合法）
  for (const lv of [3, 4, 5]) {
    const b = createBoard();
    for (const x of [4, 5, 6, 7]) b.grid[7][x] = WHITE;
    b.current = BLACK;
    b.moves.push({ x: 4, y: 7, player: WHITE });
    const m = chooseMove(b, BLACK, { level: lv, mode: 'casual', random: () => 0.5 });
    ok(m && b.grid[m.y][m.x] === EMPTY, `难度${lv} 输出合法空位`, JSON.stringify(m));
  }
}

console.log('\n【十】专业版：AI 执黑不违禁手');
{
  // 造一个「三三禁手点是当前最优」的局面，验证 AI 不会踩
  const b = createBoard();
  b.grid[7][6] = BLACK; b.grid[7][8] = BLACK;
  b.grid[6][7] = BLACK; b.grid[8][7] = BLACK;
  b.current = BLACK;
  b.moves.push({ x: 6, y: 7, player: BLACK }, { x: 8, y: 7, player: BLACK });

  let violations = 0;
  for (const lv of [2, 3, 4, 5]) {
    for (let trial = 0; trial < 8; trial++) {
      const m = chooseMove(b, BLACK, { level: lv, mode: 'pro', random: () => Math.random() });
      if (!m) continue;
      const v = checkMove(b.grid, b.size, m.x, m.y, BLACK, 'pro');
      if (!v.ok) { violations++; console.log(`    ! 难度${lv} 走了禁手 ${JSON.stringify(m)} ${v.reason}`); }
    }
  }
  eq(violations, 0, '专业版黑棋 32 次试选均未踩禁手');
}

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) { console.log('失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
