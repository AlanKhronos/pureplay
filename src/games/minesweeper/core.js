/**
 * 扫雷核心逻辑（纯函数 + 一个纯数据会话，零依赖，可在 Node 里直接跑测试）
 *
 * 设计约束（沿用「荒潮拾荒者」/「纯净玩」的架构理念）：
 *   - 本文件不碰任何平台 API（无 wx、无 document、无 window、无 canvas）；
 *   - 唯一的外部能力是注入的随机数 rng（默认 defaultRandom），测试里换成种子随机数即可完全复现；
 *   - 棋盘状态显式，翻开 / 连锁展开 / 插旗 / 胜负全部可确定性复现；
 *   - 为 UI 提供「踩雷点」「空白连通区」「雷位」等渲染所需信息。
 */

/* ───────────────────────── 常量 ───────────────────────── */

/** 格子状态：未翻开 / 已翻开 / 已插旗。 */
export const HIDDEN = 0;
export const REVEALED = 1;
export const FLAGGED = 2;

/** 对局结果。 */
export const PLAYING = 'playing';
export const WON = 'won';
export const LOST = 'lost';

/** 八个邻接方向：横、竖、两条对角。 */
const DIRS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** 首点安全区半径：点击格及其一圈邻居（保证首点邻雷数为 0，必触发连锁展开）。 */
const SAFE_RADIUS = 1;

/** 三档难度（9×9/10、12×12/25、16×16/50）。 */
export const LEVELS = {
  easy: { key: 'easy', name: '初级', cols: 9, rows: 9, mines: 10 },
  medium: { key: 'medium', name: '中级', cols: 12, rows: 12, mines: 25 },
  hard: { key: 'hard', name: '高级', cols: 16, rows: 16, mines: 50 },
};

/** 难度 key 列表（顺序即难度递增）。 */
export const LEVEL_KEYS = Object.keys(LEVELS);

/** 取难度配置，未知 key 退回初级。 */
export function levelConfig(key) {
  return LEVELS[key] ?? LEVELS.easy;
}

/* ───────────────────────── 随机数 ───────────────────────── */

/**
 * 默认随机源。**本文件里 Math.random 只出现这一次**——布雷的一切随机性
 * 都必须走注入的 rng，测试才能用种子随机数把雷局完全复现。
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

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 坐标是否在棋盘内。 */
export function inBounds(board, x, y) {
  return x >= 0 && y >= 0 && x < board.cols && y < board.rows;
}

/** 取格子；越界返回 null（调用方自行判空）。 */
export function cellAt(board, x, y) {
  return inBounds(board, x, y) ? board.cells[y][x] : null;
}

/** 某格周围的地雷数。 */
export function countAdjacent(board, x, y) {
  let n = 0;
  for (const [dx, dy] of DIRS) {
    const c = cellAt(board, x + dx, y + dy);
    if (c && c.mine) n++;
  }
  return n;
}

/** 雷是否已布置（首次点开之前为 false）。 */
export function isPlanted(board) {
  return board.planted;
}

/* ───────────────────────── 建盘与布雷 ───────────────────────── */

/**
 * 创建一盘扫雷。此时**还没有布雷**——布雷推迟到首次点开时，
 * 这样天然保证「首点安全且周围无雷」。
 */
export function createBoard(levelKey = 'easy', rng = defaultRandom) {
  const cfg = levelConfig(levelKey);
  const cells = [];
  for (let y = 0; y < cfg.rows; y++) {
    const row = [];
    for (let x = 0; x < cfg.cols; x++) {
      row.push({ mine: false, adj: 0, state: HIDDEN });
    }
    cells.push(row);
  }
  return {
    key: cfg.key,
    cols: cfg.cols,
    rows: cfg.rows,
    mineTotal: cfg.mines,
    cells,
    planted: false,        // 是否已布雷
    firstX: -1,            // 首次点开的坐标（供 UI 提示/调试）
    firstY: -1,
    flags: 0,              // 已插旗数
    revealedCount: 0,      // 已翻开的非雷格数
    progress: 0,           // 翻开进度 0..1
    result: PLAYING,       // playing / won / lost
    boom: null,            // 踩雷点 {x, y}，供爆炸动画定位
    moves: 0,              // 有效操作次数（翻开 + 插旗/拔旗）
    lastAction: null,      // 最近一次操作 {type, x, y}，供 UI 做落点反馈
    rng,                   // 随机源（可注入，方便测试复现）
  };
}

