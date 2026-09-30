/**
 * 中国象棋核心逻辑测试（Node 直接跑，零依赖，不碰任何平台 API）
 * 用法：node src/games/xiangqi/test.mjs
 *
 * 覆盖：各棋子走法、蹩马腿、塞象眼、炮翻山、兵过河、将帅照面、
 *       将军检测、被将军时必须应将（非法着法被过滤）、将死 / 困毙、
 *       AI 五档的合法性与耗时、会话层点选流程与底部安全区余量。
 */
import {
  createBoard, fromFen, toFen, cloneBoard, makeMove, undo, legalMoves, movesOf,
  pseudoMovesOf, inCheck, kingsFacing, findKing, generateMoves, resultText,
  pieceOf, pieceName, parseLevel, levelName, chooseMove, LEVELS,
  COLS, ROWS, EMPTY, RED, BLACK, KING, ADVISOR, ELEPHANT, HORSE, CHARIOT, CANNON, PAWN,
} from './core.js';
import { computeLayout } from './render.js';
import { createSession, meta } from './index.js';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${expected}，实际 ${actual}`);
}

const fen = (s) => fromFen(s);
const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

/** 统计某方在某局面下的合法着法数。 */
const moveCount = (board, side) => legalMoves(board, side).length;
/** 取某颗子的合法目标点字符串集合（便于断言）。 */
const targets = (board, x, y) => movesOf(board, x, y).map((m) => `${m.tx},${m.ty}`).sort();

/* ══════════════════════════ 一、开局与棋盘基础 ══════════════════════════ */
console.log('\n【一】开局与棋盘基础');
{
  const b = createBoard();
  eq(b.grid.length, ROWS, '棋盘 10 行');
  eq(b.grid[0].length, COLS, '棋盘 9 列');
  eq(b.turn, RED, '红先');
  eq(b.grid[9][4], pieceOf(RED, KING), '红帅在 (4,9)');
  eq(pieceName(b.grid[9][4]), '帅', '红帅汉字');
  eq(pieceName(b.grid[0][4]), '将', '黑将汉字');
  eq(pieceName(b.grid[3][0]), '卒', '黑卒汉字');
  eq(b.history.length, 0, '初始无走子历史');
  eq(toFen(b), START_FEN, '初始局面 FEN 正确');
  eq(toFen(fen(START_FEN)), START_FEN, 'FEN 往返一致');

  let count = 0;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (b.grid[y][x] !== EMPTY) count++;
  eq(count, 32, '开局 32 颗子');

  eq(moveCount(b, RED), 44, '红方开局合法着法 44 手（标准值）');
  eq(moveCount(b, BLACK), 44, '黑方开局合法着法 44 手（对称）');
  eq(generateMoves(b, RED).length, 44, '开局无被将军着法，伪合法 = 合法');
}
{
  const b = createBoard();
  ok(!makeMove(b, 4, 4, 4, 5).ok, '空格不能走子');
  eq(makeMove(b, 0, 0, 0, 1).reason, 'not-your-turn', '红方回合不能动黑子');
  eq(makeMove(b, 0, 9, 0, 5).reason, 'illegal', '车不能穿过自己的兵');
  eq(makeMove(b, 0, 9, 0, 8).ok, true, '红车前进一格合法');
  eq(b.turn, BLACK, '走子后轮到黑方');
  eq(b.history.length, 1, '历史记录 1 手');
  const u = undo(b);
  ok(u.ok && b.grid[9][0] === pieceOf(RED, CHARIOT) && b.grid[8][0] === EMPTY, '悔棋还原棋子');
  eq(b.turn, RED, '悔棋后轮次回退');

  const over = cloneBoard(b);
  over.status = { over: true, winner: RED, reason: 'checkmate', text: '' };
  eq(makeMove(over, 0, 9, 0, 8).reason, 'over', '终局后禁止落子');
}

/* ══════════════════════════ 二、各棋子走法 ══════════════════════════ */
console.log('\n【二】帅/将、仕/士');
{
  const b = fen('3k5/9/9/9/9/9/9/9/4K4/9 w');   // 红帅在九宫中央 (4,8)，黑将在 (3,0)
  const t = targets(b, 4, 8);
  eq(t.length, 3, '帅在九宫中央 3 个走点（与黑将同列的那点被飞将挡住）');
  ok(!t.includes('3,8'), '帅不能走到与黑将同列且中间无遮挡的位置（将帅照面）');
  ok(t.every((s) => { const [x, y] = s.split(',').map(Number); return x >= 3 && x <= 5 && y >= 7 && y <= 9; }),
    '帅的走点全部在九宫内');

  const c = fen('3k5/9/9/9/9/9/9/9/9/3K5 w');   // 红帅在九宫左下角 (3,9)
  eq(targets(c, 3, 9).join(' '), '4,9', '帅在角上只剩 1 点（另一个点照面，且不出九宫）');

  const free = fen('9/9/9/9/9/9/9/9/9/3K5 w');  // 无黑将时只看九宫约束
  eq(targets(free, 3, 9).join(' '), '3,8 4,9', '无对手将时帅有 2 个走点（不出九宫）');
}
{
  const b = fen('3k5/9/9/9/9/9/9/9/4A4/4K4 w'); // 红仕居中
  const t = movesOf(b, 4, 8);
  eq(t.length, 4, '仕有 4 个斜走点');
  ok(t.every((m) => m.tx !== 4 && m.ty !== 8), '仕只走斜线');
  ok(t.every((m) => m.tx >= 3 && m.tx <= 5), '仕不出九宫');
}

console.log('\n【三】相/象：塞象眼与不过河');
{
  const open = fen('3k5/9/9/9/9/9/9/9/9/2B1K4 w');
  eq(targets(open, 2, 9).join(' '), '0,7 4,7', '相走田字（两点）');

  const blocked = fen('3k5/9/9/9/9/9/9/9/3P5/2B1K4 w'); // (3,8) 塞住象眼
  eq(targets(blocked, 2, 9).join(' '), '0,7', '塞象眼后该方向不能走');

  const river = fen('3k5/9/9/9/9/2B6/9/9/9/4K4 w');     // 红相在河界己方一侧
  const t = movesOf(river, 2, 5);
  eq(t.length, 2, '相只能在本方半边活动');
  ok(t.every((m) => m.ty >= 5), '相不过河（不出现 y<5 的落点）');
}

console.log('\n【四】马：蹩马腿');
{
  const open = fen('3k5/9/9/9/4N4/9/9/9/9/4K4 w');
  eq(movesOf(open, 4, 4).length, 8, '空旷处马有 8 个落点');

  const blocked = fen('3k5/9/9/4P4/4N4/9/9/9/9/4K4 w'); // (4,3) 蹩住向上的两条腿
  const t = movesOf(blocked, 4, 4);
  eq(t.length, 6, '蹩马腿后只剩 6 个落点');
  ok(!t.some((m) => m.ty === 2), '被蹩的两个方向（落点 y=2）走不到');

  const leg = fen('3k5/9/9/9/2N6/9/9/9/9/4K4 w');       // 马在 (2,4)
  const b2 = fen('3k5/9/9/9/2NP5/9/9/9/9/4K4 w');       // 横向长边 (3,4) 被占
  ok(movesOf(b2, 2, 4).length === movesOf(leg, 2, 4).length - 2,
    '横向长边被占时同样蹩腿（少 2 点）');
}

console.log('\n【五】车与炮');
{
  const b = fen('3k5/9/9/9/9/R8/9/9/9/4K4 w');
  eq(movesOf(b, 0, 5).length, 17, '空盘车 17 个走点（横 8 + 纵 9）');

  const blocked = fen('3k5/9/9/9/9/R8/9/P8/9/4K4 w');
  const t = targets(blocked, 0, 5);
  eq(t.length, 14, '己方子挡住后减少 3 点');
  ok(!t.includes('0,8') && !t.includes('0,9'), '车不能穿过己方棋子');

  // 炮：中间无炮架 → 不能吃
  const noScreen = fen('3k5/9/r8/9/9/C8/9/9/9/4K4 w');
  const t1 = movesOf(noScreen, 0, 5);
  eq(t1.filter((m) => m.cap !== EMPTY).length, 0, '无炮架时炮不能吃子');
  eq(t1.length, 14, '无炮架时炮只能走空点（纵 6 + 横 8）');

  // 炮：一个炮架 → 可以吃
  const oneScreen = fen('3k5/9/r8/9/P8/C8/9/9/9/4K4 w');
  const t2 = movesOf(oneScreen, 0, 5);
  const caps2 = t2.filter((m) => m.cap !== EMPTY);
  eq(caps2.length, 1, '隔一个炮架可以吃子');
  eq(`${caps2[0].tx},${caps2[0].ty}`, '0,2', '翻山吃掉对面的黑车');

  // 炮：两个炮架 → 只能吃第一个
  const twoScreen = fen('3k5/9/r8/p8/P8/C8/9/9/9/4K4 w');
  const t3 = movesOf(twoScreen, 0, 5);
  const caps3 = t3.filter((m) => m.cap !== EMPTY);
  eq(caps3.length, 1, '有两个子时仍只吃第一个');
  eq(`${caps3[0].tx},${caps3[0].ty}`, '0,3', '吃的是紧邻炮架之后的那颗子');
  ok(!targets(twoScreen, 0, 5).includes('0,2'), '更远的黑车吃不到');
}

console.log('\n【六】兵/卒：过河才可横走');
{
  const before = fen('3k5/9/9/9/9/9/4P4/9/9/4K4 w');   // 红兵在 (4,6)，未过河
  eq(targets(before, 4, 6).join(' '), '4,5', '未过河的兵只能向前一步');

  const after = fen('3k5/9/9/9/4P4/9/9/9/9/4K4 w');    // 红兵在 (4,4)，已过河
  eq(targets(after, 4, 4).join(' '), '3,4 4,3 5,4', '过河后可向前 + 左右各一步');
  ok(!targets(after, 4, 4).includes('4,5'), '兵不能后退');

  const bp = fen('3k5/9/9/9/4p4/9/9/9/9/4K4 b');       // 黑卒在 (4,4)，未过河
  eq(targets(bp, 4, 4).join(' '), '4,5', '黑卒向 y 增大方向前进');

  const bp2 = fen('3k5/9/9/9/9/9/4p4/9/9/4K4 b');      // 黑卒在 (4,6)，已过河
  eq(movesOf(bp2, 4, 6).length, 3, '过河黑卒有 3 个走点');
}

/* ══════════════════════════ 七、将帅照面（飞将）══════════════════════════ */
console.log('\n【七】将帅照面（飞将）');
{
  const facing = fen('4k4/9/9/9/9/9/9/9/9/4K4 w');
  ok(kingsFacing(facing), '同列无遮挡 → 将帅照面');
  eq(facing.status.over, true, '照面局面判终局');
  eq(facing.status.reason, 'flying', '原因标记为 flying');
  eq(facing.status.winner, RED, '轮到走子的一方直接吃将获胜');

  const blocked = fen('4k4/9/9/9/9/4P4/9/9/9/4K4 w');
  ok(!kingsFacing(blocked), '中间有子不算照面');
  eq(blocked.status.over, false, '有遮挡则正常继续');

  const shield = fen('4k4/9/9/9/9/4R4/9/9/9/4K4 w');   // 红车在 (4,5) 挡着
  const legal = movesOf(shield, 4, 5);
  ok(legal.length > 0 && legal.every((m) => m.tx === 4), '挡将的车不能离开这条竖线');
  ok(pseudoMovesOf(shield, 4, 5).some((m) => m.tx === 3), '规则上本来可以横走（伪合法）');
  ok(!legal.some((m) => m.tx === 3), '但横走会被合法着法过滤掉（照面即负）');
}

/* ══════════════════════════ 八、将军与应将 ══════════════════════════ */
console.log('\n【八】将军检测 / 被将军时必须应将');
{
  const chk = fen('3k5/9/9/9/9/3R5/9/9/9/5K3 b');   // 红帅在 (5,9)，避免与黑将同列
  eq(inCheck(chk, BLACK), true, '黑将被红车照面将军');
  eq(inCheck(chk, RED), false, '红帅未被将军');
  eq(chk.status.reason, 'check', '状态标记为 check');
  eq(legalMoves(chk, BLACK).length, 1, '被将军时只剩一步可走');

  // 同样的将军，但红帅在 (4,9)：黑将唯一的躲避点 (4,0) 会造成照面 → 直接被将死
  const choke = fen('3k5/9/9/9/9/3R5/9/9/9/4K4 b');
  eq(choke.status.reason, 'checkmate', '躲避格会造成照面的将军 = 将死');

  // 红帅被黑车直线将军：无关的着法必须被过滤
  const mate = fen('3kr4/9/9/9/9/9/9/9/9/R3K4 w');
  eq(inCheck(mate, RED), true, '红帅被黑车将军');
  const legal = legalMoves(mate, RED);
  eq(legal.length, 1, '只有一步能解将（帅躲到 5,9）');
  eq(`${legal[0].fx},${legal[0].fy}->${legal[0].tx},${legal[0].ty}`, '4,9->5,9', '唯一解将是横向躲开');
  ok(movesOf(mate, 0, 9).length === 0 && pseudoMovesOf(mate, 0, 9).length > 0,
    '左下红车规则上能走，但被将军时全部被过滤（0 步合法）');
  ok(legal.every((m) => { const c = cloneBoard(mate); makeMove(c, m.fx, m.fy, m.tx, m.ty); return !inCheck(c, RED); }),
    '每步合法着法走完都不再被将军');

  // 可以垫将：除躲帅外，还可以把子挡在炮口/车线上
  const block = fen('3kr4/9/9/9/9/R8/9/9/9/4K4 w');
  const lb = legalMoves(block, RED);
  const keys = lb.map((m) => `${m.fx},${m.fy}->${m.tx},${m.ty}`).sort();
  eq(keys.join(' | '), '0,5->4,5 | 4,9->5,9', '解将只有「垫车」或「躲帅」两种');
  ok(!keys.includes('0,5->0,4'), '不相关的着法（车白走一步）被过滤');
}

/* ══════════════════════════ 九、将死与困毙 ══════════════════════════ */
console.log('\n【九】将死 / 困毙');
{
  const mated = fen('4k4/5r3/9/9/9/4p4/9/2n6/9/3rK4 w');
  eq(inCheck(mated, RED), true, '红帅正被将军');
  eq(legalMoves(mated, RED).length, 0, '红方无着可走');
  eq(mated.status.over, true, '判终局');
  eq(mated.status.reason, 'checkmate', '原因是将死');
  eq(mated.status.winner, BLACK, '黑方获胜');
  eq(resultText(mated), '黑方胜', '结果文案');

  const stale = fen('4k4/3r5/9/9/9/4p4/9/6n2/9/4K4 w');
  eq(inCheck(stale, RED), false, '困毙局面并未被将军');
  eq(legalMoves(stale, RED).length, 0, '红方同样无着可走');
  eq(stale.status.reason, 'stalemate', '原因是困毙');
  eq(stale.status.winner, BLACK, '象棋困毙判负（不是和棋）');

  const stillAlive = fen('4k4/9/9/9/9/9/9/9/4R4/4K4 w');
  eq(stillAlive.status.over, false, '普通局面不误判终局');
  ok(moveCount(stillAlive, RED) > 0, '有子可动');
}

/* ══════════════════════════ 十、AI 棋力与约束 ══════════════════════════ */
console.log('\n【十】AI：吃子、应将、杀棋、耗时');
{
  // ① 白送的车必须吃（五档都要吃）
  const free = fen('r2k5/9/9/9/9/R8/9/9/9/4K4 b');
  for (const lv of [1, 2, 3, 4, 5]) {
    const m = chooseMove(free, BLACK, { level: lv, random: () => 0.95 });
    ok(m && m.fx === 0 && m.fy === 0 && m.tx === 0 && m.ty === 5,
      `难度${lv}(${LEVELS[lv].name}) 吃掉白送的红车`, JSON.stringify(m));
  }

  // ② 被将军必须应将
  const chk = fen('3k5/9/9/9/9/3R5/9/9/9/5K3 b');
  for (const lv of [1, 3, 5]) {
    const m = chooseMove(chk, BLACK, { level: lv, random: () => 0.95 });
    const after = cloneBoard(chk);
    const r = makeMove(after, m.fx, m.fy, m.tx, m.ty);
    ok(r.ok && !inCheck(after, BLACK), `难度${lv} 的应着能解将`, JSON.stringify(m));
  }

  // ③ 一步杀：高难度必须找到
  const mateIn1 = fen('4k4/3r1r3/9/9/9/4p4/9/2n6/9/4K4 b');
  for (const lv of [3, 4, 5]) {
    const m = chooseMove(mateIn1, BLACK, { level: lv, random: () => 0.95 });
    const after = cloneBoard(mateIn1);
    makeMove(after, m.fx, m.fy, m.tx, m.ty);
    ok(after.status.over && after.status.winner === BLACK,
      `难度${lv} 抓住一步杀`, JSON.stringify(m));
  }

  // ④ AI 不得修改传入的棋盘
  const before = toFen(mateIn1);
  chooseMove(mateIn1, BLACK, { level: 5, random: () => 0.95 });
  eq(toFen(mateIn1), before, 'chooseMove 不污染传入的棋盘');

  // ⑤ 五档自对弈：每步都合法，单步耗时 < 800ms
  for (const lv of [1, 2, 3, 4, 5]) {
    const b = createBoard();
    const plies = lv >= 4 ? 4 : 10;      // 高难度含深度搜索，缩短轮次控制整体等待
    let legalAll = true, worst = 0, played = 0;
    for (let i = 0; i < plies && !b.status.over; i++) {
      const pool = legalMoves(b, b.turn);
      const t0 = performance.now();
      const m = chooseMove(b, b.turn, { level: lv, random: () => 0.95 });
      worst = Math.max(worst, performance.now() - t0);
      if (!m || !pool.some((p) => p.fx === m.fx && p.fy === m.fy && p.tx === m.tx && p.ty === m.ty)) {
        legalAll = false;
        break;
      }
      makeMove(b, m.fx, m.fy, m.tx, m.ty);
      played++;
    }
    ok(legalAll, `难度${lv} 连续 ${played} 手全部合法`);
    ok(worst < 800, `难度${lv} 单步最长耗时 ${worst.toFixed(1)}ms (<800ms)`);
  }

  // ⑥ 开局（着法最多的局面）单独测一次最高难度耗时
  {
    const b = createBoard();
    const t0 = performance.now();
    const m = chooseMove(b, RED, { level: 5, random: () => 0.95 });
    const cost = performance.now() - t0;
    ok(m && cost < 800, `最高难度在开局单步耗时 ${cost.toFixed(1)}ms (<800ms)`, JSON.stringify(m));
  }

  // ⑦ 空盘/无着可走时返回 null
  const dead = fen('4k4/5r3/9/9/9/4p4/9/2n6/9/3rK4 w');
  eq(chooseMove(dead, RED, { level: 4 }), null, '无着可走时 AI 返回 null');
}

/* ══════════════════════════ 十一、会话层（createSession）══════════════════════════ */
console.log('\n【十一】会话层：meta、点选流程、安全区余量');
{
  eq(meta.id, 'xiangqi', 'meta.id 与目录一致');
  eq(meta.ready, true, 'meta.ready');
  ok(meta.difficulties.length === 5, 'meta.difficulties 五档');
  ok(meta.difficulties.every((d, i) => d.key === `lv${i + 1}`), 'difficulty key 为 lv1..lv5');
  ok(meta.difficulties.every((d, i) => parseLevel(d.key) === i + 1), 'key 能被会话解析成 1..5');
  eq(parseLevel('lv5'), 5, "parseLevel('lv5') = 5");
  eq(levelName(3), '困难', '难度名');

  const width = 375, height = 667, insets = { top: 20, bottom: 34 };
  const session = createSession({ width, height, insets, difficulty: 'lv3', onEvent: () => {} });
  const layout = computeLayout(width, height, insets);
  const btn = layout.buttons[0];
  ok(btn.y + btn.h + 16 + insets.bottom <= height,
    `底部按钮下方留出 insets.bottom+16（按钮下沿 ${btn.y + btn.h} ≤ ${height - 16 - insets.bottom}）`);

  const p = (x, y) => layout.board.toScreen(x, y);
  const evt = [];

  // 点红兵（0,6）→ 选中；点 (0,5) → 落子
  const a = p(0, 6);
  eq(session.tap(a.x, a.y, 0).type, 'select', '点自己的棋子 → 选中');
  const b5 = p(0, 5);
  eq(session.tap(b5.x, b5.y, 0).type, 'move', '点可走点 → 落子');
  eq(session.board.grid[5][0], pieceOf(RED, PAWN), '红兵已到 (0,5)');
  eq(session.board.grid[6][0], EMPTY, '原位置清空');
  eq(session.board.history.length, 1, '会话记了一步');

  // AI 应招（玩家回合结束后 AI 才动，期间点击被 blocked）
  eq(session.tap(p(8, 8).x, p(8, 8).y, 100).type, 'blocked', 'AI 思考期间点棋盘不响应');
  session.update(5000);
  eq(session.board.history.length, 2, 'AI 已应招');
  eq(session.board.turn, RED, '应招后轮回到玩家');

  // 改选与取消（点空白）
  eq(session.tap(p(2, 6).x, p(2, 6).y, 5200).type, 'select', '可以改选另一颗棋子');
  eq(session.tap(p(1, 4).x, p(1, 4).y, 5300).type, 'cancel', '点空白 → 取消选择');

  // 悔棋回到自己走之前
  const undone = session.tap(layout.buttons[1].x + 5, layout.buttons[1].y + 5, 6000);
  ok(undone.ok && session.board.history.length === 0, '悔棋两步回到开局');
  eq(session.board.turn, RED, '悔棋后仍是玩家回合');

  // 认输 → outcome
  session.tap(layout.buttons[2].x + 5, layout.buttons[2].y + 5, 7000);
  ok(session.outcome && session.outcome.result === 'lose', '认输后 outcome = lose');
  eq(session.hud.title, '中国象棋', 'hud.title');
  ok(typeof session.hud.status === 'string' && session.hud.status.length > 0, 'hud.status 非空');

  // 重新开始
  session.tap(layout.buttons[0].x + 5, layout.buttons[0].y + 5, 8000);
  eq(session.board.history.length, 0, '重新开始后回到开局');
  eq(session.outcome, null, '重开后 outcome 归零');

  // 渲染冒烟（假 ctx：任何属性都当函数用，渐变为桩）
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k === 'measureText') return () => ({ width: 40 });
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  let renderOk = true;
  try {
    session.render(ctx, 0);
    const q = p(4, 9);
    session.tap(q.x, q.y, 0);      // 选中红帅（有可走点）
    session.render(ctx, 16);
    session.resize(414, 896, { top: 20, bottom: 34 });
    session.render(ctx, 32);
    session.press(10, 10);
    session.release();
    session.hover(100, 100);
    session.destroy();
  } catch (err) {
    renderOk = false;
    console.log('    ! 渲染异常：' + (err && err.message));
  }
  ok(renderOk, 'render / resize / press / hover / destroy 全流程不抛异常');
}

/* ══════════════════════════ 汇总 ══════════════════════════ */
console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) {
  console.log('失败清单：');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail === 0 ? 0 : 1);
