import { mulberry32 } from '../minesweeper/core.js';

/**
 * 数独核心逻辑（纯逻辑，零依赖，可在 Node 里直接跑测试）
 *
 * 设计约束（沿用「纯净玩」的架构理念）：
 *   - 本文件不碰任何平台 API（无 wx / document / window / canvas）；
 *   - 唯一的外部能力是注入的 rng（默认 Math.random）与集成层传入的时间戳 now；
 *   - 题目由回溯法生成完整解，再按难度挖空，**每挖一格都用求解器验证唯一解**；
 *   - 所有状态显式可复现：给定固定随机源，同一颗种子必得同一道题。
 *
 * 时间约定（规范 §8，踩过坑，务必遵守）：
 *   集成层传进来的 now 是 Date.now() 的**绝对毫秒时间戳**；
 *   本文件内部任何 fallback 时钟也必须用 Date.now()，
 *   绝不能用 performance.now()（那是页面加载后的相对毫秒，相减会得到 1.79e12 这种天文数字）。
 *   计时函数全部要求 now 一路透传，漏传会退化为「1970 年开局」。
 *
 * 错误检测口径（任务要求在注释里说明，这里选「与解对比」，二选一）：
 *   wrongAt(game, r, c) 判定为真的条件是——该格是玩家填入的非空格，且
 *   **数字与本题唯一解不符**。之所以不采用「是否违反行/列/宫不重复」：
 *     1) 本文件生成的每道题都携带唯一解，对比解是精确判定；
 *     2) 「违反规则」会把玩家「先填错、后改正」的中间状态算作错，容错度低；
 *     3) 与解对比还能识别「规则上暂时没冲突、但最终一定解不开」的填数。
 *   仅在题目自带解不可用时（外部导入题，见 loadPuzzle），才退化为规则冲突判定，
 *   对应实现是 ruleConflictsAt()；调用方若需要判断当前走的是哪种口径，
 *   看 puzzle.solution 是否为 null 即可。
 */

/* ───────────────────────── 基础常量 ───────────────────────── */

/** 棋盘边长（标准 9×9）。 */
export const SIZE = 9;
/** 宫的边长（3×3）。 */
export const BOX = 3;
/** 总格数。 */
export const CELLS = SIZE * SIZE;
/** 空格。 */
export const EMPTY = 0;

/** 难度档位：key 必须与 index.js 的 meta.difficulties 一一对应。 */
export const LEVELS = {
  easy: { key: 'easy', name: '简单', holes: 35, desc: '挖空 35 格 · 基础推理' },
  normal: { key: 'normal', name: '普通', holes: 45, desc: '挖空 45 格 · 需要候选数' },
  hard: { key: 'hard', name: '困难', holes: 52, desc: '挖空 52 格 · 步步为营' },
};

/** 难度 key 列表（顺序即难度递增）。 */
export const LEVEL_KEYS = Object.keys(LEVELS);

/** 取难度配置；未知 key 退回普通。 */
export function levelConfig(key) {
  return LEVELS[key] ?? LEVELS.normal;
}

/* ───────────────────────── 随机与时间 ───────────────────────── */

/**
 * 归一化随机源：允许外部直接传种子（数字）或传随机函数。
 * 传种子时用 mulberry32，保证「同一颗种子必得同一道题」，测试可完全复现。
 */
export function makeRng(seedOrFn = null) {
  if (typeof seedOrFn === 'function') return seedOrFn;
  if (typeof seedOrFn === 'number' && Number.isFinite(seedOrFn)) return mulberry32(seedOrFn >>> 0);
  return Math.random;
}

/**
 * 内部时钟 fallback。
 * ⚠️ 必须与集成层同源（Date.now 的绝对毫秒），否则计时会从 1970 年算起。
 * 正常路径下 now 由集成层一路透传，这里只在调用方漏传时兜底。
 */
function nowMs() {
  return Date.now();
}

/** 取时间戳：优先用调用方传入的 now，缺失时退回 Date.now()。 */
function pick(passed, fallback) {
  if (typeof passed === 'number' && Number.isFinite(passed)) return passed;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return nowMs();
}

/* ───────────────────────── 索引与位运算工具 ───────────────────────── */

/** 行列 → 下标（0..80）。 */
export function idx(r, c) {
  return r * SIZE + c;
}

/** 下标 → 行列。 */
export function rcOf(i) {
  return { r: (i / SIZE) | 0, c: i % SIZE };
}