/**
 * 布雷：避开 (avoidX, avoidY) 及其八邻域，让首点必为空白格。
 *
 * 挖雷位是在候选坐标数组上做部分洗牌，取前 mineTotal 个——
 * 这样「雷数恰好等于 mineTotal」是构造性保证，不依赖随机运气。
 *
 * @returns {{ok: boolean, reason?: string}} 候选格不够时返回 ok:false（不布雷）
 */
export function plantMines(board, avoidX = -1, avoidY = -1) {
  if (board.planted) return { ok: false, reason: 'planted' };

  // 1) 收集候选格（避开安全区）
  const pool = [];
  for (let y = 0; y < board.rows; y++) {
    for (let x = 0; x < board.cols; x++) {
      if (avoidX >= 0 && Math.abs(x - avoidX) <= SAFE_RADIUS && Math.abs(y - avoidY) <= SAFE_RADIUS) continue;
      pool.push({ x, y });
    }
  }
  if (pool.length < board.mineTotal) return { ok: false, reason: 'space' };

  // 2) 部分洗牌：只把前 mineTotal 位洗成互不相同的格子
  for (let i = 0; i < board.mineTotal; i++) {
    const j = i + Math.floor(board.rng() * (pool.length - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }

  // 3) 落雷并算邻雷数
  for (let i = 0; i < board.mineTotal; i++) {
    const p = pool[i];
    board.cells[p.y][p.x].mine = true;
  }
  for (let y = 0; y < board.rows; y++) {
    for (let x = 0; x < board.cols; x++) {
      board.cells[y][x].adj = countAdjacent(board, x, y);
    }
  }

  board.planted = true;
  board.firstX = avoidX;
  board.firstY = avoidY;
  return { ok: true };
}

/* ───────────────────────── 内部：翻开与判定 ───────────────────────── */

/**
 * 把 (x,y) 标记为已翻开并累加进度计数。
 * @returns 是否真的翻开了
 */
function revealCell(board, x, y) {
  const c = cellAt(board, x, y);
  if (!c || c.state !== HIDDEN) return false;
  c.state = REVEALED;
  if (!c.mine) board.revealedCount++;
  return true;
}

/**
 * 从 (x,y) 开始连锁展开空白区（广度优先的非递归写法，避免大棋盘爆栈）。
 * 规则：翻开 0 号格时，把它八邻域里的格子一并翻开；邻居中仍是 0 的继续扩散。
 * 邻居是雷则**不翻开**（正常局面下 0 号格周围不可能有雷）。
 * @returns {Array<{x:number,y:number}>} 本次新翻开的格子
 */
export function floodReveal(board, x, y) {
  const start = cellAt(board, x, y);
  if (!start || start.state !== HIDDEN) return [];

  const out = [];
  const queue = [[x, y]];
  const seen = new Set([y * board.cols + x]);

  while (queue.length) {
    const [cx, cy] = queue.shift();
    if (!revealCell(board, cx, cy)) continue;
    out.push({ x: cx, y: cy });

    if (board.cells[cy][cx].adj !== 0) continue; // 数字格到此为止
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      const key = ny * board.cols + nx;
      if (!inBounds(board, nx, ny) || seen.has(key)) continue;
      const n = board.cells[ny][nx];
      if (n.state !== HIDDEN || n.mine) continue; // 旗帜格与雷格都不自动翻开
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return out;
}

/** 刷新「翻开进度」（只算非雷格）。 */
function refreshProgress(board) {
  const safeTotal = board.rows * board.cols - board.mineTotal;
  board.progress = safeTotal > 0 ? board.revealedCount / safeTotal : 1;
}

/**
 * 胜负判定：所有非雷格都翻开即获胜（不强制把雷都插旗）。
 * @returns 是否在本判定中转为胜利
 */
export function checkWin(board) {
  if (board.result !== PLAYING) return false;
  const safeTotal = board.rows * board.cols - board.mineTotal;
  if (board.revealedCount >= safeTotal) {
    board.result = WON;
    flagAllMines(board);   // 胜利时把剩余的雷自动插旗，收尾画面干净
    return true;
  }
  return false;
}

/** 把所有未插旗的雷自动插旗（结算展示用）。 */
function flagAllMines(board) {
  let n = board.flags;
  for (let y = 0; y < board.rows; y++) {
    for (let x = 0; x < board.cols; x++) {
      const c = board.cells[y][x];
      if (c.mine && c.state === HIDDEN) { c.state = FLAGGED; n++; }
    }
  }
  board.flags = n;
}

/** 踩雷：标记战败，并揭开所有尚未插旗的雷（供结算画面显示）。 */
function explode(board, x, y) {
  board.result = LOST;
  board.boom = { x, y };
  board.cells[y][x].state = REVEALED;
  for (let yy = 0; yy < board.rows; yy++) {
    for (let xx = 0; xx < board.cols; xx++) {
      const c = board.cells[yy][xx];
      if (c.mine && c.state === HIDDEN) c.state = REVEALED;
    }
  }
}

/* ───────────────────────── 对外操作 ───────────────────────── */

/**
 * 翻开一格。首次翻开时先布雷（保证该格及其周围无雷），再连锁展开。
 *
 * @returns {{ok: boolean, reason?: string, revealed?: Array, boom?: {x,y}, win?: boolean, lose?: boolean}}
 *   reason: 'over' 对局已结束 / 'flagged' 旗帜格需先取消旗 / 'revealed' 已翻开 / 'oob' 越界 / 'space' 候选格不足
 */
export function reveal(board, x, y) {
  if (board.result !== PLAYING) return { ok: false, reason: 'over' };
  const c = cellAt(board, x, y);
  if (!c) return { ok: false, reason: 'oob' };
  if (c.state === FLAGGED) return { ok: false, reason: 'flagged' };
  if (c.state === REVEALED) return { ok: false, reason: 'revealed' };

  // 首点：先布雷（避开本格与八邻域）
  if (!board.planted) {
    const p = plantMines(board, x, y);
    if (!p.ok) return { ok: false, reason: p.reason };
  }

  board.moves++;
  board.lastAction = { type: 'reveal', x, y };

  if (c.mine) {
    explode(board, x, y);
    refreshProgress(board);
    return { ok: true, boom: { x, y }, lose: true, revealed: [] };
  }

  const revealed = floodReveal(board, x, y);
  refreshProgress(board);
  const win = checkWin(board);
  return { ok: true, revealed, win };
}

/**
 * 插旗 / 拔旗。只在未翻开的格子上有效；旗数不超过雷数（避免全靠插旗刷胜利）。
 * @returns {{ok: boolean, reason?: string, flagged?: boolean}}
 */
export function toggleFlag(board, x, y) {
  if (board.result !== PLAYING) return { ok: false, reason: 'over' };
  const c = cellAt(board, x, y);
  if (!c) return { ok: false, reason: 'oob' };
  if (c.state === REVEALED) return { ok: false, reason: 'revealed' };

  if (c.state === FLAGGED) {
    c.state = HIDDEN;
    board.flags = Math.max(0, board.flags - 1);
    board.moves++;
    board.lastAction = { type: 'unflag', x, y };
    return { ok: true, flagged: false };
  }

  if (board.flags >= board.mineTotal) return { ok: false, reason: 'flagLimit' };

  c.state = FLAGGED;
  board.flags++;
  board.moves++;
  board.lastAction = { type: 'flag', x, y };
  return { ok: true, flagged: true };
}

/** 剩余雷数（雷总数 − 已插旗数，下限 0）。 */
export function remainingMines(board) {
  return Math.max(0, board.mineTotal - board.flags);
}

/** 是否已分出胜负。 */
export function isOver(board) {
  return board.result !== PLAYING;
}

/** 是否胜利。 */
export function isWon(board) {
  return board.result === WON;
}

/** 是否战败。 */
export function isLost(board) {
  return board.result === LOST;
}

/**
 * 转成给 UI 的只读快照（render.js 只吃这个，不直接读棋盘内部结构）。
 * 每帧调用，故只做一次浅遍历，不做搜索。
 */
export function snapshot(board) {
  const grid = [];
  for (let y = 0; y < board.rows; y++) {
    const row = [];
    for (let x = 0; x < board.cols; x++) {
      const c = board.cells[y][x];
      row.push({
        state: c.state,          // 0 未翻开 / 1 已翻开 / 2 已插旗
        adj: c.state === REVEALED ? c.adj : 0,
        mine: c.state === REVEALED && c.mine,
      });
    }
    grid.push(row);
  }
  return {
    cols: board.cols,
    rows: board.rows,
    grid,
    mineTotal: board.mineTotal,
    flags: board.flags,
    remaining: remainingMines(board),
    revealedCount: board.revealedCount,
    progress: board.progress,
    result: board.result,
    boom: board.boom,
    planted: board.planted,
  };
}

/* ───────────────────────── 计时与操作记录 ───────────────────────── */

/** 计时数据（纯数据，不读时钟）。 */
export function createTimer() {
  return {
    running: false,
    startAt: 0,     // 开始时刻（ms，由外部传入）
    stopAt: 0,      // 结束时刻（ms）
    elapsed: 0,     // 结束时冻结的用时
  };
}

/** 开始计时；已开始则不重复计。 */
export function startTimer(t, now = 0) {
  if (t.running || t.elapsed > 0) return t;
  t.running = true;
  t.startAt = now;
  return t;
}

/** 停止计时并冻结用时。 */
export function stopTimer(t, now = 0) {
  if (!t.running) return t;
  t.running = false;
  t.stopAt = now;
  t.elapsed = Math.max(0, t.stopAt - t.startAt);
  return t;
}

/** 当前用时（ms）；未开始为 0。 */
export function elapsedMs(t, now = 0) {
  if (!t || (!t.running && t.elapsed === 0)) return 0;
  return t.running ? Math.max(0, now - t.startAt) : t.elapsed;
}

/** 把毫秒格式化成 mm:ss（超过 99 分钟则显示小时数）。 */
export function formatTime(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const pad = (v) => (v < 10 ? `0${v}` : `${v}`);
  return m > 99 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* ───────────────────────── 会话（纯数据，无平台 API） ───────────────────────── */

/**
 * 一盘扫雷的完整会话状态。全部通过下面两个纯函数推进，
 * 这样浏览器预览与微信小游戏跑的是同一份逻辑。
 */
export function createSession(levelKey = 'easy', rng = defaultRandom) {
  return {
    board: createBoard(levelKey, rng),
    timer: createTimer(),
    now: 0,              // 最近一次 update 的时间戳
    winAt: 0,            // 胜利时刻（做动画衰减）
    loseAt: 0,
    dirty: true,         // 快照是否需要重建
    snap: null,
  };
}

/** 本局是否已经开始（首次翻开后才算开始，计时才开始走）。 */
export function isStarted(session) {
  return session.board.planted;
}

/**
 * 推进一帧：结算时停表，并在必要时重建快照。
 * @returns {object} 当前快照
 */
export function updateSession(session, now) {
  session.now = now;
  const b = session.board;
  if (b.result !== PLAYING) {
    if (session.timer.running) stopTimer(session.timer, now);
    if (b.result === WON && !session.winAt) session.winAt = now;
    if (b.result === LOST && !session.loseAt) session.loseAt = now;
  }
  if (session.dirty || !session.snap) {
    session.snap = snapshot(b);
    session.dirty = false;
  }
  return session.snap;
}

/** 会话内翻开一格（含计时启停与快照失效）。 */
export function sessionReveal(session, x, y, now = 0) {
  const b = session.board;
  if (b.result !== PLAYING) return { ok: false, reason: 'over' };
  if (!b.planted) startTimer(session.timer, now);
  const r = reveal(b, x, y);
  if (r.ok && (r.win || r.lose)) {
    stopTimer(session.timer, now);
    if (r.win) session.winAt = now;
    if (r.lose) session.loseAt = now;
  }
  if (r.ok) session.dirty = true;
  return r;
}

/** 会话内插旗/拔旗。 */
export function sessionFlag(session, x, y) {
  const r = toggleFlag(session.board, x, y);
  if (r.ok) session.dirty = true;
  return r;
}

/** 重开一局（换新棋盘，并可换难度）。 */
export function sessionReset(session, levelKey = null, rng = null) {
  session.board = createBoard(levelKey ?? session.board.key, rng ?? session.board.rng);
  session.timer = createTimer();
  session.winAt = 0;
  session.loseAt = 0;
  session.dirty = true;
  session.snap = null;
  return session;
}
