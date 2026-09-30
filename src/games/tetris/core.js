/**
 * 俄罗斯方块核心逻辑（纯函数，零依赖，可在 Node 里直接跑测试）
 *
 * 设计约束（沿用「荒潮拾荒者」的架构理念）：
 *   - 本文件不碰任何平台 API（无 wx、无 document、无 window、无 canvas）；
 *   - 棋盘 / 方块 / 随机序列全部显式保存，同一颗种子必然复现同一局；
 *   - 旋转用「矩阵转置 + 颠倒列序」直接算出来，不做硬编码的形状表——
 *     7 种方块的 4 个朝向是同一份代码推导的，测一次就等于测了全部；
 *   - 为 UI 提供「当前方块矩阵」「下一个方块」「幽灵落点」等渲染所需信息。
 *
 * 坐标系：x 向右（0..9），y 向下（0..19）。方块矩阵中 1 表示实体格。
 */

/* ───────────────────────── 常量 ───────────────────────── */

/** 棋盘列数。 */
export const COLS = 10;
/** 棋盘行数。 */
export const ROWS = 20;
/** 空格子标记。 */
export const EMPTY = 0;

/** 方块种类（7 种）。 */
export const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

/**
 * 出生形状。统一用「最紧的方阵」表示：
 *   I 用 4×4，其余用 3×3，且实体格尽量贴着矩阵上方——这样矩阵中心就是旋转中心，
 *   4 个朝向也只是在方阵里平移，不会「转一次就往下掉一格」。
 *   除 I / O 外都占满矩阵的最下面两行，出生时正好压在第 0、1 行上。
 */
export const SHAPES = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  O: [
    [0, 0, 0],
    [0, 1, 1],
    [0, 1, 1],
  ],
  T: [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 1],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  J: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 1],
  ],
  L: [
    [0, 0, 0],
    [0, 0, 1],
    [1, 1, 1],
  ],
};

/**
 * 每种方块的配色（只在方块自身内部做明暗，保证 7 种一眼分得开）。
 * 由 render.js 取用；这是数据不是平台 API，放在 core 里便于测试同时校验齐全。
 */
export const COLORS = {
  I: { base: '#3ec6f0', hi: '#a6e9ff', lo: '#1a7ea6' },
  O: { base: '#f0c53e', hi: '#ffe9a3', lo: '#a37f11' },
  T: { base: '#b46ce8', hi: '#e0b8ff', lo: '#6f3a9c' },
  S: { base: '#4ad97f', hi: '#b0f5c8', lo: '#1f8a4b' },
  Z: { base: '#ef5f5f', hi: '#ffb1b1', lo: '#9c2b2b' },
  J: { base: '#4d7ef0', hi: '#b3c8ff', lo: '#22439c' },
  L: { base: '#f09a3e', hi: '#ffd0a0', lo: '#a55c11' },
};

/**
 * 难度档位（与 index.js 的 meta.difficulties 一一对应）。
 *   interval —— 一级时的下落间隔（毫秒）
 *   drop     —— 每升一级，间隔乘以这个系数（越小越快）
 */
export const DIFFICULTIES = {
  chill:  { name: '悠闲', interval: 900, drop: 0.86 },
  normal: { name: '普通', interval: 650, drop: 0.84 },
  fast:   { name: '快速', interval: 420, drop: 0.82 },
  turbo:  { name: '极速', interval: 260, drop: 0.80 },
};

/** 默认难度。 */
export const DEFAULT_DIFFICULTY = 'normal';

/** 难度档位参数（未知 key 退回默认档，绝不抛错）。 */
export function difficultyConfig(key) {
  return DIFFICULTIES[key] ?? DIFFICULTIES[DEFAULT_DIFFICULTY];
}

/** 消 1/2/3/4 行的基础分（乘当前等级）。 */
export const LINE_SCORES = [0, 100, 300, 500, 800];
/** 软降每下落一格的分。 */
export const SOFT_DROP_SCORE = 1;
/** 硬降每下落一格的分。 */
export const HARD_DROP_SCORE = 2;
/** 每消几行升一级。 */
export const LINES_PER_LEVEL = 10;
/** 等级上限（防止速度归零）。 */
export const MAX_LEVEL = 20;

/* ───────────────────────── 基础工具 ───────────────────────── */

/**
 * 顺时针旋转一个方阵：转置后把列序颠倒。
 * 3×3 与 4×4 都适用，且方阵尺寸不变，所以旋转中心就是矩阵中心。
 */
