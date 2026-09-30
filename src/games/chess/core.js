/**
 * 国际象棋核心逻辑（纯函数，零依赖，可在 Node 里直接跑测试）
 *
 * 设计约束（沿用「荒潮拾荒者」与五子棋 core 的架构理念）：
 *   - 本文件不碰任何平台 API（无 wx、无 document、无 window、无 canvas）；
 *   - 棋盘状态显式、可确定性复现：走子 / 悔棋 / 将军 / 将杀 / 逼和都能重放；
 *   - 坐标约定：x = 0..7 对应 a..h 列；y = 0..7 对应第 8 行 .. 第 1 行。
 *     即 y=0 在屏幕最上方（黑方底线），y=7 在屏幕最下方（白方底线）；
 *     白兵朝 y 减小的方向前进，黑兵朝 y 增大的方向前进。
 *   - 棋子编码：type + color * 8（0 = 空）。白 9..14，黑 17..22。
 *
 * 本文件分三部分：
 *   ① 棋盘与走子：createBoard / genPseudoMoves / legalMoves / applyMove / undoMove
 *   ② 规则判定：isInCheck / gameStatus（将杀、逼和、五十回合、子力不足）
 *   ③ AI：极小极大 + alpha-beta + 子力与位置表评估，五档难度（简单..亚洲）
 */

/* ───────────────────────── 常量与编码 ───────────────────────── */

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const WHITE = 1;
export const BLACK = 2;

/** 棋子中文名（UI 与提示文案用）。 */
export const PIECE_NAMES = {
  [PAWN]: '兵',
  [KNIGHT]: '马',
  [BISHOP]: '象',
  [ROOK]: '车',
  [QUEEN]: '后',
  [KING]: '王',
};

/** 由「类型 + 颜色」拼出棋子编码。 */
export function mkPiece(type, color) {
  return type + (color << 3);
}

/** 取棋子类型（兵/马/象/车/后/王）。 */
export function typeOf(code) {
  return code & 7;
}

/** 取棋子颜色（WHITE / BLACK）；空格返回 0。 */
export function colorOf(code) {
  return code === EMPTY ? 0 : code >> 3;
}

/** 对方颜色。 */
export function opponent(color) {
  return color === WHITE ? BLACK : WHITE;
}

/** 棋子中文全名，如「白后」。 */
export function pieceName(code) {
  if (!code) return '';
  return (colorOf(code) === WHITE ? '白' : '黑') + PIECE_NAMES[typeOf(code)];
}

/** 是否在 8×8 棋盘内。 */
export function inside(x, y) {
  return x >= 0 && y >= 0 && x < 8 && y < 8;
}

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS = ROOK_DIRS.concat(BISHOP_DIRS);
const KNIGHT_JUMPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/* ───────────────────────── 棋盘 ───────────────────────── */

/** 初始局面（标准开局）。 */
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * 创建一盘棋。
 * @param fen 可选：用 FEN 摆一个局面（测试与残局练习用）。
 */
export function createBoard(fen = START_FEN) {
  return fromFEN(fen);
}

/** 深拷贝（含历史），供 UI / 测试使用；AI 搜索走 make-unmake，不做克隆。 */
export function cloneBoard(board) {
  return {
    grid: board.grid.map((row) => row.slice()),
    turn: board.turn,
    castling: { ...board.castling },
    ep: board.ep ? { ...board.ep } : null,
    halfmove: board.halfmove,
    fullmove: board.fullmove,
    history: board.history.map((h) => ({
      move: { ...h.move },
      captured: h.captured,
      capturedAt: h.capturedAt ? { ...h.capturedAt } : null,
      castling: { ...h.castling },
      ep: h.ep ? { ...h.ep } : null,
      halfmove: h.halfmove,
      fullmove: h.fullmove,
    })),
  };
}

/** 取某格棋子编码（越界返回 EMPTY）。 */
export function pieceAt(board, x, y) {
  return inside(x, y) ? board.grid[y][x] : EMPTY;
}