/** 该行已用掉的数字位掩码（bit d 表示数字 d 已出现）。 */
function rowMaskOf(g, r) {
  let m = 0;
  const row = g[r];
  for (let c = 0; c < SIZE; c++) m |= 1 << row[c];
  return m;
}

/** 该列已用掉的数字位掩码。 */
function colMaskOf(g, c) {
  let m = 0;
  for (let r = 0; r < SIZE; r++) m |= 1 << g[r][c];
  return m;
}

/** 该宫已用掉的数字位掩码。 */
function boxMaskOf(g, r, c) {
  const br = Math.floor(r / BOX) * BOX;
  const bc = Math.floor(c / BOX) * BOX;
  let m = 0;
  for (let i = 0; i < BOX; i++) {
    for (let j = 0; j < BOX; j++) m |= 1 << g[br + i][bc + j];
  }
  return m;
}

/** 三个方向都试过的掩码。 */
function usedMask(g, r, c) {
  return rowMaskOf(g, r) | colMaskOf(g, c) | boxMaskOf(g, r, c);
}

/** 位掩码 → 升序数字数组。 */
function bitsToDigits(m) {
  const out = [];
  for (let d = 1; d <= SIZE; d++) if (m & (1 << d)) out.push(d);
  return out;
}

/** 该宫左上角坐标。 */
function boxOrigin(r, c) {
  return { r: Math.floor(r / BOX) * BOX, c: Math.floor(c / BOX) * BOX };
}

/** 数组洗牌（Fisher–Yates，走注入的 rng）。 */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/* ───────────────────────── 网格构造与合法性 ───────────────────────── */

/** 造一张全空的 9×9 网格。 */
export function createGrid() {
  const g = [];
  for (let r = 0; r < SIZE; r++) g.push(new Array(SIZE).fill(EMPTY));
  return g;
}

/** 深拷贝网格。 */
export function cloneGrid(g) {
  return g.map((row) => row.slice());
}

/** 数字是否合法（1..9）。 */
export function isDigit(v) {
  return Number.isInteger(v) && v >= 1 && v <= SIZE;
}

/**
 * 单格是否「放得下」某个数字：本身为空 + 行/列/宫都没有该数字。
 * 注意：这是「不违反规则」，不等于「与解一致」。
 */
export function canPlace(grid, r, c, v) {
  if (!isDigit(v)) return false;
  if (grid[r][c] !== EMPTY) return false;
  if (rowMaskOf(grid, r) & (1 << v)) return false;
  if (colMaskOf(grid, c) & (1 << v)) return false;
  if (boxMaskOf(grid, r, c) & (1 << v)) return false;
  return true;
}

/**
 * 网格是否满足数独规则（行/列/宫都不重复）。
 * 空格不算冲突；没填满也返回 true（只查冲突，不查完成度）。
 */
export function isValidGrid(grid) {
  if (!Array.isArray(grid) || grid.length !== SIZE) return false;
  for (let r = 0; r < SIZE; r++) {
    const row = grid[r];
    if (!Array.isArray(row) || row.length !== SIZE) return false;
    for (let c = 0; c < SIZE; c++) {
      const v = row[c];
      if (v === EMPTY) continue;
      if (!isDigit(v)) return false;
      for (let cc = 0; cc < SIZE; cc++) if (cc !== c && row[cc] === v) return false;
      for (let rr = 0; rr < SIZE; rr++) if (rr !== r && grid[rr][c] === v) return false;
      const { r: br, c: bc } = boxOrigin(r, c);
      for (let i = 0; i < BOX; i++) {
        for (let j = 0; j < BOX; j++) {
          const rr = br + i, cc = bc + j;
          if ((rr !== r || cc !== c) && grid[rr][cc] === v) return false;
        }
      }
    }
  }
  return true;
}

/** 该格是否与行/列/宫里的数字重复（规则口径的冲突检测）。 */
export function ruleConflictsAt(grid, r, c) {
  const v = grid[r][c];
  if (v === EMPTY) return false;
  for (let cc = 0; cc < SIZE; cc++) if (cc !== c && grid[r][cc] === v) return true;
  for (let rr = 0; rr < SIZE; rr++) if (rr !== r && grid[rr][c] === v) return true;
  const { r: br, c: bc } = boxOrigin(r, c);
  for (let i = 0; i < BOX; i++) {
    for (let j = 0; j < BOX; j++) {
      const rr = br + i, cc = bc + j;
      if ((rr !== r || cc !== c) && grid[rr][cc] === v) return true;
    }
  }
  return false;
}

/** 网格里的空格数。 */
export function countEmpty(grid) {
  let n = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (grid[r][c] === EMPTY) n++;
  }
  return n;
}

