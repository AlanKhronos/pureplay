/**
 * 游戏注册表：大厅、模式页、难度页都从这里取数据。
 *
 * 每款游戏声明自己的：
 *   - 展示信息（name/desc/glyph/color）
 *   - 是否有「模式」层（如五子棋的休闲/专业）
 *   - 难度档位列表（各游戏语义不同：棋类=AI 强度，扫雷=盘面大小，方块=下落速度）
 *   - 实现方式：kind 'builtin'（集成层内嵌）/ 'module'（src/games/<id>/ 的会话模块）
 *
 * 新增一款游戏：放好 src/games/<id>/（meta + createSession），然后在这里追加一条。
 */
import { meta as minesweeperMeta, createSession as minesweeperCreate } from './minesweeper/index.js';
import { meta as tetrisMeta, createSession as tetrisCreate } from './tetris/index.js';
import { meta as xiangqiMeta, createSession as xiangqiCreate } from './xiangqi/index.js';
import { meta as chessMeta, createSession as chessCreate } from './chess/index.js';
import { meta as goMeta, createSession as goCreate } from './go/index.js';
import { meta as game2048Meta, createSession as game2048Create } from './game2048/index.js';
import { meta as sudokuMeta, createSession as sudokuCreate } from './sudoku/index.js';
import { meta as spiderMeta, createSession as spiderCreate } from './spider/index.js';

/** 棋类统一的五档 AI 强度（五子棋用内置实现，档位由集成层定义）。 */
const CHESS_LEVELS = [
  { key: 1, name: '简单', desc: '只看一步，会失误' },
  { key: 2, name: '普通', desc: '攻守兼备' },
  { key: 3, name: '困难', desc: '会做两步预判' },
  { key: 4, name: '地狱', desc: '擅长制造双重威胁' },
  { key: 5, name: '亚洲', desc: '近乎不失误' },
];

// 注：麻将与斗地主属「牌类」类目，个人主体微信小游戏不可选，已移入 F:\游戏\shelf\
//     搬回时恢复上面的 import 与这里的条目即可。
export const GAMES = [
  {
    id: 'gomoku',
    name: '五子棋',
    desc: '经典对弈 · 五种难度',
    glyph: '五',
    color: '#c9a25e',
    ready: true,
    kind: 'builtin',
    hasModes: true,            // 休闲版 / 专业版（禁手）
    difficulties: CHESS_LEVELS,
  },

  { ...minesweeperMeta, color: '#8a9aa8', kind: 'module', hasModes: false, glyph: '雷', create: (o) => minesweeperCreate(o) },
  { ...xiangqiMeta,     color: '#a8836a', kind: 'module', hasModes: false, glyph: '象', create: (o) => xiangqiCreate(o) },
  { ...chessMeta,       color: '#7f8fa6', kind: 'module', hasModes: false, glyph: '国', create: (o) => chessCreate(o) },
  { ...goMeta,          color: '#8fa89a', kind: 'module', hasModes: false, glyph: '围', create: (o) => goCreate(o) },
  { ...tetrisMeta,      color: '#b08fa8', kind: 'module', hasModes: false, glyph: '方', create: (o) => tetrisCreate(o) },
  { ...game2048Meta,    color: '#b0a08a', kind: 'module', hasModes: false, glyph: '合', create: (o) => game2048Create(o) },
  { ...sudokuMeta,      color: '#c9a25b', kind: 'module', hasModes: false, glyph: '数', create: (o) => sudokuCreate(o) },
  { ...spiderMeta,      color: '#8a7fa8', kind: 'module', hasModes: false, glyph: '蛛', create: (o) => spiderCreate(o) },
];

/** 按 id 找游戏。 */
export function findGame(id) {
  return GAMES.find((g) => g.id === id) ?? null;
}

/** 大厅展示的游戏（全部）。 */
export function hallGames() {
  return GAMES;
}