/** 最后一手（供 UI 画上一步标记）。 */
export function lastMove(board) {
  const rec = board.history[board.history.length - 1];
  return rec ? rec.move : null;
}

/* ───────────────────────── 走法生成 ───────────────────────── */

/** 构造一个候选着法对象。 */
function makeMove(board, fx, fy, tx, ty, extra = {}) {
  const ep = extra.flag === 'ep';
  return {
    fx, fy, tx, ty,
    piece: board.grid[fy][fx],
    capture: ep ? board.grid[fy][tx] : board.grid[ty][tx],
    promote: extra.promote ?? 0,
    flag: extra.flag ?? '', // '' | 'double' | 'ep' | 'castleK' | 'castleQ'
  };
}

/**
 * 生成「伪合法」着法：只按棋子走法规则生成，不检查走后是否被将军。
 * 王的易位在这里就做完整校验（不能正被将军、不能穿行被攻击格）。
 */
export function genPseudoMoves(board, color = board.turn) {
  const out = [];
  const grid = board.grid;

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const code = grid[y][x];
      if (!code || colorOf(code) !== color) continue;
      const type = typeOf(code);

      /* ── 兵 ── */
      if (type === PAWN) {
        const dir = color === WHITE ? -1 : 1;
        const startY = color === WHITE ? 6 : 1;
        const promoY = color === WHITE ? 0 : 7;

        const pushPawn = (tx, ty, extra) => {
          if (ty === promoY) {
            // 升变：四种都生成，默认升后由 UI/AI 选择（保留完整接口）
            for (const p of [QUEEN, ROOK, BISHOP, KNIGHT]) {
              out.push(makeMove(board, x, y, tx, ty, { ...extra, promote: p }));
            }
          } else {
            out.push(makeMove(board, x, y, tx, ty, extra));
          }
        };

        const y1 = y + dir;
        if (inside(x, y1) && grid[y1][x] === EMPTY) {
          pushPawn(x, y1, {});
          const y2 = y + dir * 2;
          if (y === startY && grid[y2][x] === EMPTY) {
            out.push(makeMove(board, x, y, x, y2, { flag: 'double' }));
          }
        }
        for (const dx of [-1, 1]) {
          const tx = x + dx, ty = y + dir;
          if (!inside(tx, ty)) continue;
          const target = grid[ty][tx];
          if (target && colorOf(target) !== color) pushPawn(tx, ty, {});
          else if (!target && board.ep && board.ep.x === tx && board.ep.y === ty) {
            out.push(makeMove(board, x, y, tx, ty, { flag: 'ep' }));
          }
        }
        continue;
      }

      /* ── 马：跳着走，不蹩腿（国际象棋的马可跳子）── */
      if (type === KNIGHT) {
        for (const [dx, dy] of KNIGHT_JUMPS) {
          const tx = x + dx, ty = y + dy;
          if (!inside(tx, ty)) continue;
          const target = grid[ty][tx];
          if (target && colorOf(target) === color) continue;
          out.push(makeMove(board, x, y, tx, ty, {}));
        }
        continue;
      }

      /* ── 象 / 车 / 后：射线，不能越子 ── */
      if (type === BISHOP || type === ROOK || type === QUEEN) {
        const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : QUEEN_DIRS;
        for (const [dx, dy] of dirs) {
          let tx = x + dx, ty = y + dy;
          while (inside(tx, ty)) {
            const target = grid[ty][tx];
            if (!target) {
              out.push(makeMove(board, x, y, tx, ty, {}));
            } else {
              if (colorOf(target) !== color) out.push(makeMove(board, x, y, tx, ty, {}));
              break; // 撞子即止，不能越子
            }
            tx += dx; ty += dy;
          }
        }
        continue;
      }

      /* ── 王：一格 + 王车易位 ── */
      if (type === KING) {
        for (const [dx, dy] of KING_STEPS) {
          const tx = x + dx, ty = y + dy;
          if (!inside(tx, ty)) continue;
          const target = grid[ty][tx];
          if (target && colorOf(target) === color) continue;
          out.push(makeMove(board, x, y, tx, ty, {}));
        }

        const homeY = color === WHITE ? 7 : 0;
        if (x === 4 && y === homeY) {
          const foe = opponent(color);
          const canK = color === WHITE ? board.castling.wk : board.castling.bk;
          const canQ = color === WHITE ? board.castling.wq : board.castling.bq;
          const rookCode = mkPiece(ROOK, color);
          const kingSafe = !isSquareAttacked(board, 4, homeY, foe);

          // 短易位：f、g 空，e/f/g 不被攻击，h 位是己方车
          if (canK && kingSafe && grid[homeY][5] === EMPTY && grid[homeY][6] === EMPTY
            && grid[homeY][7] === rookCode
            && !isSquareAttacked(board, 5, homeY, foe)
            && !isSquareAttacked(board, 6, homeY, foe)) {
            out.push(makeMove(board, 4, homeY, 6, homeY, { flag: 'castleK' }));
          }
          // 长易位：b、c、d 空，e/d/c 不被攻击，a 位是己方车
          if (canQ && kingSafe && grid[homeY][1] === EMPTY && grid[homeY][2] === EMPTY
            && grid[homeY][3] === EMPTY && grid[homeY][0] === rookCode
            && !isSquareAttacked(board, 3, homeY, foe)
            && !isSquareAttacked(board, 2, homeY, foe)) {
            out.push(makeMove(board, 4, homeY, 2, homeY, { flag: 'castleQ' }));
          }
        }
      }
    }
  }
  return out;
}