/* ───────────────────────── 候选数 ───────────────────────── */

/**
 * 单格候选数：该格放哪些数字不违反行/列/宫规则。
 * 已填格返回空数组（没有「候选」这个概念）。
 */
export function cellCandidates(grid, r, c) {
  if (grid[r][c] !== EMPTY) return [];
  const used = usedMask(grid, r, c);
  const out = [];
  for (let d = 1; d <= SIZE; d++) if (!(used & (1 << d))) out.push(d);
  return out;
}

/**
 * 全盘候选数矩阵：candidates[r][c] = number[]（已填格为空数组）。
 * 每帧调用也没问题：81 格 × 位运算，量级极小。
 */
export function candidatesOf(grid) {
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) row.push(cellCandidates(grid, r, c));
    out.push(row);
  }
  return out;
}

/** 每个数字在全盘还剩几个没填。 */
export function digitCounts(grid) {
  const counts = new Array(SIZE + 1).fill(0);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = grid[r][c];
      if (v >= 1 && v <= SIZE) counts[v]++;
    }
  }
  const remaining = new Array(SIZE + 1).fill(0);
  for (let d = 1; d <= SIZE; d++) remaining[d] = SIZE - counts[d];
  return { counts, remaining };
}

/* ───────────────────────── 求解器 ───────────────────────── */

/**
 * 回溯求解，最多找出 limit 个解（limit=2 就是「唯一性校验」最快的形式：
 * 找到第二个解立刻返回，不必数完）。
 *
 * 实现要点：
 *   - 只维护一份 grid，试探失败原路写回 EMPTY，不 clone；
 *   - 候选顺序打乱后再试（走注入 rng，保证可复现）；
 *   - limit=2 只返回不挑解；limit=1 会把第一个解留在 outGrid。
 *
 * ⚠️ 两个必须有的护栏（踩过坑）：
 *   1) **先做规则自检**。如果题面本身自相矛盾（同行两个 5、同宫两个 3），
 *      那么所有空格都填不出解，朴素回溯要穷尽 C(79) 的空间——
 *      实测「(0,0)=5 与 (0,1)=5、其余全空」这种网格能让任何朴素求解器
 *      跑上几分钟。所以冲突题面在这里直接判 0 解，一步都不搜。
 *   2) **节点上限**。正常题（有解、由完整解挖出来的）不会触发；
 *      真遇上极端无解局面，宁可返回「未搜完」也不要卡死调用方。
 *
 * @returns {number} 找到的解数（上限 limit）；触发节点上限时返回当前计数
 */
export function solveCount(grid, limit = 2, rng = null, outGrid = null) {
  // 护栏 1：题面自相矛盾 → 直接 0 解
  if (!isValidGrid(grid)) return 0;

  const rnd = rng ? makeRng(rng) : null;
  let found = 0;
  let nodes = 0;

  const search = () => {
    if (++nodes > NODE_LIMIT) return true;    // 护栏 2：兜底退出，不再深搜

    // 找第一个空格（行主序，够快且无需额外内存）
    let er = -1, ec = -1;
    for (let r = 0; r < SIZE && er < 0; r++) {
      const row = grid[r];
      for (let c = 0; c < SIZE; c++) {
        if (row[c] === EMPTY) { er = r; ec = c; break; }
      }
    }
    if (er < 0) {
      // 填满了 → 命中一个解
      found++;
      if (found === 1 && outGrid) {
        for (let r = 0; r < SIZE; r++) outGrid[r] = grid[r].slice();
      }
      return found >= limit;
    }

    let cands = bitsToDigits(((1 << (SIZE + 1)) - 2) & ~usedMask(grid, er, ec));
    if (!cands.length) return false;      // 死路
    if (rnd) cands = shuffle(cands, rnd);

    for (const d of cands) {
      grid[er][ec] = d;
      if (search()) { grid[er][ec] = EMPTY; return true; }   // 已够 limit，一路剪枝回退
      grid[er][ec] = EMPTY;
    }
    return false;
  };

  search();
  return found;
}

/**
 * 搜索节点上限。
 * 正常局面（题面合法且有解）远用不到：实测量级在千以内。
 * 这个上限只为「病态无解题」兜底——宁可少算一个解，也不要卡住调用方。
 */
const NODE_LIMIT = 200000;

/** 是否恰好一个解（不修改入参：拷一份再解）。 */
export function hasUniqueSolution(grid, rng = null) {
  const work = cloneGrid(grid);
  return solveCount(work, 2, rng) === 1;
}

