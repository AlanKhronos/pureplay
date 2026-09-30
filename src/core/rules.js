/**
 * 规则集：休闲版 / 专业版
 *
 * 休闲版：无任何限制，先成五者胜（五连以上也算）。
 * 专业版（连珠规则）：黑棋受禁手约束，白棋无禁手。
 *   - 长连禁手：黑棋不得形成六子及以上连续
 *   - 四四禁手：黑棋不得同时形成两个及以上的「四」
 *   - 三三禁手：黑棋不得同时形成两个及以上的「活三」
 *
 * 实现思路（试填法，纯逻辑可测）：
 *   把落点两侧各 5 格（共 11 格）取出成线串，1=己方 2=对方/出界 0=空；
 *   「四」= 串中某个空位填成己方后恰好出现 11111；
 *   「活三」= 串中某个空位填成己方后出现 011110（活四）。
 *   四个方向各自最多计一个「四」/「活三」，避免同一方向重复计数。
 */
import { BLACK, WHITE, EMPTY, opponent } from './board.js';

export const RULE_CASUAL = 'casual';
export const RULE_PRO = 'pro';

export const RULE_LABELS = {
  [RULE_CASUAL]: { name: '休闲版', desc: '无规则限制，先成五者胜' },
  [RULE_PRO]: { name: '专业版', desc: '黑棋禁手：三三 / 四四 / 长连' },
};

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const WINDOW = 5; // 中心两侧各 5 格

/** 取以 (x,y) 为中心、沿 (dx,dy) 的 11 格线串。出界记 2。 */
function lineAt(grid, size, x, y, dx, dy, player) {
  const foe = opponent(player);
  let s = '';
  for (let step = -WINDOW; step <= WINDOW; step++) {
    if (step === 0) { s += '1'; continue; }
    const nx = x + dx * step, ny = y + dy * step;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) { s += '2'; continue; }
    const v = grid[ny][nx];
    s += v === EMPTY ? '0' : v === player ? '1' : v === foe ? '2' : '2';
  }
  return s;
}

/** 线串中是否有 ≥6 的连续 1（长连）。 */
function hasOverline(line) {
  return /111111/.test(line);
}

/** 线串中某空位填 1 后能否恰好成五（存在「四」）。 */
function canFormFive(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '0') continue;
    const next = line.slice(0, i) + '1' + line.slice(i + 1);
    if (/11111/.test(next) && !/111111/.test(next)) return true;
  }
  return false;
}

/** 线串中某空位填 1 后能否形成活四 011110（存在「活三」）。 */
function canFormOpenFour(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '0') continue;
    const next = line.slice(0, i) + '1' + line.slice(i + 1);
    if (next.includes('011110')) return true;
  }
  return false;
}

/**
 * 分析在 (x,y) 落 player 后的形态统计。
 * @returns {{overline:boolean, fours:number, openThrees:number}}
 */
export function analyzeShape(grid, size, x, y, player) {
  let overline = false, fours = 0, openThrees = 0;
  for (const [dx, dy] of DIRS) {
    const line = lineAt(grid, size, x, y, dx, dy, player);
    if (hasOverline(line)) overline = true;
    if (canFormFive(line)) fours++;
    if (canFormOpenFour(line)) openThrees++;
  }
  return { overline, fours, openThrees };
}

/**
 * 判断黑棋在 (x,y) 落子是否触犯禁手（仅专业版调用）。
 * @returns {{forbidden:boolean, reasons:string[]}}
 */
export function checkForbidden(grid, size, x, y) {
  const s = analyzeShape(grid, size, x, y, BLACK);
  const reasons = [];
  if (s.overline) reasons.push('长连');
  if (s.fours >= 2) reasons.push('四四');
  if (s.openThrees >= 2) reasons.push('三三');
  return { forbidden: reasons.length > 0, reasons };
}

/**
 * 该手是否合法（综合规则集判定）。
 * @param mode 'casual' | 'pro'
 * @returns {{ok:boolean, reason?:string, forbiddenReasons?:string[]}}
 */
export function checkMove(grid, size, x, y, player, mode) {
  if (mode !== RULE_PRO) return { ok: true };
  // 专业版：只有黑棋受禁手约束
  if (player !== BLACK) return { ok: true };
  const r = checkForbidden(grid, size, x, y);
  if (r.forbidden) {
    return { ok: false, reason: '禁手：' + r.reasons.join(' + '), forbiddenReasons: r.reasons };
  }
  return { ok: true };
}

/** 规则说明文本（给 UI 用）。 */
export function ruleHint(mode, player) {
  if (mode !== RULE_PRO) return '休闲版：无禁手，任意落子';
  if (player === BLACK) return '专业版：你执黑，三三 / 四四 / 长连为禁手';
  return '专业版：你执白，白棋无禁手（对手黑棋受限）';
}

export { BLACK, WHITE, EMPTY };
