/**
 * 2048 核心逻辑（纯函数 + 一份纯数据对局，零依赖，可在 Node 里直接跑测试）
 *
 * 设计约束（沿用「纯净玩」的架构理念）：
 *   - 本文件不碰任何平台 API（无 wx、无 document、无 window、无 canvas）；
 *   - 随机只走注入的 rng：默认 Math.random，测试里换种子随机数即可完全复现一局；
 *   - 每次「有效移动」才生成新方块，生成数量固定为 1（不可能多、不可能少）；
 *   - 合并规则严格按原版：一次移动里每个方块最多参与一次合并
 *     （2 2 2 2 左移 → 4 4，而不是 8；4 4 8 左移 → 8 8，而不是 16）；
 *   - 撤销记录走「快照 + 快照期间的生成序列」：撤销后重新走同一条路必然复现同一盘，
 *     不会因为重掷随机数而出现「撤销前后不一样」的问题。
 *
 * 坐标系：grid[row][col]，row = 0 是最上面一行，col = 0 是最左一列。
 * 方向常量用字符串（'left' | 'right' | 'up' | 'down'），与 UI 的手势判定共用。
 */

/* ───────────────────────── 常量 ───────────────────────── */

/** 对局状态。 */
export const PLAYING = 'playing';
export const WON = 'won';
export const LOST = 'lost';

/** 四个方向。 */
export const LEFT = 'left';
export const RIGHT = 'right';
export const UP = 'up';
export const DOWN = 'down';

/** 方向表：每个方向对应的扫描轴与推进方向。 */
const DIR_INFO = {
  left:  { horizontal: true,  forward: true },
  right: { horizontal: true,  forward: false },
  up:    { horizontal: false, forward: true },
  down:  { horizontal: false, forward: false },
};

/** 方向 key 列表（顺序固定，测试与 UI 都用它遍历）。 */
export const DIRECTIONS = [LEFT, RIGHT, UP, DOWN];

/** 新方块生成概率：90% 出 2，10% 出 4。 */
export const SPAWN_VALUE_SMALL = 2;
export const SPAWN_VALUE_BIG = 4;
export const SPAWN_BIG_RATE = 0.10;

/** 开局预生成的新方块数（标准玩法：开局两枚）。 */
const SPAWN_POOL_INITIAL = 2;

/**
 * 难度档位（与 index.js 的 meta.difficulties 一一对应）。
 *   size   —— 棋盘边长（4 = 4×4，5 = 5×5）
 *   target —— 本档的胜利目标值（出现即刻算胜利，但仍可继续玩）
 */
export const DIFFICULTIES = {
  easy:   { name: '简单', size: 4, target: 512 },
  normal: { name: '普通', size: 4, target: 2048 },
  hard:   { name: '困难', size: 5, target: 4096 },
};

/** 默认难度。 */
export const DEFAULT_DIFFICULTY = 'normal';

/** 难度参数（未知 key 退回默认档，绝不抛错）。 */
export function difficultyConfig(key) {
  return DIFFICULTIES[key] ?? DIFFICULTIES[DEFAULT_DIFFICULTY];
}

/** 难度 key 列表（顺序即难度递增）。 */
export const DIFFICULTY_KEYS = Object.keys(DIFFICULTIES);

/**
 * 默认随机源。**本文件里 Math.random 只出现这一次**——
 * 生成方块的一切随机性都必须走注入的 rng，测试才能完全复现。
 */
const defaultRandom = Math.random;

/* ───────────────────────── 随机数 ───────────────────────── */

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

/** 把 rng 的一个样本变成 32 位整数种子（用于给每次生成派生独立的子序列）。 */
function randomSeed(rng) {
  return Math.floor(rng() * 4294967296) >>> 0;
}

/* ───────────────────────── 数值工具 ───────────────────────── */

/**
 * 把方块数值换算成「指数」：2 → 1、4 → 2、2048 → 11。
 * 渲染层按指数取配色，测试也用它校验合并结果。
 */
export function tileExp(value) {
  if (!(value > 0)) return 0;
  return Math.max(0, Math.round(Math.log2(value)));
}

/**
 * 指数 → 数值（tileExp 的逆运算）。
 * 用位运算保证 2^k 精确，2**k 在极端值上会有浮点误差。
 */
export function expToValue(exp) {
  return exp >= 0 && exp < 31 ? 1 << exp : Math.pow(2, exp);
}

/* ───────────────────────── 建盘 ───────────────────────── */