/**
 * 解出第一个解；无解返回 null。
 * @param shuffleCandidates 求解前是否打乱候选顺序（同一道题可能对应多个解时让结果更随机）
 */
export function solveGrid(grid, shuffleCandidates = false, rng = null) {
  const work = cloneGrid(grid);
  const out = createGrid();
  const n = solveCount(work, 1, shuffleCandidates ? rng : null, out);
  return n >= 1 ? out : null;
}

/* ───────────────────────── 题目生成 ───────────────────────── */

/** 统计挖空数（给定格里的空格）。 */
export function holeCount(puzzle) {
  return countEmpty(puzzle.given);
}

/** 校验一道题是否自洽：给定格合法 + 恰好一个解 + 解与给定格兼容。 */
export function puzzleInfo(puzzle) {
  const given = puzzle.given;
  const solution = puzzle.solution;
  const valid = isValidGrid(given);
  let compatible = valid;
  if (valid) {
    for (let r = 0; r < SIZE && compatible; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = given[r][c];
        if (v !== EMPTY && v !== solution[r][c]) { compatible = false; break; }
      }
    }
  }
  return {
    valid,
    compatible,
    holes: countEmpty(given),
    unique: valid && hasUniqueSolution(given),
  };
}

/**
 * 生成一道题：先回溯造完整解，再按难度挖空，每挖一格都用求解器验证唯一解。
 *
 * 算法（挖空 + 唯一解验证，多轮冲刺）：
 *   1. 造一个随机完整解；
 *   2. 打乱 81 个位置，逐个「试删」——删掉后用求解器（limit=2）验唯一性，
 *      唯一则确认删除，否则把数字填回去（该格在本轮不可挖）；
 *   3. 一轮挖不够目标数就换一张全新的解重来（最多 MAX_ROUNDS 轮），
 *      取所有轮次里挖得最多的一张。
 *   这样做比「在一张解上死磕」更容易逼近 52 空洞的困难档，
 *   也天然带一个时间上限（每轮 81 次求解，量级固定且很小）。
 *
 * @param difficulty 难度 key（easy/normal/hard）
 * @param rng        随机源（函数或种子）；不传用 Math.random
 * @param maxRounds  最多换几张解重试（默认 6；调小可换速度）
 * @returns {{difficulty, given, solution, holes, targetHoles, unique, rounds}}
 */
export function generatePuzzle(difficulty = 'normal', rng = null, maxRounds = 6) {
  // 先把随机源归一化成函数，后续一路透传同一个函数对象
  // （若把「种子」层层往下传，每次 makeRng 都会重新初始化，序列就不可复现了）
  const rnd = makeRng(rng);
  const cfg = levelConfig(difficulty);

  let best = null;
  for (let round = 0; round < Math.max(1, maxRounds); round++) {
    const solution = generateFullGrid(rnd);
    const given = cloneGrid(solution);
    const order = [];
    for (let i = 0; i < CELLS; i++) order.push(i);
    shuffle(order, rnd);

    let holes = 0;
    for (const i of order) {
      if (holes >= cfg.holes) break;
      const r = (i / SIZE) | 0;
      const c = i % SIZE;
      const keep = given[r][c];
      given[r][c] = EMPTY;
      // 求解器验证唯一解：不唯一就把数字填回去
      if (countSolutionsUpTo(given, 2, rnd) === 1) holes++;
      else given[r][c] = keep;
    }

    if (!best || holes > best.holes) best = { given, solution, holes };
    if (best.holes >= cfg.holes) break;      // 达标，不必再换解
  }

  return {
    difficulty: cfg.key,
    given: best.given,
    solution: best.solution,
    holes: best.holes,
    targetHoles: cfg.holes,
    unique: true,                            // 构造性保证：每一步都验过唯一解
    rounds: Math.max(1, maxRounds),
  };
}

/** solveCount 的轻量包装（保证不改动传入网格）。 */
function countSolutionsUpTo(grid, limit, rng) {
  const work = cloneGrid(grid);
  return solveCount(work, limit, rng);
}

/**
 * 随机完整解：按「最少候选优先」的顺序回溯。9×9 上基本是毫秒级。
 * 走注入的 rng（洗牌 + 数字顺序），所以同种子同结果。
 */