/** 找到某方的王，返回 {x, y} 或 null。 */
export function findKing(board, color) {
  const king = mkPiece(KING, color);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (board.grid[y][x] === king) return { x, y };
    }
  }
  return null;
}

/** (x, y) 是否被 by 方任一棋子攻击（含兵、马、王、滑行子）。 */
export function isSquareAttacked(board, x, y, by) {
  const grid = board.grid;

  // 兵：白兵在下方（y 更大），故攻击 (x,y) 的白兵位于 (x±1, y+1)
  const pdir = by === WHITE ? 1 : -1;
  for (const dx of [-1, 1]) {
    const ax = x + dx, ay = y + pdir;
    if (!inside(ax, ay)) continue;
    const c = grid[ay][ax];
    if (c && colorOf(c) === by && typeOf(c) === PAWN) return true;
  }
  // 马
  for (const [dx, dy] of KNIGHT_JUMPS) {
    const ax = x + dx, ay = y + dy;
    if (!inside(ax, ay)) continue;
    const c = grid[ay][ax];
    if (c && colorOf(c) === by && typeOf(c) === KNIGHT) return true;
  }
  // 王
  for (const [dx, dy] of KING_STEPS) {
    const ax = x + dx, ay = y + dy;
    if (!inside(ax, ay)) continue;
    const c = grid[ay][ax];
    if (c && colorOf(c) === by && typeOf(c) === KING) return true;
  }
  // 车 / 后（直线）
  for (const [dx, dy] of ROOK_DIRS) {
    let ax = x + dx, ay = y + dy;
    while (inside(ax, ay)) {
      const c = grid[ay][ax];
      if (c) {
        if (colorOf(c) === by && (typeOf(c) === ROOK || typeOf(c) === QUEEN)) return true;
        break;
      }
      ax += dx; ay += dy;
    }
  }
  // 象 / 后（斜线）
  for (const [dx, dy] of BISHOP_DIRS) {
    let ax = x + dx, ay = y + dy;
    while (inside(ax, ay)) {
      const c = grid[ay][ax];
      if (c) {
        if (colorOf(c) === by && (typeOf(c) === BISHOP || typeOf(c) === QUEEN)) return true;
        break;
      }
      ax += dx; ay += dy;
    }
  }
  return false;
}

