/**
 * 蜘蛛纸牌核心逻辑（纯函数 + 一个纯数据会话，零依赖，可在 Node 里直接跑测试）
 *
 * 设计约束（沿用「荒潮拾荒者」/「纯净玩」的架构理念）：
 *   - 本文件不碰任何平台 API（无 wx、无 document、无 window、无 canvas）；
 *   - 唯一的外部能力是注入的随机数 rng（默认 defaultRandom），测试里换成种子随机数即可完全复现；
 *   - 牌局状态显式，发牌 / 移动 / 收牌 / 撤销 / 胜负全部可确定性复现；
 *   - 为 UI 提供「可移动牌组」「落点是否合法」「收集区计数」等渲染所需信息。
 *
 * 规则要点：
 *   - 104 张（8 副 K→A：1 门花色 × 8 副 / 2 门 × 4 副 / 4 门 × 2 副）；
 *   - **难度同时管三个维度**（用户要求「难度不能只看花色」+「列数按难度递增」）：
 *       ① 花色门数：easy=只用黑桃 / normal=黑桃+红桃 / hard=四门全用；
 *       ② **列数**：easy 5 列 / normal 7 列 / hard 9 列（列越少越好腾挪）；
 *       ③ 开局空列数：easy 留 2 个空列 / normal·hard 各留 1 个
 *          —— 空列是玩家的腾挪空间，用户明确要求「开局留 1~2 个空列，方便操作」；
 *       ④ 开局堆叠量：initialDeal 24 / 34 / 50（只发给非空列）。
 *   - **发牌规则（本次改动）**：旧版是「有空列就不能发牌」，而新版开局**就带空列**，
 *     两者直接冲突（会卡死：空列搬不开就永远发不了牌）。现改为：
 *     **只要发牌堆够一整轮（= 列数张）就能发，空列不再是障碍；发牌给每一列，
 *     空列也会收到牌（于是空列被自然填上）**。牌数守恒与轮数不变，不会卡死。
 *   - 发牌堆长度必须是列数的整数倍（见 LEVELS 的整除校验），每轮每列各 1 张、翻开；
 *   - 只能整体移动「同花色且降序」的连续牌组；压到别的牌上须比它小 1（难度决定是否要求同花色）；
 *   - 某列形成 K→A 的同花色完整序列即自动收走；收满 8 组即胜。
 */

/* ───────────────────────── 常量 ───────────────────────── */

/** 花色：0 黑桃 / 1 红桃 / 2 梅花 / 3 方块（顺序与 SUIT_CHARS 对应）。 */
export const SPADE = 0;
export const HEART = 1;
export const CLUB = 2;
export const DIAMOND = 3;

/** 花色显示字符（红黑判色用 isRedSuit）。 */
export const SUIT_CHARS = ['♠', '♥', '♣', '♦'];
export const SUIT_NAMES = ['黑桃', '红桃', '梅花', '方块'];

/** 牌面点数：1=A … 11=J、12=Q、13=K。 */
export const ACE = 1;
export const KING = 13;

