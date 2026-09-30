/**
 * 中国象棋核心逻辑（规则判定 + 极小极大 AI）
 *
 * 设计约束（沿用「荒潮拾荒者」的架构理念）：
 *   - 本文件不碰任何平台 API（无宿主全局对象、无绘图上下文），可在 Node 里直接跑测试；
 *   - 棋盘是显式的 9 列 × 10 行二维数组，走子/将军/将死全部可确定性复现；
 *   - 坐标约定：x = 列 0..8（左→右），y = 行 0..9（上→下）；
 *     上方（y 小）为黑方，下方（y 大）为红方，红先黑后；
 *   - 为 UI 提供「合法走法 / 可走点 / 最后一步 / 将军」等渲染所需信息。
 *
 * 棋子编码：类型 1..7，红方 = 类型，黑方 = 类型 + 8（中间空出的 8 作为分界）。
 *   sideOf(p) = p <= 7 ? RED : BLACK，typeOf(p) = p <= 7 ? p : p - 8
 */

/* ───────────────────────── 常量 ───────────────────────── */

export const COLS = 9;
export const ROWS = 10;

export const EMPTY = 0;
export const RED = 1;    // 红方：下方，先手
export const BLACK = 2;  // 黑方：上方，后手

/* 棋子类型 */
export const KING = 1;      // 帅 / 将
export const ADVISOR = 2;   // 仕 / 士
export const ELEPHANT = 3;  // 相 / 象
export const HORSE = 4;     // 马
export const CHARIOT = 5;   // 车
export const CANNON = 6;    // 炮
export const PAWN = 7;      // 兵 / 卒

/** 子力价值表（索引 = 棋子类型）：车 900 马 400 炮 450 仕/相 200 兵 100 将 10000。 */
export const VALUE = [0, 10000, 200, 200, 400, 900, 450, 100];

/** 将杀分值（远大于任何子力差）。 */
const MATE = 1000000;

/** 连续多少手无吃子判和（60 回合）。 */
export const NO_CAPTURE_DRAW = 120;

/** 红黑双方各自的棋子汉字（渲染与测试共用）。 */
export const GLYPHS = {
  [RED]: { [KING]: '帅', [ADVISOR]: '仕', [ELEPHANT]: '相', [HORSE]: '马', [CHARIOT]: '车', [CANNON]: '炮', [PAWN]: '兵' },
  [BLACK]: { [KING]: '将', [ADVISOR]: '士', [ELEPHANT]: '象', [HORSE]: '马', [CHARIOT]: '车', [CANNON]: '炮', [PAWN]: '卒' },
};

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
/** 马的八个落点（dx, dy）。 */
const HORSE_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 组合出棋子编码。 */
export function pieceOf(side, type) {
  return side === RED ? type : type + 8;
}

/** 棋子属于哪一方。 */
export function sideOf(piece) {
  return piece <= 7 ? RED : BLACK;
}

/** 棋子的类型。 */
export function typeOf(piece) {
  return piece <= 7 ? piece : piece - 8;
}

/** 对方的颜色。 */
export function opponent(side) {
  return side === RED ? BLACK : RED;
}

/** 棋子的中文名（红黑用字不同）。 */
export function pieceName(piece) {
  if (piece === EMPTY) return '';
  return GLYPHS[sideOf(piece)][typeOf(piece)];
}

/** 坐标是否在棋盘内。 */
export function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < COLS && y < ROWS;
}

/** 是否落在该方的九宫内（x 恒为 3..5，红方 y 7..9，黑方 y 0..2）。 */
export function inPalace(x, y, side) {
  if (x < 3 || x > 5) return false;
  return side === RED ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2);
}

/** 该行是否还在该方自己的一半（相/象不过河、兵/卒过河才可横走）。 */
export function ownHalf(y, side) {
  return side === RED ? y >= 5 : y <= 4;
}

/* ───────────────────────── 棋盘 ───────────────────────── */