/** 某方是否正被将军。 */
export function isInCheck(board, color) {
  const k = findKing(board, color);
  if (!k) return false;
  return isSquareAttacked(board, k.x, k.y, opponent(color));
}

/**
 * 合法着法：伪合法着法里剔除「走完自己王被将」的那些（含被牵制的子）。
 * 默认取当前行棋方。
 */
export function legalMoves(board, color = board.turn) {
  const saved = board.turn;
  board.turn = color;
  const out = [];
  for (const move of genPseudoMoves(board, color)) {
    applyMove(board, move);
    if (!isInCheck(board, color)) out.push(move);
    undoMove(board);
  }
  board.turn = saved;
  return out;
}

/** 某个格子上棋子的合法着法（UI 选中提示用）。 */
export function legalMovesFrom(board, x, y) {
  return legalMoves(board, board.turn).filter((m) => m.fx === x && m.fy === y);
}

/** 在合法着法里按「起点 + 终点（+ 升变）」找一手，找不到返回 null。 */
export function findLegalMove(board, fx, fy, tx, ty, promote = QUEEN) {
  const list = legalMoves(board, board.turn);
  const exact = list.find((m) => m.fx === fx && m.fy === fy && m.tx === tx && m.ty === ty
    && (m.promote === 0 || m.promote === promote));
  return exact ?? null;
}

/* ───────────────────────── 走子与悔棋 ───────────────────────── */

/**
 * 落子（就地修改棋盘，并把回滚信息压入 history）。
 * @returns 历史记录对象；若该格没有己方棋子则返回 null。
 */
export function applyMove(board, move) {
  const piece = board.grid[move.fy][move.fx];
  if (!piece || colorOf(piece) !== board.turn) return null;
  const me = board.turn;

  const rec = {
    move: { ...move, piece, capture: move.capture ?? EMPTY },
    captured: EMPTY,
    capturedAt: null,
    castling: { ...board.castling },
    ep: board.ep ? { ...board.ep } : null,
    halfmove: board.halfmove,
    fullmove: board.fullmove,
  };

  board.grid[move.fy][move.fx] = EMPTY;

  // 吃过路兵：被吃的兵不在目标格，而在起点同一横排
  if (move.flag === 'ep') {
    rec.captured = board.grid[move.fy][move.tx];
    rec.capturedAt = { x: move.tx, y: move.fy };
    board.grid[move.fy][move.tx] = EMPTY;
  } else if (board.grid[move.ty][move.tx] !== EMPTY) {
    rec.captured = board.grid[move.ty][move.tx];
    rec.capturedAt = { x: move.tx, y: move.ty };
  }

  // 落子（升变时换成新棋子）
  board.grid[move.ty][move.tx] = move.promote ? mkPiece(move.promote, me) : piece;

  // 易位：同步挪车
  if (move.flag === 'castleK') {
    board.grid[move.ty][move.tx - 1] = board.grid[move.ty][7];
    board.grid[move.ty][7] = EMPTY;
  } else if (move.flag === 'castleQ') {
    board.grid[move.ty][move.tx + 1] = board.grid[move.ty][0];
    board.grid[move.ty][0] = EMPTY;
  }

  // 易位权：王动过、车离开原位、车被吃，都要撤权
  if (typeOf(piece) === KING) {
    if (me === WHITE) { board.castling.wk = false; board.castling.wq = false; }
    else { board.castling.bk = false; board.castling.bq = false; }
  }
  const rookSquares = [[0, 7, 'wq'], [7, 7, 'wk'], [0, 0, 'bq'], [7, 0, 'bk']];
  for (const [rx, ry, key] of rookSquares) {
    if ((move.fx === rx && move.fy === ry) || (move.tx === rx && move.ty === ry)) {
      board.castling[key] = false;
    }
  }

  // 过路兵目标格：只有兵首步两格才留下
  board.ep = move.flag === 'double' ? { x: move.fx, y: (move.fy + move.ty) / 2 } : null;

  // 半回合计数（兵动或吃子清零，用于五十回合和棋）与回合数
  board.halfmove = (typeOf(piece) === PAWN || rec.captured) ? 0 : board.halfmove + 1;
  if (me === BLACK) board.fullmove += 1;
  board.turn = opponent(me);
  board.history.push(rec);
  return rec;
}