/** 牌面点数显示。 */
export const RANK_LABELS = ['.', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/**
 * 列数上限（困难档 9 列）。**各档的实际列数由 LEVELS[].columns 决定（5 / 7 / 9）**，
 * 引擎一律用 `game.columns.length`，不要再用一个全局常量当列数——
 * 「三档都是 10 列」正是本次要废掉的旧语义。
 */
export const MAX_COLUMNS = 9;
export const DECK_TOTAL = 104;
/** 经典蜘蛛的开局张数（= 困难档 50）。各档实际开局张数见 LEVELS[].initialDeal / initialDealOf()。 */
export const DEAL_TOTAL = 50;

/** 需要收满多少组算胜利（8 副 K→A）。 */
export const RUNS_TO_WIN = 8;

/** 对局状态。 */
export const PLAYING = 'playing';
export const WON = 'won';
export const STUCK = 'stuck';   // 无牌可发且没有任何合法走法（判负）

/**
 * 三档难度：**每个档位同时描述「花色门数」「列数」「开局空列」「开局堆叠量」**。
 *
 *   suits        用哪几门花色（1 / 2 / 4 门）
 *   columns      **列数：简单 5 / 普通 7 / 困难 9**（用户明确要求：列数按难度递增）
 *   emptyCols    开局留几个空列（简单 2 / 普通 1 / 困难 1）——空列是玩家的腾挪空间
 *   initialDeal  开局发几张（只发给「非空列」，空列留在牌桌最右侧）
 *
 * ⚠️ 整除校验（发牌是「每轮每列各 1 张」，所以 牌堆张数 必须是 列数 的整数倍）：
 *   牌堆 = 104 − initialDeal
 *     easy   104 − 24 = 80 = 5 × 16   → 发 16 轮，每轮 5 张
 *     normal 104 − 34 = 70 = 7 × 10   → 发 10 轮，每轮 7 张
 *     hard   104 − 50 = 54 = 9 ×  6   → 发  6 轮，每轮 9 张
 *   开局每列张数（只发给非空列、余数给前几列各补 1 张）：
 *     easy   fill=3  24/3 → 8,8,8                  （右侧空 2 列）
 *     normal fill=6  34/6 → 6,6,6,6,5,5            （右侧空 1 列）
 *     hard   fill=8  50/8 → 7,7,6,6,6,6,6,6        （右侧空 1 列）
 *   三档都能整轮发完、一张不剩（不会出现「最后一轮只发一半」）。
 *
 * 注：列数变少 → 同一列最终会堆得更高（104 / 5 ≈ 21 张），这是列数递减的必然代价，
 * 渲染层靠「错开间距自适应压缩」兜住，逻辑层只保证牌数守恒与不卡死。
 */
export const LEVELS = {
  easy: {
    key: 'easy', name: '简单', suits: [SPADE], columns: 5, emptyCols: 2, initialDeal: 24,
    desc: '1 种花色 · 5 列 · 空 2 列 · 牌堆 16 轮',
  },
  normal: {
    key: 'normal', name: '普通', suits: [SPADE, HEART], columns: 7, emptyCols: 1, initialDeal: 34,
    desc: '2 种花色 · 7 列 · 空 1 列 · 牌堆 10 轮',
  },
  hard: {
    key: 'hard', name: '困难', suits: [SPADE, HEART, CLUB, DIAMOND], columns: 9, emptyCols: 1, initialDeal: 50,
    desc: '4 种花色 · 9 列 · 空 1 列 · 牌堆 6 轮',
  },
};

/** 难度 key 列表（顺序即难度递增）。 */
export const LEVEL_KEYS = Object.keys(LEVELS);

/** 取难度配置，未知 key 退回简单。 */
export function levelConfig(key) {
  return LEVELS[key] ?? LEVELS.easy;
}

/**
 * 某难度开局发几张牌（含兜底：配置里没写就按经典 50 张）。
 * 渲染层/测试层都用它，避免各处再抄一份 24/34/50。
 */
export function initialDealOf(key) {
  const n = levelConfig(key).initialDeal;
  return Number.isFinite(n) ? n : DEAL_TOTAL;
}

/** 某难度的列数（5 / 7 / 9）。引擎内部一律用 game.columns.length，这里供 UI/测试取配置值。 */
export function columnsOf(key) {
  const n = levelConfig(key).columns;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : MAX_COLUMNS;
}

/** 某难度开局留几个空列（0…columns-1）。 */
export function emptyColsOf(key) {
  const n = levelConfig(key).emptyCols;
  const cols = columnsOf(key);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), cols - 1);   // 至少留一列有牌，否则开局就没得玩
}

/** 某难度「开局要发牌的列数」= 列数 − 空列数。 */
export function filledColsOf(key) {
  return columnsOf(key) - emptyColsOf(key);
}

/** 某难度牌堆能发几轮（每轮 = 列数张）。三档必须都是整数，否则最后一轮发不满。 */
export function stockRoundsOf(key) {
  return (DECK_TOTAL - initialDealOf(key)) / columnsOf(key);
}

/* ───────────────────────── 随机数 ───────────────────────── */

/**
 * 默认随机源。**本文件里 Math.random 只出现这一次**——洗牌的一切随机性
 * 都必须走注入的 rng，测试才能用种子随机数把牌局完全复现。
 */
const defaultRandom = Math.random;

/**
 * 可复现的伪随机数生成器（mulberry32）。
 * 只用到位运算与 Math.imul，不含任何平台 API。
 * @param seed 任意整数种子
 * @returns {() => number} 返回 [0,1) 的随机数函数
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────────────────────── 牌与工具 ───────────────────────── */

/** 是否红色花色（红桃/方块）。 */
export function isRedSuit(suit) {
  return suit === HEART || suit === DIAMOND;
}