/** 创建一个空棋盘骨架（不含棋子）。 */
function emptyBoard() {
  const grid = [];
  for (let y = 0; y < ROWS; y++) grid.push(new Array(COLS).fill(EMPTY));
  return {
    grid,
    turn: RED,           // 红先
    history: [],         // 走子历史，供悔棋
    noCapture: 0,        // 连续无吃子手数
    check: false,        // 当前该走的一方是否被将军
    status: { over: false, winner: EMPTY, reason: '', text: '' },
  };
}

/** 标准开局。 */
export function createBoard() {
  const board = emptyBoard();
  const g = board.grid;

  // 底线：车 马 相 仕 帅 仕 相 马 车
  const back = [CHARIOT, HORSE, ELEPHANT, ADVISOR, KING, ADVISOR, ELEPHANT, HORSE, CHARIOT];
  for (let x = 0; x < COLS; x++) {
    g[0][x] = pieceOf(BLACK, back[x]);
    g[9][x] = pieceOf(RED, back[x]);
  }
  // 炮
  g[2][1] = pieceOf(BLACK, CANNON); g[2][7] = pieceOf(BLACK, CANNON);
  g[7][1] = pieceOf(RED, CANNON);   g[7][7] = pieceOf(RED, CANNON);
  // 兵/卒
  for (const x of [0, 2, 4, 6, 8]) {
    g[3][x] = pieceOf(BLACK, PAWN);
    g[6][x] = pieceOf(RED, PAWN);
  }

  refreshStatus(board);
  return board;
}

/** 深拷贝一份棋盘（供 AI 试算与测试，避免污染真实棋盘）。 */
export function cloneBoard(board) {
  return {
    grid: board.grid.map((row) => row.slice()),
    turn: board.turn,
    history: board.history.map((h) => ({ ...h })),
    noCapture: board.noCapture,
    check: board.check,
    status: { ...board.status },
  };
}

/** 取某点的棋子（EMPTY 表示空）。 */
export function pieceAt(board, x, y) {
  if (!inBounds(x, y)) return EMPTY;
  return board.grid[y][x];
}

/* ───────────────────────── FEN（便于测试与存档）───────────────────────── */

const LETTER_TO_TYPE = { k: KING, a: ADVISOR, b: ELEPHANT, n: HORSE, r: CHARIOT, c: CANNON, p: PAWN };
const TYPE_TO_LETTER = { [KING]: 'k', [ADVISOR]: 'a', [ELEPHANT]: 'b', [HORSE]: 'n', [CHARIOT]: 'r', [CANNON]: 'c', [PAWN]: 'p' };

/**
 * 解析象棋 FEN（第 1 行是黑方底线，红方用大写字母、黑方用小写字母）。
 * 例：'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w'
 */
export function fromFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  const rows = parts[0].split('/');
  if (rows.length !== ROWS) throw new Error(`FEN 应有 ${ROWS} 行，实际 ${rows.length} 行`);

  const board = emptyBoard();
  for (let y = 0; y < ROWS; y++) {
    let x = 0;
    for (const ch of rows[y]) {
      if (ch >= '1' && ch <= '9') { x += Number(ch); continue; }
      const type = LETTER_TO_TYPE[ch.toLowerCase()];
      if (!type) throw new Error(`FEN 出现未知棋子：${ch}`);
      if (x >= COLS) throw new Error(`FEN 第 ${y + 1} 行超过 ${COLS} 列`);
      board.grid[y][x++] = pieceOf(ch === ch.toLowerCase() ? BLACK : RED, type);
    }
    if (x !== COLS) throw new Error(`FEN 第 ${y + 1} 行只有 ${x} 列`);
  }
  board.turn = parts[1] === 'b' ? BLACK : RED;
  refreshStatus(board);
  return board;
}

/** 输出 FEN。 */
export function toFen(board) {
  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    let row = '', gap = 0;
    for (let x = 0; x < COLS; x++) {
      const p = board.grid[y][x];
      if (p === EMPTY) { gap++; continue; }
      if (gap) { row += String(gap); gap = 0; }
      const letter = TYPE_TO_LETTER[typeOf(p)];
      row += sideOf(p) === RED ? letter.toUpperCase() : letter;
    }
    if (gap) row += String(gap);
    rows.push(row);
  }
  return `${rows.join('/')} ${board.turn === RED ? 'w' : 'b'}`;
}

