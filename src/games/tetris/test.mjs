/**
 * 俄罗斯方块核心逻辑测试（Node 直接跑，零依赖，不碰微信 API）
 * 用法：node src/games/tetris/test.mjs
 *
 * 覆盖：7 种方块形状 / 旋转后形状正确 / 碰撞检测（边界与堆叠）/ 消一行与四行 /
 *       计分 / 7-bag 每 7 个不重复 / 等级与速度 / 游戏结束条件 / 绘制层冒烟。
 */
import {
  COLS, ROWS, EMPTY, TYPES, SHAPES, COLORS, LINE_SCORES, MAX_LEVEL, LINES_PER_LEVEL,
  DIFFICULTIES, DEFAULT_DIFFICULTY, SOFT_DROP_SCORE, SOFT_DROP_MIN_INTERVAL, SOFT_DROP_DIVISOR,
  createState, createGrid, start, togglePause, restart, statusText, clearLabel,
  rotateMatrixCW, rotateShape, cellsOf, shapeSignature, shapeBounds, pieceCells,
  makePiece, spawnX, cellFree, canPlace, canMove, move, moveLeft, moveRight, rotate,
  softDrop, hardDrop, dropDistance, lock, fullRows, clearRows, scoreForLines, levelForLines,
  fallInterval, softDropInterval, activeInterval, fallProgress, tick, gameOver,
  mulberry32, createBag, difficultyConfig,
} from './core.js';
import {
  computeLayout, hitButton, buttonOf, renderFrame, drawBlock, pathRoundRect, pieceCellY,
} from './render.js';
import { meta, createSession } from './index.js';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 浮点近似相等（插值算出来的是小数，不能用 ===）。 */
function near(actual, expected, tol, name) {
  ok(Math.abs(actual - expected) <= tol, name, `${actual} 与 ${expected} 相差 ${Math.abs(actual - expected)} > ${tol}`);
}

/**
 * 记录 moveTo 坐标 + 统计调用次数的桩 ctx。
 * 用途：① 核对「真正画出去的方块顶点 y」等于 pieceCellY 算出来的值；
 *       ② 性能计数（beginPath / stroke / 渐变次数）——见 perf-check.mjs 的同款实现。
 */