export function rotateMatrixCW(m) {
  const n = m.length;
  const out = [];
  for (let y = 0; y < n; y++) {
    const row = [];
    for (let x = 0; x < n; x++) row.push(m[n - 1 - x][y]);
    out.push(row);
  }
  return out;
}

/** 取某种方块的第 r 个朝向（0..3），返回新矩阵，不会污染 SHAPES。 */
export function rotateShape(type, r = 0) {
  const base = SHAPES[type];
  if (!base) return null;
  const times = (((r % 4) + 4) % 4);
  let m = base;
  for (let i = 0; i < times; i++) m = rotateMatrixCW(m);
  return m;
}

/** 列出方块在矩阵坐标下的所有实体格 [[x,y], ...]。 */
export function cellsOf(matrix) {
  const out = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x]) out.push([x, y]);
    }
  }
  return out;
}

/** 方块在局面上占据的格子（矩阵坐标 + 方块坐标）。 */
export function pieceCells(piece) {
  const m = rotateShape(piece.type, piece.r);
  return cellsOf(m).map(([x, y]) => [piece.x + x, piece.y + y]);
}

/** 把方块压成「字符串签名」——测试里比对形状最方便，也便于去重。 */
export function shapeSignature(type, r = 0) {
  const m = rotateShape(type, r);
  if (!m) return '';
  const cells = cellsOf(m);
  if (!cells.length) return '';
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const w = Math.max(...cells.map((c) => c[0])) - minX + 1;
  const h = Math.max(...cells.map((c) => c[1])) - minY + 1;
  const grid = [];
  for (let y = 0; y < h; y++) grid.push(new Array(w).fill('.'));
  for (const [x, y] of cells) grid[y - minY][x - minX] = '#';
  return grid.map((row) => row.join('')).join('/');
}

/** 方块在矩阵坐标系下的包围盒（宽度 / 高度）。 */
export function shapeBounds(type, r = 0) {
  const cells = cellsOf(rotateShape(type, r));
  return {
    w: Math.max(...cells.map((c) => c[0])) - Math.min(...cells.map((c) => c[0])) + 1,
    h: Math.max(...cells.map((c) => c[1])) - Math.min(...cells.map((c) => c[1])) + 1,
  };
}

/* ───────────────────────── 棋盘与随机 ───────────────────────── */

/** 创建一个空棋盘（grid[y][x]，0 表示空）。 */
export function createGrid() {
  const grid = [];
  for (let y = 0; y < ROWS; y++) grid.push(new Array(COLS).fill(EMPTY));
  return grid;
}

/**
 * 可复现的伪随机数（mulberry32）。
 * 用自带 PRNG 而不是 Math.random，是为了让「同一颗种子 = 同一局」，
 * 测试里才能确定性地断言 7-bag 的行为。
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

/**
 * 7-bag 随机器：把 7 种方块洗成一袋依次发完，再洗下一袋。
 * 好处是**任意连续 7 个方块恰好是 7 种各一个**——不会连续十几次不出 I。
 */
export function createBag(rand = Math.random) {
  let pool = [];
  const refill = () => {
    pool = TYPES.slice();
    // Fisher-Yates
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
  };
  return {
    /** 取下一个方块类型。 */
    next() {
      if (pool.length === 0) refill();
      return pool.pop();
    },
    /** 当前袋里还剩几种（供调试/测试）。 */
    get remaining() { return pool.length; },
  };
}

/* ───────────────────────── 局面创建 ───────────────────────── */

/**
 * 造一个方块（不判断合法性，纯数据）。
 * x 是方块矩阵左上角在棋盘上的列号；方块实体在矩阵里有偏移，
 * 具体占哪几列由 pieceCells() 换算。
 */
export function makePiece(type, x = 4, y = 0, r = 0) {
  return { type, x, y, r };
}

/**
 * 出生列：让方块的**实体格**居中于棋盘。
 * 必须减去实体格在矩阵里的横向偏移 minX——否则像 I（实体在第 2 列）这类
 * 方块会被整体推偏（这个坑已经踩过：竖 I 会跑到第 6 列去）。
 */