/* ───────────────────────── 走法生成 ───────────────────────── */

/** 落子进候选表：越界或目标是己方子则丢弃。 */
function pushMove(out, g, fx, fy, tx, ty) {
  if (!inBounds(tx, ty)) return;
  const target = g[ty][tx];
  if (target !== EMPTY && sideOf(target) === sideOf(g[fy][fx])) return;
  out.push({ fx, fy, tx, ty, cap: target });
}

/** 某一颗子的全部走法（含所有规则限制，但不管走后是否被将军）。 */
function addMoves(out, g, x, y, piece) {
  const side = sideOf(piece);
  const type = typeOf(piece);

  switch (type) {
    case KING:
      for (const [dx, dy] of ORTHO) {
        const tx = x + dx, ty = y + dy;
        if (inPalace(tx, ty, side)) pushMove(out, g, x, y, tx, ty);  // 帅/将只在九宫内直走一步
      }
      break;

    case ADVISOR:
      for (const [dx, dy] of DIAG) {
        const tx = x + dx, ty = y + dy;
        if (inPalace(tx, ty, side)) pushMove(out, g, x, y, tx, ty);  // 仕/士只在九宫内斜走一步
      }
      break;

    case ELEPHANT:
      for (const [dx, dy] of DIAG) {
        const tx = x + dx * 2, ty = y + dy * 2;
        if (!inBounds(tx, ty)) continue;
        if (!ownHalf(ty, side)) continue;                            // 相/象不过河
        if (g[y + dy][x + dx] !== EMPTY) continue;                   // 塞象眼
        pushMove(out, g, x, y, tx, ty);
      }
      break;

    case HORSE:
      for (const [dx, dy] of HORSE_STEPS) {
        const tx = x + dx, ty = y + dy;
        if (!inBounds(tx, ty)) continue;
        // 蹩马腿：长边方向的紧邻格被占则走不动
        const lx = Math.abs(dx) === 2 ? x + dx / 2 : x;
        const ly = Math.abs(dy) === 2 ? y + dy / 2 : y;
        if (g[ly][lx] !== EMPTY) continue;
        pushMove(out, g, x, y, tx, ty);
      }
      break;

    case CHARIOT:
      for (const [dx, dy] of ORTHO) {
        let tx = x + dx, ty = y + dy;
        while (inBounds(tx, ty)) {
          const t = g[ty][tx];
          if (t === EMPTY) {
            pushMove(out, g, x, y, tx, ty);
          } else {
            if (sideOf(t) !== side) pushMove(out, g, x, y, tx, ty);  // 吃第一个敌子
            break;
          }
          tx += dx; ty += dy;
        }
      }
      break;

    case CANNON:
      for (const [dx, dy] of ORTHO) {
        let tx = x + dx, ty = y + dy, screen = false;
        while (inBounds(tx, ty)) {
          const t = g[ty][tx];
          if (!screen) {
            if (t === EMPTY) pushMove(out, g, x, y, tx, ty);
            else screen = true;              // 遇到炮架（无论敌我），转入翻山阶段
          } else if (t !== EMPTY) {
            if (sideOf(t) !== side) pushMove(out, g, x, y, tx, ty);  // 翻山吃第一个敌子
            break;
          }
          tx += dx; ty += dy;
        }
      }
      break;

    case PAWN: {
      const forward = side === RED ? -1 : 1;
      pushMove(out, g, x, y, x, y + forward);      // 兵/卒永远可以向前一步
      if (!ownHalf(y, side)) {                     // 过河之后才可横走
        pushMove(out, g, x, y, x - 1, y);
        pushMove(out, g, x, y, x + 1, y);
      }
      break;
    }

    default:
      break;
  }
}

