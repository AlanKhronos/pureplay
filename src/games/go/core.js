/**
 * 围棋（Go）核心逻辑 —— 纯函数，零依赖，可在 Node 里直接跑测试
 *
 * 设计约束（沿用「纯净玩」的架构理念）：
 *   - 本文件不碰任何平台 API（无 wx、无 document、无 window、无 canvas）；
 *   - 棋盘两档：**休闲 13 路**（SIZE_CASUAL）/ **专业 19 路**（SIZE_PRO，标准盘 9 个星位）；
 *     规则实现只有一套，路数只影响几何、贴目与 AI 的候选点策略；
 *   - 棋盘状态显式，落子/提子/打劫/数子全部可确定性复现；
 *   - 为 UI 提供「最后一手」「提子数」「地盘标记」等渲染所需信息。
 *
 * 实现的规则范围：
 *   气计算、提子、禁止自杀、打劫（位置型超劫：与任何历史局面同形即禁止）、
 *   虚手（pass）与连续两次 pass 终局、认输、中国规则数子估算胜负（子 + 围空）。
 *   死活不深算：地盘估算按「空白区域只与一方相邻则归该方」判定，
 *   终局时盘上的死子仍会被算作活棋——故最终比分是估算值，UI 里已注明。
 */

/* ───────────────────────── 常量 ───────────────────────── */

/** 休闲档棋盘：13 路（同屏格子更大、上手更快）。 */
export const SIZE_CASUAL = 13;
/** 专业档棋盘：19 路标准盘（9 个星位）。 */
export const SIZE_PRO = 19;
/** 默认路数（不显式传 size 时）：休闲档 13 路。 */
export const SIZE = SIZE_CASUAL;

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
/** 和棋标记。 */
export const DRAW = -1;

/**
 * 贴目（中国规则数子法的估算口径）：
 *   19 路标准盘贴 7.5（3¾ 子）；13 路及以下小盘习惯折半贴 6.5。
 */
export const KOMI = 6.5;

/** 按路数取贴目。 */
export function komiFor(size) {
  return size >= SIZE_PRO ? 7.5 : KOMI;
}

/** 四个邻接方向：上下左右。 */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * 星位表（按路数）。19 路标准盘 9 个星位：3 / 9 / 15 线两两相交 + 天元。
 * 13 路 5 个：3 / 6 / 9 线（四角 + 天元）。
 */
const STAR_TABLE = {
  9: [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]],
  13: [[3, 3], [9, 3], [6, 6], [3, 9], [9, 9]],
  19: [
    [3, 3], [9, 3], [15, 3],
    [3, 9], [9, 9], [15, 9],
    [3, 15], [9, 15], [15, 15],
  ],
};

/** 取某路数的星位坐标（返回新数组，调用方可放心修改）。 */
export function starPoints(size) {
  const hit = STAR_TABLE[size];
  if (hit) return hit.map(([x, y]) => [x, y]);
  // 表外路数（测试可传任意 size）：按边距 3（大）或 2（小）给四角 + 天元
  const edge = size >= 13 ? 3 : 2;
  const mid = (size - 1) / 2;
  const out = [[edge, edge], [size - 1 - edge, edge], [edge, size - 1 - edge], [size - 1 - edge, size - 1 - edge]];
  if (Number.isInteger(mid)) out.splice(2, 0, [mid, mid]);
  return out;
}

/** 默认路数（13）的星位，供旧引用/渲染兜底。 */
export const STAR_POINTS = starPoints(SIZE);

/** 连续 pass 达到该次数即终局（两人各停一手）。 */
export const PASSES_TO_END = 2;

/** 安全阀：连续这么多手既无提子也无虚手就强制终局（防止双方在同一区域反复填子把棋局拖死）。 */
export const MAX_QUIET_MOVES = 60;

/** 按路数取「填子安全阀」阈值：按盘面点数等比放大（9 路 81 点 → 60 手为基准）。
 *  13 路 169 点 → 125 手；19 路 361 点 → 267 手。
 *  否则大棋盘会在中盘（盘面还大半是空的）就被误判终局。 */
export function maxQuietMoves(size) {
  const scaled = Math.round(MAX_QUIET_MOVES * (size * size) / 81);
  return Math.max(MAX_QUIET_MOVES, scaled);
}

/** 按路数取「AI 认为该收工了」的连续无提子手数阈值。 */
export function quietPassThreshold(size) {
  return size >= SIZE_PRO ? 40 : 20;
}

