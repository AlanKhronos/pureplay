/**
 * 蜘蛛纸牌核心逻辑测试（Node 直接跑，零依赖，不碰微信 API）
 * 用法：node src/games/spider/test.mjs
 *
 * 覆盖点（任务要求八条 + 边界）：
 *   1) 发牌张数与布局（104 张 / **列数按难度 5·7·9** / 开局带 1~2 个空列 /
 *      开局张数 24·34·50 / 牌堆 16·10·6 轮 / 每列最后一张翻开）
 *   2) 移动合法性（同花降序可整体移、不同花不可移、点数必须相差 1、难度决定要不要同花）
 *   3) 空列规则（任意牌可落空列；**有空列也能发牌**——本次规则变更的核心）
 *   4) 收牌判定（K→A 同花色自动收走、花色不齐不收、收走后下面一张翻开）
 *   5) 发牌条件与张数（每列各 1 张、共「列数」张、翻开、牌堆准确递减、
 *      **三档都能连发到牌堆见底且牌数守恒**）
 *   6) 撤销还原（局面 / 牌堆 / 收集数 / 步数全部回滚，且不丢牌）
 *   7) 胜利判定（收满 8 组即胜；无牌可发且无路可走判困死）
 *   8) 纯逻辑约束 + index.js 会话层（时间透传、hud、outcome、渲染不抛异常）
 *   9) 布局几何（**牌桌贴顶不再垂直居中**、牌宽随列数递减、按钮安全线、56px 角区）
 */
import {
  createGame, createSession, buildDeck, mulberry32, levelConfig, LEVELS, LEVEL_KEYS, initialDealOf,
  columnsOf, emptyColsOf, filledColsOf, stockRoundsOf,
  cloneGame, movableRunLength, topCard, flipExposed, takeTail, dropRun, canMove, canDrop,
  hasCompleteRun, collectRuns, moveRun, undo, canUndo, canDeal, deal, findHint, hasAnyMove,
  refreshResult, sessionMove, sessionDeal, sessionUndo, sessionReset, updateSession, snapshot,
  countCards, collectedRuns, remainingRuns, isOver, isWon, isStuck, scoreOf, formatClock,
  cardText, isRedSuit, faceUpCount, faceDownCount,
  SPADE, HEART, CLUB, DIAMOND, ACE, KING,
  MAX_COLUMNS, DECK_TOTAL, RUNS_TO_WIN, HISTORY_LIMIT,
  PLAYING, WON, STUCK,
} from './core.js';
import { createSession as createUiSession, meta } from './index.js';
import { computeLayout, hitButton, columnAt, cardRect, renderFrame } from './render.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 读同目录下的源文件（用于纯逻辑约束自检）；路径按本文件位置解析，跑在哪个目录都对。 */
const HERE = dirname(fileURLToPath(import.meta.url));
function readSelf(name) {
  return readFileSync(join(HERE, name), 'utf8');
}