export function spawnX(type) {
  const cells = cellsOf(SHAPES[type]);
  const minX = Math.min(...cells.map((c) => c[0]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const w = maxX - minX + 1;
  return Math.round((COLS - w) / 2) - minX;
}

/** 创建一局新游戏。 */
export function createState(options = {}) {
  const rand = options.random ?? mulberry32(options.seed ?? 1);
  const state = {
    grid: createGrid(),
    bag: createBag(rand),
    piece: null,
    next: null,
    score: 0,
    level: 1,
    lines: 0,
    status: 'ready',        // ready | playing | paused | over
    difficulty: options.difficulty ?? DEFAULT_DIFFICULTY,
    elapsed: 0,             // 累计推进的毫秒（暂停不计）
    dropAcc: 0,             // 距离下次自动下落已累计的毫秒
    lastClear: 0,           // 上一次消除的行数（供 UI 做飘分）
    lastClearAt: -1,        // 上一次消除发生在 elapsed 的哪一毫秒
    softDropping: false,    // 是否按住软化键
  };
  // 先备好当前块与下一块，status 仍为 ready（由 start 才真正开动）
  state.piece = spawnNext(state);
  state.next = spawnNext(state);
  // 出生位已经放不下 = 一开局就结束
  if (!canPlace(state, state.piece.type, state.piece.x, state.piece.y, state.piece.r)) {
    state.status = 'over';
  }
  return state;
}

/** 开始游戏（从 ready 进入 playing）。 */
export function start(state) {
  if (state.status === 'over') return state;
  state.status = 'playing';
  state.dropAcc = 0;
  return state;
}

/** 暂停 / 继续（只在 playing 与 paused 之间切换）。 */
export function togglePause(state) {
  if (state.status === 'playing') state.status = 'paused';
  else if (state.status === 'paused') state.status = 'playing';
  return state.status;
}

/** 结束本局。 */
export function gameOver(state) {
  state.status = 'over';
  return state;
}

/** 从袋里取一个新的方块（核心：决定出生坐标）。 */
function spawnNext(state) {
  const type = state.bag.next();
  return makePiece(type, spawnX(type), 0, 0);
}

/* ───────────────────────── 碰撞与移动 ───────────────────────── */

/** 某一格是否可以放（在界内且为空）。y < 0 视为「尚未进入棋盘」的合法位置。 */
export function cellFree(grid, x, y) {
  if (x < 0 || x >= COLS || y >= ROWS) return false;
  if (y < 0) return true;
  return grid[y][x] === EMPTY;
}

/** 方块放在该位置是否合法（不越界、不压已有块）。 */
export function canPlace(state, type, x, y, r) {
  const m = rotateShape(type, r);
  if (!m) return false;
  for (const [cx, cy] of cellsOf(m)) {
    if (!cellFree(state.grid, x + cx, y + cy)) return false;
  }
  return true;
}

/** 判断当前方块能否朝某个偏移移动（0 表示原地，用于判断是否已触底）。 */
export function canMove(state, dx, dy) {
  const p = state.piece;
  if (!p) return false;
  return canPlace(state, p.type, p.x + dx, p.y + dy, p.r);
}

/** 左右移动一格。 */
export function move(state, dx) {
  if (state.status !== 'playing') return false;
  const p = state.piece;
  if (!p || !canMove(state, dx, 0)) return false;
  p.x += dx;
  return true;
}

export function moveLeft(state) { return move(state, -1); }
export function moveRight(state) { return move(state, 1); }

/**
 * 旋转（顺时针）。
 * 逐次尝试水平踢墙偏移：原地 → 左一格 → 右一格 → 左两格 → 右两格。
 * 这是最简的「贴墙还能转」方案，比完整 SRS 简单，手感够用且行为可预测。
 */
export const KICK_OFFSETS = [0, -1, 1, -2, 2];

export function rotate(state, dir = 1) {
  if (state.status !== 'playing') return false;
  const p = state.piece;
  if (!p || p.type === 'O') return false;      // O 转不转一个样，直接省掉
  const nr = (((p.r + (dir >= 0 ? 1 : 3)) % 4) + 4) % 4;
  for (const dx of KICK_OFFSETS) {
    if (canPlace(state, p.type, p.x + dx, p.y, nr)) {
      p.x += dx;
      p.r = nr;
      return true;
    }
  }
  return false;                                 // 被卡死，旋转失败（不算错误）
}

/** 软降：能下则下一格，返回是否成功。 */
export function softDrop(state) {
  if (state.status !== 'playing') return false;
  const p = state.piece;
  if (!p || !canMove(state, 0, 1)) return false;
  p.y += 1;
  state.score += SOFT_DROP_SCORE;
  return true;
}

/** 幽灵落点：当前方块一直往下掉会停在哪一行。 */
export function dropDistance(state, piece = state.piece) {
  if (!piece) return 0;
  const m = rotateShape(piece.type, piece.r);
  let dy = 0;
  // 最多找 ROWS 行，避免异常矩阵导致死循环
  while (dy < ROWS) {
    let blocked = false;
    for (const [cx, cy] of cellsOf(m)) {
      if (!cellFree(state.grid, piece.x + cx, piece.y + dy + 1 + cy)) { blocked = true; break; }
    }
    if (blocked) break;
    dy++;
  }
  return dy;
}

/**
 * 硬降：一步落到底，按掉落格数加分，然后立即锁定。
 * @returns {{dropped: number, cleared: number, score: number, over: boolean}|null}
 */
export function hardDrop(state) {
  if (state.status !== 'playing') return null;
  const p = state.piece;
  if (!p) return null;
  const dy = dropDistance(state);
  p.y += dy;
  state.score += dy * HARD_DROP_SCORE;
  return lock(state);
}

/* ───────────────────────── 锁定与消行 ───────────────────────── */

/** 找出所有填满的行号（升序）。 */
export function fullRows(grid) {
  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    let full = true;
    for (let x = 0; x < COLS; x++) {
      if (grid[y][x] === EMPTY) { full = false; break; }
    }
    if (full) rows.push(y);
  }
  return rows;
}

/**
 * 消除给定的行：把被消行删掉，从顶部补等量的空行。
 * 就地修改 grid，返回实际消掉的行数。
 */
export function clearRows(grid, rows) {
  if (!rows || rows.length === 0) return 0;
  const drop = new Set(rows);
  const kept = [];
  for (let y = 0; y < ROWS; y++) {
    if (!drop.has(y)) kept.push(grid[y]);
  }
  while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(EMPTY));
  for (let y = 0; y < ROWS; y++) grid[y] = kept[y];
  return rows.length;
}