export function generateFullGrid(rng = null) {
  const rnd = makeRng(rng);
  const g = createGrid();

  const fill = () => {
    // 1) 找候选最少的空格（MRV），无候选即回溯
    let br = -1, bc = -1, bestMask = 0, bestCount = 10;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (g[r][c] !== EMPTY) continue;
        const mask = ((1 << (SIZE + 1)) - 2) & ~usedMask(g, r, c);
        let n = 0;
        for (let d = 1; d <= SIZE; d++) if (mask & (1 << d)) n++;
        if (n === 0) return false;           // 死路
        if (n < bestCount) { bestCount = n; bestMask = mask; br = r; bc = c; if (n === 1) break; }
      }
    }
    if (br < 0) return true;                 // 填满了

    // 2) 候选顺序随机，保证每次生成的解不一样
    const cands = shuffle(bitsToDigits(bestMask), rnd);
    for (const d of cands) {
      g[br][bc] = d;
      if (fill()) return true;
      g[br][bc] = EMPTY;
    }
    return false;
  };

  fill();
  return g;
}

/** 序列化网格（调试/存档用，'0' 表示空格）。 */
export function gridKey(grid) {
  let s = '';
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) s += String(grid[r][c]);
  }
  return s;
}

/**
 * 从字符串还原一道题（外部导入用）。无自带解时 solution 为 null，
 * 此时 wrongAt() 自动退化为规则冲突口径。
 */
export function loadPuzzle(givenStr, solutionStr = null, difficulty = 'normal') {
  const parse = (s) => {
    if (typeof s !== 'string' || s.length !== CELLS) return null;
    const g = createGrid();
    for (let i = 0; i < CELLS; i++) {
      const ch = s[i];
      const v = ch === '.' || ch === '0' ? EMPTY : Number(ch);
      if (v !== EMPTY && !isDigit(v)) return null;
      g[(i / SIZE) | 0][i % SIZE] = v;
    }
    return g;
  };
  const given = parse(givenStr);
  if (!given) return null;
  const solution = solutionStr ? parse(solutionStr) : null;
  return {
    difficulty: levelConfig(difficulty).key,
    given,
    solution,
    holes: countEmpty(given),
    targetHoles: countEmpty(given),
    unique: solution ? true : hasUniqueSolution(given),
    rounds: 0,
    seed: null,
  };
}

/* ───────────────────────── 游戏状态与操作 ───────────────────────── */

/** 对局状态：进行中 / 已胜利。 */
export const PLAYING = 'playing';
export const WON = 'won';

/**
 * 一盘数独的完整状态（纯数据，无平台 API）。
 *   given  —— 题目给定格（不可改）
 *   grid   —— 当前盘面（含玩家填入）
 *   notes  —— 铅笔候选标记 notes[r][c] = boolean[10]（只对空格有意义）
 */
export function createGame(puzzle, rng = null) {
  const notes = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) row.push(new Array(SIZE + 1).fill(false));
    notes.push(row);
  }
  return {
    puzzle,
    grid: cloneGrid(puzzle.given),
    notes,
    timer: createTimer(),
    now: 0,            // 最近一次 update 的时间戳（集成层传入的绝对毫秒）
    startedAt: 0,      // 首次落子的时刻
    finishedAt: 0,     // 首次达成胜利的时刻
    status: PLAYING,   // playing / won
    moves: 0,          // 玩家落子次数（不含标记）
    hints: 0,          // 用掉几次提示
    wrongCount: 0,     // 当前盘面上与解不符的格数（每次改动后刷新）
    snap: null,        // 脏标记重建的快照
    dirty: true,
  };
}

/** 与解对比的错误口径（见文件头说明）。
 * - 题目自带解：玩家填的数字 ≠ 解 → 错；
 * - 无自带解：退化为规则冲突（同行/列/宫重复）→ 错。
 */
export function wrongAt(game, r, c) {
  const v = game.grid[r][c];
  if (v === EMPTY || game.puzzle.given[r][c] !== EMPTY) return false;
  const sol = game.puzzle.solution;
  if (sol) return v !== sol[r][c];
  return ruleConflictsAt(game.grid, r, c);
}

/** 当前错填的格子列表。 */
export function errorCells(game) {
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (wrongAt(game, r, c)) out.push({ r, c });
  }
  return out;
}

/** 错填格数（供 HUD / 结算展示）。 */
export function errorCount(game) {
  return errorCells(game).length;
}

/** 格子是否可操作（非给定格，且对局未结束）。 */
export function isPlayable(game, r, c) {
  if (!inGrid(r, c)) return false;
  if (game.status !== PLAYING) return false;
  return game.puzzle.given[r][c] === EMPTY;
}

/** 行列是否在盘内。 */
export function inGrid(r, c) {
  return r >= 0 && c >= 0 && r < SIZE && c < SIZE;
}

