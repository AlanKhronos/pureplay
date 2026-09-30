/**
 * 五子棋核心逻辑（纯函数，零依赖，可在 Node 里直接跑测试）
 *
 * 设计约束（沿用「荒潮拾荒者」的架构理念）：
 *   - 本文件不碰任何平台 API（无 wx、无 document、无 canvas）；
 *   - 棋盘状态是显式的，落子/胜负/悔棋全部可确定性复现；
 *   - 为 UI 提供「最后落点」「胜利连线」「候选点」等渲染所需信息。
 */

export const BOARD_SIZE = 15;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

/** 四个扫描方向：横、竖、主对角、副对角。 */
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

/** 创建一个空棋盘状态。 */
export function createBoard(size = BOARD_SIZE) {
  const grid = [];
  for (let y = 0; y < size; y++) grid.push(new Array(size).fill(EMPTY));
  return {
    size,
    grid,
    moves: [],        // 落子历史 [{x, y, player}]，用于悔棋
    winner: EMPTY,    // EMPTY 表示未分胜负
    winLine: null,    // 胜利连线 [[x,y], ...]，供 UI 高亮
    current: BLACK,   // 当前该谁落子（黑先）
  };
}

/** 返回对方的棋子颜色。 */
export function opponent(player) {
  return player === BLACK ? WHITE : BLACK;
}

/** 该点是否可落子。 */
export function canPlace(board, x, y) {
  return (
    x >= 0 && y >= 0 && x < board.size && y < board.size &&
    board.grid[y][x] === EMPTY && board.winner === EMPTY
  );
}

/**
 * 落子。就地修改棋盘并推进回合；若分出胜负则记录胜利连线。
 * @returns {{ok: boolean, reason?: string, winLine?: Array<[number, number]>|null}}
 */
export function place(board, x, y) {
  if (board.winner !== EMPTY) return { ok: false, reason: 'over' };
  if (!canPlace(board, x, y)) return { ok: false, reason: 'occupied' };

  const player = board.current;
  board.grid[y][x] = player;
  board.moves.push({ x, y, player });

  const line = findWinLine(board, x, y, player);
  if (line) {
    board.winner = player;
    board.winLine = line;
  } else if (board.moves.length >= board.size * board.size) {
    board.winner = -1; // 和棋
  } else {
    board.current = opponent(player);
  }
  return { ok: true, winLine: board.winLine };
}

/** 悔棋：撤回一步（回到上一手落子之前）。 */
export function undo(board) {
  if (board.moves.length === 0) return { ok: false, reason: 'empty' };
  const last = board.moves.pop();
  board.grid[last.y][last.x] = EMPTY;
  board.winner = EMPTY;
  board.winLine = null;
  board.current = last.player;
  return { ok: true, undone: last };
}

/**
 * 检查落子后是否形成五连。
 * @returns 胜利连线的坐标数组，未成五连则返回 null。
 */
export function findWinLine(board, x, y, player) {
  for (const [dx, dy] of DIRECTIONS) {
    const line = [[x, y]];

    // 正方向
    for (let step = 1; step < 5; step++) {
      const nx = x + dx * step, ny = y + dy * step;
      if (!inBounds(board, nx, ny) || board.grid[ny][nx] !== player) break;
      line.push([nx, ny]);
    }
    // 反方向
    for (let step = 1; step < 5; step++) {
      const nx = x - dx * step, ny = y - dy * step;
      if (!inBounds(board, nx, ny) || board.grid[ny][nx] !== player) break;
      line.unshift([nx, ny]);
    }
    if (line.length >= 5) return line;
  }
  return null;
}

/** 坐标是否在棋盘内。 */
export function inBounds(board, x, y) {
  return x >= 0 && y >= 0 && x < board.size && y < board.size;
}

/** 最后一手（供 UI 画标记）。 */
export function lastMove(board) {
  return board.moves.length ? board.moves[board.moves.length - 1] : null;
}

/**
 * 某点是否值得作为候选（周围两格内有棋子）——用于缩小 AI 搜索面。
 */
export function hasNeighbor(board, x, y, radius = 2) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (inBounds(board, nx, ny) && board.grid[ny][nx] !== EMPTY) return true;
    }
  }
  return false;
}

/**
 * 生成候选落点：空位且附近有子。棋盘为空时返回天元。
 */
export function candidates(board, radius = 2) {
  if (board.moves.length === 0) {
    const c = Math.floor(board.size / 2);
    return [[c, c]];
  }
  const out = [];
  for (let y = 0; y < board.size; y++) {
    for (let x = 0; x < board.size; x++) {
      if (board.grid[y][x] !== EMPTY) continue;
      if (hasNeighbor(board, x, y, radius)) out.push([x, y]);
    }
  }
  return out;
}

/** 深拷贝一份棋盘状态（供 AI 试算，避免污染真实棋盘）。 */
export function cloneBoard(board) {
  return {
    size: board.size,
    grid: board.grid.map((row) => row.slice()),
    moves: board.moves.map((m) => ({ ...m })),
    winner: board.winner,
    winLine: board.winLine,
    current: board.current,
  };
}

/** 胜负文案（UI 直接显示）。 */
export function resultText(board) {
  if (board.winner === BLACK) return '黑棋胜';
  if (board.winner === WHITE) return '白棋胜';
  if (board.winner === -1) return '和棋';
  return '';
}