/** 按路数取「反复虚手即收工」的手数下限（19 路中盘远未下满，别过早收）。 */
export function settlePassMoves(size) {
  return size >= SIZE_PRO ? 80 : 40;
}

/* ───────────────────────── 基础 ───────────────────────── */

/** 返回对方的棋子颜色。 */
export function opponent(player) {
  return player === BLACK ? WHITE : BLACK;
}

/** 坐标是否在棋盘内。 */
export function inBounds(board, x, y) {
  const n = board.size;
  return x >= 0 && y >= 0 && x < n && y < n;
}

/**
 * 创建一个空棋盘状态。
 * @param size 路数（默认 13 路；19 路专业盘传 SIZE_PRO）
 */
export function createBoard(size = SIZE) {
  const grid = [];
  for (let y = 0; y < size; y++) grid.push(new Array(size).fill(EMPTY));
  return {
    size,
    grid,
    moves: [],        // 对局记录 [{x, y, player, pass, captures}]，pass 时 x/y 为 -1
    current: BLACK,   // 当前该谁落子（黑先）
    captures: { [BLACK]: 0, [WHITE]: 0 },  // 各方「提掉对方多少子」
    passes: 0,        // 当前连续虚手次数
    quiet: 0,         // 连续无提子无虚手的手数（安全阀用）
    ko: null,         // 打劫禁着点 {x, y}：上一手刚提子形成劫争的落点
    hashes: [],       // 每次有效落子后的棋盘指纹（位置型超劫判定用）
    over: false,      // 对局是否已结束
    result: null,     // 终局结果快照（见 finishGame）
  };
}

/** 深拷贝棋盘（AI 试算用；不复制 UI 无关的历史，够用且快）。 */
export function cloneBoard(board) {
  return {
    size: board.size,
    grid: board.grid.map((row) => row.slice()),
    moves: board.moves.slice(),
    current: board.current,
    captures: { ...board.captures },
    passes: board.passes,
    quiet: board.quiet,
    ko: board.ko ? { ...board.ko } : null,
    hashes: board.hashes.slice(),
    over: board.over,
    result: board.result,
  };
}

/** 棋盘指纹（用于同形/打劫检测；字符串比较，棋盘小开销可忽略）。 */
export function boardHash(board) {
  return board.grid.map((row) => row.join('')).join('');
}

/* ───────────────────────── 气与棋块 ───────────────────────── */

/** 求某点所在棋块的全部棋子。@returns [[x,y], ...]；该点为空则返回空数组。 */
export function groupAt(board, x, y) {
  const color = board.grid[y]?.[x] ?? EMPTY;
  if (color === EMPTY) return [];
  const size = board.size;
  const seen = new Set([y * size + x]);
  const stack = [[x, y]];
  const out = [];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    out.push([cx, cy]);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (board.grid[ny][nx] !== color) continue;
      const k = ny * size + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push([nx, ny]);
    }
  }
  return out;
}

/** 求某点所在棋块的气（liberty）数：棋块所有棋子相邻的空点数。 */
export function liberties(board, x, y) {
  const color = board.grid[y]?.[x] ?? EMPTY;
  if (color === EMPTY) return 0;
  const size = board.size;
  const seen = new Set();
  for (const [cx, cy] of groupAt(board, x, y)) {
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (board.grid[ny][nx] !== EMPTY) continue;
      seen.add(ny * size + nx);
    }
  }
  return seen.size;
}

/** 求某点所在棋块的气点坐标（AI 看眼位、找单气棋块用）。 */
export function libertyPoints(board, x, y) {
  const color = board.grid[y]?.[x] ?? EMPTY;
  if (color === EMPTY) return [];
  const size = board.size;
  const seen = new Set();
  const out = [];
  for (const [cx, cy] of groupAt(board, x, y)) {
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (board.grid[ny][nx] !== EMPTY) continue;
      const k = ny * size + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([nx, ny]);
    }
  }
  return out;
}

/* ───────────────────────── 落子 / 提子 / 打劫 ───────────────────────── */

/** 网格版：求某点所在棋块的气数（不依赖 board 对象，供试算复用）。 */
function countLibs(grid, size, x, y) {
  const color = grid[y][x];
  if (color === EMPTY) return 0;
  const seen = new Set([y * size + x]);
  const stack = [[x, y]];
  const libs = new Set();
  while (stack.length) {
    const [cx, cy] = stack.pop();
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const v = grid[ny][nx];
      if (v === EMPTY) { libs.add(ny * size + nx); continue; }
      if (v !== color) continue;
      const k = ny * size + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push([nx, ny]);
    }
  }
  return libs.size;
}