/** 牌面文字，如 '♠Q'；给 UI 用，也方便测试打印。 */
export function cardText(card) {
  if (!card) return '--';
  return `${SUIT_CHARS[card.suit] ?? '?'}${RANK_LABELS[card.rank] ?? '?'}`;
}

/**
 * 建立一副洗好的牌。
 * 难度决定参与洗牌的花色（两副牌里只用到的花色会被挑出来），
 * 保证 1 门难度下整局只有黑桃、每张牌恰好 8 份。
 *
 * @param {string} levelKey 难度 key
 * @param {() => number} rng 随机源
 * @returns {Array<{id:number,suit:number,rank:number}>} 洗好的牌（长度恒为 104）
 */
export function buildDeck(levelKey = 'easy', rng = defaultRandom) {
  const cfg = levelConfig(levelKey);
  // 难度决定「用几门花色」：简单档只用黑桃，普通档黑桃+红桃，困难档四门全用。
  // 注意花色必须取自 cfg.suits 本身（前 N 门），这样简单档整副牌就是黑桃。
  const chosen = cfg.suits;

  const deck = [];
  let id = 0;
  // 8 副牌：只为用到的花色各发 8 份，于是 1 门 = 104 张、2 门 = 104 张、4 门 = 104 张
  const copies = 8 / chosen.length;   // 每个花色要造几副（8 / 1 = 8、8 / 2 = 4、8 / 4 = 2）
  for (let copy = 0; copy < copies; copy++) {
    for (const suit of chosen) {
      for (let rank = ACE; rank <= KING; rank++) {
        deck.push({ id: id++, suit, rank });
      }
    }
  }

  // Fisher–Yates：只依赖注入的 rng，种子相同 → 牌局完全相同
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

/** 列里的一张牌 = 基础牌 + 是否翻开（牌堆里的牌本身不改动，方便快照克隆）。 */
function toPileCard(card, faceUp) {
  return { id: card.id, suit: card.suit, rank: card.rank, faceUp: !!faceUp };
}

/** 深拷贝一列（撤销快照用）。 */
function cloneColumn(col) {
  return col.map((c) => ({ id: c.id, suit: c.suit, rank: c.rank, faceUp: c.faceUp }));
}

/** 造 n 个空列（n = 该难度的列数）。 */
function emptyColumns(n = MAX_COLUMNS) {
  const cols = [];
  for (let i = 0; i < n; i++) cols.push([]);
  return cols;
}

/** 一列里已翻开的牌数（UI 算错开高度用）。 */
export function faceUpCount(col) {
  let n = 0;
  for (const c of col) if (c.faceUp) n++;
  return n;
}

/** 一列里未翻开的牌数。 */
export function faceDownCount(col) {
  return col.length - faceUpCount(col);
}

/* ───────────────────────── 牌堆操作（对列本身的操作，不改局面计数） ───────────────────────── */

/**
 * 一列里「能整体搬走的最长牌组」的牌数。
 *
 * 规则：从列尾往上，只要相邻两张是「同花色且点数恰好差 1（下小上大）」就继续往上吃，
 * 直到断开为止。
 *
 * @param {Array} col 一列
 * @param {number} [index] 先决条件：只能搬「以 index 开头、直到列尾」的那一段。
 *                         省略时返回整列尾部牌组的牌数；给了 index 但该下标不在
 *                         尾部牌组内（含 index=列首那种「只剩一张翻开」的边界）时返回 0。
 * @returns {number} 牌数
 */
export function movableRunLength(col, index = null) {
  if (!col || col.length === 0) return 0;

  // 1) 先算出整列尾部同花降序牌组的起点
  let start = col.length - 1;
  while (start > 0) {
    const lower = col[start - 1];
    const upper = col[start];
    const ok = lower.faceUp && upper.faceUp
      && lower.suit === upper.suit
      && lower.rank === upper.rank + 1;
    if (!ok) break;
    start--;
  }

  // 省略 index：整条尾部牌组都能搬
  if (index === null) return col.length - start;

  // 2) 尾部牌组**已形成一个整体**：点其中任意一张都只会搬走整条，不允许只搬后缀。
  //    （用户要求：二叠到三上、形成同花降序之后它们就是一个整体，移动必须整体移动）
  if (index >= start && index <= col.length - 1) return col.length - start;
  return 0;
}

/** 列尾那张翻开的牌（空列或全未翻开返回 null）。 */
export function topCard(col) {
  if (!col || col.length === 0) return null;
  const c = col[col.length - 1];
  return c.faceUp ? c : null;
}

/**
 * 翻开一列**新露出的最上面那一张**（只翻一张！），返回翻开的张数（0 或 1）。
 *
 * ⚠️ 行为约定（用户要求「移动当前牌后不要让后面的牌全显示出来，只显示最外面一张」）：
 *   旧版是「列尾连续几张背面就一次全翻开」——开局每列压着 4–6 张背面，
 *   把最上面那张明牌搬走后，底下 4–5 张**唰地全部亮出来**，等于把整局的暗牌
 *   一次性送给了玩家，难度直接崩掉。现在一次只揭一张，与实体蜘蛛纸牌一致。
 *
 * @returns {number} 本次翻开的张数（顶牌已是正面/空列 → 0，天然幂等）
 */
export function flipExposed(col) {
  if (!col || col.length === 0) return 0;
  const top = col[col.length - 1];
  if (top.faceUp) return 0;
  top.faceUp = true;
  return 1;
}

/**
 * 从一列取走最后 count 张牌。count 超界时取走整列（防御性：绝不允许因为
 * count 大于列长而切开负数下标，那会返回空数组、把牌「弄丢」）。
 * @returns {Array} 取走的牌（按原顺序）
 */
export function takeTail(col, count) {
  if (!col || count <= 0) return [];
  if (count >= col.length) {
    const all = col.slice();
    col.length = 0;
    return all;
  }
  return col.splice(col.length - count, count);
}

/**
 * 把一组牌压到某列上。
 * @returns {{ok:boolean, reason?:string}} 牌组的首张比目标列顶牌小 1（或目标为空列）才允许
 */
export function dropRun(col, run, requireSameSuit) {
  if (!run || run.length === 0) return { ok: false, reason: 'emptyRun' };
  const head = run[0];
  const top = topCard(col);

  if (top) {
    if (head.rank !== top.rank - 1) return { ok: false, reason: 'rank' };
    if (requireSameSuit && head.suit !== top.suit) return { ok: false, reason: 'suit' };
  }
  for (const c of run) col.push({ id: c.id, suit: c.suit, rank: c.rank, faceUp: true });
  return { ok: true };
}

/* ───────────────────────── 建局与发牌 ───────────────────────── */

/**
 * 创建一局蜘蛛纸牌的初始状态（已按难度发好 initialDeal 张、翻开每列最后一张）。
 *
 * 发牌顺序：**只发给「非空列」**（前 fill = columns − emptyCols 列），轮流各发 1 张，
 * 发满 initialDeal 张为止（余数给前几列各补 1 张）；**最右侧 emptyCols 列留空**
 * ——用户明确要求「开局留 1~2 个空列，方便操作游玩」。
 *   easy   5 列 / 空 2 列 → 8,8,8,0,0        发牌堆 80 张（16 轮）
 *   normal 7 列 / 空 1 列 → 6,6,6,6,5,5,0    发牌堆 70 张（10 轮）
 *   hard   9 列 / 空 1 列 → 7,7,6,6,6,6,6,6,0 发牌堆 54 张（6 轮）
 *
 * @param {string} levelKey 难度 key
 * @param {() => number} rng 随机源
 */
export function createGame(levelKey = 'easy', rng = defaultRandom) {
  const cfg = levelConfig(levelKey);
  const deck = buildDeck(cfg.key, rng);
  const cols = columnsOf(cfg.key);              // 5 / 7 / 9
  const empties = emptyColsOf(cfg.key);         // 2 / 1 / 1
  const fill = cols - empties;                  // 开局真正发牌的列数
  const dealCount = initialDealOf(cfg.key);     // 24 / 34 / 50

  const columns = emptyColumns(cols);
  let next = 0;
  // ⚠️ 必须 floor：旧版写 DEAL_TOTAL / 10 = 5.4 直接比较会多跑一轮（开局发成 64 张）。
  // 这里按难度的 dealCount 与「发牌列数 fill」取整轮数再补余数。
  const fullRounds = Math.floor(dealCount / fill);   // 整轮（非空列各 1 张）
  const extraCols = dealCount % fill;                // 余数：前几列各再补 1 张
  for (let round = 0; round < fullRounds; round++) {
    for (let c = 0; c < fill; c++) {
      columns[c].push(toPileCard(deck[next++], false));
    }
  }
  // 补一轮：只给前 extraCols 列各再发 1 张
  for (let c = 0; c < extraCols; c++) {
    columns[c].push(toPileCard(deck[next++], false));
  }

  // 每列最后一张翻开（这是玩家唯一能操作的牌）；空列没有牌，自然保持空
  for (const col of columns) {
    if (col.length) col[col.length - 1].faceUp = true;
  }

  return {
    key: cfg.key,                 // 难度
    requireSameSuit: cfg.key !== 'easy',  // 压牌是否要求同花色（简单档只有 1 门花色，天然同花）
    columns,                      // 5 / 7 / 9 列牌堆（最右侧若干列为空列）
    stock: deck.slice(next),      // 发牌堆（剩余 80/70/54 张，按难度）
    collected: 0,                 // 已收走的完整序列组数（8 组即胜）
    moves: 0,                     // 有效操作次数（移动 + 发牌）
    result: PLAYING,              // playing / won / stuck
    history: [],                  // 撤销快照栈
    lastAction: null,             // 最近一次操作，供 UI 做落点反馈
  };
}

/** 深拷贝一份局面快照（撤销 / 独立推演用）。 */
export function cloneGame(game) {
  return {
    key: game.key,
    requireSameSuit: game.requireSameSuit,
    columns: game.columns.map(cloneColumn),
    stock: game.stock.map((c) => ({ id: c.id, suit: c.suit, rank: c.rank })),
    collected: game.collected,
    moves: game.moves,
    result: game.result,
    history: null,          // 快照不带历史，避免套娃；还原时也不会覆盖 game.history
    lastAction: game.lastAction ? { ...game.lastAction } : null,
  };
}

/* ───────────────────────── 收牌 ───────────────────────── */

/**
 * 某列列尾是否是 K→A 的同花色完整 13 张（即可以收走）。
 * @returns {boolean}
 */
export function hasCompleteRun(col) {
  if (!col || col.length < KING) return false;
  const start = col.length - KING;
  for (let i = 0; i < KING; i++) {
    const c = col[start + i];
    if (!c.faceUp) return false;
    if (c.rank !== KING - i) return false;         // K, Q, J, ... A
    if (c.suit !== col[start].suit) return false;   // 同花色
  }
  return true;
}

/**
 * 收走所有已成型的完整序列（一列可能刚被压上第 13 张）。
 * @returns {number} 本次收走的组数
 */
export function collectRuns(game) {
  let got = 0;
  for (const col of game.columns) {
    // 一列理论上不会同时存在两组完整序列，但循环防御一下
    while (hasCompleteRun(col)) {
      col.splice(col.length - KING, KING);
      game.collected++;
      got++;
      flipExposed(col);   // 收走后下面那张（若有）自动翻开
    }
  }
  return got;
}

/* ───────────────────────── 合法移动查询 ───────────────────────── */

/**
 * 是否能从 from 列搬 index 起的牌组到 to 列。
 *
 * 规则：
 *   ① 搬动的必须是「同花色且降序」的连续牌组；
 *   ② 目标为空列时任意牌组可放；
 *   ③ 压到别的牌上须比它小 1，且（normal/hard）花色必须相同；
 *   ④ 不能搬到源列自己。
 *
 * @returns {{ok:boolean, reason?:string, run?:Array, count?:number}}
 *   reason: 'over' 对局结束 / 'same' 源列与目标列相同 / 'empty' 源列为空 /
 *           'index' 该下标起的牌组不可整体移动 / 'rank' 点数不连续 / 'suit' 花色不同 / 'reason' 其它
 */
export function canMove(game, from, index, to) {
  if (!game || game.result !== PLAYING) return { ok: false, reason: 'over' };
  if (from === to) return { ok: false, reason: 'same' };
  const cols = game.columns.length;   // 列数按难度走（5/7/9），不再是全局常量
  if (from < 0 || from >= cols || to < 0 || to >= cols) return { ok: false, reason: 'range' };

  const src = game.columns[from];
  const dst = game.columns[to];
  if (!src || src.length === 0) return { ok: false, reason: 'empty' };
  if (index < 0 || index >= src.length) return { ok: false, reason: 'range' };

  const count = movableRunLength(src, index);
  if (count <= 0) return { ok: false, reason: 'index' };

  const status = canDrop(game, dst, src[index]);
  if (!status.ok) return { ok: false, reason: status.reason };

  return { ok: true, count, run: src.slice(index, src.length) };
}

/**
 * 某个牌组的首张能否落到目标列上（不真落，只判定）。
 * @returns {{ok:boolean, reason?:string}}
 */
export function canDrop(game, dstColumn, headCard) {
  const top = topCard(dstColumn);
  if (!top) return { ok: true };                                  // 空列：任意牌可放
  if (headCard.rank !== top.rank - 1) return { ok: false, reason: 'rank' };
  if (game.requireSameSuit && headCard.suit !== top.suit) return { ok: false, reason: 'suit' };
  return { ok: true };
}

/* ───────────────────────── 走子 ───────────────────────── */

/**
 * 执行一次移动（不检查撤销栈，调用方用 applyMove）。
 * @returns {{ok:boolean, reason?:string, moved?:number, collected?:number}}
 */
export function moveRun(game, from, index, to) {
  const check = canMove(game, from, index, to);
  if (!check.ok) return { ok: false, reason: check.reason };

  const src = game.columns[from];
  const dst = game.columns[to];
  const run = takeTail(src, check.count);
  const dropped = dropRun(dst, run, false);   // 合法性上面已判定，这里只负责落牌
  if (!dropped.ok) {
    // 理论上到不了；防御性回滚，保证不会丢牌
    for (const c of run) src.push(c);
    return { ok: false, reason: 'reason' };
  }

  if (src.length && !src[src.length - 1].faceUp) flipExposed(src);   // 露出新牌就翻开
  game.moves++;
  const collected = collectRuns(game);
  game.lastAction = { type: 'move', from, to, index, count: check.count, collected };
  return { ok: true, moved: check.count, collected };
}

/** 把所有牌从一列搬到另一列（撤销时用）。 */
function moveAll(src, dst) {
  for (const c of src) dst.push(c);
  src.length = 0;
}

/**
 * 撤销上一步。
 * @returns {{ok:boolean, reason?:string}} 无历史时返回 reason:'empty'
 */
export function undo(game) {
  if (!game || !game.history || game.history.length === 0) return { ok: false, reason: 'empty' };
  const snap = game.history.pop();
  game.columns = snap.columns;
  game.stock = snap.stock;
  game.collected = snap.collected;
  game.moves = snap.moves;
  game.result = PLAYING;   // 撤销一律回到进行中（可能从「困死」里救回来）
  game.lastAction = { type: 'undo' };
  return { ok: true };
}

/** 本局是否已有可撤销的操作。 */
export function canUndo(game) {
  return !!(game && game.history && game.history.length > 0);
}

/* ───────────────────────── 发牌 ───────────────────────── */

/**
 * 是否可以发牌：**发牌堆够一整轮（= 当前列数张）就能发**。
 *
 * ⚠️ 规则变更（本次改造的核心之一）：旧版要求「每一列都非空」才能发牌。
 * 但新版开局**自带 1~2 个空列**，两者直接冲突 —— 玩家一旦动不了空列就永远发不出牌，
 * 整局卡死。现在取消「空列不能发」的限制：发牌给每一列，**空列也会收到牌**
 * （于是空列被自然填上）。牌数守恒、每轮固定列数张、轮数不变。
 */
export function canDeal(game) {
  if (!game || game.result !== PLAYING) return false;
  const need = game.columns.length;
  return game.stock.length >= need;
}

/**
 * 发一轮：每列各发 1 张（翻开），共「列数」张（空列也会收到，直接被填上）。
 * @returns {{ok:boolean, reason?:string, dealt?:number, collected?:number}}
 *   reason: 'over' 已结束 / 'stock' 发牌堆不足一整轮 / 'noop' 未发成功
 */
export function deal(game) {
  if (!game || game.result !== PLAYING) return { ok: false, reason: 'over' };
  const cols = game.columns.length;
  if (game.stock.length < cols) return { ok: false, reason: 'stock' };

  for (let c = 0; c < cols; c++) {
    const card = game.stock.pop();
    if (!card) return { ok: false, reason: 'noop' };
    game.columns[c].push(toPileCard(card, true));
  }

  game.moves++;
  const collected = collectRuns(game);
  game.lastAction = { type: 'deal', collected };
  return { ok: true, dealt: cols, collected };
}

/* ───────────────────────── 提示 / 死局 / 胜负 ───────────────────────── */

/**
 * 找一个可行的移动（提示用）。
 * 优先「能压上去且不被判死」的走法：先把非空目标列排前面，空列排最后。
 * @returns {{from:number,index:number,to:number,count:number}|null}
 */
export function findHint(game) {
  if (!game || game.result !== PLAYING) return null;
  const cols = game.columns.length;

  // 按优先级：同花色目标 > 别的花色目标 > 空列（空列留到最后用）
  for (const pass of ['sameSuit', 'anySuit', 'empty']) {
    let best = null;
    for (let from = 0; from < cols; from++) {
      const src = game.columns[from];
      if (!src.length) continue;

      // 只枚举「尾部这条同花降序牌组」里的起点：尾牌本身 + 逐个往上
      const tail = movableRunLength(src, src.length - 1);
      const tailStart = tail > 0 ? src.length - tail : src.length - 1;
      for (let index = src.length - 1; index >= tailStart; index--) {
        if (!src[index].faceUp) break;
        if (movableRunLength(src, index) <= 0) continue;
        for (let to = 0; to < cols; to++) {
          if (to === from) continue;
          const dst = game.columns[to];
          const target = topCard(dst);
          if (pass === 'empty' && target) continue;
          if (pass === 'sameSuit' && (!target || target.suit !== src[index].suit)) continue;
          if (pass === 'anySuit' && (!target || target.suit === src[index].suit)) continue;
          const r = canMove(game, from, index, to);
          if (!r.ok) continue;
          // 同花色 + 能接到最长牌组上更优先
          const score = (target ? 100 : 0) + r.count * 10 + (target ? target.rank : 0);
          if (!best || score > best.score) {
            best = { from, index, to, count: r.count, score };
          }
        }
      }
    }
    if (best) return { from: best.from, index: best.index, to: best.to, count: best.count };
  }
  return null;
}

/** 是否还有任何合法走法。 */
export function hasAnyMove(game) {
  return findHint(game) !== null;
}

/**
 * 刷新对局状态：收满 8 组即胜；发牌堆用尽且无任何合法走法即困死（判负）。
 * 每次走子 / 发牌后都应调一次。
 * @returns {string} 刷新后的 result
 */
export function refreshResult(game) {
  if (!game) return PLAYING;
  if (game.collected >= RUNS_TO_WIN) {
    game.result = WON;
    return game.result;
  }
  if (game.result === WON) return game.result;
  if (game.stock.length === 0 && !hasAnyMove(game)) {
    game.result = STUCK;
    return game.result;
  }
  game.result = PLAYING;
  return game.result;
}

/* ───────────────────────── 推进会话的一步（含历史与判定） ───────────────────────── */

/** 把当前局面压进撤销栈（深拷贝）。 */
function pushHistory(game) {
  if (!game.history) game.history = [];
  game.history.push(cloneGame(game));
}

/** 撤销步数上限：够用就行，避免长局把内存堆爆。 */
export const HISTORY_LIMIT = 500;

/**
 * 会话级移动：记录历史 → 走牌 → 收牌 → 刷新胜负。
 * @returns {{ok:boolean, reason?:string, moved?:number, collected?:number, result?:string}}
 */
export function sessionMove(session, from, index, to) {
  const g = session.game;
  const check = canMove(g, from, index, to);
  if (!check.ok) return { ok: false, reason: check.reason };

  pushHistory(g);
  if (g.history.length > HISTORY_LIMIT) g.history.shift();

  const r = moveRun(g, from, index, to);
  if (!r.ok) {
    g.history.pop();   // 失败不留脏历史
    return r;
  }
  const result = refreshResult(g);
  session.dirty = true;
  return { ok: true, moved: r.moved, collected: r.collected, result };
}

/**
 * 会话级发牌：记录历史 → 发「列数」张 → 收牌 → 刷新胜负。
 * @returns {{ok:boolean, reason?:string, dealt?:number, collected?:number, result?:string}}
 */
export function sessionDeal(session) {
  const g = session.game;
  if (g.result !== PLAYING) return { ok: false, reason: 'over' };
  if (g.stock.length < g.columns.length) return { ok: false, reason: 'stock' };

  pushHistory(g);
  if (g.history.length > HISTORY_LIMIT) g.history.shift();

  const r = deal(g);
  if (!r.ok) {
    g.history.pop();
    return r;
  }
  const result = refreshResult(g);
  session.dirty = true;
  return { ok: true, dealt: r.dealt, collected: r.collected, result };
}

/** 会话级撤销：还原到上一手，并回到进行中。 */
export function sessionUndo(session) {
  const r = undo(session.game);
  if (r.ok) session.dirty = true;
  return r;
}

/** 会话级重开（可换难度）。 */
export function sessionReset(session, levelKey = null, rng = null) {
  const key = levelKey ?? session.game.key;
  const src = rng ?? session.rng;
  session.game = createGame(key, src);
  session.rng = src;
  session.winAt = 0;
  session.stuckAt = 0;
  session.dirty = true;
  session.snap = null;
  return session;
}

/* ───────────────────────── 会话（纯数据，无平台 API） ───────────────────────── */

/**
 * 一局蜘蛛纸牌的完整会话状态。浏览器预览与微信小游戏跑的是同一份逻辑。
 * @param {string} levelKey 难度
 * @param {() => number} rng 随机源（可注入，方便测试复现）
 */
export function createSession(levelKey = 'easy', rng = defaultRandom) {
  return {
    game: createGame(levelKey, rng),
    rng,
    now: 0,           // 最近一次 update 的时间戳（由外部传入的绝对毫秒）
    winAt: 0,         // 胜利时刻（做动效）
    stuckAt: 0,       // 困死时刻
    dirty: true,      // 快照是否需要重建
    snap: null,
  };
}

/** 已收组数（8 组即胜）。 */
export function collectedRuns(game) {
  return game.collected;
}

/** 还需要收几组。 */
export function remainingRuns(game) {
  return Math.max(0, RUNS_TO_WIN - game.collected);
}

/** 是否已分出胜负。 */
export function isOver(game) {
  return game.result !== PLAYING;
}

/** 是否胜利。 */
export function isWon(game) {
  return game.result === WON;
}

/** 是否困死（判负）。 */
export function isStuck(game) {
  return game.result === STUCK;
}

/** 总牌数（含已收走的牌）：用来核对「一张都不丢」。 */
export function countCards(game) {
  let n = game.stock.length + game.collected * KING;
  for (const col of game.columns) n += col.length;
  return n;
}

/**
 * 把毫秒格式化成 mm:ss（超过 99 分钟则显示小时数）。
 * 纯数据工具，计时本体由集成层传入的绝对时间戳驱动。
 */
export function formatClock(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const pad = (v) => (v < 10 ? `0${v}` : `${v}`);
  return m > 99 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 计分：收到的组数是主分，剩牌少、步数少、用时短则加成。
 * 仅供集成层展示，不参与规则。
 */
export function scoreOf(game, elapsedMs = 0) {
  const base = game.collected * 800;
  const left = countCards(game) - game.collected * KING;
  const bonus = Math.max(0, 2000 - left * 8 - game.moves * 4 - Math.round(elapsedMs / 1000) * 2);
  return base + bonus;
}

/**
 * 转成给 UI 的只读快照（render.js 只吃这个，不直接读内部结构）。
 * 每帧调用，只做一次浅遍历，不做搜索。
 */
export function snapshot(game) {
  const cols = game.columns.length;
  const columns = [];
  for (let i = 0; i < cols; i++) {
    const col = game.columns[i];
    const cards = [];
    // 尾部「可整体搬走」的牌组起点：渲染层据此高亮
    let runStart = -1;
    for (let k = col.length - 1; k >= 0; k--) {
      if (!col[k].faceUp) break;
      if (k < col.length - 1 && !(col[k].suit === col[k + 1].suit && col[k].rank === col[k + 1].rank + 1)) break;
      runStart = k;
    }
    for (let k = 0; k < col.length; k++) {
      const c = col[k];
      cards.push({ id: c.id, suit: c.suit, rank: c.rank, faceUp: c.faceUp });
    }
    columns.push({
      index: i,
      cards,
      faceDown: faceDownCount(col),
      faceUp: faceUpCount(col),
      movableFrom: runStart,
      empty: col.length === 0,
    });
  }

  return {
    key: game.key,
    requireSameSuit: game.requireSameSuit,
    columns,
    stock: game.stock.length,
    dealsLeft: Math.floor(game.stock.length / cols),
    canDeal: canDeal(game),
    collected: game.collected,
    remainingRuns: remainingRuns(game),
    moves: game.moves,
    canUndo: canUndo(game),
    result: game.result,
    lastAction: game.lastAction,
    cardsLeft: countCards(game) - game.collected * KING,
  };
}

/**
 * 推进一帧：记录结算时刻，并在必要时重建快照。
 * @returns {object} 当前快照
 */
export function updateSession(session, now = 0) {
  session.now = now;
  const g = session.game;
  if (g.result === WON && !session.winAt) session.winAt = now;
  if (g.result === STUCK && !session.stuckAt) session.stuckAt = now;
  if (session.dirty || !session.snap) {
    session.snap = snapshot(g);
    session.dirty = false;
  }
  return session.snap;
}