/** 造一个 size×size 的空盘（全部填 0）。 */
export function emptyGrid(size) {
  const g = [];
  for (let y = 0; y < size; y++) g.push(new Array(size).fill(0));
  return g;
}

/** 空位列表 [{x, y}]（y = 行，x = 列，与 grid 索引一致）。 */
export function emptyCells(grid) {
  const out = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (grid[y][x] === 0) out.push({ x, y });
    }
  }
  return out;
}

/** 把所有方块抄成新二维数组（撤销快照与测试用，避免共享引用）。 */
export function cloneGrid(grid) {
  return grid.map((row) => row.slice());
}

/** 盘面最大值（用于判断目标达成）。 */
export function maxTile(grid) {
  let m = 0;
  for (const row of grid) {
    for (const v of row) if (v > m) m = v;
  }
  return m;
}

/** 是否还有可移动的走法：有空格，或存在上下/左右相邻的同值方块。 */
export function hasMoves(grid) {
  const size = grid.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = grid[y][x];
      if (v === 0) return true;
      if (x + 1 < size && grid[y][x + 1] === v) return true;
      if (y + 1 < size && grid[y + 1][x] === v) return true;
    }
  }
  return false;
}

/** 盘面是否已满。 */
export function isFull(grid) {
  return emptyCells(grid).length === 0;
}

/* ───────────────────────── 单行/单列合并 ───────────────────────── */

/**
 * 把一条线（长度 n）按 direction 压紧并合并，写回 lines 的第 lineIndex 条。
 *
 * 遍历顺序由方向决定：左移从最左开始、右移从最右开始。
 * 因为读到的一定是「已经压紧且合并过」的部分，所以**每个方块最多合并一次**是
 * 结构性保证，不靠额外的标记位（2 2 2 2 左移必然得到 4 4）。
 *
 * @returns {{moved: boolean, score: number, merges: Array<{to:number, value:number}>}}
 *   merges 里 to 是写入位置（线内下标），value 是合并后的数值（= 得分数）
 */
/**
 * 把一条线（长度 n）按 direction 压紧并合并。
 *
 * 遍历顺序由方向决定：左移从最左读起、右移从最右读起。
 * 因为读到的永远是「已经压紧并合并过」的部分，所以**每个方块最多合并一次**是
 * 结构性保证，不靠额外的标记位（2 2 2 2 左移必然得到 4 4）。
 *
 * @param line 形如 [2, 2, 8, 0] 的一行（或一列）数值数组
 * @returns {{out: number[], moved: boolean, score: number, merges: Array<{to:number, value:number}>}}
 *   merges 里的 to 是合并结果在该线上的下标，value 是合并后的数值（= 得分数）
 */
function mergeLine(line, info) {
  const n = line.length;

  // 1) 按方向收集：左/上按原序，右/下反向（等价于「从目标端开始读」）
  const src = [];
  for (let k = 0; k < n; k++) src.push(line[info.forward ? k : n - 1 - k]);

  // 2) 丢掉空格
  const tiles = [];
  for (let i = 0; i < n; i++) if (src[i] !== 0) tiles.push(src[i]);

  // 3) 从目标端依次落位，同值则合并一次并跳过一个
  const out = new Array(n).fill(0);
  const merges = [];
  let score = 0;
  let w = 0;
  let i = 0;
  while (i < tiles.length) {
    const dst = info.forward ? w : n - 1 - w;
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const value = tiles[i] * 2;
      out[dst] = value;
      score += value;                       // 计分：累加合并后的值
      merges.push({ to: w, value });
      w++;
      i += 2;                               // 跳过一个 → 绝不连锁合并
    } else {
      out[dst] = tiles[i];
      w++;
      i += 1;
    }
  }

  // 4) 是否真的变了（位移或合并都算变化）
  let moved = merges.length > 0;
  for (let k = 0; k < n; k++) if (out[k] !== line[k]) moved = true;

  return { out, moved, score, merges };
}

/**
 * 对整盘执行一次滑动合并（不生成新方块、不改任何元数据）。
 * 这是纯函数：grid 不会被修改，返回新盘与计分信息。
 *
 * @param grid   二维数组（row 在前）
 * @param dir    'left' | 'right' | 'up' | 'down'
 * @returns {{grid, moved, score, merges}}
 *   merges 里的坐标已是盘面坐标 {line, to, value}：
 *   左右移时 line = 行号、to = 列号；上下移时 line = 列号、to = 行号。
 */