/** 网格版：求某点所在棋块的全部坐标。 */
function collectGroup(grid, size, x, y, color) {
  const seen = new Set([y * size + x]);
  const stack = [[x, y]];
  const out = [];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    out.push([cx, cy]);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (grid[ny][nx] !== color) continue;
      const k = ny * size + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push([nx, ny]);
    }
  }
  return out;
}

/**
 * 提掉「刚落子后失去最后一口气」的对方棋块（就地修改 grid）。
 *
 * 性能要点（19 路必须做到）：落子只可能影响**落点四邻**的棋块，
 * 因此只检查这最多 4 个棋块，绝不全盘扫描——全盘找无气棋块是 O(棋盘²)，
 * 19 路下会被 AI 的每一手试算放大 361 倍。
 * @returns 被提子坐标数组
 */
function captureAround(grid, size, x, y, color) {
  const captured = [];
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    if (grid[ny][nx] !== color) continue;
    if (countLibs(grid, size, nx, ny) > 0) continue;
    // 无气 → 整块提掉（提完该点变空，另一个邻点自然被跳过，不会重复提）
    for (const [gx, gy] of collectGroup(grid, size, nx, ny, color)) {
      grid[gy][gx] = EMPTY;
      captured.push([gx, gy]);
    }
  }
  return captured;
}

/**
 * 打劫判定：这一手之后若与**任何历史局面**同形，即禁止。
 *
 * 这是标准的位置型超劫（positional superko），比「只回看一手」的简单劫更严：
 *   - 只回看一手会把「隔几手的同形循环」放过去；
 *   - 不变式：board.hashes[k] = 第 k+1 手落子之后的局面，长度 = 已落子数。
 * 快速路径先比 hashes[length-2]（单劫最常见的形态），未命中再做全量比较。
 */
function repeatsHistory(board, grid) {
  const n = board.hashes.length;
  if (n === 0) return false;
  const now = grid.map((row) => row.join('')).join('');
  if (n >= 2 && board.hashes[n - 2] === now) return true;
  return board.hashes.includes(now);
}

/**
 * 试算：把某手棋落在临时副本上，返回结果（不修改真实棋盘）。
 * 这是「禁止自杀」「打劫」与 AI 评估共用的唯一判定入口。
 * @returns {{ok, reason?, grid?, captured?, suicide?}}
 */
export function simulate(board, x, y, player = board.current) {
  if (board.over) return { ok: false, reason: 'over' };
  if (!inBounds(board, x, y)) return { ok: false, reason: 'out-of-bounds' };
  if (board.grid[y][x] !== EMPTY) return { ok: false, reason: 'occupied' };

  const size = board.size;
  const grid = board.grid.map((row) => row.slice());
  grid[y][x] = player;

  // ① 先提对方无气棋块（只可能发生在落点四邻）
  const captured = captureAround(grid, size, x, y, opponent(player));

  // ② 再判自己：落子后自己无气且没提到子 → 自杀
  if (captured.length === 0 && countLibs(grid, size, x, y) === 0) {
    return { ok: false, reason: 'suicide' };
  }

  // ③ 打劫（位置型超劫）：提子后若与历史局面同形，禁止
  if (captured.length > 0 && repeatsHistory(board, grid)) {
    return { ok: false, reason: 'ko' };
  }

  // ④ 这一手是否「造劫」：把提子后的局面当作「上一手」，试算对手在回提点落子；
  //    若被拒且理由是 ko，说明这一手造出了劫争。UI 用 board.ko 画红叉提示。
  let koRepetition = false;
  if (captured.length === 1) {
    const [cx, cy] = captured[0];
    const probe = createBoard(size);
    probe.grid = grid;
    probe.moves = [{ x, y, player, pass: false }];
    probe.hashes = board.hashes.slice();
    probe.hashes.push(grid.map((row) => row.join('')).join(''));
    const reply = simulate(probe, cx, cy, opponent(player));
    koRepetition = !reply.ok && reply.reason === 'ko';
  }

  return { ok: true, grid, captured, koRepetition };
}

/** 该点现在是否可落子（供 UI 画幽灵子 / 命中判定）。 */
export function canPlace(board, x, y, player = board.current) {
  return simulate(board, x, y, player).ok;
}

/**
 * 正式落子：就地修改棋盘（提子、记谱、更新气与打劫禁着点）。
 * @returns {{ok, reason?, captured?: Array<[x,y]>, x?, y?}}
 */