/** 生成某方全部走法（未过滤「走后自己被将军」）。 */
export function generateMoves(board, side = board.turn) {
  const out = [];
  const g = board.grid;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = g[y][x];
      if (p === EMPTY || sideOf(p) !== side) continue;
      addMoves(out, g, x, y, p);
    }
  }
  return out;
}

/* ───────────────────────── 攻击判定 / 将军 ───────────────────────── */

/**
 * (x,y) 是否被 by 方攻击（只用于将帅安全，因此只查能打到九宫的子力）。
 * 覆盖：车、炮（翻山）、将（贴身与照面）、马（含蹩马腿）、兵/卒（向前与过河横走）。
 */
export function isAttacked(board, x, y, by) {
  const g = board.grid;

  // ① 横竖四条线：车 / 炮 / 将
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy, screen = 0;
    while (inBounds(cx, cy)) {
      const p = g[cy][cx];
      if (p !== EMPTY) {
        const s = sideOf(p), t = typeOf(p);
        if (screen === 0) {
          if (s === by) {
            if (t === CHARIOT) return true;
            // 将帅照面（同一列且中间无子）或贴身一步
            if (t === KING && (dx === 0 || Math.abs(cx - x) + Math.abs(cy - y) === 1)) return true;
          }
          screen = 1;
        } else {
          if (s === by && t === CANNON) return true;   // 炮翻山
          break;
        }
      }
      cx += dx; cy += dy;
    }
  }

  // ② 马：八个可能的马位，腿（长边中点）为空才算真攻击
  for (const [dx, dy] of HORSE_STEPS) {
    const hx = x + dx, hy = y + dy;
    if (!inBounds(hx, hy)) continue;
    const p = g[hy][hx];
    if (p === EMPTY || typeOf(p) !== HORSE || sideOf(p) !== by) continue;
    const legX = Math.abs(dx) === 2 ? x + dx / 2 : x;
    const legY = Math.abs(dy) === 2 ? y + dy / 2 : y;
    if (g[legY][legX] === EMPTY) return true;
  }

  // ③ 兵/卒：向前一步，或过河后横向一步
  const frontY = y + (by === RED ? 1 : -1);
  if (inBounds(x, frontY)) {
    const p = g[frontY][x];
    if (p !== EMPTY && sideOf(p) === by && typeOf(p) === PAWN) return true;
  }
  for (const sx of [-1, 1]) {
    const px = x + sx;
    if (!inBounds(px, y)) continue;
    const p = g[y][px];
    if (p === EMPTY || sideOf(p) !== by || typeOf(p) !== PAWN) continue;
    if (!ownHalf(y, by)) return true;     // 该兵已过河，可以横吃
  }

  return false;
}

/** 找某方的将/帅（先查九宫，兜底全盘）。 */
export function findKing(board, side) {
  const g = board.grid;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 3; x <= 5; x++) {
      const p = g[y][x];
      if (p !== EMPTY && typeOf(p) === KING && sideOf(p) === side) return { x, y };
    }
  }
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = g[y][x];
      if (p !== EMPTY && typeOf(p) === KING && sideOf(p) === side) return { x, y };
    }
  }
  return null;
}

/** 某方是否被将军。 */
export function inCheck(board, side) {
  const king = findKing(board, side);
  if (!king) return false;   // 极端测试局面（无将）按未被将军处理
  return isAttacked(board, king.x, king.y, opponent(side));
}

/** 将帅是否照面（同一列且中间无子）——出现即判主动照面一方负。 */
export function kingsFacing(board) {
  const rk = findKing(board, RED);
  const bk = findKing(board, BLACK);
  if (!rk || !bk || rk.x !== bk.x) return false;
  const from = Math.min(rk.y, bk.y) + 1;
  const to = Math.max(rk.y, bk.y);
  for (let y = from; y < to; y++) {
    if (board.grid[y][rk.x] !== EMPTY) return false;
  }
  return true;
}

/* ───────────────────────── 合法走法 ───────────────────────── */

/**
 * 某方全部合法走法：剔除「走完自己被将军」（含将帅照面）的着法。
 * 这是「被将军必须应将」的唯一实现点——AI 与玩家共用。
 */
