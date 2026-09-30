/**
 * 五子棋 AI（纯逻辑，零依赖，可在 Node 里直接跑）
 *
 * 评估算法：方向段分析
 *   对候选点，按「我方落此」与「对手落此」分别统计四个方向的连续段形态
 *   （连子数 n + 两端开放数），查棋型表得分，再加权合成。
 *
 * 五档难度（难度越高，搜索越深、失误越少）：
 *   1 简单   — 只看自己进攻、大量随机，偶尔漏防
 *   2 普通   — 攻防兼顾（防守权重 0.9），轻微随机
 *   3 困难   — 增加一步前瞻，会避开「我下完对手立刻活四」的坑
 *   4 地狱   — 必堵点强制优先 + 主动制造双威胁（双三/双四）
 *   5 亚洲   — 更宽的前瞻 + 对手反击后的二次校验 + 禁手感知，几乎不失误
 *
 * 规则感知：专业版（连珠）下，若 AI 执黑，会跳过所有禁手点（三三/四四/长连）。
 */
import { BOARD_SIZE, BLACK, WHITE, EMPTY, cloneBoard, place, candidates, opponent } from './board.js';
import { checkForbidden, RULE_PRO } from './rules.js';

/** 连子形态评分表：n = 落子后该方向连子总数，opens = 两端开放数。 */
function shapeScore(n, opens) {
  if (n >= 5) return 1_000_000;
  if (n === 4 && opens === 2) return 120_000;
  if (n === 4 && opens === 1) return 15_000;
  if (n === 3 && opens === 2) return 9_000;
  if (n === 3 && opens === 1) return 1_200;
  if (n === 2 && opens === 2) return 700;
  if (n === 2 && opens === 1) return 120;
  if (n === 1 && opens === 2) return 30;
  return 0;
}

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

function inside(board, x, y) {
  return x >= 0 && y >= 0 && x < board.size && y < board.size;
}

/** 落子后某方向的形态分。 */
function directionScore(board, x, y, player, dx, dy) {
  let forward = 0, backward = 0, openForward = false, openBackward = false;

  for (let step = 1; step <= 4; step++) {
    const nx = x + dx * step, ny = y + dy * step;
    if (!inside(board, nx, ny)) break;
    const v = board.grid[ny][nx];
    if (v === player) { forward++; continue; }
    if (v === EMPTY) openForward = true;
    break;
  }
  for (let step = 1; step <= 4; step++) {
    const nx = x - dx * step, ny = y - dy * step;
    if (!inside(board, nx, ny)) break;
    const v = board.grid[ny][nx];
    if (v === player) { backward++; continue; }
    if (v === EMPTY) openBackward = true;
    break;
  }

  const n = forward + backward + 1;
  const opens = (openForward ? 1 : 0) + (openBackward ? 1 : 0);
  return shapeScore(n, opens);
}

/** 单点评估：进攻分 + 对手在此的威胁分 × 防守权重。 */
function evaluatePoint(board, x, y, player, defenseWeight = 0.95) {
  const foe = opponent(player);
  let attack = 0, defense = 0;
  for (const [dx, dy] of DIRS) {
    attack += directionScore(board, x, y, player, dx, dy);
    defense += directionScore(board, x, y, foe, dx, dy);
  }
  return attack + defense * defenseWeight;
}

/** 分方向统计「四」与「活三」的个数（用于识别双威胁）。 */
function threatProfile(board, x, y, player) {
  let fours = 0, openThrees = 0;
  for (const [dx, dy] of DIRS) {
    const s = directionScore(board, x, y, player, dx, dy);
    if (s >= 15_000 && s < 1_000_000) fours++;      // 冲四 / 活四
    else if (s >= 9_000) openThrees++;              // 活三
  }
  return { fours, openThrees };
}

/** 该点落下是否立刻五连。 */
function isWinningMove(board, x, y, player) {
  const probe = cloneBoard(board);
  probe.current = player;
  probe.winner = EMPTY;
  const r = place(probe, x, y);
  return r.ok && probe.winner === player;
}

/** 该点是否为禁手（仅专业版黑棋需要）。 */
function isForbidden(board, x, y, player, mode) {
  if (mode !== RULE_PRO || player !== BLACK) return false;
  return checkForbidden(board.grid, board.size, x, y).forbidden;
}

/** 难度参数表。 */
export const LEVELS = {
  1: { key: 1, name: '简单', defense: 0.25, noise: 1500, sample: 0.35, lookahead: 0, preBlock: false, doubleThreat: false },
  2: { key: 2, name: '普通', defense: 0.9, noise: 40, sample: 1, lookahead: 0, preBlock: true, doubleThreat: false },
  3: { key: 3, name: '困难', defense: 1.0, noise: 12, sample: 1, lookahead: 6, preBlock: true, doubleThreat: false },
  4: { key: 4, name: '地狱', defense: 1.0, noise: 0, sample: 1, lookahead: 6, preBlock: true, doubleThreat: true },
  5: { key: 5, name: '亚洲', defense: 1.0, noise: 0, sample: 1, lookahead: 9, preBlock: true, doubleThreat: true, verify: true },
};

export function levelName(level) {
  return (LEVELS[level] ?? LEVELS[2]).name;
}

/**
 * 选出 AI 的落点。
 * @param board 当前棋盘
 * @param player AI 执子颜色
 * @param options.level 1..5（默认 2）
 * @param options.mode 'casual' | 'pro'（专业版下禁手点会被排除）
 * @returns {{x:number,y:number}|null}
 */