export function place(board, x, y) {
  const player = board.current;
  const sim = simulate(board, x, y, player);
  if (!sim.ok) return { ok: false, reason: sim.reason };

  // 必须深拷贝：simulate 返回的 grid 是副本，但「就地替换引用」会让后续
  // captureAround 之类的原地操作直接改到真实棋盘上（踩过的坑：提子凭空消失）。
  board.grid = sim.grid.map((row) => row.slice());
  const captured = sim.captured.map((p) => [p[0], p[1]]);
  board.captures[player] += captured.length;
  board.moves.push({
    x, y, player, pass: false,
    captures: captured.map(([cx, cy]) => [cx, cy]),
  });
  board.passes = 0;
  board.quiet = captured.length > 0 ? 0 : board.quiet + 1;
  board.hashes.push(boardHash(board));
  // 打劫禁着点：与 simulate 的打劫判定同源——这一手提子后回到了劫前局面，
  // 即劫争形状成立，禁着点就是被提子那一点（UI 画红叉用）。
  board.ko = sim.koRepetition ? { x: captured[0][0], y: captured[0][1] } : null;
  board.current = opponent(player);

  // 终局判定：填子安全阀（19 路阈值放宽，避免中盘被误判收工）
  if (board.quiet >= maxQuietMoves(board.size)) finishGame(board, 'max-moves');
  return { ok: true, x, y, captured };
}

/** 取某点的四邻（在盘内的）。 */
function neighborsOf(board, x, y) {
  const out = [];
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (inBounds(board, nx, ny)) out.push([nx, ny]);
  }
  return out;
}

/** 虚手（停一手）：不落子，交给对方；连续两次虚手终局。 */
export function pass(board) {
  if (board.over) return { ok: false, reason: 'over' };
  const player = board.current;
  board.moves.push({ x: -1, y: -1, player, pass: true, captures: [] });
  board.passes += 1;
  board.quiet = 0;
  board.ko = null;
  board.current = opponent(player);
  if (board.passes >= PASSES_TO_END) {
    finishGame(board, 'two-passes');
    return { ok: true, ended: true };
  }
  // 兜底：盘面下满、双方反复停手（哪怕中间夹着零星落子、零星提子）也收工，避免无休止对局。
  // 阈值放宽，玩家正常对局不会触发，只有「长期互不停手」的自动对局才会被收。
  const passCount = board.moves.filter((m) => m.pass).length;
  if (passCount >= 6 && board.moves.length >= settlePassMoves(board.size)) {
    finishGame(board, 'settled');
    return { ok: true, ended: true };
  }
  return { ok: true, ended: false };
}

/** 认输：直接判对方胜。 */
export function resign(board, player = board.current) {
  if (board.over) return { ok: false, reason: 'over' };
  board.over = true;
  board.result = {
    reason: 'resign',
    winner: opponent(player),
    margin: null,
    score: null,
  };
  return { ok: true };
}

/** 最后一手（供 UI 画标记）。 */
export function lastMove(board) {
  return board.moves.length ? board.moves[board.moves.length - 1] : null;
}

/* ───────────────────────── 数子（中国规则估算） ───────────────────────── */

/**
 * 数子：把棋盘上每个空点分给「唯一相邻的一方」，双方都相邻（或都不相邻）算中立。
 * 不判断死活，死子按活棋计——这是估算，不是精确终局判定。
 * @returns {{owner: number[][], black: number, white: number, neutral: number,
 *            blackTerritory: number, whiteTerritory: number}}
 */
export function scoreBoard(board) {
  // 行/列都以实际网格为准：测试里可能手工摆非正方形（或行数与 size 不一致）的布局
  const h = board.grid.length;
  const w = board.grid[0] ? board.grid[0].length : 0;
  const owner = [];
  for (let y = 0; y < h; y++) owner.push(new Array(w).fill(-1));   // -1 = 尚未归属
  // 已处理标记：中立区域归属仍是 EMPTY，不能靠 owner 去重（否则同一片空区会被反复计数）
  const visited = [];
  for (let y = 0; y < h; y++) visited.push(new Array(w).fill(false));

  let blackStones = 0, whiteStones = 0, neutral = 0;
  let blackTerritory = 0, whiteTerritory = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = board.grid[y][x];
      if (v === BLACK) { blackStones++; continue; }
      if (v === WHITE) { whiteStones++; continue; }
      if (visited[y][x]) continue;

      // 洪水填充一整块空白区域，同时统计它接触到的颜色
      const region = [];
      const stack = [[x, y]];
      visited[y][x] = true;
      let touchBlack = false, touchWhite = false;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        region.push([cx, cy]);
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nv = board.grid[ny][nx];
          if (nv === BLACK) { touchBlack = true; continue; }
          if (nv === WHITE) { touchWhite = true; continue; }
          if (visited[ny][nx]) continue;
          visited[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }

      let who = EMPTY;
      if (touchBlack && !touchWhite) who = BLACK;
      else if (touchWhite && !touchBlack) who = WHITE;

      for (const [rx, ry] of region) owner[ry][rx] = who;
      // 注意：棋子数在扫描时已 +1，这里只能把「围空」加到地／中立，不能重复加到子数
      if (who === BLACK) blackTerritory += region.length;
      else if (who === WHITE) whiteTerritory += region.length;
      else neutral += region.length;
    }
  }

  // 中国规则数子：子 + 地（black/white 是「子 + 地」合计；blackStones/whiteStones 是纯子数）
  return {
    owner,
    black: blackStones + blackTerritory,
    white: whiteStones + whiteTerritory,
    blackStones,
    whiteStones,
    neutral,
    blackTerritory,
    whiteTerritory,
  };
}