export function legalMoves(board, side = board.turn) {
  return filterLegal(board, side, generateMoves(board, side));
}

/** 某颗子的全部走法（不看走后是否被将军），UI 用来说明「规则不允许 vs 会送将」。 */
export function pseudoMovesOf(board, x, y) {
  const piece = pieceAt(board, x, y);
  if (piece === EMPTY) return [];
  const out = [];
  addMoves(out, board.grid, x, y, piece);
  return out;
}

/** 过滤「走完自己会被将军」的着法（原地试走再还原）。 */
function filterLegal(board, side, raw) {
  const out = [];
  const g = board.grid;
  for (const m of raw) {
    const cap = g[m.ty][m.tx];
    g[m.ty][m.tx] = g[m.fy][m.fx];
    g[m.fy][m.fx] = EMPTY;
    const bad = inCheck(board, side);
    g[m.fy][m.fx] = g[m.ty][m.tx];
    g[m.ty][m.tx] = cap;
    if (!bad) out.push(m);
  }
  return out;
}

/** 某方全部合法「吃子」着法（静态搜索用，比全量着法省一半以上开销）。 */
function legalCaptures(board, side) {
  const raw = [];
  const g = board.grid;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = g[y][x];
      if (p === EMPTY || sideOf(p) !== side) continue;
      addMoves(raw, g, x, y, p);
    }
  }
  return filterLegal(board, side, raw.filter((m) => m.cap !== EMPTY));
}

/** 某颗子的合法走法（点选棋子后显示的可走点）。 */
export function movesOf(board, x, y) {
  const piece = pieceAt(board, x, y);
  if (piece === EMPTY) return [];
  const raw = [];
  addMoves(raw, board.grid, x, y, piece);
  return filterLegal(board, sideOf(piece), raw);
}

/* ───────────────────────── 状态推进 ───────────────────────── */

/** 重算被将军标记与胜负状态（走子、悔棋、手工摆局后都要调用）。 */
export function refreshStatus(board) {
  const side = board.turn;
  board.check = inCheck(board, side);

  // 将帅照面：轮到走子的一方直接吃将获胜（正常流程下 makeMove 已把这类着法挡掉）
  if (kingsFacing(board)) {
    board.status = { over: true, winner: side, reason: 'flying', text: '将帅照面' };
    return board.status;
  }

  // 无着可走：将死或困毙，二者都判负（象棋的困毙不是和棋）
  if (legalMoves(board, side).length === 0) {
    board.status = {
      over: true,
      winner: opponent(side),
      reason: board.check ? 'checkmate' : 'stalemate',
      text: board.check ? '将死' : '困毙',
    };
    return board.status;
  }

  if (board.noCapture >= NO_CAPTURE_DRAW) {
    board.status = { over: true, winner: EMPTY, reason: 'draw', text: '和棋（长时间无吃子）' };
    return board.status;
  }

  board.status = { over: false, winner: EMPTY, reason: board.check ? 'check' : '', text: '' };
  return board.status;
}

/**
 * 走一步棋（就地修改棋盘）。
 * @returns {{ok:boolean, reason?:string, move?:object, captured?:number, check?:boolean, status?:object}}
 */
export function makeMove(board, fx, fy, tx, ty) {
  if (board.status.over) return { ok: false, reason: 'over' };

  const piece = pieceAt(board, fx, fy);
  if (piece === EMPTY) return { ok: false, reason: 'empty' };
  if (sideOf(piece) !== board.turn) return { ok: false, reason: 'not-your-turn' };

  const legal = movesOf(board, fx, fy).some((m) => m.tx === tx && m.ty === ty);
  if (!legal) return { ok: false, reason: 'illegal' };

  const cap = board.grid[ty][tx];
  board.grid[ty][tx] = piece;
  board.grid[fy][fx] = EMPTY;
  board.history.push({ fx, fy, tx, ty, piece, cap });
  board.noCapture = cap === EMPTY ? board.noCapture + 1 : 0;
  board.turn = opponent(board.turn);
  refreshStatus(board);

  return {
    ok: true,
    move: { fx, fy, tx, ty },
    captured: cap,
    check: board.check,
    status: board.status,
  };
}