/** 悔棋一手（AI 搜索里做 make-unmake 也走它）。 */
export function undoMove(board) {
  const rec = board.history.pop();
  if (!rec) return null;
  const m = rec.move;

  board.grid[m.fy][m.fx] = m.piece;
  board.grid[m.ty][m.tx] = EMPTY;
  if (rec.capturedAt) board.grid[rec.capturedAt.y][rec.capturedAt.x] = rec.captured;

  if (m.flag === 'castleK') {
    board.grid[m.ty][7] = board.grid[m.ty][m.tx - 1];
    board.grid[m.ty][m.tx - 1] = EMPTY;
  } else if (m.flag === 'castleQ') {
    board.grid[m.ty][0] = board.grid[m.ty][m.tx + 1];
    board.grid[m.ty][m.tx + 1] = EMPTY;
  }

  board.castling = rec.castling;
  board.ep = rec.ep;
  board.halfmove = rec.halfmove;
  board.fullmove = rec.fullmove;
  board.turn = colorOf(m.piece);
  return rec;
}

/* ───────────────────────── 局面判定 ───────────────────────── */

/** 子力不足判和：只剩双王，或一方仅多一个轻子。 */
export function insufficientMaterial(board) {
  let minors = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const code = board.grid[y][x];
      if (!code) continue;
      const t = typeOf(code);
      if (t === KING) continue;
      if (t === KNIGHT || t === BISHOP) { minors++; continue; }
      return false; // 有兵/车/后 → 子力充足
    }
  }
  return minors <= 1;
}

/**
 * 局面状态。
 * @param opts.repetitions 同一局面出现次数（三次重复判和，由会话层统计，缺省 1）
 * @returns { over, result, reason, check, text }
 *   result: 'white' | 'black' | 'draw' | null
 */
export function gameStatus(board, opts = {}) {
  const color = board.turn;
  const inCheck = isInCheck(board, color);
  const moves = legalMoves(board, color);

  if (moves.length === 0) {
    if (inCheck) {
      return {
        over: true, result: color === WHITE ? 'black' : 'white',
        reason: 'checkmate', check: true, text: '将杀',
      };
    }
    return { over: true, result: 'draw', reason: 'stalemate', check: false, text: '逼和' };
  }
  if (board.halfmove >= 100) {
    return { over: true, result: 'draw', reason: 'fifty', check: inCheck, text: '五十回合和棋' };
  }
  if ((opts.repetitions ?? 1) >= 3) {
    return { over: true, result: 'draw', reason: 'repetition', check: inCheck, text: '三次重复和棋' };
  }
  if (insufficientMaterial(board)) {
    return { over: true, result: 'draw', reason: 'material', check: inCheck, text: '子力不足和棋' };
  }
  return { over: false, result: null, reason: '', check: inCheck, text: inCheck ? '将军' : '' };
}

/** 结果中文文案（UI 直接显示）。 */
export function resultText(status) {
  if (!status || !status.over) return '';
  if (status.result === 'draw') return status.text || '和棋';
  return status.result === 'white' ? '白方胜' : '黑方胜';
}

/* ───────────────────────── FEN ───────────────────────── */

const FEN_CHARS = { [PAWN]: 'p', [KNIGHT]: 'n', [BISHOP]: 'b', [ROOK]: 'r', [QUEEN]: 'q', [KING]: 'k' };
const CHAR_TYPES = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