export function slideGrid(grid, dir) {
  const info = DIR_INFO[dir];
  if (!info) return { grid: cloneGrid(grid), moved: false, score: 0, merges: [] };

  const n = grid.length;
  const merges = [];
  let moved = false;
  let score = 0;
  // 先把每条线（行或列）处理成新线，再拼回盘面
  const newLines = [];
  for (let i = 0; i < n; i++) {
    const line = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      line[k] = info.horizontal ? grid[i][k] : grid[k][i];
    }
    const r = mergeLine(line, info);
    newLines.push(r.out);
    if (r.moved) moved = true;
    score += r.score;
    // 线内下标 → 盘面坐标：左右移时 line = 行号、to = 列号；上下移时反过来
    for (const m of r.merges) {
      merges.push(info.horizontal
        ? { y: i, x: m.to, value: m.value }
        : { y: m.to, x: i, value: m.value });
    }
  }

  const out = emptyGrid(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      if (info.horizontal) out[i][k] = newLines[i][k];
      else out[k][i] = newLines[i][k];
    }
  }

  return { grid: out, moved, score, merges };
}

/* ───────────────────────── 生成新方块 ───────────────────────── */

/**
 * 生成一枚新方块：先随机取值（90% 出 2），再随机挑一个空位放进去。
 * 取值与选位的随机数**分开生成**——否则「固定取值」的测试会连带影响选位序列。
 *
 * @returns {{x, y, value} | null} 无空位时返回 null（不生成）
 */
export function spawnTile(grid, rng = defaultRandom) {
  const cells = emptyCells(grid);
  if (!cells.length) return null;

  const value = rng() < SPAWN_BIG_RATE ? SPAWN_VALUE_BIG : SPAWN_VALUE_SMALL;
  const idx = Math.min(cells.length - 1, Math.max(0, Math.floor(rng() * cells.length)));
  const cell = cells[idx];
  grid[cell.y][cell.x] = value;
  return { x: cell.x, y: cell.y, value };
}

/* ───────────────────────── 对局（纯数据） ───────────────────────── */

/**
 * 开一局 2048。
 *
 * @param options.difficulty 难度 key（'easy' / 'normal' / 'hard'）
 * @param options.size       直接指定棋盘边长（覆盖难度里的 size，测试用）
 * @param options.target     直接指定目标值
 * @param options.rng        随机源（默认 Math.random）
 * @param options.spawnFn    自定义生成函数 (grid, rng) => tile|null，测试里拿它造盘面
 * @param options.initial    开局预生成几枚方块（默认 2；给 0 可造空盘）
 */
export function createGame(options = {}) {
  const cfg = difficultyConfig(options.difficulty ?? DEFAULT_DIFFICULTY);
  const size = Number.isFinite(options.size) && options.size > 1 ? Math.floor(options.size) : cfg.size;
  const target = Number.isFinite(options.target) && options.target > 1 ? Math.floor(options.target) : cfg.target;
  const rng = typeof options.rng === 'function' ? options.rng : defaultRandom;
  const spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawnTile;
  const initial = Number.isFinite(options.initial) ? Math.max(0, Math.floor(options.initial)) : SPAWN_POOL_INITIAL;

  const g = {
    key: options.difficulty && DIFFICULTIES[options.difficulty] ? options.difficulty : DEFAULT_DIFFICULTY,
    size,
    target,
    grid: emptyGrid(size),
    score: 0,
    moves: 0,               // 有效移动次数（无效尝试不计）
    attempts: 0,            // 全部操作次数（含无效移动，供调试/统计）
    result: PLAYING,
    reachedTarget: false,   // 是否已出现目标值（胜利后仍可继续玩，此标记不变）
    best: 0,                // 本会话历史最高分（内存态，重启 App 会清零）
    history: [],            // 撤销快照栈：[{grid, score, result, reachedTarget, spawns}]
    spawns: [],             // 本局每次生成序列（撤销回退时按这条序列重放，保证可复现）
    lastDir: null,          // 最近一次有效移动的方向
    meta: new Map(),        // 棋盘坐标 → 动画元数据 {spawnAt, mergeAt, dir, to}
    rng,
    spawnFn,
  };

  // 开局预生成：走同一个生成器，随机序列与后续完全一致
  for (let i = 0; i < initial; i++) {
    const t = g.spawnFn(g.grid, g.rng);
    if (!t) break;
    g.spawns.push({ x: t.x, y: t.y, value: t.value });
    g.meta.set(coordKey(t.x, t.y), { spawnAt: 0, mergeAt: 0, dir: null, to: null });
  }
  return g;
}