/** 已填格数。 */
export function filledCount(game) {
  return CELLS - countEmpty(game.grid);
}

/** 盘面是否已填满。 */
export function isComplete(game) {
  return countEmpty(game.grid) === 0;
}

/**
 * 胜利判定：棋盘填满 + 全部合法 + 与解一致（有解时）。
 * 有解时等价于「每格都等于解」；无解时等价于「填满且满足数独规则」。
 */
export function isSolved(game) {
  if (countEmpty(game.grid) !== 0) return false;
  if (!isValidGrid(game.grid)) return false;
  const sol = game.puzzle.solution;
  if (!sol) return true;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (game.grid[r][c] !== sol[r][c]) return false;
  }
  return true;
}

/**
 * 落一个数字。给定格与非空格都被拒绝（要改先擦）。
 * 会自动清掉该格的候选标记，并从同行/同列/同宫的候选标记里减掉这个数字
 * ——这是数独玩家默认期待的行为。
 *
 * @returns {{ok:boolean, reason?:string, r:number, c:number, value:number}}
 *   reason: 'over' 已结束 / 'given' 给定格 / 'occupied' 已有数字 /
 *           'oob' 越界 / 'bad' 数字不合法 / 'wrong' 落子成功但与解不符
 */
export function placeDigit(game, r, c, v, now = null) {
  if (game.status !== PLAYING) return { ok: false, reason: 'over', r, c, value: v };
  if (!inGrid(r, c)) return { ok: false, reason: 'oob', r, c, value: v };
  if (!isDigit(v)) return { ok: false, reason: 'bad', r, c, value: v };
  if (game.puzzle.given[r][c] !== EMPTY) return { ok: false, reason: 'given', r, c, value: v };
  if (game.grid[r][c] !== EMPTY) return { ok: false, reason: 'occupied', r, c, value: v };

  const t = pick(now, game.now);
  if (!game.timer.running && game.timer.elapsed === 0) startTimer(game.timer, t);
  if (!game.startedAt) game.startedAt = t;

  game.grid[r][c] = v;
  game.moves++;
  setNote(game, r, c, 0, false);      // 该格自己的候选标记作废
  clearNoteDigit(game, r, c, v);      // 同行/同列/同宫里，把 v 从候选标记中减掉
                                        // （注意：只减 v 这一个数字，别清别的格的整张候选表）

  refreshErrors(game);                // 同步 wrongCount（快照与 HUD 直接读它）
  const wrong = wrongAt(game, r, c);
  const solved = isSolved(game);
  if (solved) finish(game, t);
  game.dirty = true;
  return { ok: true, r, c, value: v, wrong, win: solved };
}

/** 擦掉一格（给定格与被判胜利后的盘面不可擦）。 */
export function eraseCell(game, r, c) {
  if (game.status !== PLAYING) return { ok: false, reason: 'over', r, c };
  if (!inGrid(r, c)) return { ok: false, reason: 'oob', r, c };
  if (game.puzzle.given[r][c] !== EMPTY) return { ok: false, reason: 'given', r, c };
  if (game.grid[r][c] === EMPTY) return { ok: false, reason: 'empty', r, c };
  game.grid[r][c] = EMPTY;
  refreshErrors(game);
  game.dirty = true;
  return { ok: true, r, c };
}

/** 清掉该格全部候选标记。 */
export function clearNotes(game, r, c) {
  for (let d = 1; d <= SIZE; d++) setNote(game, r, c, d, false);
  game.dirty = true;
}

/** 读候选标记。 */
export function noteAt(game, r, c, d) {
  if (!inGrid(r, c) || d < 1 || d > SIZE) return false;
  return game.notes[r][c][d] === true;
}

/** 写候选标记（内部用，不置脏标记由调用方负责）。 */
function setNote(game, r, c, d, on) {
  if (!inGrid(r, c)) return;
  if (d === 0) {
    for (let k = 1; k <= SIZE; k++) game.notes[r][c][k] = false;
    return;
  }
  if (d < 1 || d > SIZE) return;
  game.notes[r][c][d] = on;
}

/** 该格已标记的候选数字（升序）。 */
export function notesAt(game, r, c) {
  const out = [];
  if (!inGrid(r, c)) return out;
  for (let d = 1; d <= SIZE; d++) if (game.notes[r][c][d]) out.push(d);
  return out;
}