/** 局面 → FEN 字符串。 */
export function toFEN(board) {
  let placement = '';
  for (let y = 0; y < 8; y++) {
    let empty = 0;
    for (let x = 0; x < 8; x++) {
      const code = board.grid[y][x];
      if (!code) { empty++; continue; }
      if (empty) { placement += empty; empty = 0; }
      const ch = FEN_CHARS[typeOf(code)];
      placement += colorOf(code) === WHITE ? ch.toUpperCase() : ch;
    }
    if (empty) placement += empty;
    if (y < 7) placement += '/';
  }
  let cast = (board.castling.wk ? 'K' : '') + (board.castling.wq ? 'Q' : '')
    + (board.castling.bk ? 'k' : '') + (board.castling.bq ? 'q' : '');
  if (!cast) cast = '-';
  const ep = board.ep ? `${'abcdefgh'[board.ep.x]}${8 - board.ep.y}` : '-';
  return `${placement} ${board.turn === WHITE ? 'w' : 'b'} ${cast} ${ep} ${board.halfmove} ${board.fullmove}`;
}

/** FEN → 局面。 */
export function fromFEN(fen) {
  const parts = String(fen).trim().split(/\s+/);
  const grid = [];
  for (let y = 0; y < 8; y++) grid.push(new Array(8).fill(EMPTY));

  const rows = (parts[0] ?? '').split('/');
  for (let y = 0; y < 8 && y < rows.length; y++) {
    let x = 0;
    for (const ch of rows[y]) {
      if (ch >= '1' && ch <= '8') { x += Number(ch); continue; }
      const type = CHAR_TYPES[ch.toLowerCase()];
      if (!type || x > 7) continue;
      grid[y][x] = mkPiece(type, ch === ch.toUpperCase() ? WHITE : BLACK);
      x++;
    }
  }

  const cast = parts[2] ?? '-';
  return {
    grid,
    turn: parts[1] === 'b' ? BLACK : WHITE,
    castling: {
      wk: cast.includes('K'),
      wq: cast.includes('Q'),
      bk: cast.includes('k'),
      bq: cast.includes('q'),
    },
    ep: parts[3] && parts[3] !== '-'
      ? { x: 'abcdefgh'.indexOf(parts[3][0]), y: 8 - Number(parts[3][1]) }
      : null,
    halfmove: Number(parts[4] ?? 0) || 0,
    fullmove: Number(parts[5] ?? 1) || 1,
    history: [],
  };
}

/** 局面指纹（去掉了半回合/回合数），用于三次重复判和统计。 */
export function positionKey(board) {
  return toFEN(board).split(' ').slice(0, 4).join(' ');
}

/* ───────────────────────── 评估：子力 + 位置表 ───────────────────────── */

/** 子力价值（厘兵），按项目约定：后 900 车 500 象/马 300 兵 100 王 20000。 */
export const PIECE_VALUE = {
  [PAWN]: 100,
  [KNIGHT]: 300,
  [BISHOP]: 300,
  [ROOK]: 500,
  [QUEEN]: 900,
  [KING]: 20000,
};

/*
 * 位置表（简化评估函数，白方视角，行序 = 第 8 行到第 1 行，即本文件的 y=0..7）。
 * 黑方镜像取 (7-y, x)。数值单位与子力同为厘兵，保证「位置感」不会盖过子力。
 */
const PST = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [KNIGHT]: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [BISHOP]: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  [ROOK]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  [QUEEN]: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  [KING]: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

/** 残局王位置表（鼓励王上前助攻）。 */
const KING_END = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

/**
 * 静态评估：正分利于白方。
 * 子力 + 位置表；重子全无时切换残局王位置表。
 */