/** 消行得分：查表 × 当前等级。 */
export function scoreForLines(count, level = 1) {
  const base = LINE_SCORES[count] ?? 0;
  return base * Math.max(1, level);
}

/** 等级换算：每消 10 行升一级，上限 MAX_LEVEL。 */
export function levelForLines(lines) {
  return Math.min(MAX_LEVEL, 1 + Math.floor(lines / LINES_PER_LEVEL));
}

/**
 * 当前等级下的下落间隔（毫秒）。等级越高间隔越短。
 * 以难度档位的 interval 为一级基准，逐级乘以 drop 系数。
 */
export function fallInterval(state) {
  const cfg = difficultyConfig(state.difficulty);
  const lv = Math.max(1, state.level);
  return Math.max(50, Math.round(cfg.interval * Math.pow(cfg.drop, lv - 1)));
}

/* ───────────────────── 加速下落（软降键）的节奏 ───────────────────── */

/**
 * 按住「加速」键时，下落间隔缩到自然间隔的 1/SOFT_DROP_DIVISOR。
 * 普通难度 650ms → 65ms（约 10 倍），跟用户要的「明显加快」对得上。
 * 这是**手感参数**，不是规则：改它不影响消行/计分/7-bag/AI。
 */
export const SOFT_DROP_DIVISOR = 10;
/** 加速下落的最短间隔（再快就看不清了，也避免一帧掉好几格）。 */
export const SOFT_DROP_MIN_INTERVAL = 55;

/**
 * 按住加速键时的下落间隔。
 *   - 取自然间隔的 1/10；
 *   - 用 SOFT_DROP_MIN_INTERVAL 兜底，避免高等级下快到看不清；
 *   - 最后与自然间隔取 min —— 高等级时自然间隔本身已经接近下限（50ms），
 *     若不夹这一层，会出现「按住加速键反而比不按更慢」的反向 bug。
 */
export function softDropInterval(state) {
  const natural = fallInterval(state);
  return Math.max(1, Math.min(natural, Math.max(SOFT_DROP_MIN_INTERVAL, Math.round(natural / SOFT_DROP_DIVISOR))));
}

/**
 * 这一帧真正生效的下落间隔：按住加速键就用软降间隔。
 * tick（推进）与 fallProgress（渲染插值）共用这一份，避免两处各算一套、越算越偏。
 */
export function activeInterval(state) {
  return state.softDropping ? softDropInterval(state) : fallInterval(state);
}

/**
 * 「距上次落格」的进度，0~1。渲染层用它做**下落插值**：
 * 把 core 的整格坐标 y 再加上 progress × 一格高度，方块就从「整格跳」变成连续下移。
 *
 * 为什么不能无脑用 dropAcc / interval：
 *   ① 方块已经压在堆上/地面时（落不动了），它还要等一个完整间隔才锁定；这段时间若照常
 *      插值，方块会一点点「沉进地面」再在锁定时弹回来——必须钉在 0；
 *   ② 暂停 / 结束 / 准备中都没有「下落」可言，一律钉在 0。
 * 落格那一帧 tick 会把 dropAcc 减去一个间隔（相位自然回到 0）而 y 恰好 +1 格，
 * 两者相加的像素位置完全相等 —— 所以落格瞬间不会抖动。
 */