/** 悔棋：撤回最后一手。 */
export function undo(board) {
  const last = board.history.pop();
  if (!last) return { ok: false, reason: 'empty' };

  board.grid[last.fy][last.fx] = last.piece;
  board.grid[last.ty][last.tx] = last.cap;
  board.turn = sideOf(last.piece);

  // 无吃子计数按历史重算（历史很短，代价可忽略）
  let n = 0;
  for (let i = board.history.length - 1; i >= 0; i--) {
    if (board.history[i].cap !== EMPTY) break;
    n++;
  }
  board.noCapture = n;

  refreshStatus(board);
  return { ok: true, undone: last };
}

/** 最后一手（供 UI 画标记）。 */
export function lastMove(board) {
  return board.history.length ? board.history[board.history.length - 1] : null;
}

/** 胜负文案（UI 直接显示；不含「你/我」口径）。 */
export function resultText(board) {
  const s = board.status;
  if (!s.over) return '';
  if (s.reason === 'draw') return '和棋';
  if (s.winner === RED) return '红方胜';
  if (s.winner === BLACK) return '黑方胜';
  return '';
}

/* ───────────────────────── AI：评估 ───────────────────────── */

/** 位置分：以红方视角算，黑方镜像；量级远小于子力，只用来打破均势。 */
function positionBonus(type, x, y, side) {
  const ry = side === RED ? y : ROWS - 1 - y;   // 换算成「离红方底线几行」
  const cx = Math.abs(x - 4);                   // 离中线的横向距离

  switch (type) {
    case PAWN: {
      let b = (6 - ry) * 8;                     // 每推进一行加分
      if (ry <= 4) b += 16 + (4 - cx) * 4;      // 过河后靠中路更有威胁
      return b;
    }
    case HORSE: return (4 - cx) * 3 + (ry <= 4 ? 6 : 0);
    case CANNON: return (4 - cx) * 2 + (ry <= 4 ? 4 : 0);
    case CHARIOT: return (4 - cx) * 2;
    default: return 0;
  }
}

/** 局面评估（站在 side 的角度：正数对我方有利）。 */
export function evaluate(board, side) {
  const g = board.grid;
  let score = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = g[y][x];
      if (p === EMPTY) continue;
      const t = typeOf(p);
      const v = VALUE[t] + positionBonus(t, x, y, sideOf(p));
      score += sideOf(p) === side ? v : -v;
    }
  }
  return score;
}

/** 走法排序：先吃子（MVV-LVA），再按位置推进；好的排序能显著提高剪枝效率。 */
function orderMoves(board, moves, side) {
  const g = board.grid;
  for (const m of moves) {
    const mover = typeOf(g[m.fy][m.fx]);
    let s;
    if (m.cap !== EMPTY) {
      s = VALUE[typeOf(m.cap)] * 10 - VALUE[mover];
    } else {
      s = positionBonus(mover, m.tx, m.ty, side) - positionBonus(mover, m.fx, m.fy, side);
    }
    m.order = s;
  }
  moves.sort((a, b) => b.order - a.order);
}

/* ───────────────────────── AI：搜索 ───────────────────────── */

function doMove(g, m) {
  const cap = g[m.ty][m.tx];
  g[m.ty][m.tx] = g[m.fy][m.fx];
  g[m.fy][m.fx] = EMPTY;
  return cap;
}

function undoMove(g, m, cap) {
  g[m.fy][m.fx] = g[m.ty][m.tx];
  g[m.ty][m.tx] = cap;
}

function outOfTime(ctx) {
  return ctx.nodes >= ctx.maxNodes || (ctx.nodes & 511) === 0 && ctx.now() > ctx.deadline;
}

/**
 * 静态搜索（只搜吃子）：把「吃完还能吃回来」的交换算完，消除地平线效应。
 * 中高难度档启用——否则 depth 2 会看不出自己的子被吃后能否吃回。
 */