/** 中国规则数子：白方加上贴目（贴目按路数取，19 路 7.5）。 */
export function areaScore(board, komi = komiFor(board.size)) {
  const s = scoreBoard(board);
  return {
    ...s,
    komi,
    blackScore: s.black,
    whiteScore: s.white + komi,
    margin: s.black - (s.white + komi),
  };
}

/** 终局：算清比分并写入 board.result。 */
export function finishGame(board, reason = 'two-passes') {
  const a = areaScore(board);
  board.over = true;
  board.result = {
    reason,
    score: a,
    winner: a.margin > 0 ? BLACK : a.margin < 0 ? WHITE : DRAW,
    margin: Math.abs(a.margin),
  };
  return board.result;
}

/* ───────────────────────── 终局提示文案 ───────────────────────── */

/** 给 UI 用的结果文案。 */
export function resultText(board) {
  const r = board.result;
  if (!r) return '';
  if (r.reason === 'resign') return r.winner === BLACK ? '白方认输 · 黑胜' : '黑方认输 · 白胜';
  const name = r.winner === BLACK ? '黑棋胜' : r.winner === WHITE ? '白棋胜' : '和棋';
  const m = r.margin === null ? '' : `（${r.margin.toFixed(1)} 子差 · 估算）`;
  return `${name}${m}`;
}

/* ───────────────────────── AI：贪心 + 一层评估 ───────────────────────── */

/**
 * 难度参数表。休闲档（13 路）沿用原来的三档；专业档（19 路）用段位表示 AI 强度。
 *
 *   1 段 ~ 9 段只做「档位名 + 参数」的映射，不追求职业水平：
 *   19 路 AI 是**简化启发式**——提子 / 补气 / 连络 / 封堵的贪心打分 + 少量随机扰动，
 *   只考虑局部候选点（radius 邻域），单步有硬时间预算，宁可下得平淡也不卡 UI。
 *
 *   sample  随机抽样比例（越高越少漏看）
 *   noise   评分随机扰动（低段位明显下坏棋）
 *   attack  提子权重
 *   defense 补自己漏洞 / 封堵对方的权重
 *   radius  局部候选半径（19 路专用；切比雪夫距离）
 */
export const LEVELS = {
  lv1: {
    key: 'lv1', name: '简单', size: SIZE_CASUAL, mode: 'casual',
    sample: 0.30, noise: 55, attack: 8, defense: 0.5, liberty: 1.0, fillEye: 0,
  },
  lv2: {
    key: 'lv2', name: '普通', size: SIZE_CASUAL, mode: 'casual',
    sample: 0.80, noise: 18, attack: 12, defense: 0.9, liberty: 1.8, fillEye: 0,
  },
  lv3: {
    key: 'lv3', name: '困难', size: SIZE_CASUAL, mode: 'casual',
    sample: 1.00, noise: 4, attack: 16, defense: 1.2, liberty: 2.6, fillEye: 1,
  },
  dan1: {
    key: 'dan1', name: '1 段', dan: 1, size: SIZE_PRO, mode: 'pro', radius: 1,
    sample: 0.45, noise: 40, attack: 10, defense: 0.7, liberty: 1.2, fillEye: 0,
  },
  dan5: {
    key: 'dan5', name: '5 段', dan: 5, size: SIZE_PRO, mode: 'pro', radius: 2,
    sample: 0.80, noise: 14, attack: 14, defense: 1.0, liberty: 2.0, fillEye: 1,
  },
  dan9: {
    key: 'dan9', name: '9 段', dan: 9, size: SIZE_PRO, mode: 'pro', radius: 2,
    sample: 1.00, noise: 3, attack: 18, defense: 1.3, liberty: 2.8, fillEye: 1,
  },
};