export function fallProgress(state) {
  if (state.status !== 'playing' || !state.piece) return 0;
  if (!canMove(state, 0, 1)) return 0;          // 落不动了：不插值（见上面 ①）
  const iv = activeInterval(state);
  if (!(iv > 0)) return 0;
  const t = state.dropAcc / iv;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** 把当前方块写进棋盘，然后消行、加分、升级、换下一块。 */
export function lock(state) {
  const p = state.piece;
  if (!p) return null;
  const m = rotateShape(p.type, p.r);
  for (const [cx, cy] of cellsOf(m)) {
    const x = p.x + cx, y = p.y + cy;
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) state.grid[y][x] = p.type;
  }

  const rows = fullRows(state.grid);
  const cleared = clearRows(state.grid, rows);
  if (cleared > 0) {
    state.score += scoreForLines(cleared, state.level);
    state.lines += cleared;
    state.level = levelForLines(state.lines);
    state.lastClear = cleared;
    state.lastClearAt = state.elapsed;
  } else {
    state.lastClear = 0;
  }

  // 换下一块
  state.piece = state.next;
  state.next = spawnNext(state);
  // 新块出生时把下落计时清零。两个理由：
  //   ① 手感：每个方块都该拿到一整个间隔才落第一格，不能继承上一个方块残留的计时
  //      （旧写法在硬降之后，新块会因为残留的累计时间「一出生就往下掉」）；
  //   ② 渲染：下落插值的相位 = dropAcc / interval，残留的旧计时会让新块带着
  //      0.9 这种相位出生，视觉上「先掉大半格再弹回去」——这正是插值抖动的根源。
  state.dropAcc = 0;
  if (!canPlace(state, state.piece.type, state.piece.x, state.piece.y, state.piece.r)) {
    state.status = 'over';   // 新块一出生就放不下 = 游戏结束
  }
  return { dropped: 0, cleared, score: state.score, over: state.status === 'over' };
}

/* ───────────────────────── 时间推进 ───────────────────────── */

/**
 * 每帧推进。按累计时间自动下落（重力），并把当前方块锁定。
 * @returns {{steps: number, cleared: number, over: boolean, interval: number}}
 */
export function tick(state, dtMs) {
  const out = { steps: 0, cleared: 0, over: state.status === 'over', interval: fallInterval(state) };
  if (state.status !== 'playing') return out;

  const dt = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
  state.elapsed += dt;
  // 按住加速键时用更短的间隔。这里与 fallProgress（渲染插值）共用 activeInterval，
  // 两边必须同源，否则插值相位与实际落格时刻对不上，方块会「滑过头再弹回来」。
  out.interval = activeInterval(state);
  state.dropAcc += dt;

  let guard = 0;
  while (state.dropAcc >= out.interval && guard++ < ROWS + 4) {
    state.dropAcc -= out.interval;
    if (!softDrop(state)) {
      // 落不动了：立刻锁定（不等下一次重力）
      const res = lock(state);
      if (res) {
        out.steps += 1;
        out.cleared = res.cleared;
        if (res.over) break;
      } else break;
    } else {
      out.steps += 1;
    }
  }
  out.over = state.status === 'over';
  return out;
}

/* ───────────────────────── 其它查询 ───────────────────────── */

/** 重开一局（保留难度；重新抽种子保证下一局不一样）。 */
export function restart(state, seed) {
  const next = createState({ difficulty: state.difficulty, seed: seed ?? Math.floor(Math.random() * 1e9) });
  // 就地替换内容，避免调用方手里的引用失效
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, next);
  return start(state);
}

/** 顶部状态文案（HUD 用）。 */
export function statusText(state) {
  if (state.status === 'paused') return '已暂停';
  if (state.status === 'over') return '游戏结束';
  if (state.status === 'ready') return '准备开始';
  const cfg = difficultyConfig(state.difficulty);
  return cfg.name;
}

/**
 * 消行动画的分档文案（供 UI 飘字）。
 * 4 行是俄罗斯方块最爽的一击，给个专门称号。
 */
export function clearLabel(count) {
  if (count === 4) return '四行齐消！';
  if (count === 3) return '三行！';
  if (count === 2) return '双行！';
  if (count === 1) return '消一行';
  return '';
}