export function evaluate(board) {
  const grid = board.grid;
  let npMaterial = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const code = grid[y][x];
      if (!code) continue;
      const t = typeOf(code);
      if (t !== PAWN && t !== KING) npMaterial += PIECE_VALUE[t];
    }
  }
  const endgame = npMaterial <= 1300;

  let score = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const code = grid[y][x];
      if (!code) continue;
      const t = typeOf(code);
      const white = colorOf(code) === WHITE;
      const idx = white ? y * 8 + x : (7 - y) * 8 + x;
      const table = (t === KING && endgame) ? KING_END : PST[t];
      const v = PIECE_VALUE[t] + table[idx];
      score += white ? v : -v;
    }
  }
  return score;
}

/* ───────────────────────── AI ───────────────────────── */

const MATE = 1e7;
const INF = 1e9;

/**
 * 五档难度（AI 强度）。
 * depth 为名义搜索深度（1/2/2/3/3），breath 为每层候选着法上限，
 * noise 为「噪声带」（厘兵）：得分落在最优着法 noise 之内的着法随机挑一个，
 * 低难度靠它制造「看不过来」的观感；budget 是单步时间预算（毫秒），保证不卡手。
 */
export const LEVELS = {
  1: { key: 1, name: '简单', depth: 1, breadth: 6, noise: 320, quiesce: false, deep: false, budget: 200 },
  2: { key: 2, name: '普通', depth: 2, breadth: 8, noise: 80, quiesce: false, deep: false, budget: 350 },
  3: { key: 3, name: '困难', depth: 2, breadth: 14, noise: 20, quiesce: true, deep: false, budget: 450 },
  4: { key: 4, name: '地狱', depth: 3, breadth: 16, noise: 0, quiesce: true, deep: false, budget: 550 },
  5: { key: 5, name: '亚洲', depth: 3, breadth: 24, noise: 0, quiesce: true, deep: true, maxDepth: 4, budget: 600 },
};

/** 难度名。 */
export function levelName(level) {
  return (LEVELS[level] ?? LEVELS[2]).name;
}

/** 着法排序：吃子（MVV-LVA）、升变、易位优先，让 alpha-beta 尽早剪枝。 */
function orderMoves(board, moves) {
  const scored = moves.map((m) => {
    let s = 0;
    if (m.capture) s += 1000 + PIECE_VALUE[typeOf(m.capture)] * 10 - PIECE_VALUE[typeOf(m.piece)] / 10;
    if (m.promote) s += 800 + PIECE_VALUE[m.promote];
    if (m.flag === 'castleK' || m.flag === 'castleQ') s += 60;
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((it) => it.m);
}

/** 静态搜索：只搜吃子/升变，消除「水平线效应」。 */
function quiesce(board, alpha, beta, ply, cfg, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && ctx.clock() > ctx.deadline) ctx.aborted = true;
  if (ctx.aborted) return 0;

  const color = board.turn;
  const stand = (color === WHITE ? 1 : -1) * evaluate(board);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  if (ply > 24) return alpha; // 极端局面下的深度护栏

  const all = legalMoves(board, color);
  if (all.length === 0) return isInCheck(board, color) ? -(MATE - ply) : 0;

  const caps = orderMoves(board, all.filter((m) => m.capture || m.promote));
  let evaluated = 0;
  for (const move of caps) {
    applyMove(board, move);
    const score = -quiesce(board, -beta, -alpha, ply + 1, cfg, ctx);
    undoMove(board);
    if (ctx.aborted) return 0;
    evaluated++;
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
    if (evaluated >= cfg.breadth) break;
  }
  return alpha;
}

/** negamax + alpha-beta。返回值是「当前行棋方视角」的分数。 */
function negamax(board, depth, alpha, beta, ply, cfg, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && ctx.clock() > ctx.deadline) ctx.aborted = true;
  if (ctx.aborted) return 0;

  const color = board.turn;
  if (depth <= 0) {
    return cfg.quiesce ? quiesce(board, alpha, beta, ply, cfg, ctx)
      : (color === WHITE ? 1 : -1) * evaluate(board);
  }

  const pseudo = orderMoves(board, genPseudoMoves(board, color));
  let best = -INF;
  let any = false;   // 是否至少有一个合法着法
  let evaluated = 0;

  for (const move of pseudo) {
    applyMove(board, move);
    if (isInCheck(board, color)) { undoMove(board); continue; } // 不能送王
    any = true;
    evaluated++;
    const score = -negamax(board, depth - 1, -beta, -alpha, ply + 1, cfg, ctx);
    undoMove(board);
    if (ctx.aborted) return 0;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
    if (evaluated >= cfg.breadth) break; // 限制候选数，保证单步耗时可控
  }

  if (!any) return isInCheck(board, color) ? -(MATE - ply) : 0;
  return best;
}