/** 把某个数字从同行/同列/同宫的候选标记里减掉（落子后的自动清理）。 */
export function clearNoteDigit(game, r, c, v) {
  if (!isDigit(v)) return;
  for (let i = 0; i < SIZE; i++) {
    setNote(game, r, i, v, false);
    setNote(game, i, c, v, false);
  }
  const { r: br, c: bc } = boxOrigin(r, c);
  for (let i = 0; i < BOX; i++) {
    for (let j = 0; j < BOX; j++) setNote(game, br + i, bc + j, v, false);
  }
  game.dirty = true;
}

/**
 * 切换铅笔标记（只对空格有效，给定格与已填格拒绝）。
 * @returns {{ok:boolean, reason?:string, r, c, d, on?:boolean}}
 */
export function toggleNote(game, r, c, d) {
  if (game.status !== PLAYING) return { ok: false, reason: 'over', r, c, d };
  if (!inGrid(r, c)) return { ok: false, reason: 'oob', r, c, d };
  if (!isDigit(d)) return { ok: false, reason: 'bad', r, c, d };
  if (game.puzzle.given[r][c] !== EMPTY) return { ok: false, reason: 'given', r, c, d };
  if (game.grid[r][c] !== EMPTY) return { ok: false, reason: 'occupied', r, c, d };
  const on = !game.notes[r][c][d];
  game.notes[r][c][d] = on;
  game.dirty = true;
  return { ok: true, r, c, d, on };
}

/** 刷新错填计数（供快照与 HUD 读）。 */
export function refreshErrors(game) {
  game.wrongCount = errorCount(game);
  return game.wrongCount;
}

/**
 * 提示：填一个正确格。
 * 优先补当前选中格（若它还是空的），否则按行主序找第一个空格；
 * 落进去的一定是解里的数字。
 *
 * @returns {{ok:boolean, reason?:string, r?, c?, value?}}
 */
export function hint(game, r = -1, c = -1, now = null) {
  if (game.status !== PLAYING) return { ok: false, reason: 'over' };
  let tr = -1, tc = -1;
  if (inGrid(r, c) && game.grid[r][c] === EMPTY && game.puzzle.given[r][c] === EMPTY) {
    tr = r; tc = c;
  } else {
    outer:
    for (let rr = 0; rr < SIZE; rr++) {
      for (let cc = 0; cc < SIZE; cc++) {
        if (game.grid[rr][cc] === EMPTY) { tr = rr; tc = cc; break outer; }
      }
    }
  }
  if (tr < 0) return { ok: false, reason: 'full' };
  const v = game.puzzle.solution ? game.puzzle.solution[tr][tc] : cellCandidates(game.grid, tr, tc)[0];
  if (!isDigit(v)) return { ok: false, reason: 'nosolution' };
  const res = placeDigit(game, tr, tc, v, now);
  if (res.ok) game.hints++;
  return { ...res, hint: true };
}

/* ───────────────────────── 计时数据 ───────────────────────── */

/** 计时数据（纯数据，不读时钟）。 */
export function createTimer() {
  return {
    running: false,
    startAt: 0,    // 开始时刻（ms，集成层传入的绝对时间戳）
    stopAt: 0,     // 结束时刻（ms）
    elapsed: 0,    // 结束后冻结的用时
  };
}

/** 开始计时；已开始（或已有冻结用时）则不重复计。 */
export function startTimer(t, now = null) {
  if (t.running || t.elapsed > 0) return t;
  t.running = true;
  t.startAt = pick(now, null);
  return t;
}

/** 停表并冻结用时。 */
export function stopTimer(t, now = null) {
  if (!t.running) return t;
  const at = pick(now, t.startAt);
  t.running = false;
  t.stopAt = at;
  t.elapsed = Math.max(0, at - t.startAt);
  return t;
}

/** 当前用时（ms）；未开始为 0，停表后冻结。 */
export function elapsedMs(t, now = null) {
  if (!t || (!t.running && t.elapsed === 0)) return 0;
  if (!t.running) return t.elapsed;
  return Math.max(0, pick(now, t.startAt) - t.startAt);
}