function quiesce(board, side, alpha, beta, ply, ctx, depthLeft) {
  ctx.nodes++;
  if (outOfTime(ctx)) { ctx.timeout = true; return 0; }

  const checked = inCheck(board, side);
  const stand = checked ? -Infinity : evaluate(board, side);
  if (!checked) {
    if (depthLeft <= 0 || stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
  } else if (depthLeft <= 0) {
    return evaluate(board, side);
  }

  const moves = checked ? legalMoves(board, side) : legalCaptures(board, side);
  if (moves.length === 0) return checked ? -MATE + ply : stand;
  orderMoves(board, moves, side);

  let best = -Infinity;
  for (const m of moves) {
    const cap = doMove(board.grid, m);
    const val = -quiesce(board, opponent(side), -beta, -alpha, ply + 1, ctx, depthLeft - 1);
    undoMove(board.grid, m, cap);
    if (ctx.timeout) return best === -Infinity ? stand : best;
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best === -Infinity ? stand : best;
}

/** 负极大值搜索 + alpha-beta 剪枝。score 永远站在 side 的角度。 */
function negamax(board, side, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if (outOfTime(ctx)) { ctx.timeout = true; return 0; }

  const moves = legalMoves(board, side);
  if (moves.length === 0) return -MATE + ply;   // 无着可走（将死/困毙）即负

  if (depth <= 0) {
    return ctx.quiesce ? quiesce(board, side, alpha, beta, ply, ctx, 2) : evaluate(board, side);
  }

  orderMoves(board, moves, side);
  let best = -Infinity;
  for (const m of moves) {
    const cap = doMove(board.grid, m);
    const val = -negamax(board, opponent(side), depth - 1, -beta, -alpha, ply + 1, ctx);
    undoMove(board.grid, m, cap);
    if (ctx.timeout) return best === -Infinity ? 0 : best;
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/* ───────────────────────── AI：难度档 ───────────────────────── */

/**
 * 五档难度。
 *   depth    搜索深度（1/1/2/3/3）
 *   rootCap  根节点候选数上限（越小越快、越弱）
 *   noise    评分随机扰动（简单档用来「偶尔失误」）
 *   blunder  直接走次优着的概率
 *   quiesce  叶节点是否做「只吃子」的静态搜索（消除地平线效应）
 *   budgetMs 单步思考预算（硬约束：< 800ms）
 */
export const LEVELS = {
  1: { key: 1, name: '简单', depth: 1, rootCap: 10, noise: 200, blunder: 0.22, quiesce: false, budgetMs: 300, maxNodes: 60000 },
  2: { key: 2, name: '普通', depth: 1, rootCap: 16, noise: 0, blunder: 0, quiesce: false, budgetMs: 400, maxNodes: 90000 },
  3: { key: 3, name: '困难', depth: 2, rootCap: 20, noise: 0, blunder: 0, quiesce: true, budgetMs: 550, maxNodes: 200000 },
  4: { key: 4, name: '地狱', depth: 3, rootCap: 26, noise: 0, blunder: 0, quiesce: true, budgetMs: 620, maxNodes: 300000 },
  5: { key: 5, name: '亚洲', depth: 3, rootCap: 48, noise: 0, blunder: 0, quiesce: true, budgetMs: 700, maxNodes: 450000 },
};

/** 把难度（1..5 / 'lv1'..'lv5' / '简单'…）归一化成 1..5。 */
export function parseLevel(key) {
  if (typeof key === 'number' && Number.isFinite(key)) {
    return Math.min(5, Math.max(1, Math.round(key)));
  }
  const s = String(key ?? '').trim();
  const m = /^lv?(\d)$/i.exec(s);
  if (m) return Math.min(5, Math.max(1, Number(m[1])));
  const idx = ['简单', '普通', '困难', '地狱', '亚洲'].indexOf(s);
  if (idx >= 0) return idx + 1;
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 2;
}

export function levelName(level) {
  return (LEVELS[parseLevel(level)] ?? LEVELS[2]).name;
}

/** 只保留坐标，避免把内部排序字段带出去。 */
function bare(m) {
  return { fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty };
}

/**
 * 选出 AI 的着法。
 * @param board 当前棋盘（不会被修改）
 * @param side AI 执子方
 * @param options.level 1..5；options.random 随机源（测试可注入）；options.now 时钟；options.budgetMs 覆盖预算
 * @returns {{fx:number,fy:number,tx:number,ty:number}|null}
 */
export function chooseMove(board, side = board.turn, options = {}) {
  const level = parseLevel(options.level ?? 2);
  const cfg = LEVELS[level];
  const rand = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  // 时间预算从函数入口开始计时（含"一步杀"扫描），保证整步 < 800ms
  const startedAt = now();
  const deadline = startedAt + (options.budgetMs ?? cfg.budgetMs);

  const roots = legalMoves(board, side);
  if (roots.length === 0) return null;
  if (roots.length === 1) return bare(roots[0]);

  // ① 一步绝杀：任何难度都必须抓到（否则简单档会出现「该赢不赢」的怪象）
  for (const m of roots) {
    if (now() > deadline) break;
    const cap = doMove(board.grid, m);
    const foeMoves = legalMoves(board, opponent(side));
    undoMove(board.grid, m, cap);
    if (foeMoves.length === 0) return bare(m);
  }

  const ctx = {
    nodes: 0,
    timeout: false,
    now,
    deadline,
    maxNodes: cfg.maxNodes,
    quiesce: !!cfg.quiesce,
  };

  // ② 限制根节点候选数以控制耗时（吃子与推进优先）
  orderMoves(board, roots, side);
  const pool = roots.slice(0, Math.max(4, Math.min(cfg.rootCap, roots.length)));

  let best = pool[0];
  let bestVal = -Infinity;
  let scored = null;

  // ③ 迭代加深：任何一轮被打断都保留上一轮的完整结果，保证有棋可走
  for (let d = 1; d <= cfg.depth; d++) {
    const rows = [];
    let localBest = pool[0];
    let localVal = -Infinity;
    let alpha = -Infinity;

    for (const m of pool) {
      const cap = doMove(board.grid, m);
      // 第 1 层用全窗口（简单档要靠真实分差做扰动），更深层用收窄窗口加速
      const val = -negamax(board, opponent(side), d - 1, -Infinity, d === 1 ? Infinity : -alpha, 1, ctx);
      undoMove(board.grid, m, cap);
      if (ctx.timeout) break;

      rows.push({ m, val });
      if (val > localVal) { localVal = val; localBest = m; }
      if (val > alpha) alpha = val;
    }

    if (ctx.timeout) break;
    best = localBest;
    bestVal = localVal;
    scored = rows;

    if (bestVal >= MATE - 200) break;          // 已见杀棋，不必再深
    if (now() >= ctx.deadline) break;

    // 把本轮最佳着法提到最前，下一轮剪枝更快
    const at = pool.indexOf(best);
    if (at > 0) { pool.splice(at, 1); pool.unshift(best); }
  }

  // ④ 简单档：噪声扰动 + 偶尔走次优着（"看不过来"的观感），但绝不放掉杀棋
  if (scored && scored.length > 0) {
    if (cfg.noise > 0) {
      let pick = best;
      let pickVal = -Infinity;
      for (const r of scored) {
        const v = r.val + (rand() - 0.5) * 2 * cfg.noise;
        if (v > pickVal) { pickVal = v; pick = r.m; }
      }
      best = pick;
    }
    if (cfg.blunder > 0 && rand() < cfg.blunder) {
      const cands = scored
        .filter((r) => r.val < MATE - 1000)
        .sort((a, b) => b.val - a.val)
        .slice(0, 4);
      if (cands.length > 1) best = cands[Math.abs(Math.floor(rand() * cands.length)) % cands.length].m;
    }
  }

  return bare(best);
}

/* 供测试直接取用的内部件 */
export { positionBonus as __positionBonus, negamax as __negamax, MATE as __MATE };
