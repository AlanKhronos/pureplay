/**
 * 国际象棋核心逻辑测试（Node 直接跑，零依赖，不碰微信 API）
 * 用法：node src/games/chess/test.mjs
 *
 * 覆盖：各棋子走法 / 兵首步两格与斜吃与升变 / 王车易位条件 / 吃过路兵 /
 *       不能送王（非法走法被过滤）/ 将杀 / 逼和 / AI 五档棋力与耗时 / 模块接口与渲染。
 */
import {
  createBoard, fromFEN, toFEN, cloneBoard, positionKey, lastMove,
  genPseudoMoves, legalMoves, legalMovesFrom, findLegalMove, applyMove, undoMove,
  isInCheck, isSquareAttacked, findKing, gameStatus, insufficientMaterial, evaluate,
  chooseMove, LEVELS, levelName, mkPiece, typeOf, colorOf, pieceAt, pieceName,
  EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
} from './core.js';
import { meta, createSession, computeLayout } from './index.js';
// 【十】渲染自检用：棋子绘制入口 + 主题令牌 + 源码（查时钟源）
import { drawPiece, drawPieces } from './render.js';
import { THEME } from '../../ui/theme.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${expected}，实际 ${actual}`);
}
/** 着法列表里是否有「起点 → 终点」这一手。 */
function hasTo(list, fx, fy, tx, ty) {
  return list.some((m) => m.fx === fx && m.fy === fy && m.tx === tx && m.ty === ty);
}
/** 按坐标走一手（找不到合法着法则返回 null）。 */
function play(board, fx, fy, tx, ty, promote = QUEEN) {
  const m = findLegalMove(board, fx, fy, tx, ty, promote);
  if (!m) return null;
  applyMove(board, m);
  return m;
}
/** 简易 canvas 上下文替身：只验证 render 不抛异常。 */
function stubCtx() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  return new Proxy({}, {
    get(target, key) {
      if (key === 'measureText') return () => ({ width: 24 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      if (key === 'canvas') return { width: 375, height: 667 };
      return target[key] ?? noop;
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

console.log('\n【一】初始局面与棋子编码');
{
  const b = createBoard();
  eq(b.turn, WHITE, '白先手');
  eq(b.history.length, 0, '初始无着法历史');
  eq(legalMoves(b).length, 20, '开局 20 个合法着法（16 兵 + 4 马）');
  let count = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (b.grid[y][x]) count++;
  eq(count, 32, '开局 32 个棋子');
  eq(pieceAt(b, 4, 7), mkPiece(KING, WHITE), '白王在 e1');
  eq(pieceAt(b, 4, 0), mkPiece(KING, BLACK), '黑王在 e8');
  eq(typeOf(mkPiece(QUEEN, BLACK)), QUEEN, '编码：类型可还原');
  eq(colorOf(mkPiece(QUEEN, BLACK)), BLACK, '编码：颜色可还原');
  eq(pieceName(mkPiece(KNIGHT, WHITE)), '白马', '棋子中文名');
  eq(toFEN(b), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', '初始 FEN');
  const b2 = fromFEN(toFEN(b));
  eq(toFEN(b2), toFEN(b), 'FEN 往返一致');
  ok(legalMoves(b).every((m) => m.tx >= 0 && m.tx < 8 && m.ty >= 0 && m.ty < 8), '着法坐标都在盘内');
}

console.log('\n【二】各棋子走法');
{
  // 马：空盘中心 8 步，且能跳子（相邻格被己方兵塞满也不影响）
  const n1 = fromFEN('8/8/8/4N3/8/8/8/K6k w - - 0 1');
  eq(legalMovesFrom(n1, 4, 3).length, 8, '马在中心有 8 步');
  const ring = fromFEN('8/8/8/2PPP3/2PNP3/2PPP3/8/K6k w - - 0 1');
  eq(legalMovesFrom(ring, 3, 4).length, 8, '马被己方子围住仍能跳出（国际象棋无蹩马腿）');

  // 象：只能走斜线，不能越子
  const bFree = fromFEN('8/8/8/8/3B4/8/8/4K2k w - - 0 1');
  eq(legalMovesFrom(bFree, 3, 4).length, 13, '象在 d4 空盘有 13 步');
  const bBlock = fromFEN('8/8/5P2/8/3B4/8/8/K6k w - - 0 1');
  const bm = legalMovesFrom(bBlock, 3, 4);
  eq(bm.length, 9, '象被己方兵挡在 f6，只剩 9 步');
  ok(!hasTo(bm, 3, 4, 6, 1), '象不能越子到 g7');
  const bEat = fromFEN('8/8/5p2/8/3B4/8/8/K6k w - - 0 1');
  const be = legalMovesFrom(bEat, 3, 4);
  eq(be.length, 10, '象可以吃 f6 的敌子（9 + 1）');
  ok(be.some((m) => m.tx === 5 && m.ty === 2 && m.capture), '吃子着法带 capture 标记');
  ok(!hasTo(be, 3, 4, 6, 1), '吃掉 f6 后仍不能越子到 g7');

  // 车：直线，不能越子
  const r1 = fromFEN('7k/8/8/8/8/P7/8/R7 w - - 0 1');
  const rm = legalMovesFrom(r1, 0, 7);
  eq(rm.length, 8, '车 a1 被己方兵挡在 a3 → 8 步');
  ok(hasTo(rm, 0, 7, 0, 6), '车可走 a2');
  ok(!hasTo(rm, 0, 7, 0, 4), '车不能越子到 a4');
  ok(hasTo(rm, 0, 7, 7, 7), '车可沿底线走到 h1');

  // 后：直线 + 斜线综合（空盘 27 步）
  const q1 = fromFEN('8/8/8/8/3Q4/8/8/4K2k w - - 0 1');
  eq(legalMovesFrom(q1, 3, 4).length, 27, '后在 d4 空盘有 27 步（车 + 象）');

  // 王：一格一格（无易位权时 e1 只有 5 步）
  const k1 = fromFEN('7k/8/8/8/8/8/8/4K3 w - - 0 1');
  eq(legalMovesFrom(k1, 4, 7).length, 5, '王在 e1 有 5 步（不含易位）');
}

console.log('\n【三】兵：首步两格 / 斜吃 / 升变 / 吃过路兵');
{
  const b = fromFEN('7k/8/8/8/8/8/4P3/K7 w - - 0 1');
  const pm = legalMovesFrom(b, 4, 6);
  eq(pm.length, 2, '兵在起始行可选一格或两格');
  ok(hasTo(pm, 4, 6, 4, 4) && hasTo(pm, 4, 6, 4, 5), '两格与一格都在候选中');
  play(b, 4, 6, 4, 4);
  const bmoved = fromFEN(toFEN(b));
  bmoved.turn = WHITE;                       // 只看白兵自己的走法
  const pm2 = legalMovesFrom(bmoved, 4, 4);
  eq(pm2.length, 1, '离开起始行后只能走一格');
  ok(!hasTo(pm2, 4, 4, 4, 2), '不能连走两格');

  // 斜吃：只能吃斜前方的敌子
  const c = fromFEN('7k/8/8/8/8/3p4/4P3/K7 w - - 0 1');
  const cm = legalMovesFrom(c, 4, 6);
  eq(cm.length, 3, '兵可直进两格 + 斜吃 1 个（共 3）');
  ok(hasTo(cm, 4, 6, 3, 5) && cm.find((m) => m.tx === 3 && m.ty === 5).capture, '斜吃 d3 的敌兵');
  ok(!hasTo(cm, 4, 6, 5, 5), '斜前方是空格时不能斜走');
  const blocked = fromFEN('7k/8/8/8/8/3pp3/4P3/K7 w - - 0 1');
  const bkm = legalMovesFrom(blocked, 4, 6);
  eq(bkm.length, 1, '正前方被敌兵堵死时只能斜吃（1 步）');
  ok(hasTo(bkm, 4, 6, 3, 5) && !hasTo(bkm, 4, 6, 4, 5), '不能直进，只能吃 d3');

  // 升变：底层四种都生成，默认升后
  const p = fromFEN('8/1P6/8/8/8/8/8/K7 w - - 0 1');
  const promos = legalMovesFrom(p, 1, 1);
  eq(promos.length, 4, '到底线生成 4 种升变');
  eq(new Set(promos.map((m) => m.promote)).size, 4, '四种升变棋子齐全');
  play(p, 1, 1, 1, 0, QUEEN);
  eq(pieceAt(p, 1, 0), mkPiece(QUEEN, WHITE), '默认升后生效');
  const p2 = fromFEN('8/1P6/8/8/8/8/8/K7 w - - 0 1');
  play(p2, 1, 1, 1, 0, KNIGHT);
  eq(pieceAt(p2, 1, 0), mkPiece(KNIGHT, WHITE), '升变接口可选马');

  // 吃过路兵：完整走序 1.e4 Nf6 2.e5 d5 3.exd6 e.p.
  const ep = createBoard();
  play(ep, 4, 6, 4, 4);                 // e4
  eq(ep.ep && ep.ep.x === 4 && ep.ep.y === 5, true, '白兵首步两格后留下 e3 过路点');
  play(ep, 6, 0, 5, 2);                 // Nf6
  eq(ep.ep, null, '非兵着法会清掉过路点');
  play(ep, 4, 4, 4, 3);                 // e5
  play(ep, 3, 1, 3, 3);                 // d5
  eq(ep.ep && ep.ep.x === 3 && ep.ep.y === 2, true, '黑兵首步两格后留下 d6 过路点');
  const epMove = legalMovesFrom(ep, 4, 3).find((m) => m.flag === 'ep');
  ok(epMove && epMove.tx === 3 && epMove.ty === 2, '白兵 e5 可吃过路兵到 d6');
  applyMove(ep, epMove);
  eq(pieceAt(ep, 3, 2), mkPiece(PAWN, WHITE), '吃过路兵后白兵落在 d6');
  eq(pieceAt(ep, 3, 3), EMPTY, '被吃的黑兵 d5 已消失');
  eq(ep.ep, null, '吃过路兵后过路点清空');
  ok(!ep.history[ep.history.length - 1].move.flag.includes('double'), '吃了过路兵不会再留新过路点');
}

console.log('\n【四】王车易位（短 / 长，含条件校验）');
{
  const b = fromFEN('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const wm = legalMovesFrom(b, 4, 7);
  ok(wm.some((m) => m.flag === 'castleK'), '白方短易位可用');
  ok(wm.some((m) => m.flag === 'castleQ'), '白方长易位可用');
  const bk = fromFEN('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  const bmv = legalMovesFrom(bk, 4, 0);
  ok(bmv.some((m) => m.flag === 'castleK') && bmv.some((m) => m.flag === 'castleQ'), '黑方两侧都能易位');

  const c = cloneBoard(b);
  play(c, 4, 7, 6, 7);
  eq(pieceAt(c, 6, 7), mkPiece(KING, WHITE), '短易位：王到 g1');
  eq(pieceAt(c, 5, 7), mkPiece(ROOK, WHITE), '短易位：车到 f1');
  eq(pieceAt(c, 7, 7), EMPTY, '短易位：h1 空出');
  eq(c.castling.wk || c.castling.wq, false, '易位后白方两侧权利作废');
  const c2 = cloneBoard(b);
  play(c2, 4, 7, 2, 7);
  eq(pieceAt(c2, 2, 7), mkPiece(KING, WHITE), '长易位：王到 c1');
  eq(pieceAt(c2, 3, 7), mkPiece(ROOK, WHITE), '长易位：车到 d1');
  eq(pieceAt(c2, 0, 7), EMPTY, '长易位：a1 空出');

  const block = fromFEN('r3k2r/8/8/8/8/8/8/R3K1NR w KQkq - 0 1');
  const bg = legalMovesFrom(block, 4, 7);
  ok(!bg.some((m) => m.flag === 'castleK'), 'g1 有子时短易位被拒');
  ok(bg.some((m) => m.flag === 'castleQ'), '长易位不受影响');
  const blockQ = fromFEN('r3k2r/8/8/8/8/8/8/R2QK2R w KQkq - 0 1');
  ok(!legalMovesFrom(blockQ, 4, 7).some((m) => m.flag === 'castleQ'), 'd1 有子时长易位被拒');

  const attacked = fromFEN('4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1');
  const at = legalMovesFrom(attacked, 4, 7);
  ok(!at.some((m) => m.flag === 'castleK'), 'f1 被攻击时不能短易位（王不能穿行被攻击格）');
  ok(at.some((m) => m.flag === 'castleQ'), '长易位仍然可以');

  const inCheck = fromFEN('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1');
  ok(isInCheck(inCheck, WHITE), '白王被将军');
  ok(!legalMovesFrom(inCheck, 4, 7).some((m) => m.flag), '被将军时不能易位');

  const moved = fromFEN('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  play(moved, 4, 7, 4, 6);   // Ke2
  play(moved, 4, 0, 3, 0);   // Kd8（黑王也动）
  play(moved, 4, 6, 4, 7);   // Ke1 回来
  ok(!(moved.castling.wk || moved.castling.wq), '王动过就永久失去易位权');
  ok(!legalMovesFrom(moved, 4, 7).some((m) => m.flag), '回来后依然不能易位');

  const rookMoved = fromFEN('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  play(rookMoved, 7, 7, 7, 6);  // Rh2
  play(rookMoved, 4, 0, 3, 0);  // Kd8
  play(rookMoved, 7, 6, 7, 7);  // Rh1 回来
  eq(rookMoved.castling.wk, false, '车动过该侧易位权作废');
  eq(rookMoved.castling.wq, true, '另一侧不受影响');
  ok(!legalMovesFrom(rookMoved, 4, 7).some((m) => m.flag === 'castleK'), 'a/h 车离位后短易位被拒');
}

console.log('\n【五】不能送王：被将军的非法走法被过滤');
{
  const b = fromFEN('4r3/8/8/8/8/8/8/4K3 w - - 0 1');
  const pseudo = genPseudoMoves(b, WHITE);
  const legal = legalMoves(b, WHITE);
  ok(hasTo(pseudo, 4, 7, 4, 6), '伪合法着法里包含「沿将线后退」的 e2');
  ok(!hasTo(legal, 4, 7, 4, 6), '合法着法里 e2 被过滤（走上去仍被将）');
  eq(legal.length, 4, '被将军时只剩 4 个逃格（d1/d2/f1/f2）');
  ok(legal.every((m) => typeOf(m.piece) === KING), '被将军且无法吃子/挡子时只能动王');

  const pin = fromFEN('4r3/8/8/8/8/8/4B3/4K3 w - - 0 1');
  eq(isInCheck(pin, WHITE), false, '被牵制的象：王当前并未被将');
  eq(legalMovesFrom(pin, 4, 6).length, 0, '被牵制的象一步都不能走（不能送王）');
  ok(genPseudoMoves(pin, WHITE).some((m) => m.fx === 4 && m.fy === 6), '伪合法里象本来是有走法的');

  const mustBlock = fromFEN('4r2k/8/8/8/8/8/8/4K3 w - - 0 1');
  const blockMoves = legalMoves(mustBlock, WHITE);
  eq(blockMoves.length, 4, '车将军且无法挡（车贴底线）时只能动王');

  const defend = fromFEN('4r2k/8/8/8/8/8/7R/4K3 w - - 0 1');
  const dm = legalMoves(defend, WHITE);
  ok(dm.some((m) => m.fx === 7 && m.fy === 6 && m.tx === 4 && m.ty === 6), '可以用车垫在将线上（合法着法不只有动王）');
  eq(dm.length, 5, '逃王 4 步 + 垫车 1 步');
}

console.log('\n【六】将杀与逼和');
{
  // 后排杀：Ra8#
  const m = fromFEN('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  play(m, 0, 7, 0, 0);
  const st = gameStatus(m);
  eq(st.over, true, 'Ra8 之后对局结束');
  eq(st.reason, 'checkmate', '判定为将杀');
  eq(st.result, 'white', '白方获胜');
  ok(isInCheck(m, BLACK), '黑王确实被将');
  eq(legalMoves(m, BLACK).length, 0, '被将杀方无任何合法着法');
  ok(isSquareAttacked(m, 6, 0, WHITE), 'g8 被车控制（无法逃）');

  // 愚人杀：1.f3 e5 2.g4 Qh4#
  const f = createBoard();
  play(f, 5, 6, 5, 5);
  play(f, 4, 1, 4, 3);
  play(f, 6, 6, 6, 4);
  play(f, 3, 0, 7, 4);
  const fs = gameStatus(f);
  eq(fs.reason, 'checkmate', '愚人杀判定为将杀');
  eq(fs.result, 'black', '黑方获胜');
  eq(f.history.length, 4, '共 4 手');

  // 逼和：黑王 h8 无子可动但不被将
  const s = fromFEN('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  eq(isInCheck(s, BLACK), false, '逼和局面里黑王没被将军');
  eq(legalMoves(s, BLACK).length, 0, '黑方没有合法着法');
  const ss = gameStatus(s);
  eq(ss.reason, 'stalemate', '判定为逼和');
  eq(ss.result, 'draw', '逼和是和棋');
  eq(ss.over, true, '逼和即结束');

  // 五十回合与子力不足
  const fifty = fromFEN('k7/8/8/8/8/8/8/K6R w - - 100 60');
  eq(gameStatus(fifty).reason, 'fifty', '半回合数满 100 判和');
  const bare = fromFEN('k7/8/8/8/8/8/8/K7 w - - 0 1');
  eq(insufficientMaterial(bare), true, '双王 → 子力不足');
  eq(gameStatus(bare).reason, 'material', '双王判和');
  const kb = fromFEN('k7/8/8/8/8/8/8/KB6 w - - 0 1');
  eq(gameStatus(kb).reason, 'material', '王象对王判和');
  const kr = fromFEN('k7/8/8/8/8/8/8/KR6 w - - 0 1');
  eq(gameStatus(kr).over, false, '王车对王未结束');
  const rep = fromFEN('k7/8/8/8/8/8/8/K6R w - - 4 40');
  eq(gameStatus(rep, { repetitions: 3 }).reason, 'repetition', '三次重复判和');

  // 非结束局面
  const live = createBoard();
  eq(gameStatus(live).over, false, '开局未结束');
  eq(gameStatus(live).text, '', '开局没有将军提示');
}

console.log('\n【七】悔棋与状态回滚');
{
  const b = createBoard();
  const f0 = toFEN(b);
  play(b, 4, 6, 4, 4);
  const f1 = toFEN(b);
  const k1 = positionKey(b);
  ok(f1 !== f0, '走子后 FEN 变化');
  undoMove(b);
  eq(toFEN(b), f0, '悔棋后 FEN 完全还原');
  eq(b.history.length, 0, '历史清空');
  eq(b.turn, WHITE, '轮次还原给白方');
  ok(positionKey(b) !== k1, '局面指纹随走子变化');
  eq(cloneBoard(b).history.length, 0, '克隆体历史独立');
  const c = cloneBoard(b);
  play(c, 3, 1, 3, 3);
  eq(b.grid[3][3], EMPTY, '克隆体走子不影响原盘');
}

console.log('\n【八】AI 五档棋力');
{
  for (const lv of [1, 2, 3, 4, 5]) {
    eq(LEVELS[lv].key, lv, `难度 ${lv} 的 key 自洽`);
    ok(typeof levelName(lv) === 'string' && levelName(lv).length > 0, `难度 ${lv}(${levelName(lv)}) 有名字`);
  }
  // 每档都能给出合法着法（开局 + 中局）
  const midFEN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 5';
  for (const lv of [1, 2, 3, 4, 5]) {
    const b = createBoard();
    const mv = chooseMove(b, { level: lv });
    ok(mv && legalMoves(b).some((m) => m.fx === mv.fx && m.fy === mv.fy && m.tx === mv.tx && m.ty === mv.ty),
      `难度 ${lv} 开局给出合法着法`, JSON.stringify(mv));
    const mb = fromFEN(midFEN);
    const mv2 = chooseMove(mb, { level: lv });
    ok(mv2 && legalMoves(mb).some((m) => m.fx === mv2.fx && m.fy === mv2.fy && m.tx === mv2.tx && m.ty === mv2.ty),
      `难度 ${lv} 中局给出合法着法`, JSON.stringify(mv2));
    eq(toFEN(mb), midFEN, `难度 ${lv} 搜索后棋盘原封不动（make-unmake 恢复）`);
  }

  // 任何难度都必须抓住一步将杀
  const mateFEN = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
  for (const lv of [1, 2, 3, 4, 5]) {
    const b = fromFEN(mateFEN);
    const mv = chooseMove(b, { level: lv, random: () => 0.999 });
    const after = fromFEN(mateFEN);
    applyMove(after, mv);
    eq(gameStatus(after).reason, 'checkmate', `难度 ${lv} 找到一步将杀`);
  }

  // 白送的后要吃掉（低难度也该看得见）
  const hang = fromFEN('4k3/8/8/8/8/8/8/R2q2K1 w - - 0 1');
  for (const lv of [1, 2, 3]) {
    const mv = chooseMove(hang, { level: lv });
    eq(mv && typeOf(mv.capture) === QUEEN, true, `难度 ${lv} 吃掉白送的后`, JSON.stringify(mv));
  }

  // 无着法时返回 null（已被将杀的一方）
  const dead = fromFEN('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  play(dead, 0, 7, 0, 0);
  eq(chooseMove(dead, { level: 5 }), null, '被将杀方 AI 返回 null');

  // 单步耗时（硬约束 < 800ms）
  const heavy = fromFEN('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 5');
  for (const lv of [1, 2, 3, 4, 5]) {
    const t0 = Date.now();
    chooseMove(fromFEN(toFEN(heavy)), { level: lv });
    const ms = Date.now() - t0;
    ok(ms < 800, `难度 ${lv}(${levelName(lv)}) 单步耗时 ${ms}ms < 800ms`);
  }

  // 评估函数：吃子是正收益、位置表不越权
  const e1 = fromFEN('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  const e2 = fromFEN('4k3/8/8/8/8/8/8/3QK3 w - - 0 1');
  ok(evaluate(e2) - evaluate(e1) >= 800, '多一个后至少多 800 分（子力占主导）');
  ok(evaluate(fromFEN('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1')) > 0, '白多一兵为正分');
  ok(evaluate(fromFEN('4k3/8/8/8/8/8/4p3/4K3 w - - 0 1')) < 0, '黑多一兵为负分');
  ok(Math.abs(evaluate(createBoard())) < 60, '开局评估接近均势（位置表不越权）');
}

console.log('\n【九】模块接口与渲染（不碰平台 API）');
{
  eq(meta.id, 'chess', 'meta.id 与目录名一致');
  eq(meta.name, '国际象棋', 'meta.name');
  ok(meta.desc.length <= 16, 'meta.desc ≤ 16 字');
  eq(meta.ready, true, 'meta.ready');
  eq(meta.difficulties.length, 5, '难度档位 5 个');
  eq(meta.difficulties.map((d) => d.key).join(','), 'lv1,lv2,lv3,lv4,lv5', '难度 key 为 lv1..lv5');
  eq(meta.difficulties.map((d) => d.name).join(','), '简单,普通,困难,地狱,亚洲', '难度命名统一');

  // 创建会话：接口齐全
  const session = createSession({ width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'lv3', theme: undefined, onEvent: () => {} });
  for (const k of ['resize', 'tap', 'press', 'release', 'hover', 'update', 'render', 'destroy']) {
    eq(typeof session[k], 'function', `createSession 暴露 ${k}()`);
  }
  ok(session.hud && typeof session.hud.title === 'string', 'hud 可读');
  eq(session.busy, false, '开局不忙');
  eq(session.outcome, null, '开局无结果');

  // 渲染不抛异常
  const ctx = stubCtx();
  let renderErr = null;
  try { session.render(ctx, 1000); } catch (e) { renderErr = e; }
  eq(renderErr, null, 'stub ctx 下 render 不抛异常', renderErr ? String(renderErr) : '');

  // 底部按钮必须留出 insets.bottom + 16
  const L = computeLayout(375, 667, { top: 44, bottom: 34 });
  const btn = L.buttons[0];
  ok(btn.y + btn.h <= 667 - 34 - 16 + 0.01, '按钮底边不越过 insets.bottom + 16');
  ok(667 - 34 - 16 - (btn.y + btn.h) < 8, '按钮贴着安全边（没有过度留白）');
  const L2 = computeLayout(320, 568, { top: 20, bottom: 0 });
  ok(L2.buttons[0].y + L2.buttons[0].h <= 568 - 0 - 16 + 0.01, '无安全区机型同样留 16');
  ok(L2.board.y >= L2.contentTop + L2.hud.h - 0.01, '棋盘在顶部信息区之下');
  ok(L2.board.x >= 0 && L2.board.y >= 0 && L2.board.x + L2.board.size <= 320, '棋盘不越界');
  // 顶部让位给集成层的返回 / 齿轮
  ok(L.contentTop >= 44 + 46, '顶部让出集成层按钮的高度');

  // 交互：选中 → 落子 → AI 应答
  const s2 = createSession({ width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'lv1', onEvent: () => {} });
  const lay = computeLayout(375, 667, { top: 44, bottom: 34 });
  const e2 = lay.board.toScreen(4, 6);
  s2.tap(e2.x, e2.y, 0);
  eq(s2.state.selected && s2.state.selected.x === 4 && s2.state.selected.y === 6, true, '点自己的兵 → 选中');
  eq(s2.state.targets.length, 2, '选中后显示 2 个可走点（e3/e4）');
  const e4 = lay.board.toScreen(4, 4);
  s2.tap(e4.x, e4.y, 0);
  eq(s2.state.board.history.length, 1, '点目标格落子');
  eq(s2.state.board.grid[4][4] !== EMPTY, true, 'e4 上出现白兵');
  eq(s2.busy, true, '落子后进入 AI 思考');
  s2.update(99999);
  eq(s2.busy, false, 'AI 落子后思考结束');
  eq(s2.state.board.history.length, 2, 'AI 已应答一手');
  eq(s2.state.board.turn, WHITE, '轮到玩家');

  // 改选：点自己另一个子
  const d2 = lay.board.toScreen(3, 6);
  s2.tap(d2.x, d2.y, 0);
  eq(s2.state.selected.x === 3 && s2.state.selected.y === 6, true, '再点自己另一子 → 改选');
  // 点空白 / 盘外 → 取消
  const empty = lay.board.toScreen(7, 0);
  s2.tap(empty.x, empty.y, 0);
  eq(s2.state.selected, null, '点空白 → 取消选中');
  // 点对方棋子不是可吃点时也不落子
  const before = s2.state.board.history.length;
  const e5 = lay.board.toScreen(4, 3);
  s2.tap(e5.x, e5.y, 0);
  eq(s2.state.board.history.length, before, '非法点击不落子');

  // 悔棋按钮
  const undoBtn = lay.buttons[1];
  s2.tap(undoBtn.x + undoBtn.w / 2, undoBtn.y + undoBtn.h / 2, 1000);
  eq(s2.state.board.history.length, 0, '悔棋退回开局（撤两手）');
  eq(s2.state.board.turn, WHITE, '悔棋后轮到玩家');

  // 重新开始按钮
  play(s2.state.board, 4, 6, 4, 4);
  const resetBtn = lay.buttons[0];
  s2.tap(resetBtn.x + resetBtn.w / 2, resetBtn.y + resetBtn.h / 2, 2000);
  eq(s2.state.board.history.length, 0, '重新开始清空棋局');
  eq(toFEN(s2.state.board), toFEN(createBoard()), '重新开始回到标准开局');

  // 认输 → 结果与上报
  const events = [];
  const s3 = createSession({ width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'lv4', onEvent: (t, p) => events.push([t, p]) });
  const l3 = computeLayout(375, 667, { top: 0, bottom: 0 });
  s3.tap(l3.buttons[2].x + 10, l3.buttons[2].y + 10, 0);
  eq(s3.outcome && s3.outcome.result, 'lose', '认输 → outcome = lose');
  eq(events.length >= 1 && events[0][0], 'lose', '认输向上层上报 lose');
  s3.render(stubCtx(), 500);
  eq(667 - 0 - 16 - (l3.buttons[0].y + l3.buttons[0].h) < 8, true, 'default insets 也有底部余量');

  // resize 不炸
  let resizeErr = null;
  try { s3.resize(320, 568, { top: 20, bottom: 0 }); s3.render(stubCtx(), 600); } catch (e) { resizeErr = e; }
  eq(resizeErr, null, 'resize 后可正常渲染');

  // destroy
  s3.destroy();
  eq(s3.busy, false, 'destroy 后不忙');

  // 难度 key 与 createSession 处理一致
  for (const d of meta.difficulties) {
    const ss = createSession({ width: 375, height: 667, difficulty: d.key });
    eq(typeof ss.state.levelName, 'string', `难度 key ${d.key} 被 createSession 接受`);
    ss.destroy();
  }
}

console.log('\n【十】渲染自检：6 种棋子路径 / 落子动画 / 变换栈（记录型桩 ctx）');
{
  /**
   * 记录型 ctx 替身：不只是「不抛异常」，而是把
   *   · 每段 beginPath 路径的全部节点坐标（含 globalAlpha 快照）
   *   · fillRect 的绝对位置与尺寸（含变换换算）
   *   · save/restore/clip/clearRect 计数与变换栈
   * 都记下来，供下面的渲染断言使用。
   * 未实现的方法一律 noop（渲染层未来加绘制调用也不会让本测试崩掉）。
   */
  function recordCtx(W = 375, H = 667) {
    const groups = [];
    let cur = null;
    const noop = () => {};
    const rec = {
      groups,
      fillRects: [], strokeRects: [], clearRects: 0, fills: 0, strokes: 0,
      saves: 0, restores: 0, clips: 0, clipOutsideSave: 0, stack: [],
      tr: { a: 1, d: 1, e: 0, f: 0 },
      fillStyles: [], strokeStyles: [],
      globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
      canvas: { width: W, height: H },
      measureText: () => ({ width: 24 }),
      createLinearGradient: () => gradStub(),
      createRadialGradient: () => gradStub(),
      beginPath() { cur = { pts: [], alpha: rec.globalAlpha }; groups.push(cur); },
      moveTo(x, y) { pt(x, y); },
      lineTo(x, y) { pt(x, y); },
      bezierCurveTo(a, b, c, d, e, f) { pt(a, b); pt(c, d); pt(e, f); },
      quadraticCurveTo(a, b, c, d) { pt(a, b); pt(c, d); },
      arc(x, y, r) { pt(x - r, y - r); pt(x + r, y + r); },
      arcTo(x1, y1, x2, y2) { pt(x1, y1); pt(x2, y2); },
      closePath: noop,
      fill() { rec.fills++; rec.fillStyles.push(rec.fillStyle); },
      stroke() { rec.strokes++; rec.strokeStyles.push(rec.strokeStyle); },
      fillRect(x, y, w, h) { rec.fillRects.push(abs(x, y, w, h)); },
      strokeRect(x, y, w, h) { rec.strokeRects.push(abs(x, y, w, h)); },
      clearRect() { rec.clearRects++; },
      save() { rec.saves++; rec.stack.push({ ...rec.tr, alpha: rec.globalAlpha }); },
      restore() {
        rec.restores++;
        const s = rec.stack.pop();
        if (s) { rec.tr = { a: s.a, d: s.d, e: s.e, f: s.f }; rec.globalAlpha = s.alpha; }
      },
      translate(x, y) { rec.tr.e += rec.tr.a * x; rec.tr.f += rec.tr.d * y; },
      scale(x, y) { rec.tr.a *= x; rec.tr.d *= y; },
      rotate: noop,
      clip() { rec.clips++; if (!rec.stack.length) rec.clipOutsideSave++; },
      setTransform: noop, setLineDash: noop,
    };
    /** 路径节点一律换算成**绝对坐标**记录（否则局部坐标与阴影的绝对坐标会混进同一个包围盒）。 */
    function pt(x, y) {
      if (cur) cur.pts.push([rec.tr.e + x * rec.tr.a, rec.tr.f + y * rec.tr.d]);
    }
    function abs(x, y, w, h) {
      return { x: rec.tr.e + x * rec.tr.a, y: rec.tr.f + y * rec.tr.d, w: w * rec.tr.a, h: h * rec.tr.d };
    }
    function gradStub() {
      const g = { stops: [], addColorStop(p, c) { g.stops.push([p, c]); } };
      return g;
    }
    return (() => {
      const proxy = new Proxy(rec, {
        get(t, k) {
          if (k in t) { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
          return noop;
        },
        set(t, k, v) { t[k] = v; return true; },
      });
      rec.ctx = proxy;      // 既可直接当 ctx 用，也可 .ctx 取用
      return proxy;
    })();
  }

  /** 一段路径的包围盒。 */
  const gbox = (g) => {
    if (!g || !g.pts.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of g.pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };
  /** 若干段路径的合并包围盒（filter 同时拿到路径段与它的包围盒）。 */
  const boxOf = (rec, filter) => {
    const bs = rec.groups.map((g) => ({ g, b: gbox(g) })).filter((p) => p.b && (!filter || filter(p.g, p.b))).map((p) => p.b);
    if (!bs.length) return null;
    return {
      x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)),
      x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)),
      w: Math.max(...bs.map((b) => b.x1)) - Math.min(...bs.map((b) => b.x0)),
      h: Math.max(...bs.map((b) => b.y1)) - Math.min(...bs.map((b) => b.y0)),
      cx: (Math.min(...bs.map((b) => b.x0)) + Math.max(...bs.map((b) => b.x1))) / 2,
      cy: (Math.min(...bs.map((b) => b.y0)) + Math.max(...bs.map((b) => b.y1))) / 2,
    };
  };
  const sig = (rec) => `${rec.groups.length}:${rec.groups.reduce((n, g) => n + g.pts.length, 0)}`;
  const drawOnce = (type, color, theme = THEME) => {
    const rc = recordCtx();
    drawPiece(rc.ctx, type, color, 100, 100, 60, { theme });
    return rc;
  };

  // ① 6 种棋子都画了非空的路径（每种 = 多部件造型），且白/黑是同一套造型
  const TYPES = [[PAWN, '兵'], [ROOK, '车'], [KNIGHT, '马'], [BISHOP, '象'], [QUEEN, '后'], [KING, '王']];
  const sigs = new Set();
  for (const [tp, cn] of TYPES) {
    const w1 = drawOnce(tp, WHITE);
    const b1 = drawOnce(tp, BLACK);
    const b = boxOf(w1);
    ok(w1.groups.length >= 3, `${cn}子：画了 ${w1.groups.length} 段路径（多部件造型，非空）`);
    ok(w1.fills >= 2 && w1.strokes >= 2, `${cn}子：有填充与描边（fill ${w1.fills} / stroke ${w1.strokes}）`);
    ok(b.w > 60 * 0.35 && b.w < 60 * 0.8 && b.h > 60 * 0.8 && b.h < 60 * 1.2,
      `${cn}子：造型尺寸合理（${b.w.toFixed(1)}×${b.h.toFixed(1)}，标称 60）`);
    eq(sig(w1), sig(b1), `${cn}子：白/黑共用同一套造型路径（只有配色不同）`);
    sigs.add(sig(w1));
  }
  eq(sigs.size, 6, '6 种棋子的路径结构互不相同（部件数 + 节点数签名唯一）');

  // ② 白/黑必须靠「配色 + 描边」区分，且颜色取自主题令牌（不写死）
  const wP = drawOnce(PAWN, WHITE), bP = drawOnce(PAWN, BLACK);
  const stopsOf = (rc) => {
    const g = rc.fillStyles.find((f) => f && f.stops && f.stops.length);
    return g ? g.stops.map((s) => s[1]) : [];
  };
  const ws = stopsOf(wP), bs = stopsOf(bP);
  ok(ws.length >= 3 && bs.length >= 3, `白/黑都有多层渐变（白 ${ws.length} 层 / 黑 ${bs.length} 层）`);
  ok(ws.join() !== bs.join(), `白黑渐变配色不同（白 ${ws[0]} → 黑 ${bs[0]}）`);
  ok(ws.includes(THEME.stoneWhiteHi), `白子高光取主题令牌 stoneWhiteHi（${THEME.stoneWhiteHi}）`);
  ok(bs.includes(THEME.stoneBlackLo), `黑子暗部取主题令牌 stoneBlackLo（${THEME.stoneBlackLo}）`);
  const wStroke = wP.strokeStyles[0], bStroke = bP.strokeStyles[0];
  ok(wStroke === THEME.boardEdge && bStroke === THEME.stoneWhiteLo,
    `描边也不同且取自主题（白 ${wStroke} / 黑 ${bStroke}）`);
  const custom = drawOnce(PAWN, WHITE, { boardEdge: '#010101', stoneWhiteHi: '#020202' });
  ok(custom.strokeStyles.includes('#010101') && stopsOf(custom).includes('#020202'),
    '换一套主题令牌后描边/渐变立刻跟着变（确认没写死颜色）');

  // ③ 动画：进度只认传入的 now（规范 §8）—— 落子 / 抬起 / 被吃
  const L = computeLayout(375, 667, { top: 0, bottom: 0 });
  const cell = L.board.cell, size = cell * 0.96;
  const epSq = (x, y) => L.board.toScreen(x, y);
  const clearGrid = () => {
    const b = createBoard();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b.grid[y][x] = EMPTY;
    return b;
  };
  const mkState = (board, extra = {}) => ({
    board, selected: null, targets: [], lastMove: null, animT0: 0, animMove: null, liftT0: 0,
    hover: null, outcome: null, status: null, statusText: '', aiThinking: false,
    pressIndex: -1, toast: null, levelName: '', ...extra,
  });
  const frame = (st, t) => { const rc = recordCtx(); drawPieces(rc.ctx, L, st, THEME, t); return rc; };
  // 「实体棋子本体」：alpha > 0.9（底面阴影/被吃子/落定涟漪都是半透明，用透明度筛掉）
  const bodyBox = (rc) => boxOf(rc, (g) => g.alpha > 0.9);
  const shadowBox = (rc) => gbox(rc.groups[0]);          // 单子局面：第一段路径就是底面投影
  const ghostBox = (rc) => boxOf(rc, (g) => g.alpha < 0.99 && g.alpha > 0.05);
  const ghostAlpha = (rc) => {
    const a = rc.groups.filter((g) => g.alpha < 0.99 && g.alpha > 0.05).map((g) => g.alpha);
    return a.length ? Math.max(...a) : 0;
  };

  // ③-a 落下：从抬起高度缓动落回 + 落定压扁回弹
  const bd1 = clearGrid();
  bd1.grid[4][4] = mkPiece(PAWN, WHITE);                  // e4 上有一颗白兵
  const stDrop = mkState(bd1, { animT0: 1e6, animMove: { fx: 4, fy: 6, tx: 4, ty: 4, capture: 0, flag: 'double' } });
  const D0 = frame(stDrop, 1e6), D1 = frame(stDrop, 1e6 + 130), D2 = frame(stDrop, 1e6 + 240), D3 = frame(stDrop, 1e6 + 400);
  const d0 = bodyBox(D0), d1 = bodyBox(D1), d2 = bodyBox(D2), d3 = bodyBox(D3);
  ok(d0 && d1 && d3, '落子动画帧里画出了棋子本体');
  ok(d0.y0 < d1.y0 && d1.y0 < d3.y0,
    `落子动画中棋子逐帧下落（顶边 ${d0.y0.toFixed(1)} → ${d1.y0.toFixed(1)} → ${d3.y0.toFixed(1)}px）`);
  const dropH = d3.y0 - d0.y0;
  ok(Math.abs(dropH - size * 0.17) < size * 0.05,
    `落点起始高度 ≈ 0.17×棋子尺寸（实测 ${dropH.toFixed(2)}px / 期望 ${(size * 0.17).toFixed(2)}px）`);
  ok(Math.abs(d0.cx - epSq(4, 4).x) < 0.6 && Math.abs(d3.cx - epSq(4, 4).x) < 0.6, '落子横向始终对准 e4 格');
  eq(Math.abs(d2.y1 - d3.y1) < 0.6, true, '落定回弹以底面为支点（压扁时底边不动）');
  ok(d2.h < d3.h, `落定压扁（回弹帧高度 ${d2.h.toFixed(1)} < 静止 ${d3.h.toFixed(1)}）`);
  eq(sig(frame(stDrop, 1e6 + 400)), sig(frame(stDrop, 1e6 + 900)), true, '动画结束后进入静止帧（不再重复动画）');
  const sh0 = shadowBox(D0), sh3 = shadowBox(D3);
  eq(Math.abs(sh0.cy - sh3.cy) < 0.01, true, '底面阴影钉在格子上（不随棋子抬升上移）');
  ok(sh0.w > sh3.w * 1.02, `越抬高阴影越大（${sh0.w.toFixed(1)} → ${sh3.w.toFixed(1)}px）`);
  eq(sig(frame(stDrop, 1e6 + 130)), sig(frame(stDrop, 1e6 + 130)), true, '同一 now 渲染两帧结果完全一致（无隐藏时钟）');

  // ③-b 抬起：点选己方棋子 → 上浮 + 阴影加大
  const liftBd = clearGrid();
  liftBd.grid[4][4] = mkPiece(QUEEN, WHITE);
  const stLift = mkState(liftBd, { selected: { x: 4, y: 4 }, liftT0: 2e6 });
  const l0 = bodyBox(frame(stLift, 2e6)), l1 = bodyBox(frame(stLift, 2e6 + 400));
  ok(l1.y0 < l0.y0, `点选棋子后抬起（顶边 ${l0.y0.toFixed(1)} → ${l1.y0.toFixed(1)}px）`);
  ok(Math.abs((l0.y0 - l1.y0) - size * 0.17) < size * 0.06, '抬起高度 ≈ 0.17×棋子尺寸（easeOutBack 带一点过冲）');
  eq(Math.abs(l1.cx - l0.cx) < 0.01, true, '抬起只在纵向（横向不漂）');
  ok(shadowBox(frame(stLift, 2e6 + 400)).w > shadowBox(frame(stLift, 2e6)).w, '抬起后底面阴影同步加大');
  eq(bodyBox(frame(mkState(liftBd), 2e6)).y0, l0.y0, '没选中（liftT0=0）时棋子不下沉也不上浮');

  // ③-c 吃子：被吃子在原格淡出 + 缩小
  const capBd = clearGrid();
  capBd.grid[3][3] = mkPiece(PAWN, WHITE);                // 白兵已吃到 d5
  const stCap = mkState(capBd, {
    animT0: 3e6, animMove: { fx: 4, fy: 4, tx: 3, ty: 3, capture: mkPiece(PAWN, BLACK), flag: '' },
  });
  const C1 = frame(stCap, 3e6 + 40), C2 = frame(stCap, 3e6 + 190);
  const cb1 = ghostBox(C1), cb2 = ghostBox(C2);
  ok(cb1 && cb2, '被吃子确实被画出来了（半透明那一组路径）');
  ok(cb2.w < cb1.w, `被吃子随时间缩小（${cb1.w.toFixed(1)} → ${cb2.w.toFixed(1)}px）`);
  ok(ghostAlpha(C2) < ghostAlpha(C1), `被吃子随时间变淡（alpha ${ghostAlpha(C1).toFixed(2)} → ${ghostAlpha(C2).toFixed(2)}）`);
  const d5 = epSq(3, 3);
  ok(Math.abs(cb1.cx - d5.x) < 1 && cb1.cy > d5.y - size * 0.3 && cb1.cy < d5.y + size * 0.4, '被吃子画在它原来那一格（d5）');
  eq(bodyBox(frame(mkState(capBd), 3e6)).w, bodyBox(frame(stCap, 3e6 + 400)).w, true, '动画结束后被吃子不再出现');

  // ③-d 吃过路兵：被吃的兵在 (tx, fy)，不是终点格
  const epBd = clearGrid();
  epBd.grid[3][2] = mkPiece(PAWN, WHITE);                 // 白兵吃过路兵后落在 d6
  const stEp = mkState(epBd, {
    animT0: 4e6, animMove: { fx: 4, fy: 3, tx: 3, ty: 2, capture: mkPiece(PAWN, BLACK), flag: 'ep' },
  });
  const eb = ghostBox(frame(stEp, 4e6 + 40));
  ok(Math.abs(eb.cy - epSq(3, 3).y) < cell * 0.35,
    `吃过路兵：被吃兵画在 d5（与自己起点同一横线），实测 cy=${eb.cy.toFixed(1)} / d5=${epSq(3, 3).y.toFixed(1)}`);
  ok(Math.abs(eb.cy - epSq(3, 2).y) > cell * 0.5, '吃过路兵：被吃兵不在终点格 d6');

  // ④ 变换栈平衡 / 裁剪不泄漏 / 无整屏铺底（规范 §10 §11）
  const rc = recordCtx(375, 667);
  const sess = createSession({ width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'lv2' });
  const lay2 = computeLayout(375, 667, { top: 44, bottom: 34 });
  let renderErr = null;
  try {
    sess.render(rc.ctx, 1000);                                                          // 开局 32 子
    sess.tap(lay2.board.toScreen(4, 6).x, lay2.board.toScreen(4, 6).y, 2000);           // 选中 e2
    sess.render(rc.ctx, 2050);                                                          // 抬起中
    sess.render(rc.ctx, 2400);                                                          // 抬起完成
    sess.tap(lay2.board.toScreen(4, 4).x, lay2.board.toScreen(4, 4).y, 3000);           // 落 e4
    sess.render(rc.ctx, 3080);                                                          // 落下中
    sess.render(rc.ctx, 3300);                                                          // 落定回弹
    sess.update(99999);
    sess.render(rc.ctx, 100000);                                                        // AI 落子后
    sess.tap(lay2.buttons[2].x + 10, lay2.buttons[2].y + 10, 100001);                   // 认输
    sess.render(rc.ctx, 100100);                                                        // 结算态
  } catch (e) { renderErr = e; }
  eq(renderErr, null, '记录型 ctx 下多帧渲染（选中/落下/落定/结算）不抛异常', renderErr ? String(renderErr) : '');
  eq(rc.saves === rc.restores && rc.saves > 0, true, `save/restore 严格配对（${rc.saves}/${rc.restores}，规范 §11）`);
  eq(rc.clipOutsideSave, 0, 'clip() 一律包在 save 内（高光裁剪不会泄漏到后续棋子）');
  ok(rc.strokes >= 32 * 4, `32 颗棋子的路径都画了（累计 stroke ${rc.strokes} 次）`);
  const full = rc.fillRects.filter((r) => r.w >= 375 * 0.9 && r.h >= 667 * 0.9);
  eq(full.length, 0, `无整屏铺底（${rc.fillRects.length} 处 fillRect 全部小于 90% 屏幅）`);
  eq(rc.clearRects, 0, '渲染层从不调用 clearRect（清屏是集成层职责，规范 §10）');

  // ⑤ 时间源：动画只认传入的 now，模块自己不许读钟（规范 §8）
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/gm, '$1');
  const srcOf = (f) => stripComments(readFileSync(new URL(f, import.meta.url), 'utf8'));
  ok(!/performance\s*\.\s*now/.test(srcOf('./render.js')) && !/Date\s*\.\s*now/.test(srcOf('./render.js')),
    'render.js 不读任何时钟（动画进度全部来自传入的 now）');
  ok(!/performance\s*\.\s*now/.test(srcOf('./index.js')), 'index.js 不用 performance.now()（与集成层 Date.now 同源）');
}

console.log('\n【十一】音效注入（options.sfx 可缺省，必须静默降级）');
{
  const L11 = computeLayout(375, 667, { top: 0, bottom: 0 });
  const at = (x, y) => L11.board.toScreen(x, y);
  const calls = [];
  const s = createSession({
    width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'lv2',
    sfx: { play: (n) => { calls.push(n); return true; } },
  });
  s.tap(at(4, 6).x, at(4, 6).y, 1000);                       // 选中 e2 兵（开始抬高）
  eq(calls.join(','), 'select', '选中棋子（开始抬高）时播 select');
  s.tap(at(4, 4).x, at(4, 4).y, 2000);                       // 落 e4
  eq(calls[calls.length - 1], 'tap', '普通落子播 tap');
  s.update(99999);                                           // AI 应答
  ok(calls.filter((c) => c === 'tap' || c === 'capture').length >= 2, 'AI 落子同样出声（tap / capture）');

  const calls2 = [];
  const s2 = createSession({
    width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'lv2',
    sfx: { play: (n) => calls2.push(n) },
  });
  s2.state.board = fromFEN('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  s2.tap(at(4, 4).x, at(4, 4).y, 3000);                      // 选中 e4 兵
  s2.tap(at(3, 3).x, at(3, 3).y, 4000);                      // 吃 d5 的黑兵
  eq(calls2.join(','), 'select,capture', '吃子播 capture（不是 tap）');

  let sfxErr = null;
  try {
    const s3 = createSession({ width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'lv2' });  // 不给 sfx
    s3.tap(at(4, 6).x, at(4, 6).y, 0); s3.tap(at(4, 4).x, at(4, 4).y, 0);
    const s4 = createSession({ width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'lv2', sfx: { play() { throw new Error('boom'); } } });
    s4.tap(at(4, 6).x, at(4, 6).y, 0); s4.tap(at(4, 4).x, at(4, 4).y, 0);
    const s5 = createSession({ width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'lv2', sfx: {} });  // 没有 play 方法
    s5.tap(at(4, 6).x, at(4, 6).y, 0); s5.tap(at(4, 4).x, at(4, 4).y, 0);
  } catch (e) { sfxErr = e; }
  eq(sfxErr, null, 'sfx 缺省 / 无 play 方法 / play 抛异常，三种情况都静默降级不抛异常', sfxErr ? String(sfxErr) : '');
}

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) {
  console.log('失败清单：');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail === 0 ? 0 : 1);