export function chooseMove(board, player, options = {}) {
  const level = Math.min(5, Math.max(1, options.level ?? 2));
  const mode = options.mode ?? 'casual';
  const cfg = LEVELS[level];
  const rand = options.random ?? Math.random;

  if (board.moves.length === 0) {
    const c = Math.floor(board.size / 2);
    return { x: c, y: c };
  }

  let spots = candidates(board, 2);
  // 专业版黑棋：先剔除禁手点
  if (mode === RULE_PRO && player === BLACK) {
    spots = spots.filter(([x, y]) => !isForbidden(board, x, y, player, mode));
  }
  if (spots.length === 0) return null;

  // ① 一步致胜：任何难度都必须抓住。
  //    必须放在「简单档抽样」之前——否则制胜点可能被随机抽掉，出现"该赢不赢"的怪象。
  for (const [x, y] of spots) {
    if (isWinningMove(board, x, y, player)) return { x, y };
  }

  // 简单档：随机抽样，制造"看不过来"的观感（只影响评分范围，不影响上面的必胜棋）
  if (cfg.sample < 1) {
    const keep = Math.max(4, Math.floor(spots.length * cfg.sample));
    spots = spots.slice().sort(() => rand() - 0.5).slice(0, keep);
  }

  const center = (board.size - 1) / 2;
  const scored = [];

  for (const [x, y] of spots) {
    // ① 自己一步致胜
    if (isWinningMove(board, x, y, player)) return { x, y };

    // ② 对手一步成五 → 必堵（简单档凭"看不见"漏防）
    if (cfg.preBlock && isWinningMove(board, x, y, opponent(player))) {
      scored.push({ x, y, score: 900_000 });
      continue;
    }

    let score = evaluatePoint(board, x, y, player, cfg.defense);

    // ④ 地狱/亚洲：主动制造双威胁（双四/双三）
    if (cfg.doubleThreat) {
      const tp = threatProfile(board, x, y, player);
      if (tp.fours >= 2) score += 200_000;
      else if (tp.fours >= 1 && tp.openThrees >= 1) score += 60_000;
      else if (tp.openThrees >= 2) score += 40_000;
    }

    const dist = Math.abs(x - center) + Math.abs(y - center);
    score -= dist * 2;
    if (cfg.noise > 0) score += (rand() - 0.5) * cfg.noise;
    scored.push({ x, y, score });
  }

  scored.sort((a, b) => b.score - a.score);
  let best = { x: scored[0].x, y: scored[0].y };

  // ③ 前瞻
  if (cfg.lookahead > 0) {
    best = lookahead(board, player, scored.slice(0, cfg.lookahead), best, { ...cfg, mode });
  }

  return best;
}

/**
 * 一步前瞻：模拟落子后看对手能拿到的最佳威胁，取「我方得分 − 对手反击分」最大者。
 * verify=true（亚洲档）时再补一层：若对手反击后我方无法应对，则降低该点评价。
 */
function lookahead(board, player, top, fallback, cfg) {
  const foe = opponent(player);
  let best = fallback;
  let bestValue = -Infinity;

  for (const cand of top) {
    const test = cloneBoard(board);
    test.current = player;
    test.winner = EMPTY;
    const r = place(test, cand.x, cand.y);
    if (!r.ok) continue;
    if (test.winner === player) return { x: cand.x, y: cand.y };

    // 对手最佳回应
    let foeBest = 0;
    let foeKiller = null;
    let foeSpots = candidates(test, 2);
    if (cfg.mode === RULE_PRO && foe === BLACK) {
      foeSpots = foeSpots.filter(([x, y]) => !isForbidden(test, x, y, foe, cfg.mode));
    }
    for (const [fx, fy] of foeSpots) {
      if (isWinningMove(test, fx, fy, foe)) { foeBest = 1_000_000; foeKiller = { x: fx, y: fy }; break; }
      const s = evaluatePoint(test, fx, fy, foe, 0);
      if (s > foeBest) { foeBest = s; foeKiller = { x: fx, y: fy }; }
    }

    let value = cand.score - foeBest * 0.9;

    // 亚洲档：对手反击后，检查我方是否还有解（有解则加分，无解则重罚）
    if (cfg.verify && foeKiller && foeBest >= 9_000) {
      const after = cloneBoard(test);
      after.current = foe;
      after.winner = EMPTY;
      place(after, foeKiller.x, foeKiller.y);
      if (after.winner === foe) {
        value -= 500_000;                     // 对手直接赢 → 这点不能走
      } else {
        after.current = player;
        const replies = candidates(after, 2);
        const hasAnswer = replies.some(([rx, ry]) => {
          if (isWinningMove(after, rx, ry, player)) return true;
          return evaluatePoint(after, rx, ry, player, 1.0) >= 100_000;
        });
        if (!hasAnswer) value -= 60_000;      // 无解 → 降权
        else value += 8_000;
      }
    }

    if (value > bestValue) { bestValue = value; best = { x: cand.x, y: cand.y }; }
  }
  return best;
}

export { evaluatePoint as __evaluatePoint, shapeScore as __shapeScore, directionScore as __directionScore, threatProfile as __threatProfile };
export { BOARD_SIZE, BLACK, WHITE, EMPTY };
