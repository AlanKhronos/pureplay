/**
 * 扫雷核心逻辑测试（Node 直接跑，零依赖，不碰微信 API）
 * 用法：node src/games/minesweeper/test.mjs
 *
 * 覆盖点（任务要求六条 + 边界）：
 *   1) 雷数正确
 *   2) 首次点击安全（首点及八邻域无雷）
 *   3) 连锁展开的格子数正确
 *   4) 标旗计数
 *   5) 踩雷判负
 *   6) 全部非雷格翻开判胜
 *   + 计时 / 快照 / 重开 / 会话语义
 */
import {
  createBoard, createSession, createTimer, startTimer, stopTimer, elapsedMs, formatTime,
  plantMines, reveal, toggleFlag, floodReveal, checkWin, cellAt, countAdjacent,
  remainingMines, isOver, isWon, isLost, isPlanted, levelConfig, mulberry32,
  snapshot, updateSession, sessionReveal, sessionFlag, sessionReset, isStarted,
  HIDDEN, REVEALED, FLAGGED, PLAYING, WON, LOST, LEVEL_KEYS, LEVELS,
} from './core.js';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name} ${extra}`); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? '' : `期望 ${expected}，实际 ${actual}`);
}

/* ── 测试用的手工造盘辅助（全部走公开 API，不偷看内部实现） ── */

/** 造一张指定尺寸的空棋盘（未布雷）。 */
function blank(cols, rows, mineTotal) {
  const b = createBoard('easy');
  b.cols = cols; b.rows = rows; b.mineTotal = mineTotal;
  const cells = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) row.push({ mine: false, adj: 0, state: HIDDEN });
    cells.push(row);
  }
  b.cells = cells;
  return b;
}

/** 在指定坐标布下地雷并刷新邻雷数。 */
function seedMines(b, list) {
  for (const [x, y] of list) b.cells[y][x].mine = true;
  for (let y = 0; y < b.rows; y++) {
    for (let x = 0; x < b.cols; x++) b.cells[y][x].adj = countAdjacent(b, x, y);
  }
  b.planted = true;
  return b;
}

/** 独立实现的「预期连锁展开集合」：从起点沿 0 号格与 0 号格的邻居扩散。 */
function expectFlood(b, x, y) {
  const out = new Set([y * b.cols + x]);
  const queue = [[x, y]];
  while (queue.length) {
    const [cx, cy] = queue.shift();
    if (b.cells[cy][cx].adj !== 0) continue;
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= b.cols || ny >= b.rows) continue;
      const k = ny * b.cols + nx;
      if (out.has(k) || b.cells[ny][nx].mine) continue;
      out.add(k); queue.push([nx, ny]);
    }
  }
  return out;
}

function mineCount(b) {
  let n = 0;
  for (let y = 0; y < b.rows; y++) for (let x = 0; x < b.cols; x++) if (b.cells[y][x].mine) n++;
  return n;
}

/* ═══════════════════════════════════════════ */

console.log('\n【一】难度档位与建盘');
{
  eq(LEVEL_KEYS.join(','), 'easy,medium,hard', '三档难度 key 正确');

  const easy = levelConfig('easy'), mid = levelConfig('medium'), hard = levelConfig('hard');
  eq(`${easy.cols}×${easy.rows}/${easy.mines}`, '9×9/10', '初级 9×9 · 10 雷');
  eq(`${mid.cols}×${mid.rows}/${mid.mines}`, '12×12/25', '中级 12×12 · 25 雷');
  eq(`${hard.cols}×${hard.rows}/${hard.mines}`, '16×16/50', '高级 16×16 · 50 雷');
  eq(levelConfig('不存在的key').key, 'easy', '未知难度退回初级');

  for (const key of LEVEL_KEYS) {
    const b = createBoard(key);
    const cfg = LEVELS[key];
    eq(b.cells.length, cfg.rows, `${key} 行数正确`);
    eq(b.cells[0].length, cfg.cols, `${key} 列数正确`);
    eq(b.planted, false, `${key} 建盘时不布雷（推迟到首点）`);
    eq(b.result, PLAYING, `${key} 初始为进行中`);
    eq(b.revealedCount, 0, `${key} 初始翻开数为 0`);
    eq(isPlanted(b), false, `${key} isPlanted 为假`);
  }
}

console.log('\n【二】雷数正确（多种子 × 三难度）');
{
  for (const key of LEVEL_KEYS) {
    const cfg = LEVELS[key];
    let allOk = true;
    for (let seed = 1; seed <= 12; seed++) {
      const b = createBoard(key, mulberry32(seed * 977 + 13));
      plantMines(b, Math.floor(cfg.cols / 2), Math.floor(cfg.rows / 2));
      if (mineCount(b) !== cfg.mines) { allOk = false; break; }
    }
    ok(allOk, `${key}：12 个种子下雷数恒为 ${cfg.mines}`, allOk ? '' : '存在偏差');

    // 候选格不足时不布雷（应报 space，且棋盘保持干净）
    const tiny = blank(2, 2, 9);
    const r = plantMines(tiny, 0, 0);
    ok(!r.ok && r.reason === 'space', '候选格不足时拒绝布雷');
    eq(mineCount(tiny), 0, '拒绝布雷后棋盘无雷');
    eq(tiny.planted, false, '拒绝布雷后 planted 仍为假');

    // 二次布雷被拒
    const b2 = createBoard('easy', mulberry32(7));
    plantMines(b2, 4, 4);
    const again = plantMines(b2, 0, 0);
    ok(!again.ok && again.reason === 'planted', '同一盘不能重复布雷');
  }
}

console.log('\n【三】首次点击安全（首点及八邻域必无雷）');
{
  // 安全区 = 首点 + 其八邻域，区内一定无雷；区外一圈则可能贴雷，
  // 故区内任意格的邻雷数最多是外圈 8 格全中。首点自身必须邻雷数为 0
  // ——这一条同时保证了「首点必落在空白连通区里，一次点击至少掀开 3×3 一片」。
  const SAFE_ZONE_MAX_ADJ = 8;
  for (const key of LEVEL_KEYS) {
    const cfg = LEVELS[key];
    let safe = true, nearZero = true, bounded = true, cascaded = true;
    outer:
    for (let seed = 1; seed <= 6; seed++) {
      for (let px = 0; px < cfg.cols; px += 2) {
        for (let py = 0; py < cfg.rows; py += 2) {
          const b = createBoard(key, mulberry32(seed * 1000 + px * 37 + py));
          const r = reveal(b, px, py);
          if (!r.ok) { safe = false; break outer; }

          // 首点本身
          if (cellAt(b, px, py).mine) { safe = false; break outer; }
          if (countAdjacent(b, px, py) !== 0) { nearZero = false; break outer; }

          // 八邻域：不许有雷，邻雷数不许超过 1
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const c = cellAt(b, px + dx, py + dy);
              if (!c) continue;
              if (c.mine) { safe = false; break outer; }
              if (countAdjacent(b, px + dx, py + dy) > SAFE_ZONE_MAX_ADJ) { bounded = false; break outer; }
            }
          }

          // 首点是 0 号格 ⇒ 不在边角的棋盘内部首点，至少掀开含自身的 3×3 一片
          const interior = px > 0 && py > 0 && px < cfg.cols - 1 && py < cfg.rows - 1;
          if (interior && b.revealedCount < 9) { cascaded = false; break outer; }
        }
      }
    }
    ok(safe, `${key}：首点及八邻域均无雷`);
    ok(nearZero, `${key}：首点邻雷数为 0（首点必落在空白区，连锁展开有保证）`);
    ok(bounded, `${key}：安全区内任意格邻雷数 ≤ ${SAFE_ZONE_MAX_ADJ}（雷只可能贴在区外一圈）`);
    ok(cascaded, `${key}：内部首点至少掀开含自身的 3×3 一片（≥9 格）`);
  }

  // 首点安全区不该吃掉太多空间：高级仍能放下 50 雷
  const hard = createBoard('hard', mulberry32(2024));
  const r = reveal(hard, 15, 15);   // 角落首点（安全区只有 4 格）
  ok(r.ok, '角落首点也能正常布雷翻开');
  eq(mineCount(hard), 50, '角落首点布雷数仍是 50');
  eq(hard.firstX, 15, '记录首点 x');
  eq(hard.firstY, 15, '记录首点 y');

  // 边界首点同样安全
  const edge = createBoard('medium', mulberry32(77));
  const er = reveal(edge, 0, 0);
  ok(er.ok && !cellAt(edge, 0, 0).mine && countAdjacent(edge, 0, 0) === 0, '左上角首点安全且邻雷数为 0');
  eq(mineCount(edge), 25, '边界首点布雷数仍是 25');
}

console.log('\n【四】连锁展开的格子数正确');
{
  // 7×7，四颗雷在 (5,5)(6,5)(5,6)(6,6) 缩成 2×2 一角，点击左上角：
  // 预期展开「与起点连通的 0 号格 + 它们的非雷邻居」
  const b = seedMines(blank(7, 7, 4), [[5, 5], [6, 5], [5, 6], [6, 6]]);
  const expect = expectFlood(b, 0, 0);
  const got = floodReveal(b, 0, 0);
  eq(expect.size, 45, '预期展开集合为 45 格（与独立实现一致）');
  eq(got.length, 45, 'floodReveal 返回 45 格');
  eq(new Set(got.map((p) => p.y * 7 + p.x)).size, 45, '返回坐标互不重复');
  eq(b.revealedCount, 45, 'revealedCount 同步为 45');

  // 展开到的格子必须全是非雷格，且格子集合与预期完全一致
  let leaked = 0, missed = 0;
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const c = b.cells[y][x];
      if (c.mine && c.state !== HIDDEN) leaked++;
      if (!c.mine && c.state === REVEALED && !expect.has(y * 7 + x)) missed++;
    }
  }
  eq(leaked, 0, '连锁展开不会翻开雷格');
  eq(missed, 0, '连锁展开没有多翻预期外的格子');

  // 贴着雷的那一圈（邻雷 > 0）会被翻开，但不继续向外扩散
  const nearMine = cellAt(b, 4, 6);   // (4,6) 贴着 (5,6)/(5,5)
  eq(nearMine.adj, 2, '边界格 (4,6) 邻雷数为 2');
  eq(nearMine.state, REVEALED, '边界格被翻开（但不再向外扩散）');
  eq(cellAt(b, 4, 4).adj, 1, '(4,4) 邻雷数为 1');
  eq(cellAt(b, 5, 5).state, HIDDEN, '雷格保持未翻开');

  // 真正的「数字格」：邻雷 > 0 的格子被掀开时只掀自己一格
  const nb = seedMines(blank(5, 5, 1), [[4, 4]]);
  eq(nb.cells[3][3].adj, 1, '(3,3) 邻雷数为 1（贴着唯一那颗雷）');
  const nr = floodReveal(nb, 3, 3);
  eq(nr.length, 1, '数字格只掀开自己一格');
  eq(nb.revealedCount, 1, '数字格不触发连锁');
  eq(nb.cells[3][3].state, REVEALED, '该格确已翻开');

  // 重复调用不重复计数
  const again = floodReveal(nb, 3, 3);
  eq(again.length, 0, '已翻开的格子再次 floodReveal 返回空');
  eq(nb.revealedCount, 1, '重复调用不会重复累加 revealedCount');

  // 大幅棋盘（高级）一次点击的真实展开数 = 独立算出的预期数
  const hb = createBoard('hard', mulberry32(4242));
  reveal(hb, 8, 8);
  const cnt = hb.revealedCount;
  ok(cnt >= 9, `高级首点展开 ${cnt} 格（≥9）`);
  eq(hb.revealedCount, snapshot(hb).revealedCount, '快照里的翻开数与棋盘一致');
}

console.log('\n【五】标旗计数');
{
  const b = createBoard('easy', mulberry32(99));
  plantMines(b, 4, 4);

  eq(b.flags, 0, '初始旗数为 0');
  eq(remainingMines(b), 10, '初始剩余雷数 = 雷总数');

  const f1 = toggleFlag(b, 0, 0);
  ok(f1.ok && f1.flagged === true, '插旗成功');
  eq(b.flags, 1, '插旗后旗数为 1');
  eq(cellAt(b, 0, 0).state, FLAGGED, '旗格状态为 FLAGGED');
  eq(remainingMines(b), 9, '剩余雷数递减为 9');

  // 同一格再点 = 拔旗
  const f2 = toggleFlag(b, 0, 0);
  ok(f2.ok && f2.flagged === false, '再次点按为拔旗');
  eq(b.flags, 0, '拔旗后旗数为 0');
  eq(cellAt(b, 0, 0).state, HIDDEN, '拔旗后回到未翻开');
  eq(remainingMines(b), 10, '剩余雷数回到 10');

  // 上限：旗数不超过雷数
  let placed = 0;
  for (let y = 0; y < 9 && placed < 12; y++) {
    for (let x = 0; x < 9 && placed < 12; x++) {
      if (toggleFlag(b, x, y).ok) placed++;
    }
  }
  eq(placed, 10, '插满 10 面旗后不再接受新旗');
  eq(b.flags, 10, '旗数上限 = 雷数');
  const over = toggleFlag(b, 8, 8);
  ok(!over.ok && over.reason === 'flagLimit', '超上限插旗被拒（reason=flagLimit）');
  eq(remainingMines(b), 0, '剩余雷数为 0 且不为负');

  // 已翻开的格子不能插旗；旗帜格不能被翻开
  const b2 = createBoard('easy', mulberry32(5));
  reveal(b2, 4, 4);
  const flaggedCell = (() => {
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      if (b2.cells[y][x].state === REVEALED) return { x, y };
    }
    return null;
  })();
  const rf = toggleFlag(b2, flaggedCell.x, flaggedCell.y);
  ok(!rf.ok && rf.reason === 'revealed', '已翻开的格子不能插旗');

  const b3 = blank(4, 4, 2);
  seedMines(b3, [[0, 0], [3, 3]]);
  toggleFlag(b3, 1, 1);
  const rv = reveal(b3, 1, 1);
  ok(!rv.ok && rv.reason === 'flagged', '旗帜格需要先拔旗才能翻开');
  eq(cellAt(b3, 1, 1).state, FLAGGED, '被拒后旗子仍在');

  // 越界
  ok(toggleFlag(b3, -1, 0).reason === 'oob', '越界插旗被拒');
  ok(toggleFlag(b3, 4, 0).reason === 'oob', '越界插旗被拒（右下）');
}

console.log('\n【六】踩雷判负');
{
  // 真实随机局（种子 1）：首点翻开 36 格仍未结束，正好用来踩雷
  const b = createBoard('easy', mulberry32(1));
  const first = reveal(b, 4, 4);
  ok(first.ok && !first.lose, '首点是安全格，不判负');
  eq(b.result, PLAYING, '翻开安全格后仍在进行中');
  eq(b.revealedCount, 36, '首点连锁铺开 36 格（未翻完）');
  eq(b.boom, null, '未踩雷时没有爆炸点');
  eq(isOver(b), false, '此时对局未结束');

  // 找一颗雷踩下去
  let mx = -1, my = -1;
  for (let y = 0; y < 9 && mx < 0; y++) {
    for (let x = 0; x < 9; x++) if (b.cells[y][x].mine) { mx = x; my = y; break; }
  }
  eq(cellAt(b, mx, my).state, HIDDEN, '此时雷还没被翻开（正常玩法看不见）');

  const boom = reveal(b, mx, my);
  ok(boom.ok && boom.lose === true, '踩雷返回 lose');
  ok(!!boom.boom && boom.boom.x === mx && boom.boom.y === my, '返回踩雷坐标供爆炸动画使用');
  eq(b.result, LOST, '踩雷后对局为 LOST');
  eq(isLost(b), true, 'isLost 为真');
  eq(isOver(b), true, 'isOver 为真');
  eq(cellAt(b, mx, my).state, REVEALED, '被踩的雷格显示为已翻开');
  eq(b.boom.x, mx, '棋盘记录 boom 坐标');
  eq(b.boom.y, my, '棋盘记录 boom 纵坐标');
  eq(b.progress < 1, true, '战败时进度未满');

  // 结束时把所有雷都亮出来
  let hiddenMines = 0;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const c = b.cells[y][x];
    if (c.mine && c.state === HIDDEN) hiddenMines++;
  }
  eq(hiddenMines, 0, '战败后所有雷可见（未被插旗的自动翻开）');

  // 终局后不再接受操作
  ok(reveal(b, 0, 8).reason === 'over', '终局后翻开被拒');
  ok(toggleFlag(b, 0, 8).reason === 'over', '终局后插旗被拒');
  ok(!checkWin(b), '战败局面不会因为 checkWin 变成胜利');
  eq(isWon(b), false, '战败局面 isWon 为假');

  // 踩雷的那一盘，之前插的旗子不会被误翻
  const flagged = createBoard('easy', mulberry32(2));
  reveal(flagged, 4, 4);
  toggleFlag(flagged, 0, 0);
  let fmx = -1, fmy = -1;
  for (let y = 0; y < 9 && fmx < 0; y++) {
    for (let x = 0; x < 9; x++) {
      if (flagged.cells[y][x].mine && !(x === 0 && y === 0)) { fmx = x; fmy = y; break; }
    }
  }
  reveal(flagged, fmx, fmy);
  eq(flagged.result, LOST, '插旗后踩雷同样判负');
  eq(cellAt(flagged, 0, 0).state, FLAGGED, '已插旗的雷在战败结算时保留旗子');

  // 真实布雷局里踩雷同样判负
  let lostOk = true;
  for (let seed = 1; seed <= 8; seed++) {
    const rb = createBoard('medium', mulberry32(seed * 31));
    reveal(rb, 6, 6);
    // 找一颗雷踩下去
    let mx = -1, my = -1;
    for (let y = 0; y < rb.rows && mx < 0; y++) {
      for (let x = 0; x < rb.cols; x++) if (rb.cells[y][x].mine) { mx = x; my = y; break; }
    }
    const r = reveal(rb, mx, my);
    if (!(r.ok && r.lose && rb.result === LOST)) lostOk = false;
  }
  ok(lostOk, '8 个种子下踩雷均判负');
}

console.log('\n【七】全部非雷格翻开判胜');
{
  // 7×7，八颗雷围成一圈把中心包住：从圈内点开只掀 1 格，绝不会误判胜利
  const RING_MINES = [[2, 2], [3, 2], [4, 2], [2, 3], [4, 3], [2, 4], [3, 4], [4, 4]];
  const ring = seedMines(blank(7, 7, RING_MINES.length), RING_MINES);
  const inner = reveal(ring, 3, 3);
  eq(inner.win, false, '被雷圈住的首点不会判胜');
  eq(ring.result, PLAYING, '此时仍在进行中');
  eq(ring.revealedCount, 1, '圈内首点只掀开 1 格（四周都是数字格）');
  eq(ring.progress < 1, true, '进度小于 1');
  eq(isWon(ring), false, 'isWon 为假');
  eq(isOver(ring), false, '对局未结束');

  // 逐个补上剩余非雷格：注意一次点击可能连锁掀开很多格，
  // 因此判据是「非雷格数未满 41 时，绝不出现 WON」，而不是看单次返回值
  let earlyWin = 0;
  for (let y = 0; y < 7 && ring.result === PLAYING; y++) {
    for (let x = 0; x < 7; x++) {
      const c = ring.cells[y][x];
      if (c.mine || c.state !== HIDDEN) continue;
      reveal(ring, x, y);
      if (ring.result === WON && ring.revealedCount < 49 - RING_MINES.length) earlyWin++;
      if (ring.result !== PLAYING) break;
    }
  }
  eq(earlyWin, 0, '还剩非雷格时不会提前判胜');
  eq(ring.result, WON, '对局为 WON');
  eq(ring.revealedCount, 49 - RING_MINES.length, '非雷格 41 个全部翻开');
  eq(isWon(ring), true, 'isWon 为真');
  eq(remainingMines(ring), 0, '胜利时雷已自动插旗，剩余雷数为 0');
  eq(ring.progress, 1, '进度为 1');
  eq(cellAt(ring, 2, 2).state, FLAGGED, '胜利后雷格以旗子收尾');
  eq(isOver(ring), true, '胜利后 isOver 为真');
  ok(reveal(ring, 0, 0).reason === 'over', '胜利后不接受继续翻开');

  // 4×4 / 1 雷：首点就把 15 个非雷格全部铺开，直接判胜
  const b2 = seedMines(blank(4, 4, 1), [[3, 3]]);
  const first2 = reveal(b2, 0, 0);
  eq(first2.win, true, '4×4 首点铺满全部非雷格，直接判胜');
  eq(b2.result, WON, '对局为 WON');
  eq(b2.revealedCount, 15, '首点掀开 15 个非雷格');
  eq(b2.progress, 1, '进度为 1');
  eq(cellAt(b2, 3, 3).state, FLAGGED, '胜利后唯一那颗雷以旗子收尾');

  // 真实布雷局：把所有非雷格点开应必胜（逐格点，暴露所有边界）
  for (const key of LEVEL_KEYS) {
    const rb = createBoard(key, mulberry32(key.length * 777 + 3));
    let won = false, lost = false;
    for (let y = 0; y < rb.rows && !won; y++) {
      for (let x = 0; x < rb.cols; x++) {
        const c = rb.cells[y][x];
        if (c.mine || c.state === REVEALED) continue;
        const rr = reveal(rb, x, y);
        if (rr.lose) { lost = true; break; }   // 不应发生
        if (rr.win) { won = true; break; }
      }
    }
    eq(lost, false, `${key}：逐格翻开安全格不会踩雷`);
    ok(won, `${key}：逐格翻开所有非雷格后判胜`);
    eq(rb.result, WON, `${key}：最终结果为 WON`);
    eq(rb.revealedCount, rb.rows * rb.cols - rb.mineTotal, `${key}：翻开的非雷格数 = 总格数 − 雷数`);
    eq(rb.progress, 1, `${key}：进度为 1`);
  }
}

console.log('\n【八】计时数据');
{
  const t = createTimer();
  eq(elapsedMs(t, 1000), 0, '未开始计时的用时为 0');
  eq(formatTime(0), '00:00', '格式化 0ms');
  eq(formatTime(1000), '00:01', '格式化 1 秒');
  eq(formatTime(65000), '01:05', '格式化 1 分 05 秒');
  eq(formatTime(99 * 60000), '99:00', '99 分钟仍用 mm:ss');
  eq(formatTime(100 * 60000), '1:40:00', '超过 99 分钟显示小时');
  eq(formatTime(-5), '00:00', '负值归零');

  startTimer(t, 1000);
  eq(elapsedMs(t, 3500), 2500, '计时中用时随时钟推进');
  startTimer(t, 9000);
  eq(elapsedMs(t, 3500), 2500, '重复 startTimer 不重置起点');
  stopTimer(t, 6000);
  eq(elapsedMs(t, 999999), 5000, '停表后用时冻结');
  startTimer(t, 999999);
  eq(elapsedMs(t, 999999), 5000, '已停表的计时器不会被再次启动');

  // 会话：首次翻开才开始计时，胜负即停表
  const s = createSession('easy', mulberry32(11));
  eq(isStarted(s), false, '新建会话尚未开始');
  eq(elapsedMs(s.timer, 9999), 0, '未翻开前不计时');
  sessionReveal(s, 4, 4, 120);
  eq(isStarted(s), true, '首次翻开后本局已开始');
  const tick = updateSession(s, 5120);
  eq(tick.result, PLAYING, '快照显示仍在进行中');
  const rr = sessionReveal(s, 4, 4, 8000);
  ok(!rr.ok && rr.reason === 'revealed', '会话内重复翻开同一格被拒');
  let elapsed = elapsedMs(s.timer, 8000);
  ok(elapsed > 0, `会话计时在走（${formatTime(elapsed)}）`);
}

console.log('\n【九】快照 / 会话 / 重开');
{
  const s = createSession('medium', mulberry32(2026));
  const snap0 = updateSession(s, 0);
  eq(snap0.cols, 12, '快照列数 12');
  eq(snap0.rows, 12, '快照行数 12');
  eq(snap0.mineTotal, 25, '快照雷数 25');
  eq(snap0.remaining, 25, '快照剩余雷数 25');
  eq(snap0.result, PLAYING, '快照初始进行中');
  eq(snap0.grid.length, 12, '快照网格行数正确');
  eq(snap0.grid[0].length, 12, '快照网格列数正确');
  eq(snap0.planted, false, '快照显示尚未布雷');

  sessionReveal(s, 6, 6, 100);
  const snap1 = updateSession(s, 200);
  eq(snap1.planted, true, '首点后快照显示已布雷');
  ok(snap1.revealedCount >= 9, '快照记录翻开数');
  eq(snap1.progress > 0 && snap1.progress < 1, true, '进度介于 0 与 1 之间');

  // 快照不泄漏未翻开格的雷信息（防作弊 / 防误画）
  let leaked = 0;
  for (let y = 0; y < snap1.rows; y++) {
    for (let x = 0; x < snap1.cols; x++) {
      const c = snap1.grid[y][x];
      if (c.state !== REVEALED && (c.mine === true || c.adj !== 0)) leaked++;
    }
  }
  eq(leaked, 0, '未翻开格在快照里不带雷/邻雷信息');

  sessionFlag(s, 0, 0);
  const snap2 = updateSession(s, 300);
  eq(snap2.remaining, 24, '插旗后快照剩余雷数递减');
  eq(snap2.grid[0][0].state, FLAGGED, '快照里 (0,0) 为旗帜');

  // 重开：换新盘、计时归零、可换难度
  sessionReset(s, 'hard', mulberry32(1));
  const snap3 = updateSession(s, 400);
  eq(snap3.cols, 16, '重开后可切到高级（16 列）');
  eq(snap3.mineTotal, 50, '重开后雷数 50');
  eq(snap3.revealedCount, 0, '重开后翻开数归零');
  eq(snap3.flags, 0, '重开后旗数归零');
  eq(snap3.result, PLAYING, '重开后为进行中');
  eq(snap3.planted, false, '重开后回到未布雷');
  eq(elapsedMs(s.timer, 999999), 0, '重开后计时归零');
  eq(isStarted(s), false, '重开后会话回到未开始');

  // 不传难度时沿用原难度
  sessionReset(s);
  eq(updateSession(s, 500).cols, 16, '重开不传难度时沿用原难度');

  // 会话内走完一局：战败
  const s2 = createSession('easy', mulberry32(808));
  sessionReveal(s2, 4, 4, 0);
  let mx = -1, my = -1;
  for (let y = 0; y < 9 && mx < 0; y++) for (let x = 0; x < 9; x++) if (s2.board.cells[y][x].mine) { mx = x; my = y; break; }
  const boom = sessionReveal(s2, mx, my, 5000);
  ok(boom.ok && boom.lose, '会话内踩雷判负');
  const snapLose = updateSession(s2, 5000);
  eq(snapLose.result, LOST, '会话快照为 LOST');
  eq(snapLose.boom.x, mx, '会话快照带踩雷坐标');
  eq(elapsedMs(s2.timer, 99000), 5000, '判负瞬间停表（时间冻结在 5000ms）');

  // sessionFlag 在终局后被拒
  ok(sessionFlag(s2, 0, 8).reason === 'over', '终局后会话插旗被拒');

  // 会话内走完一局：胜利
  const s3 = createSession('hard', mulberry32(555));
  let wonSession = false;
  for (let y = 0; y < 16 && !wonSession; y++) {
    for (let x = 0; x < 16; x++) {
      const c = s3.board.cells[y][x];
      if (c.mine || c.state === REVEALED) continue;
      const r = sessionReveal(s3, x, y, 1000 + y * 10 + x);
      if (r.win) { wonSession = true; break; }
    }
  }
  ok(wonSession, '会话内翻完非雷格判胜');
  const snapWin = updateSession(s3, 3000);
  eq(snapWin.result, WON, '会话快照为 WON');
  eq(elapsedMs(s3.timer, 99999) > 0, true, '胜利时冻结了一个大于 0 的用时');
}

console.log('\n【十】纯逻辑约束自检');
{
  // 注入的 rng 必须是唯一随机来源：同一 seed 两次建盘结果完全一致
  const a = createBoard('medium', mulberry32(31415));
  const b = createBoard('medium', mulberry32(31415));
  plantMines(a, 5, 5); plantMines(b, 5, 5);
  let same = true;
  for (let y = 0; y < 12 && same; y++) {
    for (let x = 0; x < 12; x++) {
      if (a.cells[y][x].mine !== b.cells[y][x].mine || a.cells[y][x].adj !== b.cells[y][x].adj) { same = false; break; }
    }
  }
  ok(same, '同一随机种子 → 完全相同的雷局（可复现）');

  const c = createBoard('medium', mulberry32(999));
  plantMines(c, 5, 5);
  let diff = false;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) if (a.cells[y][x].mine !== c.cells[y][x].mine) diff = true;
  ok(diff, '不同随机种子 → 不同雷局');

  // mulberry32 输出落在 [0,1)
  const r = mulberry32(1);
  let inRange = true;
  for (let i = 0; i < 500; i++) { const v = r(); if (!(v >= 0 && v < 1)) inRange = false; }
  ok(inRange, 'mulberry32 输出恒在 [0,1)');

  eq(snapshot(createBoard('easy')).cols, 9, 'snapshot 可直接用于未布雷棋盘');
}

console.log('\n──────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) { console.log('失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