/** 难度 key 列表（含段位），供 UI/测试枚举。 */
export const LEVEL_KEYS = Object.keys(LEVELS);

/** 取某难度档的棋盘路数（未知 key 退回普通档）。 */
export function boardSizeOfLevel(key) {
  return (LEVELS[key] ?? LEVELS.lv2).size;
}

/**
 * AI 单步的**硬时间预算**（毫秒）：超时就用「目前看到的最好一手」返回，
 * 保证 19 路也不会卡住 UI（规范 §6：render/update 里不能做重计算）。
 */
export const AI_THINK_BUDGET_MS = 240;

/** 候选：所有空点（13 路只有 169 点，全盘评估完全够快）。 */
export function candidates(board) {
  const out = [];
  for (let y = 0; y < board.size; y++) {
    for (let x = 0; x < board.size; x++) {
      if (board.grid[y][x] === EMPTY) out.push([x, y]);
    }
  }
  return out;
}

/**
 * 局部候选：与已有棋子「切比雪夫距离 ≤ radius」的空点。
 *
 * 19 路盘 361 个空点，若每个点都跑一次 simulate + 多轮泛洪，单步会到几百毫秒；
 * 而围棋的下一手几乎总落在已有棋子附近，把候选限制在邻域后候选量降到几十个，
 * 单步稳进 100ms 内，而棋力几乎无感下降（这正是需求里允许的「只考虑一环邻域」）。
 */
export function localCandidates(board, radius = 2) {
  const n = board.size;
  const mark = new Uint8Array(n * n);
  let any = false;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (board.grid[y][x] === EMPTY) continue;
      any = true;
      const y0 = Math.max(0, y - radius), y1 = Math.min(n - 1, y + radius);
      const x0 = Math.max(0, x - radius), x1 = Math.min(n - 1, x + radius);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) mark[ny * n + nx] = 1;
      }
    }
  }
  const out = [];
  if (!any) return out;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (mark[y * n + x] && board.grid[y][x] === EMPTY) out.push([x, y]);
    }
  }
  return out;
}

/** 只剩 1 气的 color 棋块，其唯一气点（color 为对方 → 提子点；为己方 → 救子点）。 */
function oneLibertyPoints(board, color) {
  const n = board.size;
  const seen = new Set();
  const out = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (board.grid[y][x] !== color) continue;
      const k = y * n + x;
      if (seen.has(k)) continue;
      for (const [gx, gy] of groupAt(board, x, y)) seen.add(gy * n + gx);
      const libs = libertyPoints(board, x, y);
      if (libs.length === 1) out.push(libs[0]);
    }
  }
  return out;
}

/** 能提子的点（对方只剩 1 气的棋块的唯一气点）。 */
export function capturePoints(board, player) {
  return oneLibertyPoints(board, opponent(player));
}

/** 能救活自己棋块的点（己方只剩 1 气的棋块的唯一气点）。 */
export function savePoints(board, player) {
  return oneLibertyPoints(board, player);
}

/**
 * 单点价值（AI 的核心评估函数）。
 *   价值 = 提子数 × 攻击权重
 *        + 邻近己方棋子的连络 + 邻近空点的围空潜力
 *        - 邻近对方强棋的惩罚（对方棋块越好动，惩罚越大）
 * 铁律：能提子必须提；能救自己一大块必须救；能封住对方一大块必须封。
 */