/** 把毫秒格式化成 mm:ss（超过 99 分钟显示 时:分:秒）。 */
export function formatTime(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const pad = (v) => (v < 10 ? `0${v}` : `${v}`);
  return m > 99 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 结束一局（记时刻、停表、置状态）。 */
function finish(game, now) {
  game.status = WON;
  game.finishedAt = now;
  stopTimer(game.timer, now);
}

/* ───────────────────────── 快照（渲染只读它） ───────────────────────── */

/**
 * 转成给 render.js 的只读快照。每帧调用，故只做一趟浅遍历。
 * 候选数不在快照里算——render 需要哪一格再向 core 要，避免每帧铺 81 份数组。
 */
export function snapshot(game) {
  const p = game.puzzle;
  const grid = [];
  const given = [];
  const wrong = [];
  const notes = [];
  for (let r = 0; r < SIZE; r++) {
    grid.push(game.grid[r].slice());
    given.push(p.given[r].slice());
    const wrow = [];
    const nrow = [];
    for (let c = 0; c < SIZE; c++) {
      wrow.push(wrongAt(game, r, c));
      const ns = [];
      if (game.grid[r][c] === EMPTY) {
        for (let d = 1; d <= SIZE; d++) if (game.notes[r][c][d]) ns.push(d);
      }
      nrow.push(ns);
    }
    wrong.push(wrow);
    notes.push(nrow);
  }
  const { remaining } = digitCounts(game.grid);
  return {
    size: SIZE,
    grid,
    given,
    wrong,
    notes,
    filled: filledCount(game),
    total: CELLS,
    empty: countEmpty(game.grid),
    remaining,               // remaining[1..9]：每个数字还差几个
    wrongCount: game.wrongCount,
    moves: game.moves,
    hints: game.hints,
    status: game.status,
    difficulty: p.difficulty,
    holes: p.holes,
    elapsed: elapsedMs(game.timer, game.now),
  };
}

/* ───────────────────────── 会话（纯数据） ───────────────────────── */

/** 新建一局（含出题）。 */
export function createGameSession(difficulty = 'normal', rng = null) {
  const puzzle = generatePuzzle(difficulty, rng);
  const g = createGame(puzzle, rng);
  return {
    game: g,
    rng: makeRng(rng),
    now: 0,
    winAt: 0,
    outcome: null,
  };
}

/** 推进一帧：时间戳透传 + 按需重建快照。 */
export function updateGame(session, now = null) {
  if (!session) return null;
  const t = pick(now, session.now);
  session.now = t;
  session.game.now = t;
  if (session.game.dirty || !session.game.snap) {
    session.game.snap = snapshot(session.game);
    session.game.dirty = false;
  }
  return session.game.snap;
}

/** 会话内落子（含计时启停、结果记录）。 */
export function sessionPlace(session, r, c, v, now = null) {
  const t = pick(now, session.now);
  session.now = t;
  const res = placeDigit(session.game, r, c, v, t);
  if (res.ok && res.win) markWin(session, t);
  return res;
}

/** 会话内擦除。 */
export function sessionErase(session, r, c, now = null) {
  session.now = pick(now, session.now);
  return eraseCell(session.game, r, c);
}

/** 会话内切换候选标记。 */
export function sessionNote(session, r, c, d, now = null) {
  session.now = pick(now, session.now);
  return toggleNote(session.game, r, c, d);
}

/** 会话内提示。 */
export function sessionHint(session, r = -1, c = -1, now = null) {
  const t = pick(now, session.now);
  session.now = t;
  const res = hint(session.game, r, c, t);
  if (res.ok && res.win) markWin(session, t);
  return res;
}

/** 记录胜利（快照失效 + 结算数据）。 */
function markWin(session, now) {
  session.winAt = now;
  session.game.dirty = true;
  session.outcome = {
    result: 'win',
    score: scoreOf(session.game),
    detail: {
      elapsedMs: Math.round(elapsedMs(session.game.timer, now)),
      difficulty: session.game.puzzle.difficulty,
      mistakes: session.game.wrongCount,
      hints: session.game.hints,
      moves: session.game.moves,
    },
  };
}

/** 简易计分：越快越高，提示与错填扣分，难度加成（仅供集成层展示）。 */
export function scoreOf(game) {
  const factor = game.puzzle.difficulty === 'hard' ? 3 : game.puzzle.difficulty === 'easy' ? 1 : 2;
  const ms = elapsedMs(game.timer, game.now);
  const base = 1000 - Math.round(ms / 300);
  const penalty = game.hints * 60 + game.wrongCount * 10;
  return Math.max(10, base - penalty) * factor;
}

/**
 * 重开一局：换新题、清计时与标记。
 * @param nextDifficulty 不传则沿用当前难度
 */
export function restartGame(session, nextDifficulty = null, rng = null) {
  const key = nextDifficulty ?? session.game.puzzle.difficulty;
  const r = rng ?? session.rng;
  const puzzle = generatePuzzle(key, r);
  session.game = createGame(puzzle, r);
  session.rng = makeRng(r);
  session.winAt = 0;
  session.outcome = null;
  session.game.now = session.now;
  return session;
}