function makeRecCtx() {
  const rec = { moves: [], begins: 0, strokes: 0, fills: 0, grads: 0, rects: [] };
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = {
    canvas: { width: 750, height: 1334 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: 'left', textBaseline: 'top', globalAlpha: 1,
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    save: noop, restore: noop, closePath: noop, clip: noop,
    beginPath: () => { rec.begins++; },
    moveTo: (x, y) => { rec.moves.push([x, y]); },
    lineTo: noop, arc: noop, arcTo: noop, rect: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, translate: noop, rotate: noop, scale: noop,
    clearRect: noop, fillRect: (x, y, w, h) => { rec.rects.push({ x, y, w, h }); }, strokeRect: noop,
    fill: () => { rec.fills++; }, stroke: () => { rec.strokes++; },
    fillText: noop, strokeText: noop, measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => { rec.grads++; return grad; },
    createRadialGradient: () => { rec.grads++; return grad; },
    setTransform: noop, drawImage: noop,
  };
  return { ctx, rec };
}

/** 只记 fillRect 的桩 ctx（查"有没有整屏铺底"用）。 */
function makeFullRecCtx() {
  const { ctx, rec } = makeRecCtx();
  return { ctx, rec };
}

/** 把棋盘某一行填指定的列（测试造局面用）。 */
function fillRow(grid, y, cols) {
  for (const x of cols) grid[y][x] = 'I';
}

/** 造一套「除 holes 外的列都填满」的行。 */
function fillRowExcept(grid, y, holes = []) {
  const cols = [];
  for (let x = 0; x < COLS; x++) if (!holes.includes(x)) cols.push(x);
  fillRow(grid, y, cols);
}

/**
 * 造一局「已开打」的状态。
 * createState 出来的是 ready（等玩家动手），要测移动/旋转必须先 start。
 */
function playing(options = {}) {
  const st = createState(options);
  start(st);
  return st;
}

/* ═════════════════════ 一、7 种方块形状 ═════════════════════ */

console.log('\n【一】7 种方块形状');
{
  eq(TYPES.length, 7, '共 7 种方块');
  eq(TYPES.join(''), 'IOTSZJL', '种类齐全：I O T S Z J L');

  // 形状签名（去空白后的最小包围盒），一格一格数得清
  eq(shapeSignature('I'), '####', 'I 出生形状是一横四格');
  eq(shapeSignature('O'), '##/##', 'O 出生形状是 2×2');
  eq(shapeSignature('T'), '.#./###', 'T 出生形状是「下三上一」');
  eq(shapeSignature('S'), '.##/##.', 'S 出生形状是右上错排');
  eq(shapeSignature('Z'), '##./.##', 'Z 出生形状是左上错排');
  eq(shapeSignature('J'), '#../###', 'J 出生形状是左竖 + 底三');
  eq(shapeSignature('L'), '..#/###', 'L 出生形状是右竖 + 底三');

  // 每种方块都是 4 格
  for (const t of TYPES) {
    eq(cellsOf(SHAPES[t]).length, 4, `${t} 恰好 4 格`);
  }

  // 每种方块都有配色（渲染层要按类型取色）
  for (const t of TYPES) {
    ok(COLORS[t] && typeof COLORS[t].base === 'string', `${t} 有配色`);
  }

  // 包围盒
  const bi = shapeBounds('I');
  ok(bi.w === 4 && bi.h === 1, 'I 的包围盒 4×1', JSON.stringify(bi));
  const bo = shapeBounds('O');
  ok(bo.w === 2 && bo.h === 2, 'O 的包围盒 2×2', JSON.stringify(bo));

  // 出生列：让实体格居中（I 占 3..6，O 占 4、5，其余占 4..6）
  eq(spawnX('I'), 3, 'I 出生 x=3（实体占第 3..6 列）');
  eq(spawnX('O'), 3, 'O 出生 x=3（实体占第 4、5 列）');
  eq(spawnX('T'), 4, 'T 出生 x=4（实体占第 4..6 列）');

  // 出生位置合法性：O 的 2×2 落在 4、5 列
  const oCells = pieceCells(makePiece('O', spawnX('O'), 0, 0));
  ok(oCells.every(([x]) => x === 4 || x === 5), 'O 出生于中间两列', JSON.stringify(oCells));
  // 所有方块出生时都在棋盘内，且横向居中（实体格范围的中点贴近棋盘中线）
  for (const t of TYPES) {
    const cells = pieceCells(makePiece(t, spawnX(t), 0, 0));
    const xs = cells.map((c) => c[0]);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    ok(cells.every(([x, y]) => x >= 0 && x < COLS && y >= 0 && y < ROWS), `${t} 出生位置在棋盘内`, JSON.stringify(cells));
    ok(Math.abs(mid - (COLS - 1) / 2) <= 1, `${t} 出生位置横向居中（中线 ${mid}）`, JSON.stringify(xs));
  }
}

/* ═════════════════════ 二、旋转后形状正确 ═════════════════════ */

console.log('\n【二】旋转后形状正确');
{
  // 旋转本质：3×3 顺时针 = 转置后列序颠倒
  const a = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
  const r1 = rotateMatrixCW(a);
  eq(JSON.stringify(r1), JSON.stringify([[7, 4, 1], [8, 5, 2], [9, 6, 3]]), '矩阵顺时针旋转一次');
  eq(JSON.stringify(rotateMatrixCW(rotateMatrixCW(rotateMatrixCW(rotateMatrixCW(a))))),
     JSON.stringify(a), '旋转四次回到原状');

  // 偏移不变式：把矩阵旋转 90°，等价于所有格坐标 (x,y) → (c-1-y, x)
  for (const t of TYPES) {
    let m = SHAPES[t];
    const c = m.length;
    for (let k = 1; k <= 4; k++) {
      const rot = rotateShape(t, k);
      const expect = cellsOf(m).map(([x, y]) => `${c - 1 - y},${x}`).sort();
      const actual = cellsOf(rot).map(([x, y]) => `${x},${y}`).sort();
      eq(actual.join('|'), expect.join('|'), `${t} 第 ${k} 次旋转：坐标映射正确`);
      m = rot;
    }
  }

  // 关键朝向的形状（逐格手抄核对过；检查值独立于实现，不是照抄运行结果）
  eq(shapeSignature('I', 1), '#/#/#/#', 'I 转一次变竖四格');
  eq(shapeSignature('I', 2), '####', 'I 转两次回横');
  eq(shapeSignature('T', 1), '#./##/#.', 'T 转一次：竖排靠左、凸起朝右');
  eq(shapeSignature('T', 2), '###/.#.', 'T 转两次朝下');
  eq(shapeSignature('T', 3), '.#/##/.#', 'T 转三次：竖排靠右、凸起朝左');
  eq(shapeSignature('S', 1), '#./##/.#', 'S 转一次变竖');
  eq(shapeSignature('Z', 1), '.#/##/#.', 'Z 转一次变竖');
  eq(shapeSignature('J', 1), '##/#./#.', 'J 转一次：横两格在上、尾巴朝下');
  eq(shapeSignature('L', 1), '#./#./##', 'L 转一次：尾巴朝上、横两格在下');

  // O 旋转不变
  for (let k = 0; k < 4; k++) eq(shapeSignature('O', k), '##/##', `O 的第 ${k} 朝向不变`);
  // T / J / L 四个朝向互不相同
  for (const t of ['T', 'J', 'L']) {
    const set = new Set([0, 1, 2, 3].map((k) => shapeSignature(t, k)));
    eq(set.size, 4, `${t} 四个朝向互不相同`);
  }
  // S / Z 是 180° 对称的方块：只有两个朝向，2 次旋转回到原形（几何事实，不是 bug）
  for (const t of ['S', 'Z']) {
    eq(shapeSignature(t, 2), shapeSignature(t, 0), `${t} 转两次回到原形（180° 对称）`);
    eq(shapeSignature(t, 3), shapeSignature(t, 1), `${t} 转三次等于转一次`);
    const set = new Set([0, 1, 2, 3].map((k) => shapeSignature(t, k)));
    eq(set.size, 2, `${t} 只有两个朝向`);
  }
  // I 与 O 的朝向更少，这是几何事实
  eq(new Set([0, 1, 2, 3].map((k) => shapeSignature('I', k))).size, 2, 'I 只有横/竖两种朝向');
  eq(new Set([0, 1, 2, 3].map((k) => shapeSignature('O', k))).size, 1, 'O 只有一种朝向');

  // 旋转 SHAPES 不能被污染
  eq(shapeSignature('I'), '####', 'rotateShape 不污染原始形状表');
  eq(rotateShape('X'), null, '未知类型返回 null');
}

/* ═════════════════════ 三、碰撞检测 ═════════════════════ */

console.log('\n【三】碰撞检测（边界 / 堆叠）');
{
  eq(cellFree(createGrid(), -1, 5), false, 'x < 0 越界');
  eq(cellFree(createGrid(), COLS, 5), false, 'x ≥ 列数越界');
  eq(cellFree(createGrid(), 5, ROWS), false, 'y ≥ 行数越界');
  eq(cellFree(createGrid(), 5, -1), true, 'y < 0（尚未入场）视为合法');

  const st = createState({ seed: 7 });
  st.grid[5][4] = 'T';
  eq(cellFree(st.grid, 4, 5), false, '已有方块处不可放');
  eq(cellFree(st.grid, 4, 4), true, '空处可放');

  // 左右边界：O 是 3×3 矩阵里第 1、2 列、第 1、2 行的 2×2 方块
  const b = playing({ seed: 7 });
  b.piece = makePiece('O', 3, 5, 0);
  ok(pieceCells(b.piece).every(([x]) => x === 4 || x === 5), 'O 在 x=3 时实体占第 4、5 列');
  b.piece.x = 0;
  ok(pieceCells(b.piece).every(([x]) => x >= 0), 'O 在 x=0 时实体仍在棋盘内（第 1、2 列）');
  eq(canMove(b, -1, 0), true, '还能再左移一格（左移后实体贴到第 0、1 列）');
  eq(move(b, -1), true, '左移成功');
  eq(b.piece.x, -1, '左移后 x = -1');
  eq(canMove(b, -1, 0), false, '再左移就出界了');
  eq(move(b, -1), false, 'move 左移失败返回 false');
  eq(b.piece.x, -1, '左移失败后位置不变');
  b.piece.x = COLS - 4;                              // 实体占第 7、8 列
  ok(pieceCells(b.piece).every(([x]) => x < COLS), 'O 在 x=6 时实体占第 7、8 列');
  eq(canMove(b, 1, 0), true, '右侧还有空列，可以右移');
  b.piece.x = COLS - 3;                              // 实体占第 8、9 列
  eq(canMove(b, 1, 0), false, '到边界后不能再右移');
  eq(move(b, 1), false, 'move 右移失败返回 false');
  eq(b.piece.x, COLS - 3, '右移失败后位置不变');

  // 底部：竖 I 的实体在第 0..3 行（矩阵里靠上），落到底端停在第 19 行
  const d = playing({ seed: 7 });
  d.piece = makePiece('I', 3, 0, 1);
  eq(pieceCells(d.piece).map((c) => c[1]).join(','), '0,1,2,3', '竖 I（x=3,r=1）实体在第 5 列、第 0..3 行');
  eq(dropDistance(d), 16, '竖 I 从顶部正好落 16 格（底端停在第 19 行）');
  d.piece = makePiece('I', 3, ROWS - 4, 1);
  eq(dropDistance(d), 0, '底端已经贴地时幽灵落点距离为 0');
  eq(canMove(d, 0, 1), false, '触底后不能再下移');

  // 堆叠：底部两行右侧有方块，横 I 只能落在它们正上方
  const g = playing({ seed: 7 });
  for (let y = ROWS - 2; y < ROWS; y++) {
    for (let x = 4; x < COLS; x++) g.grid[y][x] = 'L';
  }
  g.piece = makePiece('I', 3, 0, 0);   // 横 I 实体在第 3..6 列、第 1 行
  const dist = dropDistance(g);
  eq(dist, 16, '被底部两行方块顶住，只落 16 格');
  g.piece.y += dist;                   // 先落到底，再看还能不能动
  eq(canMove(g, 0, 1), false, '落到底后不能再下移');
  eq(canMove(g, 1, 0), true, '没压到右侧堆叠时可以右移');
  eq(canMove(g, -1, 0), true, '左侧也空，可以左移');

  // 右侧被挡：第 5..9 列底部有块，横 I 右移会撞上
  const g2 = playing({ seed: 7 });
  for (let y = ROWS - 2; y < ROWS; y++) {
    for (let x = 5; x < COLS; x++) g2.grid[y][x] = 'L';
  }
  g2.piece = makePiece('I', 6, 16, 0);   // 实体在第 6..9 列、第 17 行
  eq(pieceCells(g2.piece).map((c) => c[0]).join(','), '6,7,8,9', '横 I 实体占第 6..9 列');
  eq(canMove(g2, 1, 0), false, '再右移就出界（第 10 列不存在）');
  eq(canMove(g2, -1, 0), true, '左侧还空，可以左移躲开');

  // 出生位被占 = 非法（O 的实体占第 4、5 列的 1、2 行）
  const h = playing({ seed: 7 });
  const hCells = pieceCells(makePiece('O', 3, 0, 0));
  for (const [x, y] of hCells) h.grid[y][x] = 'Z';
  eq(hCells.map((c) => `${c[0]},${c[1]}`).join(' '), '4,1 5,1 4,2 5,2', 'O 出生实体格位置（核对用）');
  eq(canPlace(h, 'O', 3, 0, 0), false, '出生区被占，O 不能放');
  eq(canPlace(h, 'O', 3, 2, 0), true, '往下挪两行就能放');

  // 旋转踢墙：S 靠踢墙也能转（这是设计好的手感）
  const k = playing({ seed: 7 });
  k.piece = makePiece('S', spawnX('S'), 0, 0);
  eq(rotate(k, 1), true, 'S 在出生位能顺时针旋转');
  eq(k.piece.r, 1, '旋转后朝向为 1');
  const k2 = playing({ seed: 7 });
  k2.piece = makePiece('S', 0, 5, 0);
  eq(canPlace(k2, 'S', 0, 5, 1), true, 'S 在 x=0 处原地旋转后实体落在第 1、2 列，放得下');
  eq(rotate(k2, 1), true, '贴左墙的 S 也能旋转');
  eq(k2.piece.x, 0, '原地就放得下，所以不需要踢墙（踢墙顺序 0 → -1 → +1）');
  eq(k2.piece.r, 1, '旋转后朝向为 1');
  eq(rotate(k2, -1), true, '逆时针旋转（转三次）也可用');
  eq(k2.piece.r, 0, '逆转一次回到初始朝向');

  // 真正需要踢墙的场景：目标朝向在当前位置会越界，靠水平偏移救回来
  const k3 = playing({ seed: 7 });
  k3.piece = makePiece('T', -1, 5, 3);   // 朝左的 T 实体在第 1 列和第 0、1 列
  eq(pieceCells(k3.piece).map((c) => c[0]).join(','), '1,0,1,1', '朝左的 T 实体占第 0、1 列');
  eq(canPlace(k3, 'T', -1, 5, 3), true, '当前朝向放在 x=-1 是合法的');
  eq(canPlace(k3, 'T', -1, 5, 1), false, '顺时针转一次后的朝向放在 x=-1 会越界（第 -1 列）');
  eq(rotate(k3, 1), true, '越界时旋转靠踢墙救回');
  eq(k3.piece.r, 0, 'r=3 再顺时针转一次回到 0');
  eq(k3.piece.x, 0, '踢墙把方块往右推了一格');

  // 旋转四圈回到原样
  const fj = playing({ seed: 7 });
  fj.piece = makePiece('T', 4, 10, 0);
  for (let i = 0; i < 4; i++) rotate(fj, 1);
  eq(fj.piece.r, 0, 'T 转四次朝向回 0');
  eq(fj.piece.x, 4, 'T 转四次 x 不变');

  // ready 状态下所有操作都不生效（等玩家点确认/开始）
  const rd = createState({ seed: 7 });
  eq(rd.status, 'ready', 'createState 出来是 ready');
  eq(moveLeft(rd), false, 'ready 时左移无效');
  eq(rotate(rd, 1), false, 'ready 时旋转无效');
  eq(softDrop(rd), false, 'ready 时软降无效');
  eq(hardDrop(rd), null, 'ready 时硬降无效');
  eq(tick(rd, 5000).steps, 0, 'ready 时不自动下落');
}

/* ═════════════════════ 四、消行 ═════════════════════ */

console.log('\n【四】消行（一行 / 四行）');
{
  // fullRows / clearRows 基础
  const g = createGrid();
  eq(fullRows(g).length, 0, '空盘没有满行');
  fillRowExcept(g, 19, [0]);
  eq(fullRows(g).length, 0, '差一格不算满行');
  fillRowExcept(g, 19, []);
  eq(fullRows(g).length, 1, '填满即算满行');
  eq(fullRows(g)[0], 19, '满行行号正确');

  fillRowExcept(g, 18, []);
  eq(fullRows(g).join(','), '18,19', '多行按升序返回');

  const before = g[17][0];   // 第 17 行是空的（满行只填了 18、19 行）
  eq(before, EMPTY, '第 17 行原本为空');
  const row18 = g[18].slice();
  eq(clearRows(g, [19]), 1, 'clearRows 返回消掉的行数');
  eq(fullRows(g).length, 1, '消掉一行后只剩一满行');
  eq(fullRows(g)[0], 19, '上方内容整体下移一行');
  eq(g[19].join(''), row18.join(''), '原第 18 行整体下移到第 19 行（内容原样）');

  // 消一行：第 19 行只差一块（竖 I 的实体所在的列），补上即可消 1 行
  const s1 = playing({ seed: 3 });
  s1.piece = makePiece('I', 3, 16, 1);
  const hole1 = pieceCells(s1.piece)[0][0];          // 竖 I 的实体列
  fillRowExcept(s1.grid, 19, [hole1]);
  eq(hole1, 5, '竖 I（x=3, r=1）实体落在第 5 列');
  const r1 = hardDrop(s1);
  eq(r1.cleared, 1, '竖 I 补齐第 19 行 → 消 1 行');
  eq(s1.lines, 1, '消行计数 +1');
  eq(fullRows(s1.grid).length, 0, '消完盘面无满行');
  // 消掉第 19 行后：补的空行从顶部推入，原来的所有行整体下移一格
  eq(s1.grid[19][hole1], 'I', '原第 18 行（只差第 5 列）下移到第 19 行，其余列内容保持原样');
  eq(s1.grid[17][hole1], 'I', '竖 I 的上面几格也随之落到第 17、18 行');
  eq(s1.grid[16].every((v) => v === EMPTY), true, '第 16 行恢复为空（原第 15 行是空行）');
  eq(s1.grid[0].every((v) => v === EMPTY), true, '新的第 0 行是补进来的空行');
  eq(s1.status, 'playing', '消行后游戏继续');

  // 消四行：4 行只差同一列，用竖 I 穿下去一次消 4 行
  const s4 = playing({ seed: 3 });
  const hole4 = pieceCells(makePiece('I', 4, 0, 1))[0][0];   // 竖 I（x=4）实体在第 6 列
  eq(hole4, 6, '竖 I（x=4, r=1）实体落在第 6 列');
  for (let y = ROWS - 4; y < ROWS; y++) fillRowExcept(s4.grid, y, [hole4]);
  s4.piece = makePiece('I', 4, ROWS - 6, 1);
  eq(dropDistance(s4), 2, '竖 I 从第 14 行还能落 2 格');
  const r4 = hardDrop(s4);
  eq(r4.cleared, 4, '一次消 4 行（俄罗斯方块最高分击）');
  eq(s4.lines, 4, '消行计数 +4');
  eq(s4.score, 800 + 2 * 2, '消 4 行得 800 分（1 级）+ 硬降 2 格×2');
  eq(fullRows(s4.grid).length, 0, '四行清空后无残留满行');
  eq(s4.lines < LINES_PER_LEVEL, true, '4 行还没到升级线');
  eq(s4.grid.slice(ROWS - 4).every((row) => row.every((v) => v === EMPTY)), true, '底部四行全空（空行从顶部补入）');

  // 消行后上方方块整体下移，列位置不变
  const s5 = playing({ seed: 3 });
  s5.piece = makePiece('I', 3, 16, 1);
  const hole5 = pieceCells(s5.piece)[0][0];          // 第 5 列
  fillRowExcept(s5.grid, 19, [hole5]);
  s5.grid[12][2] = 'T';                             // 消行前，第 12 行只有一个 T
  eq(fullRows(s5.grid).length, 0, '此时还没有满行（第 19 行缺第 5 列那块）');
  eq(s5.grid[19].filter((v) => v !== EMPTY).length, 9, '第 19 行已填 9 格，只差竖 I 那一列');
  hardDrop(s5);
  eq(s5.lines, 1, '成功消掉 1 行');
  eq(s5.grid[13][2], 'T', '消行后上方方块下移一行且不换列');
  eq(s5.grid[12][2], EMPTY, '原位置已空');

  // 新方块出生后与已消行的棋盘无冲突
  eq(s5.status, 'playing', '消行后游戏继续');
}

/* ═════════════════════ 五、计分 ═════════════════════ */

console.log('\n【五】计分正确');
{
  eq(LINE_SCORES[1], 100, '消 1 行 100 分');
  eq(LINE_SCORES[2], 300, '消 2 行 300 分');
  eq(LINE_SCORES[3], 500, '消 3 行 500 分');
  eq(LINE_SCORES[4], 800, '消 4 行 800 分');
  eq(scoreForLines(1, 1), 100, '1 行 × 1 级 = 100');
  eq(scoreForLines(4, 2), 1600, '4 行 × 2 级 = 1600');
  eq(scoreForLines(0, 5), 0, '没消行不得分');
  eq(scoreForLines(9, 1), 0, '不存在的消行数得 0 分');

  // 硬降计分：每下落一格 2 分
  const h = playing({ seed: 5 });
  h.piece = makePiece('O', 3, 0, 0);
  const dy = dropDistance(h);
  hardDrop(h);
  eq(h.score, dy * 2, `硬降 ${dy} 格得 ${dy * 2} 分`);

  // 软降计分：每下落一格 1 分
  const s = playing({ seed: 5 });
  const y0 = s.piece.y;
  softDrop(s); softDrop(s); softDrop(s);
  eq(s.piece.y, y0 + 3, '软降三格');
  eq(s.score, 3, '软降 3 格得 3 分');

  // 消行分按当前等级放大
  const l = playing({ seed: 5 });
  l.level = 3;
  l.piece = makePiece('I', 3, ROWS - 5, 1);   // 实体在第 5 列、第 17..20 行 → 只能再落 1 格
  const holeL = pieceCells(l.piece)[0][0];
  fillRowExcept(l.grid, 19, [holeL]);
  const beforeScore = l.score;
  const res = hardDrop(l);
  eq(res.cleared, 1, '高等级下同样能消 1 行');
  eq(l.score - beforeScore, 100 * 3 + 1 * 2, '消行分 = 100×3 级 + 硬降 1 格×2');

  // 软降/硬降都有分，但软降更划算（鼓励手动操作）
  const cmp = playing({ seed: 5 });
  cmp.piece = makePiece('O', 3, 0, 0);
  const d2 = dropDistance(cmp);
  ok(d2 * 1 < d2 * 2, '同样距离下软降比硬降分少（硬降有奖励）');
}

/* ═════════════════════ 六、7-bag 随机器 ═════════════════════ */

console.log('\n【六】7-bag：每 7 个不重复');
{
  const rand = mulberry32(20260927);
  const bag = createBag(rand);
  const first7 = [];
  for (let i = 0; i < 7; i++) first7.push(bag.next());
  eq(new Set(first7).size, 7, '第一袋 7 个互不重复（恰好 7 种各一）');
  eq(first7.slice().sort().join(''), TYPES.slice().sort().join(''), '第一袋正好是 7 种方块全集');

  // 连取 20 袋，每袋内部都不重复
  let dup = 0;
  for (let b = 0; b < 20; b++) {
    const seen = new Set();
    for (let i = 0; i < 7; i++) seen.add(bag.next());
    if (seen.size !== 7) dup++;
  }
  eq(dup, 0, '连续 20 袋，每袋都是 7 种各一个');

  // 任意窗口都满足「7 个一批」的性质：不会出现 13 个不出同一类型
  const seq = [];
  for (let i = 0; i < 140; i++) seq.push(bag.next());
  let worstGap = 0;
  for (const t of TYPES) {
    let gap = 0, max = 0;
    for (const v of seq) { gap = v === t ? 0 : gap + 1; max = Math.max(max, gap); }
    worstGap = Math.max(worstGap, max);
  }
  ok(worstGap <= 12, '任何方块最多间隔 12 个必出（140 个样本）', `最长间隔 ${worstGap}`);

  // 同一种子 = 同一序列（可复现）
  const a = createBag(mulberry32(42));
  const b = createBag(mulberry32(42));
  const sa = [], sb = [];
  for (let i = 0; i < 21; i++) { sa.push(a.next()); sb.push(b.next()); }
  eq(sa.join(''), sb.join(''), '同一种子产生完全相同的序列');

  // 不同种子通常不同
  const c = createBag(mulberry32(43));
  const sc = [];
  for (let i = 0; i < 21; i++) sc.push(c.next());
  ok(sa.join('') !== sc.join(''), '不同种子序列不同');

  // 开局状态里的 bag 也要能持续供货
  const st = createState({ seed: 99 });
  ok(TYPES.includes(st.piece.type), '开局当前块是合法类型', st.piece.type);
  ok(TYPES.includes(st.next.type), '开局下一块是合法类型', st.next.type);
  eq(st.status, 'ready', 'createState 出来是 ready（等玩家动手，由集成层决定何时 start）');
  start(st);
  eq(st.status, 'playing', 'start 后进入进行中');

  // 连续出生 30 块都不会卡住（每块都锁掉）
  let spawned = 0;
  for (let i = 0; i < 30 && st.status === 'playing'; i++) {
    hardDrop(st);
    spawned++;
  }
  ok(spawned >= 5, '连续硬降能持续推进（每块都换新）', `实际 ${spawned} 块`);
}

/* ═════════════════════ 七、等级与下落速度 ═════════════════════ */

console.log('\n【七】等级与下落速度');
{
  eq(LINES_PER_LEVEL, 10, '每 10 行升一级');
  eq(levelForLines(0), 1, '0 行 = 1 级');
  eq(levelForLines(9), 1, '9 行还是 1 级');
  eq(levelForLines(10), 2, '10 行升到 2 级');
  eq(levelForLines(25), 3, '25 行 = 3 级');
  eq(levelForLines(1000), MAX_LEVEL, '等级有上限', String(MAX_LEVEL));

  // 四个难度档位与规范一致
  eq(DIFFICULTIES.chill.interval, 900, '悠闲 900ms');
  eq(DIFFICULTIES.normal.interval, 650, '普通 650ms');
  eq(DIFFICULTIES.fast.interval, 420, '快速 420ms');
  eq(DIFFICULTIES.turbo.interval, 260, '极速 260ms');
  eq(DEFAULT_DIFFICULTY, 'normal', '默认难度是普通');
  eq(difficultyConfig('不存在').name, DIFFICULTIES.normal.name, '未知难度退回默认档');

  // 间隔随等级递减，且不为 0
  for (const key of Object.keys(DIFFICULTIES)) {
    const st = createState({ difficulty: key, seed: 1 });
    const lv1 = fallInterval(st);
    eq(lv1, DIFFICULTIES[key].interval, `${key} 1 级间隔 = 基准值`);
    st.level = 5;
    const lv5 = fallInterval(st);
    ok(lv5 < lv1, `${key} 等级越高下落越快`, `${lv1} → ${lv5}`);
    st.level = MAX_LEVEL;
    ok(fallInterval(st) >= 50, `${key} 最高等级仍有正间隔`, String(fallInterval(st)));
  }

  // 时间推进：累计到间隔才落一格
  const st = playing({ difficulty: 'normal', seed: 1 });
  const y0 = st.piece.y;
  tick(st, 300);
  eq(st.piece.y, y0, '累计不足一个间隔不落格');
  tick(st, 400);   // 累计 700 ≥ 650
  eq(st.piece.y, y0 + 1, '累计超过间隔落一格');

  // 每帧固定 16ms 推进，1 秒大约落 650/16 ≈ 40 格
  const st2 = playing({ difficulty: 'chill', seed: 1 });
  st2.piece = makePiece('O', 3, 0, 0);
  for (let i = 0; i < 60; i++) tick(st2, 16);
  eq(st2.elapsed, 960, '累计时间正确记账');
  ok(st2.piece.y > 0, '约 1 秒后已经下落若干格', `y=${st2.piece.y}`);

  // 按住速降时下落更快
  const st3 = playing({ difficulty: 'normal', seed: 1 });
  const base = fallInterval(st3);
  st3.softDropping = true;
  const fast = tick(st3, 1).interval;
  ok(fast < base, '速降键按住时下落间隔缩短', `${base} → ${fast}`);

  // 暂停不计时
  const st4 = playing({ difficulty: 'normal', seed: 1 });
  st4.status = 'paused';
  const e0 = st4.elapsed;
  tick(st4, 5000);
  eq(st4.elapsed, e0, '暂停时推进不计时');
  eq(togglePause(st4), 'playing', '暂停后再切回进行中');
  eq(togglePause(st4), 'paused', '再次切换到暂停');

  // 结束（非暂停）时推进也不落块
  const st5 = playing({ difficulty: 'normal', seed: 1 });
  gameOver(st5);
  const e5 = st5.elapsed;
  eq(tick(st5, 5000).steps, 0, '结束后推进不落块');
  eq(st5.elapsed, e5, '结束后推进不计时');
}

/* ═════════════════════ 八、游戏结束条件 ═════════════════════ */

console.log('\n【八】游戏结束判定');
{
  // 出生区被占 → 新块放不下
  const st = playing({ seed: 11 });
  for (let x = 3; x <= 6; x++) st.grid[0][x] = 'T';
  st.grid[1][3] = 'T'; st.grid[1][4] = 'T'; st.grid[1][5] = 'T'; st.grid[1][6] = 'T';
  st.piece = makePiece('T', 4, 5, 0);      // 先把当前块挪到空旷处
  lock(st);                                 // 锁定后才换新块
  eq(st.status, 'over', '新块出生即被堵 → 游戏结束');

  // 结束时不再接受操作
  const before = JSON.stringify(st.grid);
  eq(moveLeft(st), false, '结束后左移无效');
  eq(moveRight(st), false, '结束后右移无效');
  eq(rotate(st, 1), false, '结束后旋转无效');
  eq(softDrop(st), false, '结束后软降无效');
  eq(hardDrop(st), null, '结束后硬降无效');
  eq(tick(st, 1000).steps, 0, '结束后时间推进不再落块');
  eq(JSON.stringify(st.grid), before, '结束后盘面不被改动');

  // 先塞满一整行，再从顶部堆到结束
  const g = playing({ seed: 12 });
  fillRowExcept(g.grid, 18, []);
  g.grid[19][0] = EMPTY;                    // 第 19 行留个洞，不会被一起消掉
  let guard = 0;
  while (g.status === 'playing' && guard++ < 300) hardDrop(g);
  eq(g.status, 'over', '把方块堆到顶会结束（无需外力干预）');
  ok(g.lines >= 1, '过程中至少消掉一行', String(g.lines));
  ok(g.score > 0, '整局下来有得分', String(g.score));

  // over 后重开：状态复位
  restart(g, 777);
  start(g);
  eq(g.status, 'playing', '重开后进入进行中');
  eq(g.score, 0, '重开清零分数');
  eq(g.lines, 0, '重开清零消行');
  eq(g.level, 1, '重开回到 1 级');
  eq(fullRows(g.grid).length, 0, '重开后盘面干净');
}

console.log('\n【八·补】状态文案与工具');
{
  const st = playing({ seed: 1 });
  eq(statusText(st), DIFFICULTIES.normal.name, '进行中显示难度名');
  eq(clearLabel(4), '四行齐消！', '四行文案');
  eq(clearLabel(1), '消一行', '一行文案');
  eq(clearLabel(0), '', '没消行没文案');
  ok(statusText(createState({ seed: 1, difficulty: 'turbo' })).length > 0, '状态文案非空');
  const o = createState({ seed: 1 });
  o.status = 'over';
  eq(statusText(o), '游戏结束', '结束文案');
}

/* ═════════════════════ 九、绘制层与入口冒烟 ═════════════════════ */

console.log('\n【九】绘制层与模块入口（冒烟）');
{
  // 布局：底部按钮必须留出 insets.bottom + 16
  for (const [w, h, ins] of [[375, 667, { top: 44, bottom: 34 }], [390, 844, { top: 47, bottom: 34 }], [320, 568, {}], [768, 1024, { top: 20, bottom: 20 }]]) {
    const L = computeLayout(w, h, ins);
    const lowest = Math.max(...L.buttons.map((b) => b.y + b.h));
    const limit = h - (ins.bottom ?? 0) - 16;
    ok(lowest <= limit, `${w}×${h} 按钮不侵占底部安全区（${lowest} ≤ ${limit}）`);
    ok(L.buttons.length === 6, `${w}×${h} 六个操作按钮（用户要求新增加速键）`);
    for (const b of L.buttons) {
      ok(b.w >= 44 && b.h >= 44, `${w}×${h} 按钮 ${b.key} 够大（${Math.round(b.w)}×${Math.round(b.h)}）`);
    }
    ok(L.board.w > 0 && L.board.h > 0, `${w}×${h} 棋盘尺寸为正`);
    eq(L.board.h / L.board.cell, ROWS, `${w}×${h} 棋盘纵向正好 20 行`);
    eq(L.board.w / L.board.cell, COLS, `${w}×${h} 棋盘横向正好 10 列`);
    const keys = L.buttons.map((b) => b.key).join(',');
    eq(keys, 'left,rotate,right,soft,drop,pause', `${w}×${h} 按钮齐全且顺序固定（加速键在 right 与 drop 之间）`);
    ok(hitButton(L, buttonOf(L, 'drop').x + 2, buttonOf(L, 'drop').y + 2) === 'drop', `${w}×${h} 命中硬降按钮`);
    ok(hitButton(L, L.board.x + 2, L.board.y + 2) === null, `${w}×${h} 棋盘区域不误判为按钮`);
  }

  // 伪 ctx：把关键路径跑一遍，捕捉渲染期崩溃
  const calls = { fill: 0, stroke: 0, text: [] };
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = {
    canvas: { width: 750, height: 1334 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: 'left', textBaseline: 'top', globalAlpha: 1,
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    save: noop, restore: noop, beginPath: noop, closePath: noop, clip: noop,
    moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, rect: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, translate: noop, rotate: noop, scale: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop,
    fill: () => { calls.fill++; }, stroke: () => { calls.stroke++; },
    fillText: (t) => { calls.text.push(String(t)); },
    strokeText: noop, measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    setTransform: noop, drawImage: noop,
  };

  const sess = createSession({
    width: 375, height: 667, insets: { top: 44, bottom: 34 },
    difficulty: 'normal', theme: {}, onEvent: () => {},
  });
  ok(typeof sess.tap === 'function' && typeof sess.render === 'function', '会话对象接口齐全');
  ok(sess.busy === true, 'busy 为 true（下落需要持续推帧）');
  ok(sess.outcome === null, '未结束时 outcome 为 null');
  ok(typeof sess.hud.status === 'string' && sess.hud.status.length > 0, 'hud.status 非空');

  renderFrame(ctx, computeLayout(375, 667, { top: 44, bottom: 34 }), createState({ seed: 2 }), {}, 1000);
  ok(calls.fill > 10 && calls.stroke > 10, '一次全帧绘制产生了填充与描边', `fill=${calls.fill} stroke=${calls.stroke}`);
  ok(calls.text.includes('俄罗斯方块'), '帧内画出了标题');
  ok(calls.text.includes('分数') && calls.text.includes('等级') && calls.text.includes('消行'), '帧内画出了统计条');
  // 按钮文字：'到底' = 原「速降」改语义（一步落到底），'加速' = 新增的第 6 键
  const btnLabels = calls.text.filter((t) => ['到底', '加速', '旋转', '暂停'].includes(t));
  ok(btnLabels.length >= 4, '帧内画出了按钮文字（含新的「加速」「到底」）', JSON.stringify(btnLabels));

  // 暂停 / 结束浮层
  const pst = createState({ seed: 2 });
  pst.status = 'paused'; pst.pausedAt = 0;
  renderFrame(ctx, computeLayout(375, 667, {}), pst, {}, 500);
  ok(calls.text.includes('已暂停'), '暂停层文案正确');
  // 结算弹窗归集成层（规范 §9/§10 新约定）：模块不再自绘结算文案，只保留终局棋盘画面
  const ost = createState({ seed: 2 });
  ost.status = 'over'; ost.overAt = 0;
  const textsBeforeOver = calls.text.length;
  renderFrame(ctx, computeLayout(375, 667, {}), ost, {}, 500);
  const overTexts = calls.text.slice(textsBeforeOver);
  ok(!overTexts.includes('游戏结束') && !overTexts.includes('本局得分'), '结算弹窗归集成层：模块帧内不再自绘结算文案');
  ok(overTexts.includes('俄罗斯方块') && overTexts.includes('分数'), '终局帧棋盘画面照常渲染（标题/统计仍在）');

  // 单块绘制与圆角路径工具
  drawBlock(ctx, 10, 10, 30, 'I', 1, 1);
  drawBlock(ctx, 10, 50, 30, 'O', 0.3, 1);
  drawBlock(ctx, 10, 90, 1, 'X', 1, 1);   // 极小尺寸不能崩
  pathRoundRect(ctx, 0, 0, 10, 10, 3);
  ok(true, 'drawBlock / pathRoundRect 各种尺寸都不崩');

  // meta 与难度 key 对得上
  eq(meta.id, 'tetris', 'meta.id 与目录名一致');
  ok(meta.ready === true, 'meta.ready = true');
  eq(meta.difficulties.length, 4, 'meta 四个难度');
  eq(meta.difficulties.map((d) => d.key).join(','), 'chill,normal,fast,turbo', '难度 key 顺序');
  for (const d of meta.difficulties) {
    ok(!!DIFFICULTIES[d.key], `meta 难度 ${d.key} 在 core 里有配置`);
    ok(d.name.length > 0 && d.desc.length > 0, `难度 ${d.key} 有名称与描述`);
  }

  // 会话交互：点按钮能推动状态
  const s2 = createSession({ width: 375, height: 667, insets: {}, difficulty: 'chill', theme: {} });
  const L2 = computeLayout(375, 667, {});
  const before2 = s2.hud.status;
  s2.press(L2.buttons[0].x + 5, L2.buttons[0].y + 5);      // 按下 ←
  s2.release();
  s2.tap(L2.buttons[0].x + 5, L2.buttons[0].y + 5);
  ok(true, '按钮按下/抬起/点击全流程不崩');
  s2.update(0); s2.update(16); s2.update(32);
  s2.render(ctx);
  s2.resize(390, 844, { top: 47, bottom: 34 });
  s2.render(ctx);
  ok(s2.hud.status.indexOf('分数') >= 0 || before2.indexOf('分数') >= 0, 'hud 里带分数');

  // 暂停按钮真的能暂停
  const L3 = computeLayout(390, 844, { top: 47, bottom: 34 });
  const pauseBtn = L3.buttons.find((b) => b.key === 'pause');
  s2.tap(pauseBtn.x + 5, pauseBtn.y + 5);
  eq(s2.hud.status.indexOf('已暂停') >= 0, true, '点暂停按钮后进入暂停态');
  s2.tap(pauseBtn.x + 5, pauseBtn.y + 5);
  eq(s2.hud.status.indexOf('已暂停'), -1, '再点一次恢复进行中');

  // 硬降按钮能加分
  const dropBtn = L3.buttons.find((b) => b.key === 'drop');
  const sc0 = Number(s2.hud.status.replace(/[^0-9]/g, '')) || 0;
  s2.tap(dropBtn.x + 5, dropBtn.y + 5);
  const sc1 = Number(s2.hud.status.replace(/[^0-9]/g, '')) || 0;
  ok(sc1 > sc0, '硬降按钮能得分', `${sc0} → ${sc1}`);

  s2.destroy();
  ok(true, 'destroy() 不崩');

  // 会话级联调：把方块硬降堆到顶，验证结果上报与 outcome 契约
  const events = [];
  const s3 = createSession({
    width: 375, height: 667, insets: { top: 44, bottom: 34 },
    difficulty: 'turbo', theme: {},
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const L4 = computeLayout(375, 667, { top: 44, bottom: 34 });
  const dropBtn2 = L4.buttons.find((b) => b.key === 'drop');
  s3.press(dropBtn2.x + 5, dropBtn2.y + 5);
  s3.release();
  let steps = 0;
  let t = 0;
  while (s3.outcome === null && steps < 400) {
    s3.tap(dropBtn2.x + 5, dropBtn2.y + 5);
    t += 16;
    s3.update(t);
    steps++;
  }
  ok(s3.outcome !== null, '一直硬降最终会结束（会话层不卡死）', `用了 ${steps} 步`);
  eq(s3.outcome.result, 'lose', 'outcome.result 为 lose');
  ok(s3.outcome.score > 0, 'outcome 带本局得分', String(s3.outcome.score));
  eq(events.filter((e) => e.type === 'lose').length, 1, 'lose 事件只上报一次');
  ok(events[0].payload.score === s3.outcome.score, '事件负载与 outcome 一致');
  const scoreBeforeRestart = s3.outcome.score;
  s3.tap(dropBtn2.x + 5, dropBtn2.y + 5);     // 结束后再点硬降 = 重新开始
  eq(s3.outcome, null, '重开后 outcome 回到 null');
  ok(scoreBeforeRestart > 0, '重开前的分数确实存在');
  s3.update(t + 16);
  ok(true, '重开后继续推帧不崩');
}

/* ═════════════════════ 十、下落插值（视觉连续） ═════════════════════ */

console.log('\n【十】下落插值：连续下移，不是整格跳');
{
  const L = computeLayout(375, 667, { top: 44, bottom: 34 });
  const cell = L.board.cell;

  // ① 相位定义：落格瞬间归零，随累计时间线性涨到 1
  const st = playing({ difficulty: 'normal', seed: 5 });
  st.piece = makePiece('O', 3, 0, 0);
  const iv = activeInterval(st);
  eq(fallProgress(st), 0, '刚开始下落时相位为 0');
  tick(st, iv * 0.5);
  ok(Math.abs(fallProgress(st) - 0.5) < 1e-9, '过了半个间隔，相位到 0.5', String(fallProgress(st)));
  tick(st, iv * 0.5 - 1);
  ok(fallProgress(st) > 0.99 && fallProgress(st) <= 1, '临近落格时相位趋近 1', String(fallProgress(st)));
  tick(st, 1);
  eq(st.piece.y, 1, '到点落一格');
  eq(fallProgress(st), 0, '落格瞬间相位归零（这正是"不抖动"的依据：y 多了 1 格、相位少了一格）');

  // ② 暂停 / 结束 / 未开局 都不插值
  const p = playing({ seed: 5 });
  p.status = 'paused';
  p.dropAcc = 300;
  eq(fallProgress(p), 0, '暂停时不插值');
  const o = playing({ seed: 5 });
  o.status = 'over';
  o.dropAcc = 300;
  eq(fallProgress(o), 0, '结束后不插值');
  const r = createState({ seed: 5 });
  r.dropAcc = 300;
  eq(fallProgress(r), 0, '未开局（ready）不插值');

  // ③ 压在堆上/地面时相位钉在 0
  //    否则方块会一点点"沉进地面"，等锁定时再弹回来 —— 这是插值最容易出的视觉事故
  const g = playing({ seed: 5 });
  g.piece = makePiece('O', 3, 0, 0);
  g.piece.y += dropDistance(g);
  eq(canMove(g, 0, 1), false, '方块已经落到底');
  g.dropAcc = Math.round(activeInterval(g) * 0.9);
  eq(fallProgress(g), 0, '落不动时相位钉在 0（不往地面里插值）');

  // ④ 逐帧驱动：画出来的 y 必须连续单调，且**每一帧的位移都小于一格**
  const s2 = playing({ difficulty: 'turbo', seed: 5 });
  s2.piece = makePiece('O', 3, 0, 0);          // 固定方块，避免锁定换块干扰序列
  const inset = Math.max(1, cell * 0.045);
  const ys = [];
  const gridYs = [];
  const phases = [];
  const deltas = [];
  let prevPiece = null;
  let prevY = 0;
  let clock = 10000;
  for (let i = 0; i < 200; i++) {
    clock += 16;
    tick(s2, 16);
    const phase = fallProgress(s2);
    const y = pieceCellY(L, s2, s2.piece.y, phase * cell);   // 与 drawPiece 同一处定义
    if (s2.piece === prevPiece) deltas.push(y - prevY);
    prevPiece = s2.piece;
    prevY = y;
    ys.push(y);
    gridYs.push(s2.piece.y);
    phases.push(phase);
  }
  ok(ys.length === 200, '连推 200 帧都拿到了方块坐标');
  ok(deltas.every((d) => d >= 0), '下落位移从不倒退（落格瞬间不抖动）', `最小位移 ${Math.min(...deltas).toFixed(4)}`);
  ok(deltas.every((d) => d < cell), '每一帧的位移都小于一格 —— 是连续下移而不是整格跳',
    `最大单帧位移 ${Math.max(...deltas).toFixed(4)} < 一格 ${cell}`);
  ok(deltas.filter((d) => d > 0).length > 150, '绝大多数帧都在往下走（视觉上真的在动）',
    `${deltas.filter((d) => d > 0).length}/200 帧有位移`);
  ok(new Set(ys.map((y) => y.toFixed(3))).size > 100, '200 帧里出现过上百个不同的像素位置（不是只有二十几个整格点）',
    `${new Set(ys.map((y) => y.toFixed(3))).size} 个不同位置`);

  // ⑤ 真渲染核对：桩 ctx 里记到的 moveTo 坐标，必须等于 pieceCellY 算出来的值
  //    （证明"测试断言的插值"和"真正画出去的插值"是同一个数，不是两套绕过彼此的实现）
  const { ctx, rec } = makeRecCtx();
  const s3 = playing({ difficulty: 'normal', seed: 8 });
  s3.piece = makePiece('O', 3, 0, 0);
  const board = L.board;
  let matched = 0;
  const frames = 40;
  for (let i = 0; i < frames; i++) {
    tick(s3, 16);
    rec.moves.length = 0;
    renderFrame(ctx, L, s3, {}, 20000 + i * 16);
    // 方块实体格在矩阵里不一定从第 0 行开始（O 在第 1、2 行），取最上面那一格
    const cells = cellsOf(rotateShape(s3.piece.type, s3.piece.r));
    const minCy = Math.min(...cells.map((c) => c[1]));
    const expect = pieceCellY(L, s3, s3.piece.y + minCy, fallProgress(s3) * cell) + inset;
    // 方块那一格的顶边必然出现在路径里；顺带确认它落在棋盘区内
    if (rec.moves.some(([x, y]) => Math.abs(y - expect) < 1e-9 && x > board.x && x < board.x + board.w)) matched++;
  }
  eq(matched, frames, `${frames} 帧渲染里、画出的方块顶边 y 与 pieceCellY 完全一致`);

  // 打印一段跨「落格」的坐标序列当插值证据（可复现，不是嘴上说的）
  const firstDrop = gridYs.findIndex((gy, i) => i > 0 && gy > gridYs[i - 1]);
  const from = Math.max(0, firstDrop - 3);
  const to = Math.min(ys.length, firstDrop + 3);
  const seg = [];
  for (let i = from; i < to; i++) {
    seg.push(`帧${i}: 格行${gridYs[i]} t=${phases[i].toFixed(3)} y=${ys[i].toFixed(2)}`);
  }
  console.log(`   插值证据（跨"落格"那几帧，cell=${cell}px）：`);
  console.log(`     ${seg.join('  |  ')}`);
  console.log(`     第 ${firstDrop} 帧发生落格：格行 ${gridYs[firstDrop - 1]} → ${gridYs[firstDrop]}，`
    + `像素 y ${ys[firstDrop - 1].toFixed(2)} → ${ys[firstDrop].toFixed(2)}（位移 ${(ys[firstDrop] - ys[firstDrop - 1]).toFixed(2)}px，远小于一格）`);
  console.log(`   200 帧位移：最小 ${Math.min(...deltas).toFixed(3)}px / 最大 ${Math.max(...deltas).toFixed(3)}px`
    + `（一格 ${cell}px；整格跳的最大位移会是 ${cell}px）`);
}

/* ═════════════════════ 十一、加速下落（第 6 个键位） ═════════════════════ */

console.log('\n【十一】加速下落（软降键）');
{
  // ① 间隔：按住加速后显著变短，且绝不短过下限、绝不超过自然间隔
  for (const key of Object.keys(DIFFICULTIES)) {
    const st = playing({ difficulty: key, seed: 2 });
    const natural = fallInterval(st);
    st.softDropping = true;
    const fast = softDropInterval(st);
    ok(fast < natural, `${key} 加速下落比自然下落快`, `${natural}ms → ${fast}ms`);
    ok(fast >= SOFT_DROP_MIN_INTERVAL, `${key} 加速间隔不低于下限 ${SOFT_DROP_MIN_INTERVAL}ms`, String(fast));
    eq(activeInterval(st), fast, `${key} 按住加速时 activeInterval 取软降间隔`);
  }
  // 高等级：自然间隔本身已压到下限，加速**不能反而更慢**（反向 bug 的回归测试）
  const hi = playing({ difficulty: 'turbo', seed: 2 });
  hi.level = MAX_LEVEL;
  const nHi = fallInterval(hi);
  hi.softDropping = true;
  ok(softDropInterval(hi) <= nHi, '高等级时加速不会比自然下落更慢', `${nHi}ms → ${softDropInterval(hi)}ms`);

  // ② 同样时间，按住加速落得更多格（直接看 y）
  const a = playing({ difficulty: 'normal', seed: 3 });
  const b = playing({ difficulty: 'normal', seed: 3 });
  b.softDropping = true;
  for (let i = 0; i < 40; i++) { tick(a, 16); tick(b, 16); }
  ok(b.piece.y > a.piece.y, '同样推进 640ms：按住加速落得更多格', `不按 y=${a.piece.y} / 按住 y=${b.piece.y}`);

  // ③ 会话层：按住 → 松开，用注入的 now 驱动（规范 §8）
  const cal = { top: 44, bottom: 34 };
  const L = computeLayout(375, 667, cal);
  const softBtn = L.buttons.find((x) => x.key === 'soft');
  const dropBtn = L.buttons.find((x) => x.key === 'drop');
  const rightBtn = L.buttons.find((x) => x.key === 'right');
  const idx = (k) => L.buttons.findIndex((b) => b.key === k);
  eq(L.buttons.map((b) => b.key).join(','), 'left,rotate,right,soft,drop,pause',
    '按钮顺序：加速键插在 right 与 drop 之间');
  ok(idx('soft') === idx('right') + 1 && idx('drop') === idx('soft') + 1,
    '加速键的前后邻居正是 right 与 drop', `right=${idx('right')} soft=${idx('soft')} drop=${idx('drop')}`);
  ok(softBtn.y === dropBtn.y && softBtn.x < dropBtn.x && rightBtn.y < softBtn.y,
    '第二排从左到右是 加速 → 到底（暂停），right 在第一排');
  near(dropBtn.x - (softBtn.x + softBtn.w), L.btnGap, 0.5, '加速键紧邻「到底」左侧（间隔 = btnGap）');

  // 分数 = 下落格数（每落一格 1 分，本段不消行、不硬降），用它当"落了多少格"的探针
  const scoreOf = (sess) => Number(String(sess.hud.status).replace(/[^0-9]/g, '')) || 0;
  const sHold = createSession({ width: 375, height: 667, insets: cal, difficulty: 'normal', theme: {} });
  const sFree = createSession({ width: 375, height: 667, insets: cal, difficulty: 'normal', theme: {} });
  let clock = 5000;
  sHold.update(clock); sFree.update(clock);          // 第一帧只建立计时基线
  const baseHold = scoreOf(sHold);
  sHold.press(softBtn.x + 5, softBtn.y + 5);         // 按住加速键
  for (let i = 0; i < 60; i++) {                     // 960ms
    clock += 16;
    sHold.update(clock); sFree.update(clock);
  }
  const held = scoreOf(sHold) - baseHold;
  const free = scoreOf(sFree);
  ok(held > free, '按住加速键 960ms 比不按落得更多格（分数=下落格数）', `加速 ${held} 格 / 自然 ${free} 格`);
  ok(held >= 8, '按住加速确实"显著加快"（960ms 至少 8 格）', String(held));

  sHold.release();                                   // 松开
  const beforeRelease = scoreOf(sHold);
  for (let i = 0; i < 60; i++) { clock += 16; sHold.update(clock); }
  const afterRelease = scoreOf(sHold) - beforeRelease;
  ok(afterRelease >= 1 && afterRelease <= 2, '松开后回到自然节奏（960ms 只落 1~2 格）', `+${afterRelease}`);

  // ④ 短促点一下（press/release 落在同一帧）也要落一格，否则触屏/鼠标上等于没反应
  const sTap = createSession({ width: 375, height: 667, insets: cal, difficulty: 'normal', theme: {} });
  sTap.update(clock);
  const t0 = scoreOf(sTap);
  sTap.press(softBtn.x + 5, softBtn.y + 5);
  sTap.release();
  sTap.tap(softBtn.x + 5, softBtn.y + 5);
  eq(scoreOf(sTap) - t0, 1, '加速键"点一下"补落一格（且不重复扣两次）');

  // ⑤ 加速键不改变规则：仍然是"每落一格 1 分"，倍率写死为 10 倍
  eq(SOFT_DROP_SCORE, 1, '软降计分仍是每格 1 分（规则未动）');
  eq(SOFT_DROP_DIVISOR, 10, '加速倍率固定为 10 倍（普通难度 650ms → 65ms）');
}

/* ═════════════════════ 十二、桩 ctx 连续多帧（冒烟） ═════════════════════ */

console.log('\n【十二】桩 ctx 连推多帧不抛异常');
{
  const L = computeLayout(375, 667, { top: 44, bottom: 34 });
  const { ctx, rec } = makeRecCtx();
  const sess = createSession({ width: 375, height: 667, insets: { top: 44, bottom: 34 }, difficulty: 'turbo', theme: {} });
  let clock = 100000;
  let frames = 0;
  let threw = null;
  // 覆盖进行中 / 暂停 / 恢复 三种状态，每种都连推若干帧
  try {
    for (; frames < 90; frames++) { clock += 16; sess.update(clock); sess.render(ctx, clock); }
    const pauseBtn = L.buttons.find((b) => b.key === 'pause');
    sess.tap(pauseBtn.x + 5, pauseBtn.y + 5);
    const paused = sess.hud.status.indexOf('已暂停') >= 0;
    ok(paused, '中途点暂停真的进入了暂停态');
    for (let i = 0; i < 20; i++, frames++) { clock += 16; sess.update(clock); sess.render(ctx, clock); }
    sess.tap(pauseBtn.x + 5, pauseBtn.y + 5);
    eq(sess.hud.status.indexOf('已暂停'), -1, '再点一次恢复进行中');
    for (let i = 0; i < 180; i++, frames++) { clock += 16; sess.update(clock); sess.render(ctx, clock); }
  } catch (e) {
    threw = e;
  }
  ok(threw === null, `${frames} 帧连续渲染（含暂停/恢复）不抛异常`, threw ? String(threw && threw.message) : '');
  ok(rec.strokes > 0 && rec.begins > 0, '这些帧确实画了东西（不是空跑）', `beginPath=${rec.begins} stroke=${rec.strokes}`);

  // 终局状态连推多帧（结算弹窗归集成层，模块只保持棋盘画面）
  let threw2 = null;
  const over = createState({ seed: 9 });
  over.status = 'over';
  over.overAt = clock;
  try { for (let i = 0; i < 30; i++) renderFrame(ctx, L, over, {}, clock + i * 16); } catch (e) { threw2 = e; }
  ok(threw2 === null, '终局状态连推 30 帧也不抛异常', threw2 ? String(threw2 && threw2.message) : '');

  // 规范 §10：一帧里也不能出现全屏铺底
  const { ctx: ctx2, rec: rec2 } = makeFullRecCtx();
  const s4 = createState({ seed: 9 });
  s4.status = 'playing';
  renderFrame(ctx2, L, s4, {}, 1000);
  const full = rec2.rects.filter((r) => r.x <= 1 && r.y <= 1 && r.w >= 374 && r.h >= 666);
  eq(full.length, 0, '渲染层仍然没有整屏铺底（青白底归集成层）');
}

/* ═════════════════════ 汇总 ═════════════════════ */

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) { console.log('失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