/** 棋盘坐标 → Map 键。 */
export function coordKey(x, y) {
  return `${x},${y}`;
}

/** 把 t（毫秒时间戳）设为「刚落子」的动画时刻（写进 meta）。 */
function markSpawn(g, x, y, now) {
  g.meta.set(coordKey(x, y), { spawnAt: now, mergeAt: 0, dir: null, to: null });
}

/**
 * 执行一次移动（四方向通用）。
 *
 * 顺序：滑行合并 → 无效则原样返回（**不生成新方块**）→ 有效则生成 1 枚 → 判胜负。
 * 胜利后（出现目标值）对局不再锁定，仍可继续玩；失败（满盘且无相邻同值）才判负。
 *
 * @param g     createGame 的返回对象
 * @param dir   方向（LEFT / RIGHT / UP / DOWN）
 * @param now   当前时间戳（ms，Date.now() 同源；只用于动画元数据，缺省 0）
 * @returns {{ok, moved, score, gained, spawned, reached, result, reason?}}
 *   ok = 是否真的动了（无效移动 ok:false，且不生成方块）
 */
export function move(g, dir, now = 0) {
  if (!DIR_INFO[dir]) return { ok: false, moved: false, reason: 'dir', reached: null, spawned: [], gained: 0 };
  if (g.result === LOST) {
    return { ok: false, moved: false, reason: 'over', reached: null, spawned: [], gained: 0 };
  }

  g.attempts++;
  const res = slideGrid(g.grid, dir);
  if (!res.moved) {
    // 无效移动：盘面不变、不计分、不生成方块、不写撤销快照
    return { ok: false, moved: false, reason: 'nochange', reached: null, spawned: [], gained: 0 };
  }

  // 1) 撤销快照（快照 + 本步生成序列 → 撤销后重走必然复现）
  g.history.push({
    grid: cloneGrid(g.grid),
    score: g.score,
    result: g.result,
    reachedTarget: g.reachedTarget,
    spawns: g.spawns.length,
  });

  // 2) 滑行、合并、计分
  const before = new Map();
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (g.grid[y][x] !== 0) before.set(coordKey(x, y), g.grid[y][x]);
    }
  }

  g.grid = res.grid;
  g.score += res.score;
  if (g.score > g.best) g.best = g.score;
  g.moves++;
  g.lastDir = dir;

  // 3) 动画元数据：合并格标 mergeAt，位移格记方向（render 只读 meta，不参与判定）
  const taken = new Set();
  for (const key of before.keys()) {
    const [bx, by] = key.split(',').map(Number);
    const dest = findDestination(g.grid, bx, by, before.get(key), dir, taken);
    if (!dest) continue;
    taken.add(coordKey(dest.x, dest.y));
    // 语义清晰：只有合并格才带 mergeAt；位移格一律清掉，避免继承旧格的动画时间戳
    g.meta.set(coordKey(dest.x, dest.y), {
      spawnAt: 0,
      mergeAt: dest.merged ? now : 0,
      dir,
      to: null,
    });
  }
  for (const m of res.merges) {
    g.meta.set(coordKey(m.x, m.y), { spawnAt: 0, mergeAt: now, dir: null, to: null });
  }

  // 4) 有效移动后必有且仅有 1 枚新方块
  const tile = g.spawnFn(g.grid, g.rng);
  const spawned = [];
  if (tile) {
    g.spawns.push({ x: tile.x, y: tile.y, value: tile.value });
    markSpawn(g, tile.x, tile.y, now);
    spawned.push(tile);
  }

  // 5) 胜负：先判胜利（出现目标值），再判失败（无路可走）
  let reached = null;
  let result = g.result;
  const top = maxTile(g.grid);
  if (top > 0) {
    // 目标值在合并结果里出现 → 记为「本步达成」（可能是本次合并出来的）
    if (!g.reachedTarget && top >= g.target) {
      g.reachedTarget = true;
      reached = top;
    }
  }
  if (g.reachedTarget) result = WON;
  if (g.result !== WON && !hasMoves(g.grid)) result = LOST;
  g.result = result;

  return {
    ok: true,
    moved: true,
    dir,
    score: g.score,
    gained: res.score,        // 本次移动的得分增量
    spawned,
    reached,                  // 本步是否刚达成目标（数值或 null）
    result: g.result,
  };
}