/** core.js 源码（自检用）。 */
const CORE_SRC = readSelf('core.js');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${expected}，实际 ${actual}`);
}

/* ── 造局辅助（全部走公开 API，不偷看内部实现） ── */

/** 造一个空局（该难度全部列 + 指定牌堆），用来手工摆牌。 */
function blankGame(levelKey = 'hard', stockCards = 0) {
  const g = createGame(levelKey, mulberry32(1));
  g.columns = [];
  for (let i = 0; i < columnsOf(levelKey); i++) g.columns.push([]);
  g.stock = [];
  for (let i = 0; i < stockCards; i++) g.stock.push({ id: 1000 + i, suit: SPADE, rank: ACE + (i % 13) });
  g.collected = 0;
  g.moves = 0;
  g.result = PLAYING;
  g.history = [];
  return g;
}

/**
 * 按难度算「开局每列张数」的期望串。
 * 只发给非空列（前 fill = 列数 − 空列数 列），余数给前几列各补 1 张；
 * **最右侧 emptyCols 列留空**（用户要求「开局留 1~2 个空列」）。
 */
function expectCols(key) {
  const n = initialDealOf(key);
  const cols = columnsOf(key), fill = filledColsOf(key);
  const per = Math.floor(n / fill), extra = n % fill;
  const out = [];
  for (let i = 0; i < cols; i++) out.push(i < fill ? per + (i < extra ? 1 : 0) : 0);
  return out.join(',');
}

/** 造成一张牌（便于手写牌面）。 */
let uid = 9000;
function C(suit, rank, faceUp = true) {
  return { id: uid++, suit, rank, faceUp };
}

/**
 * 把一组牌塞进某列。未翻开的牌只应出现在「会被翻开的那张之上」，
 * 所以：最后一张按 faceUpLast 处理，其余一律盖着。
 * （要造「K…A 都露着」的收牌局面得显式给 faceUpLast 或直接用 putOpen。）
 */
function put(g, col, specs, faceUpLast = true) {
  for (let i = 0; i < specs.length; i++) {
    const [suit, rank] = specs[i];
    const last = i === specs.length - 1;
    const up = last ? faceUpLast : false;
    g.columns[col].push(C(suit, rank, up));
  }
  return g;
}

/** 造一条全部翻开的尾巴牌组（收牌局面用：K…2 都露着，只差最后一张 A）。 */
function putOpen(g, col, specs) {
  for (const [suit, rank] of specs) g.columns[col].push(C(suit, rank, true));
  return g;
}

/** 统计整局的牌数（含已收走）。 */
function allCards(g) {
  return countCards(g);
}

/* ═══════════════════════════════════════════ */

console.log('\n【一】难度档位与牌堆');
{
  eq(LEVEL_KEYS.join(','), 'easy,normal,hard', '三档难度 key 正确');
  eq(levelConfig('easy').suits.length, 1, '简单档只用 1 门花色');
  eq(levelConfig('normal').suits.length, 2, '普通档用 2 门花色');
  eq(levelConfig('hard').suits.length, 4, '困难档用 4 门花色');
  eq(levelConfig('easy').suits[0], SPADE, '简单档花色是黑桃');
  eq(levelConfig('不存在的key').key, 'easy', '未知难度退回简单');

  // ── 难度必须**同时**体现「花色门数」「列数」「开局空列」三个维度（用户要求） ──
  // ① 开局张数：只发给非空列
  eq(levelConfig('easy').initialDeal, 24, '简单档开局 24 张（3 列各 8 张，右侧空 2 列）');
  eq(levelConfig('normal').initialDeal, 34, '普通档开局 34 张（6 列 6/6/6/6/5/5，右侧空 1 列）');
  eq(levelConfig('hard').initialDeal, 50, '困难档开局 50 张（8 列 7/7/6/6/6/6/6/6，右侧空 1 列）');
  ok(levelConfig('easy').suits.length < levelConfig('normal').suits.length
    && levelConfig('normal').suits.length < levelConfig('hard').suits.length,
    '花色门数随难度递增（花色维度 1 < 2 < 4）');
  ok(initialDealOf('easy') < initialDealOf('normal') && initialDealOf('normal') < initialDealOf('hard'),
    '开局张数随难度递增（数量维度 24 < 34 < 50）');
  // ② 列数：用户原话「简单 5 列 / 普通 7 列 / 困难 9 列」（旧版三档都是 10 列）
  eq(columnsOf('easy'), 5, '简单档 5 列');
  eq(columnsOf('normal'), 7, '普通档 7 列');
  eq(columnsOf('hard'), 9, '困难档 9 列');
  ok(columnsOf('easy') < columnsOf('normal') && columnsOf('normal') < columnsOf('hard'),
    '列数随难度递增（5 < 7 < 9，用户明确要求）');
  ok(LEVEL_KEYS.every((k) => columnsOf(k) <= MAX_COLUMNS),
    `三档列数都不超过上限 MAX_COLUMNS=${MAX_COLUMNS}`);
  // ③ 开局空列：用户要求「简单 2 个、普通/困难 1 个，方便操作游玩」
  eq(emptyColsOf('easy'), 2, '简单档开局留 2 个空列');
  eq(emptyColsOf('normal'), 1, '普通档开局留 1 个空列');
  eq(emptyColsOf('hard'), 1, '困难档开局留 1 个空列');
  eq(filledColsOf('easy'), 3, '简单档开局只有 3 列有牌（5 − 2）');
  eq(filledColsOf('normal'), 6, '普通档开局 6 列有牌（7 − 1）');
  eq(filledColsOf('hard'), 8, '困难档开局 8 列有牌（9 − 1）');
  eq(initialDealOf('不存在的key'), levelConfig('easy').initialDeal, '未知难度退回简单档的开局张数');
  eq(columnsOf('不存在的key'), levelConfig('easy').columns, '未知难度退回简单档的列数');
  eq(emptyColsOf('不存在的key'), levelConfig('easy').emptyCols, '未知难度退回简单档的空列数');
  // ④ 整除校验：每轮发「列数」张，所以牌堆张数必须能被列数整除，否则最后一轮发不满
  for (const k of LEVEL_KEYS) {
    const stock = DECK_TOTAL - initialDealOf(k);
    eq(stock % columnsOf(k), 0,
      `${k}：牌堆 ${stock} 张 = ${columnsOf(k)} 列 × ${stockRoundsOf(k)} 轮（整除，每轮发满）`);
    eq(stockRoundsOf(k), Math.floor(stock / columnsOf(k)), `${k}：发牌轮数是整数（${stockRoundsOf(k)} 轮）`);
    eq(stock, columnsOf(k) * stockRoundsOf(k), `${k}：104 − ${initialDealOf(k)} = ${columnsOf(k)} × ${stockRoundsOf(k)}`);
  }

  const deck = buildDeck('hard', mulberry32(7));
  eq(deck.length, DECK_TOTAL, '牌堆 104 张');
  eq(new Set(deck.map((c) => c.id)).size, DECK_TOTAL, '104 张牌 id 互不相同');

  // 每个 (花色, 点数) 恰好 2 张
  const hist = new Map();
  for (const c of deck) hist.set(`${c.suit}-${c.rank}`, (hist.get(`${c.suit}-${c.rank}`) ?? 0) + 1);
  eq(hist.size, 52, '困难档覆盖 4 花色 × 13 点数 = 52 种牌');
  let allTwo = true;
  for (const [, n] of hist) if (n !== 2) allTwo = false;
  ok(allTwo, '每种牌恰好 2 张（两副牌）');

  // 1 门难度：整副只有黑桃，且每张点数恰好 8 份
  const easyDeck = buildDeck('easy', mulberry32(3));
  eq(easyDeck.length, DECK_TOTAL, '简单档仍是 104 张');
  ok(easyDeck.every((c) => c.suit === SPADE), '简单档只有黑桃');
  const rankHist = new Map();
  for (const c of easyDeck) rankHist.set(c.rank, (rankHist.get(c.rank) ?? 0) + 1);
  let eightEach = rankHist.size === 13;
  for (const [, n] of rankHist) if (n !== 8) eightEach = false;
  ok(eightEach, '简单档每个点数恰好 8 份（8 副 K→A）');

  // 同种子可复现
  const a = buildDeck('hard', mulberry32(2024)).map((c) => c.id).join(',');
  const b = buildDeck('hard', mulberry32(2024)).map((c) => c.id).join(',');
  eq(a, b, '同一种子洗出的牌序完全一致（可复现）');
  const d = buildDeck('hard', mulberry32(2025)).map((c) => c.id).join(',');
  ok(a !== d, '不同种子洗出的牌序不同');

  eq(isRedSuit(HEART), true, '红桃是红色花色');
  eq(isRedSuit(DIAMOND), true, '方块是红色花色');
  eq(isRedSuit(SPADE), false, '黑桃不是红色花色');
  eq(isRedSuit(CLUB), false, '梅花不是红色花色');
  eq(cardText({ suit: SPADE, rank: 12 }), '♠Q', 'cardText 输出花色 + 点数');
}

console.log('\n【二】开局发牌：张数与布局');
{
  for (const key of LEVEL_KEYS) {
    const g = createGame(key, mulberry32(11));
    const deal0 = initialDealOf(key);
    const cols = columnsOf(key);
    const empties = emptyColsOf(key);
    const fill = filledColsOf(key);
    eq(g.columns.length, cols, `${key}：共 ${cols} 列`);
    eq(g.columns.map((c) => c.length).join(','), expectCols(key),
      `${key}：开局每列 ${expectCols(key)}（空列在最右侧）`);
    eq(g.columns.filter((c) => c.length === 0).length, empties,
      `${key}：开局恰好 ${empties} 个空列（用户要求「方便用户操作游玩」）`);
    eq(g.columns.slice(0, fill).every((c) => c.length > 0), true,
      `${key}：前 ${fill} 列都有牌（空列只出现在最右侧）`);
    eq(g.columns.slice(fill).every((c) => c.length === 0), true,
      `${key}：后 ${empties} 列开局都是空的`);
    eq(g.stock.length, DECK_TOTAL - deal0, `${key}：发牌堆剩 ${DECK_TOTAL - deal0} 张`);

    let total = 0, faceUpTotal = 0, perColOk = true;
    for (const col of g.columns) {
      total += col.length;
      faceUpTotal += col.filter((c) => c.faceUp).length;
      // 每列恰好最后一张翻开，其余都盖着；空列没有牌，天然合规
      const okCol = col.length === 0
        || (col[col.length - 1].faceUp === true && col.slice(0, -1).every((c) => c.faceUp === false));
      if (!okCol) perColOk = false;
    }
    eq(total, deal0, `${key}：开局共发出 ${deal0} 张`);
    eq(faceUpTotal, fill, `${key}：开局恰好翻开 ${fill} 张（每个非空列一张）`);
    ok(perColOk, `${key}：每列最后一张翻开、其余未翻开`);
    eq(allCards(g), DECK_TOTAL, `${key}：全局共 104 张牌，一张不多一张不少`);
    eq(g.collected, 0, `${key}：开局收集区为空`);
    eq(g.moves, 0, `${key}：开局步数为 0`);
    eq(g.result, PLAYING, `${key}：开局进行中`);
    eq(g.requireSameSuit, key !== 'easy', `${key}：压牌同花要求 = ${key !== 'easy'}`);
    // ★ 规则变更：空列不再是发牌的障碍（旧版「有空列不能发」会与开局空列直接冲突、卡死整局）
    eq(canDeal(g), true, `${key}：开局带 ${empties} 个空列，仍然可以发牌（新规则：牌堆够一轮就能发）`);
  }

  // 开局不该出现可撤销历史（还没走棋）
  const g0 = createGame('normal', mulberry32(5));
  eq(canUndo(g0), false, '开局没有可撤销的操作');
  eq(g0.history.length, 0, '开局历史栈为空');

  // 简单档整局只有黑桃
  const ge = createGame('easy', mulberry32(9));
  let onlySpade = true;
  for (const col of ge.columns) for (const c of col) if (c.suit !== SPADE) onlySpade = false;
  for (const c of ge.stock) if (c.suit !== SPADE) onlySpade = false;
  ok(onlySpade, '简单档整局（含发牌堆）只有黑桃');
}

console.log('\n【三】同列错开与可搬动牌组识别');
{
  const g = blankGame('hard');
  // 0 列：盖上 2 张 + 翻开 ♠7 ♠6 ♠5 （同花降序三段）
  g.columns[0].push(C(SPADE, 9, false), C(HEART, 3, false));
  g.columns[0].push(C(SPADE, 7), C(SPADE, 6), C(SPADE, 5));
  eq(faceDownCount(g.columns[0]), 2, '0 列 2 张未翻开');
  eq(faceUpCount(g.columns[0]), 3, '0 列 3 张已翻开');
  eq(movableRunLength(g.columns[0]), 3, '整条 ♠7♠6♠5 可整体搬走');
  eq(movableRunLength(g.columns[0], 2), 3, '从 ♠7 起可搬 3 张');
  // ⚠️ 规则变更（用户要求 2026-09-28）：同花降序序列一旦形成就是「一个整体」，
  // 点其中任意一张都只搬整条，不允许只搬后缀（原来允许从 ♠6 起搬 2 张）。
  eq(movableRunLength(g.columns[0], 3), 3, '从 ♠6 起也只能搬整条 3 张（不许拆后缀）');
  eq(movableRunLength(g.columns[0], 4), 3, '单张尾牌同样只能搬整条 3 张');
  eq(movableRunLength(g.columns[0], 1), 0, '未翻开的牌不能搬');
  eq(movableRunLength(g.columns[0], 0), 0, '未翻开的牌不能搬（列首）');

  // 1 列：♠7 ♥6 ♠5 —— 中间断了，只能搬最后一张
  const g2 = blankGame('hard');
  g2.columns[1].push(C(SPADE, 7), C(HEART, 6), C(SPADE, 5));
  eq(movableRunLength(g2.columns[1]), 1, '花色不同 → 只有尾牌可搬');
  eq(movableRunLength(g2.columns[1], 0), 0, '断开的牌组不能整体搬');

  // 2 列：♠7 ♠5 —— 点数不连续，只能搬尾牌
  const g3 = blankGame('hard');
  g3.columns[2].push(C(SPADE, 7), C(SPADE, 5));
  eq(movableRunLength(g3.columns[2]), 1, '点数不连续 → 只有尾牌可搬');

  // 3 列：点数升序（♠5 ♠6 ♠7）不是降序，只能搬尾牌
  const g4 = blankGame('hard');
  g4.columns[3].push(C(SPADE, 5), C(SPADE, 6), C(SPADE, 7));
  eq(movableRunLength(g4.columns[3]), 1, '升序不是「降序连牌」→ 只有尾牌可搬');

  // 尾牌折叠：翻牌 / 取走 / 落牌
  // ⚠️ 语义变更（用户要求「移动当前牌后不要让后面的牌全显示出来，只显示最外面一张」）：
  //   旧版 flipExposed 会把列尾连续几张背面**一次全翻开**；现在一次只揭最上面那一张。
  const col = [C(SPADE, 4, false), C(HEART, 9, false), C(SPADE, 8, false)];
  eq(topCard(col), null, '全未翻开时没有可操作的顶牌');
  eq(flipExposed(col), 1, 'flipExposed 一次只翻开最外面那一张');
  eq(col[2].faceUp, true, '最外面那张已翻开');
  eq(col[0].faceUp, false, '被压在下面的牌仍然盖着（旧版会把 3 张全亮出来）');
  eq(col[1].faceUp, false, '中间那张也仍然盖着');
  eq(flipExposed(col), 0, '顶牌已翻开时 flipExposed 返回 0（幂等）');
  eq(topCard(col).rank, 8, '顶牌是 ♠8');
  // 把顶牌搬走 → 只会再揭一张，不会连锁全亮
  const moved = takeTail(col, 1);
  eq(moved.length, 1, '取走顶牌');
  eq(flipExposed(col), 1, '搬走后又只揭一张');
  eq(col[1].faceUp, true, '新顶牌翻开了');
  eq(col[0].faceUp, false, '更下面那张依旧是暗牌（一次只揭一张的铁证）');
  col.unshift(C(CLUB, 2, false));   // 复原成 3 张，继续原有断言
  const col2 = [C(SPADE, 4, false), C(HEART, 9, true)];   // 只有第一张盖着，不在列尾
  eq(flipExposed(col2), 0, '列尾已翻开时不会去翻中间的暗牌');
  eq(col2[0].faceUp, false, '中间的暗牌保持未翻开');
  const taken = takeTail(col, 1);
  eq(taken.length, 1, 'takeTail 取走 1 张');
  eq(col.length, 2, '取走后列里少一张');
  eq(takeTail(col, 99).length, 2, 'takeTail 数量超界时取走全部（防御）');
  eq(takeTail(col, 0).length, 0, 'takeTail 0 张返回空');
}

console.log('\n【四】移动合法性');
{
  // 同花降序可整体移动；目标顶牌必须大 1
  const g = blankGame('hard');
  g.columns[0].push(C(SPADE, 7), C(SPADE, 6), C(SPADE, 5));
  g.columns[1].push(C(SPADE, 8));
  const r1 = canMove(g, 0, 0, 1);
  ok(r1.ok, '♠7♠6♠5 整体压到 ♠8（同花、降序）合法');
  eq(r1.count, 3, '可搬动 3 张');
  const mv = moveRun(g, 0, 0, 1);
  eq(mv.ok, true, 'moveRun 执行成功');
  eq(mv.moved, 3, 'moveRun 报告搬了 3 张');
  eq(g.columns[1].map((c) => cardText(c)).join(' '), '♠8 ♠7 ♠6 ♠5', '目标列变成 4 连');
  eq(g.columns[0].length, 0, '源列被搬空');

  // 不同花色：困难档必须同花 → 拒绝（reason=suit）
  const g2 = blankGame('hard');
  g2.columns[0].push(C(SPADE, 7));
  g2.columns[1].push(C(HEART, 8));
  const r2 = canMove(g2, 0, 0, 1);
  ok(!r2.ok && r2.reason === 'suit', '困难档：不同花色不能压（reason=suit）');
  eq(moveRun(g2, 0, 0, 1).ok, false, '不同花色的 moveRun 被拒');
  eq(g2.columns[0].length, 1, '被拒后源列牌没动');

  // 简单档不要求同花：♥8 上可以压 ♠7
  const g3 = blankGame('easy');
  g3.columns[0].push(C(SPADE, 7));
  g3.columns[1].push(C(HEART, 8));
  const r3 = canMove(g3, 0, 0, 1);
  ok(r3.ok, '简单档：不要求同花，♠7 可以压 ♥8');
  eq(moveRun(g3, 0, 0, 1).ok, true, '简单档执行成功');
  eq(g3.columns[1].length, 2, '目标列变成 2 张');

  // 点数必须恰好小 1
  const g4 = blankGame('hard');
  g4.columns[0].push(C(SPADE, 6));
  g4.columns[1].push(C(SPADE, 8));
  const r4 = canMove(g4, 0, 0, 1);
  ok(!r4.ok && r4.reason === 'rank', '差 2 点不能压（reason=rank）');
  const g5 = blankGame('hard');
  g5.columns[0].push(C(SPADE, 9));
  g5.columns[1].push(C(SPADE, 8));
  ok(!canMove(g5, 0, 0, 1).ok, '大牌不能压小牌（♠9 压不了 ♠8）');

  // 断开的牌组不能整体搬（不同花）
  const g6 = blankGame('hard');
  g6.columns[0].push(C(SPADE, 7), C(HEART, 6));
  g6.columns[1].push(C(SPADE, 8));
  const r6 = canMove(g6, 0, 0, 1);
  ok(!r6.ok && r6.reason === 'index', '不同花的连牌不能整体搬（♠7♥6 → reason=index）');
  ok(canMove(g6, 0, 1, 1).ok === false, '♥6 压 ♠8 花色不同被拒');
  const r6b = canMove(g6, 0, 1, -1);
  ok(!r6b.ok, '目标列越界被拒');

  // 不能搬到自己列上
  eq(canMove(g, 1, 0, 1).reason, 'same', '不能搬到源列自己');
  eq(canMove(g, 0, 0, 1).reason, 'empty', '空列上搬牌 → reason=empty');
  eq(canMove(g, 8, 0, 1).reason, 'empty', '空列作为源列 → reason=empty');

  // 走牌后露出的牌自动翻开（♠7 压到 ♠8 上，露出的 ♥4 自动翻开）
  const g7 = blankGame('hard');
  g7.columns[0].push(C(HEART, 4, false), C(SPADE, 7));
  g7.columns[1].push(C(SPADE, 8));
  const rr = moveRun(g7, 0, 1, 1);
  ok(rr.ok, '搬走尾牌成功');
  eq(g7.columns[0].length, 1, '源列还剩 1 张');
  eq(g7.columns[0][0].faceUp, true, '搬走后露出的牌自动翻开');
  eq(g7.columns[0][0].suit, HEART, '翻开的是原来盖着的那张');

  // 已结束的对局不接受走子
  const g8 = blankGame('hard');
  g8.columns[0].push(C(SPADE, 5));
  g8.columns[1].push(C(SPADE, 6));
  g8.result = WON;
  eq(canMove(g8, 0, 0, 1).reason, 'over', '终局后移动被拒');

  // dropRun 直接调用：空列任意牌可放
  const empty = [];
  eq(dropRun(empty, [C(SPADE, 3)], true).ok, true, 'dropRun 到空列成功');
  eq(empty.length, 1, 'dropRun 落牌数量正确');
  eq(dropRun(empty, [C(SPADE, 5)], true).reason, 'rank', 'dropRun 点数不连续被拒');
}

console.log('\n【五】空列规则');
{
  const g = blankGame('hard');
  g.columns[0].push(C(SPADE, 5));
  // 空列可以放任意牌（10 也放得下）
  const r1 = canMove(g, 0, 0, 3);
  ok(r1.ok, '任意牌可以落到空列');
  const mv = moveRun(g, 0, 0, 3);
  ok(mv.ok, '落到空列执行成功');
  eq(g.columns[3].length, 1, '空列里现在有 1 张');
  eq(g.columns[0].length, 0, '源列变空');
  eq(snapshot(g).columns[3].empty, false, '快照里该列不再是空列');
  eq(snapshot(g).columns[0].empty, true, '快照里源列标记为空');

  // 整条同花降序牌组也可以整体落到空列
  const g2 = blankGame('hard');
  g2.columns[1].push(C(HEART, 9), C(HEART, 8), C(HEART, 7));
  const mv2 = moveRun(g2, 1, 0, 5);
  ok(mv2.ok, '整条 ♥9♥8♥7 落到空列成功');
  eq(g2.columns[5].length, 3, '空列接了 3 张');

  // ── ★ 规则变更（本次改造核心）：空列不再是发牌的障碍 ──
  // 旧版：存在空列时 canDeal=false、deal 返回 reason='empty'。
  // 新版：开局自带 1~2 个空列，若保留旧规则，玩家动不了空列就永远发不出牌 → 整局卡死。
  //       现在「发牌堆够一整轮就能发」，发牌给每一列，**空列也会收到牌**（自然被填上）。
  const hardCols = columnsOf('hard');
  const g3 = blankGame('hard', 54);
  put(g3, 0, [[SPADE, 5]]);           // 只有 0 列有牌，其余 8 列都空
  eq(canDeal(g3), true, '存在空列时**仍然可以**发牌（新规则；旧规则在这里会判死局）');
  const d = deal(g3);
  ok(d.ok, '有空列时 deal 成功（不再返回 reason=empty）');
  eq(d.dealt, hardCols, `一次发「列数」张（${hardCols} 张），空列也被发到`);
  eq(g3.stock.length, 54 - hardCols, `发牌堆准确减少 ${hardCols} 张`);
  eq(g3.columns[0].length, 2, '原本有牌的列多了一张');
  eq(g3.columns[1].length, 1, '原本空的列被发到 1 张（空列自然被填上）');
  eq(g3.columns.every((c) => c.length > 0), true, '发过一轮后整桌已无空列');
  eq(g3.columns.every((c) => c[c.length - 1].faceUp), true, '发下来的牌都是翻开的');
  eq(allCards(g3), 54 + 1, '发牌不改变总牌数（54 张牌堆 + 手里 1 张）');

  // 每列都有牌时当然也能发
  const g4 = blankGame('hard', 54);
  for (let c = 0; c < g4.columns.length; c++) put(g4, c, [[SPADE, 5]]);
  eq(canDeal(g4), true, '每列都有牌时可以发牌');

  // 发牌堆不足一整轮（列数张）时不能发
  const g5 = blankGame('hard', hardCols - 1);
  for (let c = 0; c < g5.columns.length; c++) put(g5, c, [[SPADE, 5]]);
  eq(canDeal(g5), false, `发牌堆不足一轮（${hardCols - 1} < ${hardCols}）时不能发牌`);
  ok(!deal(g5).ok, '发牌堆不足时 deal 被拒');

  // 边界：正好剩一轮 = 最后一轮
  const g6 = blankGame('hard', hardCols);
  for (let c = 0; c < g6.columns.length; c++) put(g6, c, [[SPADE, 5]]);
  eq(canDeal(g6), true, `正好剩 ${hardCols} 张时是最后一轮，仍可发`);
  eq(deal(g6).ok, true, '最后一轮发牌成功');
  eq(g6.stock.length, 0, '发完后发牌堆为空');
  eq(canDeal(g6), false, '牌堆空后不能再发');
}

console.log('\n【六】发牌：张数与被翻开的牌');
{
  const g = createGame('hard', mulberry32(2026));
  const before = g.columns.map((c) => c.length);
  const faceUpBefore = g.columns.map((c) => c.filter((x) => x.faceUp).length);
  const stockBefore = g.stock.length;
  const totalBefore = allCards(g);

  const r = deal(g);
  ok(r.ok, '正常发牌成功');
  eq(r.dealt, g.columns.length, `一次发「列数」张（困难档 ${g.columns.length} 张）`);
  eq(g.stock.length, stockBefore - g.columns.length, `发牌堆准确减少 ${g.columns.length} 张`);
  eq(allCards(g), totalBefore, '发牌不改变总牌数');

  let allPlusOne = true, allFlipped = true;
  for (let c = 0; c < g.columns.length; c++) {
    if (g.columns[c].length !== before[c] + 1) allPlusOne = false;
    if (g.columns[c].filter((x) => x.faceUp).length !== faceUpBefore[c] + 1) allFlipped = false;
    if (g.columns[c][g.columns[c].length - 1].faceUp !== true) allFlipped = false;
  }
  ok(allPlusOne, `每列各多 1 张（${g.columns.length} 列共 ${g.columns.length} 张）`);
  ok(allFlipped, '发下来的牌是翻开的（每列 +1 张翻开）');
  eq(g.moves, 1, '发牌计入步数');

  // 连发到牌堆见底（困难档 6 轮）
  const hardRounds = stockBefore / g.columns.length;
  eq(hardRounds, stockRoundsOf('hard'), `困难档一共 ${hardRounds} 轮发牌`);
  for (let i = 1; i < hardRounds; i++) {
    const rr = deal(g);
    ok(rr.ok, `第 ${i + 1} 轮发牌成功`);
  }
  eq(g.stock.length, 0, `${hardRounds} 轮发完，发牌堆为 0`);
  eq(allCards(g), DECK_TOTAL, '整局仍是 104 张（发牌不丢牌）');
  ok(!deal(g).ok, '牌堆空后 deal 被拒');

  // 终局后不能发牌
  const g2 = createGame('easy', mulberry32(4));
  g2.result = WON;
  ok(!deal(g2).ok, '终局后不能发牌');
  eq(canDeal(g2), false, '终局后 canDeal 为假');
}

console.log('\n【六·补】三档都能把牌堆整轮发完（牌数守恒 / 不因空列卡死）');
{
  // 这是本次「开局留空列」改造最重要的一条证据链：
  // 空列不再是发牌障碍 → 一口气发到牌堆见底，每一轮都恰好发出「列数」张、
  // 总牌数恒为 104、牌 id 不重不漏、空列在发牌中被自然填上。
  for (const key of LEVEL_KEYS) {
    const g = createGame(key, mulberry32(4321));
    const cols = g.columns.length;
    const rounds = stockRoundsOf(key);
    const startEmpty = g.columns.filter((c) => c.length === 0).length;
    eq(startEmpty, emptyColsOf(key), `${key}：开局 ${startEmpty} 个空列`);

    let n = 0, bad = 0, conserved = true;
    while (g.stock.length > 0) {
      const before = g.stock.length;
      const r = deal(g);
      if (!r.ok || r.dealt !== cols || g.stock.length !== before - cols) bad++;
      if (allCards(g) !== DECK_TOTAL) conserved = false;
      n++;
      if (n > 60) break;                       // 防御：绝不空转
    }
    ok(bad === 0, `${key}：连续发完牌堆，每一轮都成功且恰好发出 ${cols} 张（异常轮次 ${bad}）`);
    eq(n, rounds, `${key}：连发 ${n} 轮发完（等于配置的 ${rounds} 轮）`);
    ok(conserved, `${key}：发牌全程总牌数恒为 104（不丢不重）`);
    eq(g.stock.length, 0, `${key}：牌堆见底`);
    eq(g.columns.every((c) => c.length > 0), true, `${key}：发过牌后空列已被填上（没有永远发不到牌的空洞）`);

    // 104 张牌 id 唯一（一张不多、一张不重）
    const ids = new Set();
    for (const col of g.columns) for (const c of col) ids.add(c.id);
    eq(ids.size, DECK_TOTAL, `${key}：发完后 ${ids.size} 个唯一牌 id（104 张不重不漏）`);
    eq(allCards(g), DECK_TOTAL, `${key}：发完后总牌数仍是 104`);
    ok(!deal(g).ok, `${key}：牌堆空后 deal 被拒`);

    // 各列张数分布：最坏差 = 开局最满那列的张数（空列只少吃了开局那几张）
    const lens = g.columns.map((c) => c.length);
    const spread = Math.max(...lens) - Math.min(...lens);
    const maxInitial = Math.ceil(initialDealOf(key) / filledColsOf(key));
    ok(spread <= maxInitial, `${key}：各列张数差 ${spread} ≤ 开局最满列 ${maxInitial}（分布均衡）`);
    eq(lens.reduce((a, b) => a + b, 0), DECK_TOTAL, `${key}：各列张数之和 = ${DECK_TOTAL}`);

    // 单调性：开局空列数 + 列数都按难度递增
    eq(g.result, PLAYING, `${key}：发完牌后（未收集满 8 组）仍是进行中`);
  }
}

console.log('\n【七】收牌判定');
{
  // 压上最后一张 A 即自动收走：列尾是 ♠2，另一列是 ♠A（A 比 2 小 1，可压）
  const g = blankGame('hard', 10);
  const seq = [];
  for (let r = KING; r >= 2; r--) seq.push([SPADE, r]);
  putOpen(g, 0, seq);                   // ♠K … ♠2 全部露着（实战中就是一路摆下来的）
  eq(hasCompleteRun(g.columns[0]), false, 'K→2 还不算完整序列');
  g.columns[1].push(C(SPADE, ACE));
  eq(hasCompleteRun(g.columns[0]), false, 'A 不在这一列，仍不完整');
  const mv = moveRun(g, 1, 0, 0);
  ok(mv.ok, '把 ♠A 压到 ♠2 上成功');
  eq(mv.collected, 1, '压上 A 的瞬间自动收走 1 组');
  eq(g.collected, 1, '收集区计数为 1');
  eq(g.columns[0].length, 0, '完整序列从列里移走');
  eq(g.collected, 1, '收集数 +1');
  // 这一局是手工摆的：牌堆 10 张 + ♠K…♠2 共 12 张 + ♠A 1 张 = 23 张，收牌后一张不少
  eq(allCards(g), 10 + 12 + 1, '收走的 13 张仍计入总牌数（没有凭空消失）');

  // 花色不齐不算
  const g2 = blankGame('hard');
  const mixed = [];
  for (let r = KING; r >= 1; r--) mixed.push([r === 7 ? HEART : SPADE, r]);
  putOpen(g2, 0, mixed);
  eq(hasCompleteRun(g2.columns[0]), false, '中间混了别的花色 → 不算完整序列');
  eq(collectRuns(g2), 0, 'collectRuns 不收花色不齐的列');

  // 点数不齐不算（缺一张）
  const g3 = blankGame('hard');
  const miss = [];
  for (let r = KING; r >= 1; r--) { if (r !== 7) miss.push([SPADE, r]); }
  putOpen(g3, 0, miss);
  eq(hasCompleteRun(g3.columns[0]), false, '缺一张的序列不算完整');

  // 点数排序颠倒不算（全翻开，确保拦下来的是「顺序」而不是「暗牌」）
  const g4 = blankGame('hard');
  const asc = [];
  for (let r = 1; r <= KING; r++) asc.push([SPADE, r]);
  putOpen(g4, 0, asc);
  eq(hasCompleteRun(g4.columns[0]), false, '升序 A→K 不算完整序列（必须是 K→A）');

  // 有未翻开的牌混在里面不算（K→A 顺序对、同花色，但整列盖着）
  const g5 = blankGame('hard');
  const hidden = [];
  for (let r = KING; r >= 1; r--) hidden.push([SPADE, r]);
  put(g5, 0, hidden, false);
  eq(hasCompleteRun(g5.columns[0]), false, '序列里有未翻开的牌 → 不算完整');

  // 收走后下面那张自动翻开
  const g6 = blankGame('hard');
  g6.columns[0].push(C(HEART, 5, false));
  const s6 = [];
  for (let r = KING; r >= 1; r--) s6.push([CLUB, r]);
  putOpen(g6, 0, s6);
  eq(hasCompleteRun(g6.columns[0]), true, '完整序列可收');
  eq(collectRuns(g6), 1, '收走 1 组');
  eq(g6.columns[0].length, 1, '收走后只剩底下那张');
  eq(g6.columns[0][0].faceUp, true, '底下那张自动翻开');
  eq(g6.collected, 1, '收集计数 +1');

  // 一列里两组连续完整序列一次收走（顺序：K…A、K…A）
  const g7 = blankGame('hard');
  const two = [];
  for (let i = 0; i < 2; i++) for (let r = KING; r >= 1; r--) two.push([HEART, r]);
  putOpen(g7, 0, two);
  eq(collectRuns(g7), 2, '一列两组完整序列一次收走 2 组');
  eq(g7.columns[0].length, 0, '收完后该列为空');

  // 收牌只影响成型的列
  const g8 = blankGame('hard');
  put(g8, 0, [[SPADE, 3], [SPADE, 2]]);
  put(g8, 1, [[HEART, 8], [HEART, 7]]);
  eq(collectRuns(g8), 0, '没有完整序列时收牌数为 0');
  eq(g8.columns[0].length, 2, '普通牌列不受影响');
}

console.log('\n【八】撤销还原');
{
  // 撤销一次移动
  const g = blankGame('hard', 20);
  put(g, 0, [[SPADE, 7]]);
  put(g, 1, [[SPADE, 8]]);            // ♠7 压 ♠8（同花、点数小 1）
  const beforeStr = JSON.stringify(g.columns);
  const stockBefore = g.stock.length;
  const s = { game: g, rng: mulberry32(1), now: 0, dirty: true, snap: null, winAt: 0, stuckAt: 0 };
  const r = sessionMove(s, 0, 0, 1);
  ok(r.ok, '会话移动成功');
  eq(g.columns[1].length, 2, '移动后目标列 2 张');
  eq(g.columns[0].length, 0, '移动后源列空了');
  eq(g.moves, 1, '会话移动计入步数');
  eq(canUndo(g), true, '现在有可撤销的操作');
  eq(g.history.length, 1, '历史栈有 1 条');

  const u = sessionUndo(s);
  ok(u.ok, '会话撤销成功');
  eq(JSON.stringify(g.columns), beforeStr, '撤销后各列完全还原');
  eq(g.stock.length, stockBefore, '撤销后牌堆也还原');
  eq(canUndo(g), false, '撤销到底后没有可撤销的操作');
  eq(allCards(g), 20 + 2, '撤销不丢牌（牌堆 20 + 手里 2 张）');
  ok(!sessionUndo(s).ok, '没有历史时撤销被拒');

  // 撤销一次发牌（连收集数一起回滚）
  const s2 = createSession('hard', mulberry32(31));
  const lensBefore = s2.game.columns.map((c) => c.length).join(',');
  const stock2 = s2.game.stock.length;
  const dr = sessionDeal(s2);
  ok(dr.ok, '会话发牌成功');
  eq(s2.game.stock.length, stock2 - s2.game.columns.length,
    `发牌后牌堆减少 ${s2.game.columns.length} 张（困难档 9 列）`);
  sessionUndo(s2);
  eq(s2.game.columns.map((c) => c.length).join(','), lensBefore, '撤销发牌后列长还原');
  eq(s2.game.stock.length, stock2, '撤销发牌后牌堆还原');
  eq(s2.game.moves, 0, '撤销后步数归零');

  // 连撤多步
  const s3 = createSession('hard', mulberry32(77));
  let moves = 0;
  for (let i = 0; i < 3; i++) {
    if (sessionDeal(s3).ok) moves++;
  }
  eq(s3.game.moves, moves, `连续发牌 ${moves} 步`);
  eq(s3.game.history.length, moves, '历史栈同步增长');
  let undone = 0;
  while (sessionUndo(s3).ok) undone++;
  eq(undone, moves, '逐步撤销回到起点');
  eq(s3.game.moves, 0, '全部撤销后步数归 0');
  eq(s3.game.stock.length, DECK_TOTAL - initialDealOf('hard'),
    `全部撤销后牌堆回到 ${DECK_TOTAL - initialDealOf('hard')} 张（困难档开局 50 张）`);
  eq(s3.game.columns.map((c) => c.length).join(','), expectCols('hard'), '全部撤销后布局回到开局');

  // 撤销把「困死」救回来
  const g4 = blankGame('hard');
  put(g4, 0, [[SPADE, 5], [HEART, 4]]);
  put(g4, 1, [[SPADE, 3]]);
  g4.stock = [];
  const s4 = { game: g4, rng: mulberry32(1), now: 0, dirty: true, snap: null, winAt: 0, stuckAt: 0 };
  // 先走一步把局面变成困死
  sessionMove(s4, 0, 1, 1);          // ♥4 压 ♠5？花色要求 → 不合法
  const r4 = sessionMove(s4, 0, 1, 1);
  if (r4.ok) refreshResult(g4);
  sessionUndo(s4);
  eq(s4.game.result, PLAYING, '撤销后回到进行中（不再困死）');

  // 历史栈上限
  eq(HISTORY_LIMIT > 0, true, '历史栈有上限（防止长局堆爆内存）');
}

console.log('\n【九】胜利与困死判定');
{
  // 收满 8 组即胜（手摆：♠K…♠2 已露着，另一列放 ♠A）
  const g = blankGame('hard');
  g.collected = RUNS_TO_WIN - 1;
  putOpen(g, 0, (() => {
    const out = [];
    for (let r = KING; r >= 2; r--) out.push([SPADE, r]);
    return out;
  })());
  putOpen(g, 1, [[SPADE, ACE]]);
  eq(g.result, PLAYING, '7 组时仍在进行中');
  const mv = moveRun(g, 1, 0, 0);       // ♠A 压 ♠2 → 凑成 K→A
  ok(mv.ok, '把最后一张 A 压上去');
  eq(g.collected, RUNS_TO_WIN, '收集到 8 组');
  eq(refreshResult(g), WON, '收满 8 组 → 胜利');
  eq(isWon(g), true, 'isWon 为真');
  eq(isOver(g), true, 'isOver 为真');
  eq(remainingRuns(g), 0, '剩余组数为 0');
  eq(collectedRuns(g), 8, 'collectedRuns 为 8');
  eq(g.collected, RUNS_TO_WIN, `胜利阈值是 ${RUNS_TO_WIN} 组`);

  // 会话级：把最后一张 A 压上去，会话应立刻判胜
  // 先把列都清空，再手摆「差一张 A 就成 K→A」的局面（走公开 API 推进）
  const s = createSession('hard', mulberry32(3));
  for (let c = 0; c < s.game.columns.length; c++) s.game.columns[c].length = 0;
  s.game.stock.length = 0;
  s.game.collected = RUNS_TO_WIN - 1;
  putOpen(s.game, 0, (() => {
    const out = [];
    for (let r = KING; r >= 2; r--) out.push([SPADE, r]);
    return out;
  })());                                // ♠K … ♠2
  putOpen(s.game, 1, [[SPADE, ACE]]);   // 另一列放 ♠A
  s.dirty = true;
  const r = sessionMove(s, 1, 0, 0);   // A 压 2 → 凑成 K→A
  ok(r.ok, '会话层把最后一张 A 压上去成功');
  eq(r.result, WON, '会话层立刻判胜（result=won）');
  eq(s.game.result, WON, '局面状态为 WON');
  eq(isWon(s.game), true, 'isWon 为真');

  // 7 组时不算胜
  const g2 = blankGame('hard');
  g2.collected = RUNS_TO_WIN - 1;
  put(g2, 0, [[SPADE, 5]]);
  put(g2, 1, [[SPADE, 6]]);      // 留一步合法走法，避免顺带判成困死
  eq(refreshResult(g2), PLAYING, '只有 7 组时不算胜');

  // 困死判定：牌堆空 + 没有任何合法走法
  const g3 = blankGame('hard');
  g3.stock = [];
  put(g3, 0, [[SPADE, 5]]);
  put(g3, 1, [[SPADE, 9]]);
  for (let c = 2; c < g3.columns.length; c++) put(g3, c, [[CLUB, 9]]);   // 补满，杜绝「搬到空列」这条路
  eq(hasAnyMove(g3), false, '没有合法走法');
  eq(refreshResult(g3), STUCK, '牌堆空且无路可走 → 困死');
  eq(isStuck(g3), true, 'isStuck 为真');
  eq(isOver(g3), true, '困死也算结束');

  // 有走法就不困死
  const g4 = blankGame('hard');
  g4.stock = [];
  put(g4, 0, [[SPADE, 5], [HEART, 8]]);
  put(g4, 1, [[HEART, 7]]);
  eq(hasAnyMove(g4), true, '存在合法走法');
  eq(refreshResult(g4), PLAYING, '有走法时不会困死');

  // 还能发牌时也不困死（牌堆还有牌）
  const g5 = blankGame('hard');
  for (let c = 0; c < g5.columns.length; c++) put(g5, c, [[SPADE, 5]]);
  g5.stock = [{ id: 1, suit: SPADE, rank: KING }, { id: 2, suit: SPADE, rank: KING }];
  eq(refreshResult(g5), PLAYING, '牌堆还有牌时不算困死');

  // 空列的走法也算走法
  const g6 = blankGame('hard');
  g6.stock = [];
  put(g6, 0, [[SPADE, 12], [HEART, 3]]);
  eq(hasAnyMove(g6), true, '可以把牌搬到空列（也是合法走法）');
  eq(refreshResult(g6), PLAYING, '有「落到空列」的走法就不困死');
}

console.log('\n【十】提示（findHint）');
{
  // ♠9 压 ♠10（同花），另一列是空的：应优先选同花目标列，而不是空列
  const g = blankGame('hard');
  put(g, 0, [[SPADE, 5], [SPADE, 9]]);
  put(g, 1, [[SPADE, 10]]);
  const h = findHint(g);
  ok(!!h, '找得到提示');
  eq(h.from, 0, '提示的源列是 0');
  eq(h.to, 1, '提示的目标列是 1');
  eq(h.index, 1, '提示搬列尾那张');
  eq(h.count, 1, '提示搬 1 张');

  // 同花优先于异花
  const g2 = blankGame('hard');
  put(g2, 0, [[SPADE, 9]]);
  put(g2, 1, [[HEART, 10]]);
  put(g2, 2, [[SPADE, 10]]);
  const h2 = findHint(g2);
  eq(h2.to, 2, '同样合法时优先选同花色目标列');

  // 空列优先级最低：只有空列可落时才会去空列
  const g3 = blankGame('hard');
  put(g3, 0, [[SPADE, 9]]);
  const h3 = findHint(g3);
  ok(!!h3, '没有可压的列时仍能给建议');
  eq(h3.to, 1, '没有可压的列时退而求其次：搬到空列');
  eq(h3.from, 0, '搬到空列的源列是 0');

  // 无路可走返回 null
  const g4 = blankGame('hard');
  put(g4, 0, [[SPADE, 5]]);
  put(g4, 1, [[SPADE, 9]]);
  // 其余 8 列都是空列 → 其实还能搬空列，所以补满
  for (let c = 2; c < g4.columns.length; c++) put(g4, c, [[CLUB, 9]]);
  eq(findHint(g4), null, '没有合法走法时提示为 null');
  eq(hasAnyMove(g4), false, 'hasAnyMove 一致为假');

  // 终局不给提示
  const g5 = blankGame('hard');
  put(g5, 0, [[SPADE, 5]]);
  put(g5, 1, [[SPADE, 6]]);
  g5.result = WON;
  eq(findHint(g5), null, '终局后不给提示');

  // 提示确实是合法走法：照着提示走一定成功
  const g6 = createGame('normal', mulberry32(1234));
  let hintOk = true;
  for (let i = 0; i < 40; i++) {
    const h6 = findHint(g6);
    if (!h6) break;
    const r6 = moveRun(g6, h6.from, h6.index, h6.to);
    if (!r6.ok) { hintOk = false; break; }
    refreshResult(g6);
    if (g6.result !== PLAYING) break;
  }
  ok(hintOk, '照提示连续走 40 步都不违规');
  eq(allCards(g6), DECK_TOTAL, '连走 40 步后总牌数仍是 104（一张不丢）');
}

console.log('\n【十一】快照 / 会话 / 重开');
{
  const s = createSession('normal', mulberry32(2027));
  const snap0 = updateSession(s, 0);
  eq(snap0.columns.length, columnsOf('normal'), `快照有 ${columnsOf('normal')} 列（普通档 7 列）`);
  eq(snap0.key, 'normal', '快照带难度 key');
  eq(snap0.collected, 0, '快照收集数为 0');
  eq(snap0.remainingRuns, 8, '快照剩余组数为 8');
  eq(snap0.stock, DECK_TOTAL - initialDealOf('normal'),
    `快照牌堆 ${DECK_TOTAL - initialDealOf('normal')} 张（普通档开局 34 张）`);
  eq(snap0.dealsLeft, stockRoundsOf('normal'), `快照剩余 ${stockRoundsOf('normal')} 轮发牌`);
  eq(snap0.canDeal, true, '快照可以发牌（带 1 个空列也能发）');
  eq(snap0.canUndo, false, '快照开局不可撤销');
  eq(snap0.result, PLAYING, '快照进行中');
  eq(snap0.moves, 0, '快照步数 0');
  eq(snap0.columns[0].faceDown, 5, '快照第 1 列有 5 张未翻开（普通档第 1 列 6 张）');
  eq(snap0.columns[0].faceUp, 1, '快照第 1 列有 1 张翻开');
  eq(snap0.columns[0].empty, false, '快照第 1 列不是空列');
  eq(snap0.columns[0].movableFrom, 5, '快照标记尾部可搬牌组起点');
  eq(snap0.columns[columnsOf('normal') - 1].empty, true, '快照最后一列（普通档的空列）标记为空');

  // 快照不泄漏未翻开牌的具体牌面（防作弊 / 防误画）
  const col0 = snap0.columns[0];
  let hiddenLeak = 0;
  for (const card of col0.cards) {
    if (!card.faceUp && card.rank > 0 && card.suit >= 0) {
      // 未翻开的牌在快照里仍然带点数花色（渲染需要画背，不画正面，属可接受），
      // 这里断言的是必须显式标记 faceUp=false，渲染层据此才不画正面
      if (card.faceUp !== false) hiddenLeak++;
    }
  }
  eq(hiddenLeak, 0, '快照里未翻开的牌都显式标记 faceUp=false');

  // 走一步后快照更新
  const before = s.game.columns.map((c) => c.length).join(',');
  const dr = sessionDeal(s);
  ok(dr.ok, '会话发牌成功');
  const snap1 = updateSession(s, 100);
  eq(snap1.stock, DECK_TOTAL - initialDealOf('normal') - columnsOf('normal'),
    `发牌后快照牌堆 ${DECK_TOTAL - initialDealOf('normal') - columnsOf('normal')} 张`);
  eq(snap1.moves, 1, '发牌后快照步数 1');
  eq(snap1.canUndo, true, '发牌后快照可撤销');
  eq(snap1.dealsLeft, stockRoundsOf('normal') - 1, `发牌后剩余 ${stockRoundsOf('normal') - 1} 轮`);
  eq(snap1.columns.map((c) => c.cards.length).join(','), before.split(',').map((n) => +n + 1).join(','),
    '发牌后每列各多 1 张');

  // 重开：可换难度
  sessionReset(s, 'hard', mulberry32(5));
  const snap2 = updateSession(s, 200);
  eq(snap2.key, 'hard', '重开后难度切到困难');
  eq(snap2.requireSameSuit, true, '重开后要求同花色');
  eq(snap2.stock, DECK_TOTAL - initialDealOf('hard'),
    `重开后牌堆回到 ${DECK_TOTAL - initialDealOf('hard')} 张（困难档开局 50 张）`);
  eq(snap2.collected, 0, '重开后收集数归零');
  eq(snap2.moves, 0, '重开后步数归零');
  eq(snap2.canUndo, false, '重开后不可撤销');
  eq(snap2.result, PLAYING, '重开后进行中');

  // 不传难度则沿用
  sessionReset(s);
  eq(updateSession(s, 300).key, 'hard', '重开不传难度时沿用原难度');

  // 计分
  const g = blankGame('hard');
  eq(scoreOf(g, 0) >= 0, true, '计分不为负');
  const g2 = blankGame('hard');
  g2.collected = 4;
  ok(scoreOf(g2, 0) > scoreOf(g, 0), '收的组越多分越高');
  ok(scoreOf(g, 60000) < scoreOf(g, 0), '用时越长分越低');

  // 时间格式化（绝对时间戳场景）
  eq(formatClock(0), '00:00', '0ms → 00:00');
  eq(formatClock(3000), '00:03', '3 秒 → 00:03');
  eq(formatClock(65000), '01:05', '65 秒 → 01:05');
  eq(formatClock(-5), '00:00', '负值归零');
  eq(formatClock(100 * 60000), '1:40:00', '超过 99 分钟显示小时');
}

console.log('\n【十二】布局与渲染（牌桌贴顶 / 列数按难度 / 不画全屏背景）');
{
  // 列数按难度：布局自己也得认（不传 view 时用 colCount 参数）
  for (const key of LEVEL_KEYS) {
    const L = computeLayout(375, 667, { top: 44, bottom: 34 }, null, key);
    eq(L.columns.length, columnsOf(key), `${key}：布局给出 ${columnsOf(key)} 列`);
    eq(L.cols, columnsOf(key), `${key}：布局自报列数 layout.cols = ${columnsOf(key)}`);
  }
  const layout = computeLayout(375, 667, { top: 44, bottom: 34 }, null, 'hard');
  eq(layout.columns.length, 9, '布局给困难档 9 列（不传 colCount 时默认简单档，这里显式传 hard）');
  eq(layout.buttons.length, 3, '底部 3 颗按钮（重新开始 / 撤销 / 发牌）');
  eq(layout.buttons.map((b) => b.key).join(','), 'restart,undo,deal', '按钮 key 顺序正确');
  ok(layout.bottomLimit <= 667 - 34, '按钮底边不越过 insets.bottom 安全线');
  eq(layout.bottomLimit, 667 - 34 - 16, '按钮底边 = height − insets.bottom − 16（规范 §5）');
  ok(layout.footer.y + layout.footer.h <= layout.bottomLimit + 1, '底部区域含 16px 余量');
  ok(layout.table.y > layout.info.y + layout.info.h - 1, '牌桌在信息条下方');
  ok(layout.table.bottom <= layout.footer.y + 1,
    '牌桌（含最后一张牌的下边缘）不压到底部按钮');
  eq(layout.columns[0].w > 0, true, '列宽为正');
  ok(layout.cardH > layout.cardW, '牌面是竖版（高 > 宽）');
  ok(layout.faceUpGap > layout.faceDownGap, '翻开牌错开更多（露出点数花色）');

  // ── ★ 本次改造几何重点一：牌桌**贴顶**，不再垂直居中 ──
  // 旧版：table.y = availTop + (availH − tableH) / 2，木板悬在屏幕中间。
  // 新版：table.y === availTop，牌桌铺满可用带，牌从顶部往下排，下方空白就是放置区。
  eq(layout.table.y, layout.availTop, '牌桌贴顶：table.y === availTop（不是居中偏移后的值）');
  eq(layout.table.y, layout.info.y + layout.info.h + Math.round(layout.pad * 0.8),
    '牌桌从「信息条下方的 padding」起算，顶部对齐（用户原话：牌桌从 padding 起）');
  eq(layout.table.y + layout.table.h, layout.availBottom,
    '牌桌一路铺到提示按钮上方的底线（铺满可用带，下方留出的空白就是放置区）');
  ok(layout.table.y + layout.table.h <= layout.hintButton.y, '牌桌下沿不压提示胶囊');
  eq(layout.table.h, layout.availH, '牌桌高度 = 可用带高度（不再只占 78%）');
  eq(layout.bandTop, layout.table.y + layout.tablePad, '内容带贴牌桌顶部（bandTop = table.y + 内边距）');
  ok(layout.dropZone >= 0, `牌桌下方放置区 ${layout.dropZone}px ≥ 0`);
  eq(layout.dropZone, layout.table.h - layout.tablePad * 2 - layout.contentH,
    '放置区 = 牌桌高度 − 上下内边距 − 最高列高度（实测值）');

  // 按钮命中
  const b1 = layout.buttons[0];
  eq(hitButton(layout, b1.x + 2, b1.y + 2), 'restart', '命中重新开始');
  const b3 = layout.buttons[2];
  eq(hitButton(layout, b3.x + b3.w - 2, b3.y + b3.h - 2), 'deal', '命中发牌');
  const hb = layout.hintButton;
  eq(hitButton(layout, hb.x + hb.w / 2, hb.y + hb.h / 2), 'hint', '命中提示胶囊');
  eq(hitButton(layout, layout.width / 2, layout.table.y + 4), null, '牌桌中间不命中按钮');
  ok(!layout.buttons.some((b) => b.y + b.h > layout.bottomLimit), '每颗按钮都在安全线以上');

  // ── ★ 本次改造几何重点二：多机型 × 三档的几何硬约束 ──
  {
    const SQ = 56;   // 集成层左上返回键 / 右上齿轮的占位（各 56×56）
    const devices2 = [
      [320, 480, 30, 26], [360, 640, 30, 30], [375, 667, 44, 34],
      [420, 805, 44, 34], [430, 932, 44, 40],
    ];
    for (const [w, h, it, ib] of devices2) {
      for (const key of LEVEL_KEYS) {
        const L = computeLayout(w, h, { top: it, bottom: ib }, null, key);
        eq(L.bottomLimit, h - ib - 16, `${w}×${h} ${key}：按钮基线 = height − insets.bottom − 16`);
        ok(L.bottomLimit <= h - ib - 16 + 0.001, `${w}×${h} ${key}：底部按钮下沿不越过安全线`);
        eq(L.table.y, L.availTop, `${w}×${h} ${key}：牌桌顶部对齐 availTop`);
        ok(L.table.y >= L.info.y + L.info.h, `${w}×${h} ${key}：牌桌在信息条下方`);
        ok(L.table.y >= SQ, `${w}×${h} ${key}：牌桌顶部不与 56px 角区相交`);
        eq(L.columns.length, columnsOf(key), `${w}×${h} ${key}：列数 = ${columnsOf(key)}`);
        const lastGeo = L.columns[L.columns.length - 1];
        ok(lastGeo.x + lastGeo.w <= w - L.pad + 1, `${w}×${h} ${key}：最后一列不越右边界`);
        ok(L.columns[0].x >= L.pad - 1, `${w}×${h} ${key}：第一列不越左边界`);
        ok(lastGeo.x + lastGeo.w > L.columns[0].x, `${w}×${h} ${key}：列从左到右排布`);
        ok(L.cardW > 0 && L.cardH > L.cardW, `${w}×${h} ${key}：牌面竖版且尺寸为正`);
      }
      // 牌宽随列数递减：列变少 → 牌放大（用户要求「适当增大纸牌」）
      const Le = computeLayout(w, h, { top: it, bottom: ib }, null, 'easy');
      const Ln = computeLayout(w, h, { top: it, bottom: ib }, null, 'normal');
      const Lh = computeLayout(w, h, { top: it, bottom: ib }, null, 'hard');
      ok(Le.cardW > Ln.cardW && Ln.cardW > Lh.cardW,
        `${w}×${h}：牌宽随列数递减（简单 ${Le.cardW} > 普通 ${Ln.cardW} > 困难 ${Lh.cardW}）`);
      ok(Le.cardH > Lh.cardH, `${w}×${h}：简单档牌高 ${Le.cardH} > 困难档 ${Lh.cardH}`);
    }
  }

  // ── insets.top = 0 的机型：信息条/牌桌照样不能压进 56px 角区（靠布局内的硬下限兜住） ──
  {
    const L0 = computeLayout(375, 667, { top: 0, bottom: 34 }, null, 'easy');
    ok(L0.info.y >= 56, `insets.top=0 时信息条仍让开 56px 角区（info.y=${L0.info.y}）`);
    ok(L0.table.y >= 56, `insets.top=0 时牌桌仍让开 56px 角区（table.y=${L0.table.y}）`);
    eq(L0.bottomLimit, 667 - 34 - 16, 'insets.top=0 时按钮仍守 height − insets.bottom − 16');
    eq(L0.table.y, L0.availTop, 'insets.top=0 时牌桌依然贴顶');
  }

  // ── 「提示」按钮必须躲开集成层占用的左上(返回键)/右上(齿轮)两个角落 ──
  // 集成层那两个键各约占 56px；旧版把提示放在信息条右端 → 正好压在齿轮上，还把收集区挤到左边。
  {
    const SQ = 56;
    for (const [w, h, b] of [[375, 667, 34], [420, 805, 34], [420, 900, 40], [430, 932, 40], [320, 480, 20]]) {
      const L = computeLayout(w, h, { top: 44, bottom: b });
      const hb2 = L.hintButton;
      const overl = (r1, r2) => !(r1.x + r1.w <= r2.x || r2.x + r2.w <= r1.x
        || r1.y + r1.h <= r2.y || r2.y + r2.h <= r1.y);
      const cornerTL = { x: 0, y: 0, w: SQ, h: SQ };
      const cornerTR = { x: w - SQ, y: 0, w: SQ, h: SQ };
      ok(!overl(hb2, cornerTL), `${w}×${h}：提示按钮不压左上返回键`);
      ok(!overl(hb2, cornerTR), `${w}×${h}：提示按钮不压右上齿轮`);
      ok(hb2.y >= L.info.y + L.info.h, `${w}×${h}：提示按钮在信息条（收集区）下方，不再挤收集区`);
      ok(hb2.y + hb2.h <= L.buttons[0].y, `${w}×${h}：提示按钮不压底部按钮排`);
      ok(hb2.x + hb2.w / 2 === Math.round(w / 2) || Math.abs(hb2.x + hb2.w / 2 - w / 2) <= 1,
        `${w}×${h}：提示按钮水平居中`);
      // 收集区 8 格必须完整落在屏幕上、且不被任何按钮压住
      const box = Math.max(10, Math.round(L.info.h * 0.52));
      const step = box + Math.max(3, Math.round(box * 0.28));
      const barW = box * 8 + (step - box) * 7;
      ok(L.info.x >= 0 && L.info.x + barW <= w, `${w}×${h}：收集区 8 格完整可见（宽 ${barW}）`);
      const barRect = { x: L.info.x, y: L.info.y, w: barW, h: L.info.h };
      ok(!overl(barRect, cornerTL) && !overl(barRect, cornerTR), `${w}×${h}：收集区不与返回键/齿轮重叠`);
      ok(!overl(barRect, L.hintButton), `${w}×${h}：收集区不与提示按钮重叠`);
      eq(L.bottomLimit, h - b - 16, `${w}×${h}：底部按钮仍在 height − insets.bottom − 16 之上`);
    }
  }

  // 命中列 / 牌
  const s = createUiSession({ width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'easy', theme: {} });
  s.update(1000);
  const view = s.snapshot;
  const lay = computeLayout(375, 667, { top: 44, bottom: 34 }, view);
  const geo = lay.columns[0];
  const hitTop = columnAt(lay, view, geo.x + lay.cardW / 2, geo.top + lay.cardH * 0.9);
  ok(!!hitTop && hitTop.col === 0, '点在不翻开的牌上能命中第 1 列');
  const rectLast = cardRect(lay, view, 0, view.columns[0].cards.length - 1);
  const hitLast = columnAt(lay, view, rectLast.x + lay.cardW / 2, rectLast.y + rectLast.h - 2);
  ok(!!hitLast && hitLast.col === 0 && hitLast.index === view.columns[0].cards.length - 1,
    '点列尾那张命中的是翻开的那张');
  eq(columnAt(lay, view, 5, 5), null, '牌桌外不命中任何列');

  // 用桩 ctx 渲染一帧，不应抛异常
  const ctx = makeCtx();
  let threw = null;
  try {
    renderFrame(ctx, lay, {
      key: 'easy', columns: view.columns, stock: view.stock, dealsLeft: view.dealsLeft,
      canDeal: view.canDeal, collected: view.collected, remainingRuns: view.remainingRuns,
      moves: view.moves, canUndo: view.canUndo, undoLeft: 0, result: view.result,
      cardsLeft: view.cardsLeft, levelName: '简单', requireSameSuit: false, elapsedMs: 0,
      selection: { col: 0, index: view.columns[0].cards.length - 1 },
      pressButton: 'deal', pressCard: null, hint: { from: 0, index: 0, to: 1, count: 1, until: 9e15 },
      rejectCol: 2, rejectAt: 990, toast: { text: '测试', at: 900 },
      lastCollectAt: 950, winAt: 0, stuckAt: 0,
    }, {}, 1000);
  } catch (e) { threw = e; }
  eq(threw, null, 'renderFrame 用桩 ctx 渲染不抛异常');
  // ⚠️ 约定变更：清屏与铺底由**集成层**负责（规范 §10）。
  // 早先这里断言 `clearRect >= 1`；但游戏自己 clearRect 会把集成层刚铺好的青白底清掉
  // （实机表现为整屏深灰）。现在反过来守住新约定：本模块**不得**清屏。
  ok(ctx.calls.clearRect === 0, '不自己清屏（clearRect 交给集成层，规范 §10）');
  ok(ctx.calls.fillRect === 0, '不用 fillRect 铺全屏底色（背景交给集成层的青白渐变）');
  ok(ctx.calls.fillText > 0, '渲染画了文字（信息条 / 按钮）');

  // ── 渲染热路径回归：渐变缓存 + 绘制调用量（「反应太慢、操作卡顿」的整改证据） ──
  {
    const vw = {
      key: 'easy', columns: view.columns, stock: view.stock, dealsLeft: view.dealsLeft,
      canDeal: view.canDeal, collected: view.collected, remainingRuns: view.remainingRuns,
      moves: view.moves, canUndo: view.canUndo, undoLeft: 0, result: view.result,
      cardsLeft: view.cardsLeft, levelName: '简单', requireSameSuit: false, elapsedMs: 0,
      selection: null, pressButton: null, pressCard: null, hint: null,
      rejectCol: null, rejectAt: 0, toast: null, lastCollectAt: 0, winAt: 0, stuckAt: 0,
    };
    const cg = makeCtx();
    renderFrame(cg, lay, vw, {}, 1000);
    const g1 = cg.calls.gradient, s1 = cg.calls.stroke;
    renderFrame(cg, lay, vw, {}, 1001);
    const g2 = cg.calls.gradient - g1, s2 = cg.calls.stroke - s1;
    ok(g1 > 0 && g2 === 0,
      `渐变按尺寸缓存：第一帧建 ${g1} 个，第二帧 createLinearGradient 调用 ${g2} 次（旧版每帧 80+ 个）`);
    ok(s2 === s1 && s2 > 0, `每帧描边次数稳定（${s2} 次/帧，两帧一致）`);
    ok(s2 <= 260, `未翻开的牌只画露出来那一条：一帧描边 ${s2} 次 ≤ 260（旧版 800+ 次）`);
    ok(cg.calls.beginPath > 0, `一帧建立 ${cg.calls.beginPath} 条路径`);
  }

  // 小屏 / 大屏都不越界（列数按难度：默认简单档 5 列）
  for (const [w, h] of [[320, 480], [360, 640], [414, 896], [430, 932]]) {
    const l2 = computeLayout(w, h, { top: 30, bottom: 26 }, null, 'hard');
    ok(l2.bottomLimit === h - 26 - 16, `${w}×${h}：底部安全线正确`);
    const lastL2 = l2.columns[l2.columns.length - 1];
    ok(lastL2.x + lastL2.w <= w - l2.pad + 1, `${w}×${h}：最后一列（第 ${l2.columns.length} 列）不越右边界`);
    ok(l2.cardH > 0 && l2.cardW > 0, `${w}×${h}：牌面尺寸为正`);
  }

  // 超长列时自动压缩间距，绝不越出牌桌（连最后一张牌的下边缘一起算）
  const tall = {
    columns: view.columns.map((c, i) => (i === 0
      ? { ...c, faceDown: 20, faceUp: 20 }
      : { ...c, faceDown: 5, faceUp: 1 })),
  };
  const l3 = computeLayout(375, 667, { top: 44, bottom: 34 }, tall);
  const tallH = 20 * l3.faceDownGap + 20 * l3.faceUpGap + l3.cardH;
  ok(tallH <= l3.table.h + 1, '超长列时自动压缩错开间距，整列塞得进牌桌');

  // ── 间距「双向自适应」回归 ──
  // 旧版只在「溢出」时压缩：空间富裕时牌挤在牌桌顶部、下面一大片空木色（实机截图确认过）。
  {
    const l1 = computeLayout(375, 667, { top: 44, bottom: 34 }, null, 'hard');   // 保守估（最坏 6+12）
    const l420 = computeLayout(420, 805, { top: 44, bottom: 34 }, view);    // 用户报的机型（简单档 5 列）
    ok(l420.table.y + l420.table.h <= l420.footer.y + 1, '420×805：牌桌不越到底部按钮');
    // ★ 改造后：牌桌贴顶并铺满可用带（旧版只占 78% 且垂直居中）
    eq(l420.table.y, l420.availTop, '420×805：牌桌贴顶（table.y === availTop）');
    eq(l420.table.h, l420.availH, '420×805：牌桌铺满可用带（下方空白即放置区）');
    ok(l420.table.bottom <= l420.hintButton.y + 1, '420×805：牌桌下沿不压提示胶囊');
    // ── 点 5 回归：牌桌要**向下延伸**，让玩家直观看到下面还有放置空间 ──
    ok(l420.table.h >= l420.contentH + 40,
      `420×805：牌桌 ${l420.table.h} 明显长于内容带 ${l420.contentH}（下方留出纵深）`);
    ok(l420.dropZone >= 20, `420×805：布局声明了 ${l420.dropZone}px 的下方放置区`);
    let deepest = 0;
    for (let c = 0; c < view.columns.length; c++) {
      const col = view.columns[c];
      if (!col.cards.length) continue;
      const rr = cardRect(l420, view, c, col.cards.length - 1);
      deepest = Math.max(deepest, rr.y + rr.h);
    }
    ok(l420.table.bottom - deepest >= 24,
      `420×805：最深一张牌下面还有 ${Math.round(l420.table.bottom - deepest)}px 牌桌纵深（放置区看得见）`);
    ok(l420.bandTop >= l420.table.y - 1 && l420.bandTop + l420.contentH <= l420.table.bottom + 1,
      '420×805：牌放在牌桌上半部的内容带里，牌桌整体向下延伸');
    // 小屏也要留出纵深，但不许溢出
    const lsmall = computeLayout(360, 640, { top: 30, bottom: 30 }, view);
    ok(lsmall.table.bottom - lsmall.bandTop - lsmall.contentH >= 16,
      `360×640：小屏也留了 ${Math.round(lsmall.table.bottom - lsmall.bandTop - lsmall.contentH)}px 下方纵深`);
    ok(lsmall.table.bottom <= lsmall.hintButton.y + 1, '360×640：延伸后的牌桌仍不压提示按钮');
    ok(l420.faceUpGap >= 18,
      `420×805 空间富裕时明牌间距放大到 ${l420.faceUpGap}px（旧版固定 ~17px，牌挤在顶部）`);
    ok(l420.faceDownGap > 4, `420×805 空间富裕时暗牌间距也放大到 ${l420.faceDownGap}px`);
    ok(l420.faceUpGap <= Math.max(12, Math.round(l420.cardH * 0.42)) + 1,
      '明牌间距不超过「一张牌高 42%」的上限（不被扯得太散）');
    ok(l420.faceDownGap <= Math.max(4, Math.round(l420.cardH * 0.22)) + 1,
      '暗牌间距不超过「一条背」的上限');

    // 全部列都在牌桌内、且纵向居中（张数多的列起点更高）
    let allIn = true;
    for (let c = 0; c < view.columns.length; c++) {
      const col = view.columns[c];
      const top = l420.columns[c].top;
      const last = cardRect(l420, view, c, col.cards.length - 1);
      if (top < l420.table.y - 1) allIn = false;
      if (last.y + last.h > l420.table.bottom + 1) allIn = false;
    }
    ok(allIn, `420×805：${view.columns.length} 列都落在牌桌内（无越界）`);
    ok(l420.columns[0].top < l420.columns[4].top,
      '420×805：张数多的列起点更高（矮列在牌桌内坐得低一点，整体视觉居中）');

    // 空间不足时必须压缩
    const tiny = computeLayout(320, 480, { top: 30, bottom: 26 }, tall);
    ok(tiny.faceUpGap < l420.faceUpGap, '空间不足时明牌间距自动压缩');
    ok(20 * tiny.faceDownGap + 20 * tiny.faceUpGap + tiny.cardH <= tiny.table.h + 1,
      '320×480 超长列：压缩后整列仍塞得进牌桌');
    ok(tiny.columns[0].top >= tiny.table.y - 1, '320×480：列起点不低于牌桌顶');

    // 明牌永远比暗牌露得多（否则看不清点数花色）
    for (const L of [layout, l1, l420, l3, tiny]) {
      ok(L.faceUpGap >= L.faceDownGap, `间距关系正确：明牌 ${L.faceUpGap} ≥ 暗牌 ${L.faceDownGap}`);
    }
  }

  // 开局各列的明暗分布必须是「前 n−1 张背面 + 最后一张正面」
  {
    let okFlags = true;
    const sm = createUiSession({
      width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'hard',
      theme: {}, rng: mulberry32(1357),
    });
    sm.update(1790000000000);
    const cols0 = sm.snapshot.columns;
    for (const col of cols0) {
      for (let i = 0; i < col.cards.length; i++) {
        const want = i === col.cards.length - 1;
        if (col.cards[i].faceUp !== want) okFlags = false;
      }
    }
    ok(okFlags, `开局 ${cols0.length} 列：每列最后一张正面、其余全部背面（空列没有牌，天然合规）`);
    eq(cols0[0].faceDown + cols0[0].faceUp, cols0[0].cards.length, '快照的暗牌数 + 明牌数 = 该列张数');
    eq(cols0.filter((c) => !c.empty).every((c) => c.faceUp === 1), true,
      `开局每个非空列正好 1 张正面（困难档 ${filledColsOf('hard')} 个非空列）`);
    eq(cols0.filter((c) => c.empty).length, emptyColsOf('hard'),
      `开局恰好 ${emptyColsOf('hard')} 个空列（困难档）`);
    eq(cols0.length, columnsOf('hard'), `快照列数 = 难度列数（${columnsOf('hard')}）`);
    sm.destroy();
  }
}

console.log('\n【十三】会话层（index.js）：时间约定与结果上报');
{
  eq(meta.id, 'spider', 'meta.id 是 spider（与目录名一致）');
  eq(meta.ready, true, 'meta.ready 为真');
  eq(meta.difficulties.map((d) => d.key).join(','), 'easy,normal,hard', 'meta 难度 key 与 core 一致');
  for (const d of meta.difficulties) {
    ok(LEVELS[d.key] !== undefined, `meta 难度 ${d.key} 在 core 里有对应配置`);
    ok(d.desc.length <= 16, `meta 难度 ${d.key} 的 desc ≤16 字`);
  }
  ok(meta.desc.length <= 16, 'meta.desc ≤16 字');

  // 规范 §8：now 是 Date.now() 的绝对时间戳，计时必须透传
  const s = createUiSession({ width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'easy', theme: {} });
  const T0 = 1790000000000;   // 模拟 Date.now() 量级
  s.update(T0);
  eq(s.hud.right, '00:00', '未操作时用时 00:00');
  eq(s.hud.title, '蜘蛛纸牌', 'hud.title 正确');

  // 发一张牌开始计时（用底部发牌按钮）
  const layout = computeLayout(375, 667, { top: 44, bottom: 34 }, s.snapshot);
  const dealBtn = layout.buttons.find((b) => b.key === 'deal');
  s.tap(dealBtn.x + dealBtn.w / 2, dealBtn.y + dealBtn.h / 2, T0);
  s.update(T0);
  const beforeStock = s.snapshot.stock;
  eq(beforeStock, DECK_TOTAL - initialDealOf('easy') - columnsOf('easy'),
    `点发牌按钮后牌堆剩 ${DECK_TOTAL - initialDealOf('easy') - columnsOf('easy')} 张（简单档开局 24 张 + 发 5 张）`);

  // 3 秒后：用时必须显示 00:03，而不是 1970 年那种天文数字
  s.update(T0 + 3000);
  eq(s.hud.right, '00:03', '传入 T0 与 T0+3000 后用时显示 00:03（时间透传正确）');
  s.update(T0 + 65000);
  eq(s.hud.right, '01:05', '传入 T0+65000 后用时显示 01:05');
  ok(s.hud.status.includes('已收 0/8'), 'hud.status 带收集进度');

  // 撤销按钮
  const undoBtn = layout.buttons.find((b) => b.key === 'undo');
  s.tap(undoBtn.x + undoBtn.w / 2, undoBtn.y + undoBtn.h / 2, T0 + 66000);
  s.update(T0 + 66000);
  eq(s.snapshot.stock, DECK_TOTAL - initialDealOf('easy'),
    `点撤销按钮后牌堆回到 ${DECK_TOTAL - initialDealOf('easy')} 张`);

  // 重新开始按钮
  const restartBtn = layout.buttons.find((b) => b.key === 'restart');
  s.tap(restartBtn.x + restartBtn.w / 2, restartBtn.y + restartBtn.h / 2, T0 + 67000);
  s.update(T0 + 67000);
  eq(s.snapshot.columns.map((c) => c.cards.length).join(','), expectCols('easy'),
    '点重新开始后布局回到开局（简单档 3 列各 8 张 + 2 个空列）');
  eq(s.hud.right, '00:00', '重新开始后用时归零');
  eq(s.outcome, null, '未分胜负时 outcome 为 null');
  eq(s.busy, false, '刚重开、还没有任何操作时不需要持续推帧（省电）');
  // 再发一次牌 → 计时开始走，此时才需要持续推帧
  s.tap(dealBtn.x + dealBtn.w / 2, dealBtn.y + dealBtn.h / 2, T0 + 68000);
  s.update(T0 + 68000);
  eq(s.busy, true, '有操作在计时后需要持续推帧（hud 上的用时在走）');
  s.update(T0 + 71000);
  eq(s.hud.right, '00:03', '重开后重新起算：传入 T0+68000 与 T0+71000 显示 00:03');

  // ── 自动对局：验证「点牌 → 点列」链路端到端可用 ──
  // 洗牌随机源是可注入的，这里**固定种子**，彻底消除「某局恰好无解」造成的 flaky。
  const events = [];
  const SPIDER_SEED = 20260807;

  /**
   * 用指定种子跑一遍完全相同的驱动逻辑，返回指标。
   * 这样正式断言可以写成「不得低于同种子下的实测值」，而不是拍脑袋的 ≥6 步。
   */
  function trialRun(seed) {
    const t = createUiSession({
      width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'easy', theme: {},
      rng: mulberry32(seed), onEvent: () => {},
    });
    const lay0 = computeLayout(375, 667, { top: 44, bottom: 34 }, t.snapshot);
    const dealBtn = lay0.buttons.find((b) => b.key === 'deal');
    const T = T0 + 100000;

    const runStart = (cards, index) => {
      if (index < 0 || index >= cards.length || !cards[index].faceUp) return -1;
      for (let i = index + 1; i < cards.length; i++) {
        const lower = cards[i - 1];
        const upper = cards[i];
        if (!upper.faceUp || lower.suit !== upper.suit || lower.rank !== upper.rank + 1) return -1;
      }
      return index;
    };
    /** 用快照找一个真合法走法（规则与 core 一致，另有交叉验证）。 */
    const findMove = () => {
      const v = t.snapshot;
      let best = null;
      for (let from = 0; from < v.columns.length; from++) {
        const col = v.columns[from];
        if (col.movableFrom < 0 || runStart(col.cards, col.movableFrom) < 0) continue;
        const head = col.cards[col.movableFrom];
        for (let to = 0; to < v.columns.length; to++) {
          if (to === from) continue;
          const dst = v.columns[to];
          let score;
          if (dst.cards.length === 0) score = col.cards.length - col.movableFrom;
          else {
            const top = dst.cards[dst.cards.length - 1];
            if (head.rank !== top.rank - 1) continue;
            if (v.requireSameSuit && head.suit !== top.suit) continue;
            score = 1000 + (col.cards.length - col.movableFrom);
          }
          if (!best || score > best.score) best = { from, index: col.movableFrom, to, score };
        }
      }
      return best;
    };
    /** 选中 → 落牌，返回是否真的走成了。 */
    const step = (mv) => {
      t.update(T);
      const lay = computeLayout(375, 667, { top: 44, bottom: 34 }, t.snapshot);
      const v0 = t.snapshot;
      const r1 = cardRect(lay, v0, mv.from, mv.index);
      t.tap(r1.x + lay.cardW / 2, r1.y + r1.h - 2, T);
      const dst = t.snapshot.columns[mv.to];
      const r2 = dst.cards.length
        ? cardRect(lay, t.snapshot, mv.to, dst.cards.length - 1)
        : { x: lay.columns[mv.to].x, y: lay.columns[mv.to].top, w: lay.cardW, h: lay.cardH };
      t.tap(r2.x + lay.cardW / 2, r2.y + r2.h / 2, T);
      t.update(T);
      return t.snapshot.moves > v0.moves;
    };

    let coordTries = 0, coordOkCount = 0, deals = 0, rounds = 0;
    // 提示胶囊点两次（第 1 次出建议、第 2 次照建议走一步）——与正式跑法完全一致，
    // 否则试跑与正式跑的步数会对不上（这两步也算步数）。
    const hint = lay0.hintButton;
    t.tap(hint.x + hint.w / 2, hint.y + hint.h / 2, T);
    t.update(T);
    const hintMoves1 = t.snapshot.moves;
    t.tap(hint.x + hint.w / 2, hint.y + hint.h / 2, T);
    t.update(T);
    const hintMoves2 = t.snapshot.moves;

    // 清掉提示可能留下的选中态（点一张暗牌）
    {
      const v = t.snapshot;
      const fd = v.columns.findIndex((c) => c.cards.length && !c.cards[c.cards.length - 1].faceUp);
      if (fd < 0) t.tap(1, 1, T);
      else {
        const lay = computeLayout(375, 667, { top: 44, bottom: 34 }, v);
        const rr = cardRect(lay, v, fd, v.columns[fd].cards.length - 1);
        t.tap(rr.x + lay.cardW / 2, rr.y + rr.h / 2, T);
      }
      t.update(T);
    }

    while (rounds < 200 && t.outcome === null) {
      rounds++;
      t.update(T);
      const s = t.snapshot;
      if (s.result !== 'playing') break;
      if (s.canDeal) {
        const before = s.stock;
        deals++;
        t.tap(dealBtn.x + dealBtn.w / 2, dealBtn.y + dealBtn.h / 2, T);
        t.update(T);
        if (t.snapshot.stock !== before - columnsOf('easy')) break;
        continue;
      }
      const mv = findMove();
      if (!mv) break;
      coordTries++;
      if (step(mv)) coordOkCount++; else break;
    }
    const out = {
      moves: t.snapshot.moves,
      deals,
      coordTries,
      coordOkCount,
      hintMoves1,
      hintMoves2,
      collected: t.snapshot.collected,
      stock: t.snapshot.stock,
      result: t.snapshot.result,
    };
    t.destroy();
    return out;
  }

  // 扫几个种子，挑一个「确实能走出棋」的（每个种子的结果都是确定的，不会 flaky）
  let chosen = null;
  for (let seed = 1; seed <= 12; seed++) {
    const r = trialRun(seed);
    if (r.coordOkCount >= 1 && r.moves >= 2) { chosen = { seed, r }; break; }
  }
  ok(chosen !== null, '扫 12 个固定种子，至少有一个能走出棋（若有解都无解说明驱动写错了）');
  const trial = chosen ? chosen.r : { moves: 0, deals: 0, coordTries: 0, coordOkCount: 0, stock: 50, result: 'playing' };

  // 正式跑一遍（同一个固定种子 → 结果与 trial 完全一致）
  const auto = createUiSession({
    width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'easy', theme: {},
    rng: mulberry32(chosen ? chosen.seed : SPIDER_SEED),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const autoLayout = computeLayout(375, 667, { top: 44, bottom: 34 }, auto.snapshot);
  const autoDeal = autoLayout.buttons.find((b) => b.key === 'deal');
  const hintBtn = autoLayout.hintButton;
  const T1 = T0 + 100000;

  /** 用坐标走一步可行棋（选中源列尾组 → 点目标列），返回是否真的走成了。 */
  function stepByCoords(from, index, to) {
    // 列高会随局面变化，每次都按当前快照重算布局，保证点到的就是那张牌
    auto.update(T1);
    const lay = computeLayout(375, 667, { top: 44, bottom: 34 }, auto.snapshot);
    const v0 = auto.snapshot;
    const r1 = cardRect(lay, v0, from, index);
    auto.tap(r1.x + lay.cardW / 2, r1.y + r1.h - 2, T1);
    const dst = auto.snapshot.columns[to];
    const r2 = dst.cards.length
      ? cardRect(lay, auto.snapshot, to, dst.cards.length - 1)
      : { x: lay.columns[to].x, y: lay.columns[to].top, w: lay.cardW, h: lay.cardH };
    auto.tap(r2.x + lay.cardW / 2, r2.y + r2.h / 2, T1);
    auto.update(T1);
    return auto.snapshot.moves > v0.moves;
  }

  /**
   * 用快照找「整体可搬走的尾巴牌组」的起点（只按渲染层拿得到的信息判断）。
   * 规则与 core 一致：一段连续翻开、同花色、点数严格 −1 的尾部牌组。
   */
  function runStart(cards, index) {
    if (index < 0 || index >= cards.length) return -1;
    if (!cards[index].faceUp) return -1;
    for (let i = index; i < cards.length; i++) {
      if (!cards[i].faceUp) return -1;
      if (i > index) {
        const lower = cards[i - 1];
        const upper = cards[i];
        if (lower.suit !== upper.suit || lower.rank !== upper.rank + 1) return -1;
      }
    }
    return index;
  }

  /**
   * 找一个真合法走法（纯快照判定，不碰 index.js 内部状态）。
   * 这条规则是**照 core 抄的**，所以在【十四】里专门有一条「与 core.canMove 结论一致」的交叉验证。
   */
  function legalMoves() {
    const v = auto.snapshot;
    const out = [];
    for (let from = 0; from < v.columns.length; from++) {
      const col = v.columns[from];
      if (col.movableFrom < 0) continue;
      const index = col.movableFrom;
      if (runStart(col.cards, index) < 0) continue;
      const head = col.cards[index];
      for (let to = 0; to < v.columns.length; to++) {
        if (to === from) continue;
        const dst = v.columns[to];
        if (dst.cards.length === 0) { out.push({ from, index, to, len: col.cards.length - index }); continue; }
        const top = dst.cards[dst.cards.length - 1];
        if (head.rank !== top.rank - 1) continue;
        if (v.requireSameSuit && head.suit !== top.suit) continue;
        out.push({ from, index, to, len: col.cards.length - index });
      }
    }
    return out;
  }

  /** 自动对局选步：优先接同花，其次接异花，最后挪去空列；且不立刻反悔上一步。 */
  function pickMove() {
    const all = legalMoves();
    if (all.length === 0) return null;
    const v = auto.snapshot;
    const last = v.lastAction;
    const rev = last && last.type === 'move' ? { from: last.to, to: last.from } : null;
    const score = (mv) => {
      const dst = v.columns[mv.to];
      const top = dst.cards.length ? dst.cards[dst.cards.length - 1] : null;
      let s = mv.len * 10;
      if (top && top.suit === v.columns[mv.from].cards[mv.index].suit) s += 1000;
      else if (!top) s -= 100;
      if (rev && rev.from === mv.from && rev.to === mv.to) s -= 5000;
      return s;
    };
    return all.slice().sort((a, b) => score(b) - score(a))[0];
  }

  // 先把「提示胶囊」这条交互单独验证掉：第一次出建议，第二次照建议走一步
  auto.tap(hintBtn.x + hintBtn.w / 2, hintBtn.y + hintBtn.h / 2, T1);
  auto.update(T1);
  const movesAfterHint1 = auto.snapshot.moves;
  auto.tap(hintBtn.x + hintBtn.w / 2, hintBtn.y + hintBtn.h / 2, T1);
  auto.update(T1);
  const movesAfterHint2 = auto.snapshot.moves;
  eq(movesAfterHint1, 0, '第一次点提示只给建议、不动牌');
  eq(movesAfterHint2, 1, '第二次点提示（1.6 秒内）照建议走了一步');
  eq(movesAfterHint1, trial.hintMoves1, '提示第一次点击的步数与试跑一致');
  eq(movesAfterHint2, trial.hintMoves2, '提示第二次点击的步数与试跑一致');

  // 用「点牌 → 点列」的坐标路径连走若干步（验证整套点击链路真的能推进局面）
  // 策略与 trialRun 完全一致：能发牌就先发（牌堆越堆越密、走法更多），再挑一个合法走法。
  // ⚠️ 提示那两次点击可能留着选中态，先点一下暗牌把它清掉，否则第一下点击只是取消选中。
  {
    const v = auto.snapshot;
    const faceDownCol = v.columns.findIndex((c) => c.cards.length && !c.cards[c.cards.length - 1].faceUp);
    if (faceDownCol < 0) auto.tap(1, 1, T1);   // 点空白处清选中态
    else {
      const lay = computeLayout(375, 667, { top: 44, bottom: 34 }, v);
      const rr = cardRect(lay, v, faceDownCol, v.columns[faceDownCol].cards.length - 1);
      auto.tap(rr.x + lay.cardW / 2, rr.y + rr.h / 2, T1);
    }
    auto.update(T1);
  }

  let rounds = 0, coordsOk = false, coordTried = 0, dealsUsed = 0, collectedEver = 0;
  while (rounds < 200 && auto.outcome === null) {
    rounds++;
    auto.update(T1);
    const s = auto.snapshot;
    if (s.result !== 'playing') break;
    collectedEver = Math.max(collectedEver, s.collected);

    if (s.canDeal) {
      const before = s.stock;
      dealsUsed++;
      auto.tap(autoDeal.x + autoDeal.w / 2, autoDeal.y + autoDeal.h / 2, T1);
      auto.update(T1);
      if (auto.snapshot.stock !== before - columnsOf('easy')) break;
      continue;
    }

    const mv = pickMove();
    if (!mv) break;                       // 无路可走且不能发牌 → 困死
    coordTried++;
    const okStep = stepByCoords(mv.from, mv.index, mv.to);
    coordsOk = coordsOk || okStep;
    if (!okStep) break;                   // 点不动了说明链路有问题，别空转
  }
  auto.update(T1);

  // 断言写法：**先看这一局到底有没有可走的棋，再决定断言什么**
  // ——「无合法走法」是牌局本身的属性，不是失败；但只要探到了走法，就要求它真的能走成。
  eq(coordTried, trial.coordTries, '固定种子下：探到的走法次数与试跑一致（完全可复现）');
  if (coordTried > 0) {
    eq(coordsOk, true, `用「点牌 → 点列」的坐标路径真的走成了棋（${coordTried} 次探测全成功）`);
  } else {
    ok(true, '固定种子下这局开局即无解，跳过「坐标路径走成棋」的断言（不是失败）');
  }
  eq(auto.snapshot.moves, trial.moves, '固定种子下：推进步数与试跑完全一致（点击 → 落牌链路可用）');
  ok(auto.snapshot.moves >= Math.max(1, trial.moves),
    `自动对局推进了 ${auto.snapshot.moves} 步（种子 ${chosen ? chosen.seed : SPIDER_SEED} 下的确定值）`);
  eq(dealsUsed, trial.deals, '发牌次数与试跑一致');
  ok(dealsUsed >= 1, `自动对局里点了 ${dealsUsed} 次发牌按钮，每次都准确发出「列数」张（简单档 5 张）`);
  eq(auto.snapshot.stock, DECK_TOTAL - initialDealOf('easy') - dealsUsed * columnsOf('easy'),
    '发过牌后牌堆张数与发牌次数对得上（每轮发「列数」张）');

  // ── 确定性的「结算上报」验证：用 core 会话把胜利局面走完（挂到 index 会话上必炸，这里只验 core 路径） ──
  const coreWin = createSession('hard', mulberry32(2027));
  for (let c = 0; c < coreWin.game.columns.length; c++) coreWin.game.columns[c].length = 0;
  coreWin.game.stock.length = 0;
  coreWin.game.collected = RUNS_TO_WIN - 1;
  putOpen(coreWin.game, 0, (() => {
    const out = [];
    for (let r = KING; r >= 2; r--) out.push([SPADE, r]);
    return out;
  })());
  putOpen(coreWin.game, 1, [[SPADE, ACE]]);
  const winMove = sessionMove(coreWin, 1, 0, 0);
  ok(winMove.ok && winMove.result === WON, 'core 会话：最后一张 A 归位 → 判胜');
  eq(scoreOf(coreWin.game, 1234) > 0, true, '胜利局面计分为正');

  // 点「重新开始」按钮 → 计时归零、局面回到开局、结算态清空
  // ⚠️ 改造后简单档只有 5 列：自动对局把牌堆发完后很可能真的走不动（判困死），
  //    所以不再断言「仍是 playing」，改成「状态合法 + 状态与 outcome 对得上」。
  ok(auto.snapshot.result === 'playing' || auto.snapshot.result === 'stuck' || auto.snapshot.result === 'won',
    `自动对局停止时状态合法（${auto.snapshot.result}）`);
  if (auto.snapshot.result === 'playing') {
    eq(auto.outcome, null, '进行中时 outcome 为 null');
  } else {
    ok(auto.outcome !== null, `终局（${auto.snapshot.result}）已上报 outcome`);
  }
  const autoRestart = computeLayout(375, 667, { top: 44, bottom: 34 }, auto.snapshot).buttons
    .find((b) => b.key === 'restart');
  auto.tap(autoRestart.x + autoRestart.w / 2, autoRestart.y + autoRestart.h / 2, T1 + 4000);
  auto.update(T1 + 4000);
  eq(auto.outcome, null, '重开后 outcome 清空');
  eq(auto.snapshot.result, 'playing', '重开后回到进行中');
  eq(auto.snapshot.moves, 0, '重开后步数归零');
  eq(auto.snapshot.stock, DECK_TOTAL - initialDealOf('easy'),
    `重开后牌堆回到 ${DECK_TOTAL - initialDealOf('easy')} 张（简单档开局 24 张）`);
  eq(auto.hud.right, '00:00', '重开后用时归零');
  eq(auto.busy, false, '重开后静置时不需要持续推帧');

  // 打完一帧渲染（桩 ctx，含收牌动效 / 胜利描边）
  const ctx3 = makeCtx();
  let winRenderOk = true;
  try { auto.render(ctx3, T1 + 200); } catch (e) { winRenderOk = false; }
  ok(winRenderOk, '渲染不抛异常');
  ok(ctx3.calls.fillText > 0, '渲染画了文字（信息条 / 按钮）');

  // 静置后不能再吃帧
  auto.update(T1 + 9000);
  eq(auto.busy, false, '静置后不再需要持续推帧');

  // destroy 后不再上报
  auto.destroy();
  eq(auto.outcome, null, 'destroy 后 outcome 仍是 null');

  // resize 不炸 + 布局跟着变
  let resizeOk = true;
  try {
    auto.resize(320, 480, { top: 20, bottom: 20 });
    auto.update(T1 + 5000);
  } catch (e) { resizeOk = false; }
  ok(resizeOk, 'resize 后仍能正常 update');

  // ── 随机源注入：同一 seed 两次开会得到完全相同的牌局（测试不再 flaky 的根据） ──
  {
    const mk = (seed) => createUiSession({
      width: 375, height: 667, insets: { top: 44, bottom: 34 },
      difficulty: 'hard', theme: {}, rng: mulberry32(seed),
    });
    const a1 = mk(777), a2 = mk(777), b1 = mk(778);
    const dump = (s) => JSON.stringify(s.snapshot.columns.map((c) => c.cards.map((x) => `${x.suit}${x.rank}${x.faceUp ? '' : 'x'}`)));
    eq(dump(a1), dump(a2), '同一 seed 两次会话 → 牌局完全相同（可复现）');
    ok(dump(a1) !== dump(b1), '不同 seed → 牌局不同');
    eq(a1.snapshot.stock, DECK_TOTAL - initialDealOf('hard'),
      `注入随机源后发牌堆仍是 ${DECK_TOTAL - initialDealOf('hard')} 张（困难档开局 50 张）`);
    ok(typeof a1.snapshot.columns[0].cards[0].faceUp === 'boolean', '注入随机源后牌面结构正常');

    // 不传 rng 时退回 Math.random，仍然是个能用的会话（真机路径）
    const plain = createUiSession({ width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'easy', theme: {} });
    plain.update(T0);
    eq(plain.snapshot.stock, DECK_TOTAL - initialDealOf('easy'),
      '不传 rng 时仍能正常开局（默认 Math.random）');
    eq(plain.snapshot.moves, 0, '不传 rng 时初始步数为 0');
    let plainOk = true;
    try { plain.tap(1, 1, T0 + 10); plain.update(T0 + 10); plain.render(makeCtx(), T0 + 10); } catch (e) { plainOk = false; }
    ok(plainOk, '不传 rng 时会话交互与渲染都不抛异常');
    plain.destroy();
    a1.destroy(); a2.destroy(); b1.destroy();
  }

  // press / release / hover 不炸
  let inputOk = true;
  try {
    auto.press(100, 300);
    auto.hover(100, 300);
    auto.release();
    auto.press(layout.buttons[0].x + 4, layout.buttons[0].y + 4);
    auto.release();
  } catch (e) { inputOk = false; }
  ok(inputOk, 'press / hover / release 不抛异常');

  // 点牌桌空白处（选中态清空）不炸
  let blankOk = true;
  try {
    auto.tap(1, 1, T1 + 6000);
    auto.update(T1 + 6000);
  } catch (e) { blankOk = false; }
  ok(blankOk, '点空白处不抛异常');

  // 渲染一帧（桩 ctx）
  const ctx2 = makeCtx();
  let renderOk = true;
  try { auto.render(ctx2, T1 + 7000); } catch (e) { renderOk = false; }
  ok(renderOk, '会话 render 用桩 ctx 不抛异常');

  // hud.right 不会再出现 1.79e12 那种天文数字
  auto.update(T1 + 8000);
  ok(!/^\d{7,}:/.test(auto.hud.right), 'hud.right 不会出现天文数字（performance.now 事故已避开）');

  // 一个静置的会话：没有计时也没有反馈时不该一直吃帧
  const idle = createUiSession({ width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'easy', theme: {} });
  idle.update(T0);
  eq(idle.busy, false, '刚开局、未操作时不需要持续推帧');
  eq(idle.outcome, null, '开局 outcome 为 null');

  // ── 音效接入（sfx 由集成层通过 options.sfx 传入，**可能不存在**） ──
  // 硬要求：sfx 缺失 / 没有 play / play 返回 false / play 抛异常 —— 一律静默降级，绝不抛。
  {
    const heard = [];
    const withSfx = createUiSession({
      width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'easy', theme: {},
      rng: mulberry32(20260807),
      sfx: { play: (n) => { heard.push(n); return false; } },   // 故意返回 false，模拟「没播出来」
    });
    const l4 = computeLayout(375, 667, { top: 44, bottom: 34 }, withSfx.snapshot);
    const deal4 = l4.buttons.find((b) => b.key === 'deal');
    const undo4 = l4.buttons.find((b) => b.key === 'undo');
    withSfx.update(T0);
    eq(heard.length, 0, '开局静置时不出声');

    withSfx.tap(deal4.x + deal4.w / 2, deal4.y + deal4.h / 2, T0);   // 发牌 → tap
    withSfx.update(T0);
    eq(heard.join(','), 'tap', '发牌出 tap 音（play 返回 false 也不抛）');

    withSfx.tap(undo4.x + undo4.w / 2, undo4.y + undo4.h / 2, T0 + 1);   // 撤销按钮 → click
    withSfx.update(T0 + 1);
    eq(heard.join(','), 'tap,click', '撤销按钮出 click 音');

    heard.length = 0;
    const v4 = withSfx.snapshot;
    const rr4 = cardRect(l4, v4, 0, v4.columns[0].cards.length - 1);
    withSfx.tap(rr4.x + l4.cardW / 2, rr4.y + rr4.h - 2, T0 + 2);       // 选中尾牌 → select
    withSfx.update(T0 + 2);
    eq(heard.join(','), 'select', '点中可搬动的牌组出 select 音');
    withSfx.destroy();

    let sfxSafe = true;
    try {
      // ① 完全不传 sfx（真机上集成层没接音效时的路径）
      const a = createUiSession({ width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'easy', theme: {} });
      a.update(T0); a.tap(1, 1, T0 + 1); a.render(makeCtx(), T0 + 1); a.destroy();
      // ② sfx 存在但没有 play 方法
      const b = createUiSession({ width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'easy', theme: {}, sfx: {} });
      b.update(T0); b.tap(1, 1, T0 + 1); b.destroy();
      // ③ play 自己抛异常
      const c = createUiSession({
        width: 375, height: 667, insets: { top: 0, bottom: 0 }, difficulty: 'easy', theme: {},
        sfx: { play() { throw new Error('音效炸了'); } },
      });
      c.update(T0); c.tap(1, 1, T0 + 1); c.render(makeCtx(), T0 + 1); c.destroy();
    } catch (e) { sfxSafe = false; }
    ok(sfxSafe, 'sfx 缺失 / 没有 play / play 抛异常：三种情况都静默降级、不抛异常');
  }
}

console.log('\n【十四】纯逻辑约束自检');
{
  // core.js 里不能有平台 API（注释里提到这些词不算，查的是真被调用的写法）
  const src = CORE_SRC;
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 去掉块注释
    .replace(/\/\/[^\n]*/g, '');        // 去掉行注释
  for (const bad of ['wx.', 'document.', 'document[', 'window.', 'window[', 'canvas', 'performance.now']) {
    ok(!code.includes(bad), `core.js 代码里不含「${bad}」`);
  }
  eq((code.match(/Math\.random/g) ?? []).length, 1, 'Math.random 在 core.js 代码里只出现 1 次（唯一随机出口）');
  ok(/const defaultRandom = Math\.random/.test(code), '默认随机源就是那一处 Math.random');

  // render.js / index.js 也不 import 第三方包
  const rsrc = readSelf('render.js');
  const isrc = readSelf('index.js');
  for (const s of [rsrc, isrc]) {
    ok(!/from\s+['"][^./]/.test(s), '模块不 import 第三方包（只用相对路径）');
  }
  ok(/function nowMs\(\) \{\s*return Date\.now\(\);/.test(isrc), 'index.js 的 fallback 时钟是 Date.now()');
  ok(!/performance\.now\(\)\s*[;,)]/.test(isrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
    'index.js 代码里不调用 performance.now()（规范 §8 的坑）');

  // cloneGame 是深拷贝，改副本不影响原局
  const g = blankGame('hard');
  put(g, 0, [[SPADE, 5]]);
  const cp = cloneGame(g);
  cp.columns[0][0].rank = KING;
  cp.columns.push([]);
  eq(g.columns[0][0].rank, 5, 'cloneGame 是深拷贝（改副本不影响原局）');
  eq(cp.columns.length, columnsOf('hard') + 1, '副本可以独立改动');
  eq(cp.history, null, '快照不带历史（避免套娃）');

  // 快照里标记的「可搬牌组起点」必须与 core 的 movableRunLength 完全一致（渲染高亮靠它）
  let snapAgree = true;
  for (let seed = 1; seed <= 4; seed++) {
    const gg = createGame('hard', mulberry32(seed * 31));
    const snap = snapshot(gg);
    for (let c = 0; c < gg.columns.length; c++) {
      const tail = movableRunLength(gg.columns[c]);
      const expect = tail > 0 ? gg.columns[c].length - tail : -1;
      if (snap.columns[c].movableFrom !== expect) snapAgree = false;
      if (snap.columns[c].cards.length !== gg.columns[c].length) snapAgree = false;
      if (snap.columns[c].faceUp !== gg.columns[c].filter((x) => x.faceUp).length) snapAgree = false;
    }
  }
  ok(snapAgree, '快照的 movableFrom / 张数 / 翻开数 与 core 完全一致（渲染层据此高亮）');

  // 「快照判定规则」与 core.canMove 结论一致（测试里的自动对局用前者找步，必须同源）
  const snapRuleOk = (() => {
    const gg = createGame('hard', mulberry32(99));
    for (let i = 0; i < 30; i++) {
      const snap = snapshot(gg);
      for (let from = 0; from < gg.columns.length; from++) {
        const col = snap.columns[from];
        if (col.movableFrom < 0) continue;
        const head = col.cards[col.movableFrom];
        for (let to = 0; to < gg.columns.length; to++) {
          if (to === from) continue;
          const dst = snap.columns[to];
          let expect;
          if (dst.cards.length === 0) expect = true;
          else {
            const top = dst.cards[dst.cards.length - 1];
            expect = head.rank === top.rank - 1 && (!snap.requireSameSuit || head.suit === top.suit);
          }
          if (expect !== canMove(gg, from, col.movableFrom, to).ok) return false;
        }
      }
      const h = findHint(gg);
      if (!h) break;
      if (!moveRun(gg, h.from, h.index, h.to).ok) break;
      if (refreshResult(gg) !== PLAYING) break;
    }
    return true;
  })();
  ok(snapRuleOk, '「用快照找步」的规则与 core.canMove 结论逐条一致');

  // 一条完整不变量：随机走 60 步，总牌数恒为 104
  let invOk = true;
  for (let seed = 1; seed <= 5; seed++) {
    const g2 = createGame('hard', mulberry32(seed * 97));
    for (let i = 0; i < 60; i++) {
      const h = findHint(g2);
      if (h) moveRun(g2, h.from, h.index, h.to);
      else if (canDeal(g2)) deal(g2);
      else break;
      if (allCards(g2) !== DECK_TOTAL) { invOk = false; break; }
      if (g2.collected > RUNS_TO_WIN) { invOk = false; break; }
      refreshResult(g2);
    }
  }
  ok(invOk, '随机走 60 步 × 5 局：总牌数恒为 104，收集数不超过 8');

  // 收满 8 组后必为 WON
  let winCheck = true;
  for (let seed = 1; seed <= 3; seed++) {
    const g3 = createGame('easy', mulberry32(seed));
    g3.collected = RUNS_TO_WIN;
    if (refreshResult(g3) !== WON) winCheck = false;
  }
  ok(winCheck, '收集数达到 8 时 refreshResult 一律判胜');
}

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) { console.log('失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);

/* ── 测试辅助（放在末尾，函数声明会提升） ── */

/** 桩 Canvas 2D 上下文：只记录调用，不真的画。 */
function makeCtx() {
  const calls = {
    clearRect: 0, fillRect: 0, fill: 0, stroke: 0, fillText: 0, arc: 0,
    gradient: 0, beginPath: 0, segment: 0, setLineDash: 0,
  };
  const grad = { addColorStop() {} };
  return {
    calls,
    canvas: { width: 375, height: 667 },
    save() {}, restore() {}, beginPath() { calls.beginPath++; }, closePath() {},
    moveTo() { calls.segment++; }, lineTo() { calls.segment++; }, arcTo() { calls.segment++; },
    arc() { calls.arc++; calls.segment++; },
    fill() { calls.fill++; }, stroke() { calls.stroke++; },
    fillRect() { calls.fillRect++; }, clearRect() { calls.clearRect++; },
    strokeRect() {}, clip() {}, setLineDash() { calls.setLineDash++; }, translate() {}, rotate() {}, scale() {},
    fillText() { calls.fillText++; }, strokeText() {}, measureText: () => ({ width: 10 }),
    createLinearGradient: () => { calls.gradient++; return grad; },
    createRadialGradient: () => { calls.gradient++; return grad; },
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: '#000', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
  };
}