export function evaluatePoint(board, x, y, player, opts = {}) {
  const cfg = { ...LEVELS.lv2, ...opts };
  const foe = opponent(player);
  const sim = simulate(board, x, y, player);
  if (!sim.ok) return { score: -Infinity, illegal: sim.reason };

  let score = 0;

  // ① 提子（最实在的收益）
  score += sim.captured.length * cfg.attack;

  // ② 邻近己方：连络 + 气数（自己活得好，周围才站得住）
  let friendLibs = 0;
  for (const [nx, ny] of neighborsOf(board, x, y)) {
    const v = board.grid[ny][nx];
    if (v === player) { score += 1.2; friendLibs += Math.min(6, liberties(board, nx, ny)); }
    else if (v === EMPTY) score += 0.55;      // 邻近空点：围空潜力
  }
  score += friendLibs * 0.18 * cfg.liberty;

  // ③ 邻近对方强棋：惩罚（对方气越多、越成块，越不该贴着下）
  for (const [nx, ny] of neighborsOf(board, x, y)) {
    if (board.grid[ny][nx] !== foe) continue;
    const lib = liberties(board, nx, ny);
    const grp = groupAt(board, nx, ny).length;
    score -= cfg.defense * (0.8 + Math.min(8, lib) * 0.35 + Math.min(6, grp) * 0.25);
  }

  // ④ 自己落子后的安全度：落点棋块气太少要扣分（送吃），气多加分（棋形厚）
  const myLib = countLibs(sim.grid, board.size, x, y);
  if (myLib <= 1) score -= 5 * cfg.defense;
  else score += Math.min(5, myLib) * 0.35 * cfg.liberty;

  // ⑤ 封堵价值：这一手下去，对方邻近棋块是否被逼到没气（防守/进攻的硬账）
  for (const [nx, ny] of neighborsOf(board, x, y)) {
    if (board.grid[ny][nx] !== foe) continue;
    if (countLibs(sim.grid, board.size, nx, ny) === 1) score += 3.0 * cfg.defense;
  }
  // 同理：落子后自己邻近棋块只剩一口气，说明对方下一步要提，价值下调
  for (const [nx, ny] of neighborsOf(board, x, y)) {
    if (board.grid[ny][nx] !== player) continue;
    if (countLibs(sim.grid, board.size, nx, ny) === 1) score -= 2.0 * cfg.defense;
  }

  return { score, illegal: null, captured: sim.captured.length, liberties: myLib };
}

/** 是否是「自己的真眼」（四邻全己方，或边界 + 三邻己方）——不吃眼的档位不填眼。 */
export function isSelfEye(board, x, y, player) {
  let own = 0, total = 0;
  for (const [nx, ny] of neighborsOf(board, x, y)) {
    total++;
    if (board.grid[ny][nx] === player) own++;
  }
  return total > 0 && own === total;
}

/**
 * AI 选点：贪心 + 一层评估（不搜索、不做死活），带**单步硬时间预算**。
 *
 * 难度只影响候选规模、抽样比例与随机扰动：
 *   休闲档（13 路）：简单档会漏吃子、下坏棋；困难档见提子必提、会围空与封堵。
 *   专业档（19 路）：1/5/9 段对应候选半径、抽样与扰动，只考虑局部候选点。
 *
 * 时间可注入（规范 §8/§12）：`options.clock` 传一个返回当前毫秒的函数，
 * 测试里可以用假时钟确定性地验证「超预算即停手并返回已看到的最好一手」。
 *
 * @returns {{x, y, pass?, score?, evaluated?, truncated?, elapsedMs?}}
 */