/**
 * 找一个方块移动后的落点（仅用于动画元数据，不参与任何判定）。
 *
 * 沿移动方向走到最远空格；若越过后第一枚方块同值且未被占用，则落在它上面（合并）。
 * @param taken 已被前面方块占用的落点集合（同一次移动内去重，避免两个方块落到同一格）
 * @returns {{x, y, merged} | null}
 */
function findDestination(grid, x, y, value, dir, taken) {
  const info = DIR_INFO[dir];
  const size = grid.length;
  const dx = info.horizontal ? (info.forward ? -1 : 1) : 0;
  const dy = info.horizontal ? 0 : (info.forward ? -1 : 1);

  let cx = x;
  let cy = y;
  for (let i = 0; i < size; i++) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) break;
    if (grid[ny][nx] === 0) { cx = nx; cy = ny; continue; }
    // 撞上非空格：同值且没被别人占走 → 合并；否则停在原地
    if (grid[ny][nx] === value && !taken.has(coordKey(nx, ny))) {
      return { x: nx, y: ny, merged: true };
    }
    break;
  }
  if (cx === x && cy === y) return null;      // 压根没动
  return { x: cx, y: cy, merged: false };
}

/**
 * 撤销上一步（无效移动根本没进历史，所以撤销的一定是有效移动）。
 * 撤销后按快照里的生成序列回退，保证「撤销 → 重走」结果完全一致。
 * @returns {{ok: boolean, reason?: string}}
 */
export function undo(g) {
  const snap = g.history.pop();
  if (!snap) return { ok: false, reason: 'empty' };

  g.grid = cloneGrid(snap.grid);
  g.score = snap.score;
  g.result = snap.result;
  g.reachedTarget = snap.reachedTarget;
  g.spawns.length = snap.spawns;      // 回退生成序列（重走时不再重新掷骰子）
  g.moves = Math.max(0, g.moves - 1);
  g.lastDir = null;
  g.meta = new Map();
  return { ok: true, freed: snap.spawns };
}

/** 能否撤销。 */
export function canUndo(g) {
  return g.history.length > 0;
}

/** 是否已结束（失败）。 */
export function isOver(g) {
  return g.result === LOST;
}

/** 是否已达成目标（可继续玩）。 */
export function isWon(g) {
  return g.result === WON;
}

/**
 * 直接摆一个盘面（测试与「读档」用）。
 * 会同步 score / moves / meta 的初始生成时刻，并把 result 重新判定一次。
 */
export function setGrid(g, grid, opts = {}) {
  const size = g.size;
  const next = emptyGrid(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      next[y][x] = Number(grid?.[y]?.[x]) || 0;
    }
  }
  g.grid = next;
  g.score = Number.isFinite(opts.score) ? opts.score : 0;
  g.best = Math.max(g.best, g.score);
  g.moves = 0;
  g.history.length = 0;
  g.spawns.length = 0;
  g.lastDir = null;
  g.meta = new Map();
  g.reachedTarget = maxTile(next) >= g.target;
  g.result = !hasMoves(next) ? LOST : (g.reachedTarget ? WON : PLAYING);
  return g;
}

/* ───────────────────────── 给 UI 的只读视图 ───────────────────────── */

/**
 * 组装渲染视图。render.js 只吃这个对象，不直接读对局内部结构。
 * 每帧调用，故只做一次浅遍历，不做搜索。
 */
export function snapshot(g, now = 0) {
  const cells = [];
  for (let y = 0; y < g.size; y++) {
    const row = [];
    for (let x = 0; x < g.size; x++) {
      const v = g.grid[y][x];
      const m = g.meta.get(coordKey(x, y)) || null;
      row.push({
        value: v,
        exp: tileExp(v),
        spawnAt: v && m ? (m.spawnAt || 0) : 0,
        mergeAt: v && m ? (m.mergeAt || 0) : 0,
      });
    }
    cells.push(row);
  }
  return {
    size: g.size,
    cells,
    score: g.score,
    best: Math.max(g.best, g.score),
    moves: g.moves,
    target: g.target,
    result: g.result,
    reachedTarget: g.reachedTarget,
    canUndo: canUndo(g),
    now,
  };
}

/** 顶部一行状态文案。 */
export function statusText(g) {
  if (g.result === LOST) return `无路可走 · 得分 ${g.score}`;
  if (g.reachedTarget) return `已达成 ${g.target} · 得分 ${g.score}`;
  return `目标 ${g.target} · 得分 ${g.score}`;
}