/** 对根节点每个着法做一次全窗口搜索，返回带分数的列表（按分数降序）。 */
function scoreRoot(board, moves, depth, cfg, ctx) {
  const scored = [];
  for (const move of moves) {
    applyMove(board, move);
    const score = -negamax(board, depth - 1, -INF, INF, 1, cfg, ctx);
    undoMove(board);
    if (ctx.aborted) break;
    scored.push({ move, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { scored };
}

/**
 * 替 AI 选一手棋。
 * @param board 当前棋盘（会被 make-unmake，但结束后恢复原状）
 * @param options.level 1..5（默认 2）
 * @param options.random 随机源（测试可注入固定值）
 * @param options.clock 计时源（默认 Date.now）
 * @param options.budgetMs 覆盖单步时间预算
 * @returns 着法对象；无合法着法时返回 null
 */
export function chooseMove(board, options = {}) {
  const level = Math.min(5, Math.max(1, options.level ?? 2));
  const cfg = LEVELS[level];
  const rand = options.random ?? Math.random;
  const clock = options.clock ?? (() => Date.now());

  const moves = legalMoves(board, board.turn);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  // ① 一步将杀：任何难度都必须抓住（否则低难度会「该赢不赢」）
  const foe = opponent(board.turn);
  for (const move of moves) {
    applyMove(board, move);
    const mated = isInCheck(board, foe) && legalMoves(board, foe).length === 0;
    undoMove(board);
    if (mated) return move;
  }

  const deadline = clock() + (options.budgetMs ?? cfg.budget ?? 500);
  const ctx = { nodes: 0, deadline, aborted: false, clock };

  let scored = [];
  if (cfg.deep) {
    // 亚洲档：迭代加深——先用低深度拿到可用着法，预算内逐层加深，超时即用上一层结果
    let ordered = orderMoves(board, moves);
    const maxDepth = cfg.maxDepth ?? cfg.depth;
    for (let d = 1; d <= maxDepth; d++) {
      const roundCtx = { nodes: ctx.nodes, deadline, aborted: false, clock };
      const round = scoreRoot(board, ordered, d, cfg, roundCtx);
      ctx.nodes = roundCtx.nodes;
      if (round.scored.length && !(roundCtx.aborted && d > 1)) {
        scored = round.scored;
        ordered = scored.map((s) => s.move);
        if (Math.abs(scored[0].score) >= MATE - 100) break; // 已找到将杀，不必再深
      }
      if (roundCtx.aborted || clock() >= deadline) break;
    }
  } else {
    scored = scoreRoot(board, orderMoves(board, moves), cfg.depth, cfg, ctx).scored;
  }

  if (!scored.length) return moves[0];

  // 噪声带内随机：低难度因此会「贪小便宜」或看漏对方的威胁
  const bestScore = scored[0].score;
  const pool = cfg.noise > 0 ? scored.filter((s) => s.score >= bestScore - cfg.noise) : [scored[0]];
  const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return pick.move;
}

/** 上一手搜索的节点数（调试/性能自查用）。 */
export function aiStats() {
  return { levels: Object.keys(LEVELS).length };
}

export { START_FEN };