export function chooseMove(board, player, options = {}) {
  const cfg = LEVELS[options.level] ?? LEVELS.lv2;
  const rand = options.random ?? Math.random;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const budget = Number.isFinite(options.deadlineMs) ? options.deadlineMs : AI_THINK_BUDGET_MS;
  const t0 = clock();
  const elapsed = () => Math.max(0, clock() - t0);

  // 落子历史为空时没有「上一步」可依：仍要返回合法落点（可能是外部摆好的题面局面，
  // 不能盲目返回天元——那不是合法落点）。空盘取天元，否则贪心评估一遍。
  if (board.moves.length === 0) {
    let occupied = 0;
    for (let y = 0; y < board.size; y++) {
      for (let x = 0; x < board.size; x++) if (board.grid[y][x] !== EMPTY) occupied++;
    }
    if (occupied === 0) {   // 真正的空盘：抢天元（19 路即 (9,9)，也是星位）
      const c = Math.floor(board.size / 2);
      return { x: c, y: c, evaluated: 0, truncated: false, elapsedMs: elapsed() };
    }
    const pool = board.size >= SIZE_PRO ? localCandidates(board, cfg.radius ?? 2) : candidates(board);
    let pick = null;
    let pickScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (i > 0 && (i & 3) === 0 && elapsed() > budget) break;
      const [x, y] = pool[i];
      const ev = evaluatePoint(board, x, y, player, cfg);
      if (ev.illegal) continue;
      let s = ev.score;
      if (cfg.noise > 0) s += (rand() - 0.5) * cfg.noise;
      if (s > pickScore) { pickScore = s; pick = [x, y]; }
    }
    if (!pick) return { x: -1, y: -1, pass: true, evaluated: 0, truncated: false, elapsedMs: elapsed() };
    return { x: pick[0], y: pick[1], score: pickScore, evaluated: pool.length, truncated: false, elapsedMs: elapsed() };
  }

  // ① 候选池：13 路全盘扫（169 点足够快）；19 路只取局部邻域
  const pool = new Map();
  const add = (x, y) => {
    if (x < 0 || y < 0 || x >= board.size || y >= board.size) return;
    if (board.grid[y][x] !== EMPTY) return;
    const k = y * board.size + x;
    if (!pool.has(k)) pool.set(k, [x, y]);
  };
  const base = board.size >= SIZE_PRO
    ? localCandidates(board, cfg.radius ?? 2)
    : candidates(board);
  for (const [x, y] of base) add(x, y);
  // ② 提子点与救子点必须进候选：这两类是「硬账」，不能被抽样或局部半径漏掉
  for (const [x, y] of capturePoints(board, player)) add(x, y);
  for (const [x, y] of savePoints(board, player)) add(x, y);
  // ③ 上一手的邻域（贴身应手）
  const lm = board.moves[board.moves.length - 1];
  if (lm && !lm.pass) for (const [x, y] of neighborsOf(board, lm.x, lm.y)) add(x, y);

  let spots = [...pool.values()];

  // ④ 低段位/简单档抽样：候选多了就随机砍一刀（观感上是「看漏了」）
  if (cfg.sample < 1 && spots.length > 24) {
    const keep = Math.max(12, Math.floor(spots.length * cfg.sample) + 6);
    const must = new Set([...capturePoints(board, player), ...savePoints(board, player)].map(([x, y]) => y * board.size + x));
    const soft = spots.filter(([x, y]) => !must.has(y * board.size + x));
    const hard = spots.filter(([x, y]) => must.has(y * board.size + x));
    const shuffled = soft.slice().sort(() => rand() - 0.5);
    const room = Math.max(0, keep - hard.length);
    spots = hard.concat(shuffled.slice(0, room));
  }

  // ⑤ 逐个打分，带硬预算（超时立刻带最好的一手返回，不把 UI 卡死）
  let best = null;
  let bestScore = -Infinity;
  let evaluated = 0;
  let truncated = false;
  for (let i = 0; i < spots.length; i++) {
    if (i > 0 && (i & 3) === 0 && elapsed() > budget) { truncated = true; break; }
    const [x, y] = spots[i];
    if (cfg.fillEye === 0 && isSelfEye(board, x, y, player) && board.moves.length > 12) continue;
    const ev = evaluatePoint(board, x, y, player, cfg);
    if (ev.illegal) continue;
    evaluated++;
    let s = ev.score;
    if (cfg.noise > 0) s += (rand() - 0.5) * cfg.noise;
    if (s > bestScore) { bestScore = s; best = { x, y, score: s }; }
  }

  // 候选全被过滤（例如只剩自己的眼）→ 虚手
  if (!best) return { x: -1, y: -1, pass: true, evaluated, truncated, elapsedMs: elapsed() };

  // 收官判断：盘面已无有价值的大点（分数接近 0）就停一手，交给对方。
  // 但盘面还很空时（19 路尤其明显）不许停手——否则一盘 19 路会在几十手就草草收场。
  const total = board.size * board.size;
  let filled = 0;
  for (let y = 0; y < board.size; y++) {
    for (let x = 0; x < board.size; x++) if (board.grid[y][x] !== EMPTY) filled++;
  }
  const phaseOpen = filled / total > 0.3;
  if (bestScore < 1.0 && board.quiet > 6 && phaseOpen) {
    return { x: -1, y: -1, pass: true, score: bestScore, evaluated, truncated, elapsedMs: elapsed() };
  }
  return { ...best, evaluated, truncated, elapsedMs: elapsed() };
}

/** AI 是否应该虚手（对方停一手后，AI 若已领先就直接结束对局）。 */
export function shouldPass(board, player, options = {}) {
  const cfg = LEVELS[options.level] ?? LEVELS.lv2;
  const rand = options.random ?? Math.random;
  // 低段位/简单档经常「看不出该收工」，会继续下（观感上更友好，失误也是难度的一部分）
  if ((cfg.key === 'lv1' || cfg.key === 'dan1') && rand() < 0.5) return false;
  const a = areaScore(board);
  const lead = player === BLACK ? a.margin : -a.margin;
  // 领先 + 盘面进入收官（quiet 高）→ 停一手结束；落后则继续找机会
  if (board.quiet >= 8 && lead > 0) return true;
  // 盘面已经长时间没有提子也没有虚手 → 收工，避免无限对局（19 路阈值放宽）
  if (board.quiet >= quietPassThreshold(board.size)) return true;
  return false;
}
