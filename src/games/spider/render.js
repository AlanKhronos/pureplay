/**
 * 蜘蛛纸牌绘制层：只负责「把状态画出来」，不持有状态、不碰平台 API。
 *
 * 视觉沿用「纯净玩」的木质感，但**不画全屏背景**——集成层会铺青白渐变底，
 * 这里只画牌桌区域（半透明木色卡片衬托），并且所有文字色都从 theme 取
 * （theme.textPrimary 现在是浅底上的深色文字，不能写死白色）。
 *
 * 左上返回键与右上齿轮由集成层绘制；结算弹窗也由集成层统一画（读 outcome），
 * 本文件只画：牌桌 + 各列牌叠（列数按难度 5/7/9）+ 收集区计数 + 底部三按钮 + 提示胶囊。
 */
import {
  SUIT_CHARS, RANK_LABELS, PLAYING, WON, MAX_COLUMNS,
  levelConfig, initialDealOf, columnsOf, emptyColsOf, stockRoundsOf,
} from './core.js';

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/** 牌面红黑两色（语义固定，不随主题走）。 */
const RED = '#c0392b';
const BLACK = '#22303f';

/** 纸牌纵横比（高 / 宽）。 */
const CARD_ASPECT = 1.42;
/**
 * 最坏列塞进内容区后，平均每张牌至少要露出来的高度占牌高的比例。
 * 列数 5/7/9 后同一列会堆到 ~104/列数 张（简单档 ≈ 21 张），
 * 牌放太大就只能靠压缩间距硬塞、点数被切得看不清，所以给牌宽设一个**高度上限**。
 */
const MIN_STRIP_RATIO = 0.20;
/**
 * 牌宽被上面那条高度上限压低时，**最多压掉 15%**。
 * 否则在 320×480 这种小屏上会把简单档压到比普通档还窄（列少反而牌小，
 * 与「列变少就放大纸牌」的设计意图正好相反）。
 */
const MIN_CARD_W_RATIO = 0.85;

/**
 * 发牌动画节奏（像真人发牌）：第 i 列的出发时刻 = 起始时刻 + i × DEAL_STEP_MS，
 * 每张用 DEAL_FLY_MS 从发牌堆飞到该列列尾 —— 严格按列序串行出发，
 * 相邻两张有短暂交叠（前一张还在飞、后一张已离手），看起来就是「啪、啪、啪」连着发。
 */
const DEAL_STEP_MS = 90;
const DEAL_FLY_MS = 170;
/**
 * 移动动画总时长（象棋落子三段手感）：
 * 0~40% 抬起（略放大 + 上浮）→ 40~75% 滞空（滑到目标上方悬住）→ 75~100% 加速落下（带压缩感）。
 */
const MOVE_DUR_MS = 460;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 快缓出（抬起/滑行的收尾感）。 */
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
/** 慢加速（落下的重力感）。 */
const easeInQuad = (t) => t * t;

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 向当前路径追加一个圆角矩形（**不** beginPath，便于把多个子路径并成一次描边）。 */
function subRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** 圆角矩形路径（不依赖 ctx.roundRect，兼容小游戏基础库）。 */
export function pathRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  subRoundRect(ctx, x, y, w, h, r);
}

/**
 * 只有上方两个圆角的矩形路径（未翻开牌「露出来的那一条」用）。
 * 底部是平口——下面紧接着就被下一张牌盖住了，圆角既看不见也白描。
 */
export function pathRoundRectTop(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/* ───────────────────── 帧内缓存（性能关键） ─────────────────────
 * 这一屏最贵的三件事，全部改成「只算一次、之后复用」：
 *
 * 1) createLinearGradient：每次调用都要构造一个原生渐变对象，104 张牌 × 60 帧
 *    = 每秒 6000+ 次，是掉帧的头号元凶。做法是**把渐变建在局部原点上**
 *    （如 (0,0)→(0,h)），画牌时用 translate 把牌挪到位——同尺寸的牌于是共用同一个
 *    渐变对象。缓存按 ctx 分桶（渐变对象与创建它的上下文绑定），换 ctx 自动失效。
 * 2) rgba()：每帧要拼上千个颜色串，按「色值+透明度」缓存字符串。
 * 3) 字体串：`700 17px ...` 每张牌拼 2–3 次，同样缓存。
 * 三张缓存都只依赖尺寸/色值，不随牌局变化（换局也不需要失效）。
 */
const gradCache = new WeakMap();   // ctx → Map<key, CanvasGradient>
const rgbaCache = new Map();       // '色值|alpha' → 'rgba(...)'
const fontCache = new Map();       // '字重|像素' → 完整 font 串

/** 取某个 ctx 的渐变桶（同一 ctx 连续调用时走一次身份比较，不再查 WeakMap）。 */
function bucketOf(ctx) {
  if (ctx === bucketCtx && bucketMap) return bucketMap;
  let m = gradCache.get(ctx);
  if (!m) { m = new Map(); gradCache.set(ctx, m); }
  bucketCtx = ctx;
  bucketMap = m;
  return m;
}
let bucketCtx = null;
let bucketMap = null;

/** 按 (ctx, key) 复用线性渐变；坐标一律传局部原点的（配合 translate 用）。 */
function cachedLinear(ctx, key, x0, y0, x1, y1, stops) {
  const bucket = bucketOf(ctx);
  let g = bucket.get(key);
  if (!g) {
    g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    bucket.set(key, g);
  }
  return g;
}

/**
 * 牌面/牌背渐变的**快速通道**：一帧里要按尺寸取上百次，所以缓存「上一次的尺寸」，
 * 命中时只做几个数字比较，连 Map 都不查。换尺寸/换 ctx 才走慢路径。
 */
let cardGradCtx = null;
let cardGradW = 0;
let cardGradH = 0;
let cardGradFace = null;
let cardGradBack = null;
function cardGradients(ctx, w, h) {
  if (ctx === cardGradCtx && w === cardGradW && h === cardGradH) {
    return { face: cardGradFace, back: cardGradBack };
  }
  const bucket = bucketOf(ctx);
  const fk = `face|${w}|${h}`;
  const bk = `back|${w}|${h}`;
  let f = bucket.get(fk);
  if (!f) {
    f = ctx.createLinearGradient(0, 0, 0, h);
    for (const s of FACE_STOPS) f.addColorStop(s[0], s[1]);
    bucket.set(fk, f);
  }
  let b = bucket.get(bk);
  if (!b) {
    b = ctx.createLinearGradient(0, 0, w, h);
    for (const s of BACK_STOPS) b.addColorStop(s[0], s[1]);
    bucket.set(bk, b);
  }
  cardGradCtx = ctx;
  cardGradW = w;
  cardGradH = h;
  cardGradFace = f;
  cardGradBack = b;
  return { face: f, back: b };
}

/** 字体串缓存：像素取整，避免浮点字号把缓存键撑爆。 */
function fontOf(weight, px) {
  const p = Math.max(6, Math.round(px));
  const key = `${weight}|${p}`;
  let s = fontCache.get(key);
  if (!s) { s = `${weight} ${p}px ${FONT}`; fontCache.set(key, s); }
  return s;
}

/** 文本对齐设置，省得每处重复。 */
function setText(ctx, align, baseline) {
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
}

/** 把 '#rrggbb' 转成 rgba(...)；解析失败时原样返回（容错）。结果带缓存。 */
function rgba(hex, a) {
  if (typeof hex !== 'string' || hex[0] !== '#') return hex;
  const key = hex + '|' + a;
  const hit = rgbaCache.get(key);
  if (hit !== undefined) return hit;
  const s = hex.length === 4
    ? hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex.slice(1);
  const n = parseInt(s, 16);
  let out = hex;
  if (!Number.isNaN(n)) out = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  // 动画透明度会产生大量不同 alpha，键数封顶防内存无限增长
  if (rgbaCache.size > 512) rgbaCache.clear();
  rgbaCache.set(key, out);
  return out;
}

/** 尽量用主题令牌，取不到再退回内置近似色（保证两种主题下都不难看）。 */
function tone(theme, key, fallback) {
  const v = theme ? theme[key] : undefined;
  return (typeof v === 'string' && v) ? v : fallback;
}

/* ───────────────────────── 布局 ───────────────────────── */

/**
 * 计算一屏的几何信息。纯函数，方便 Node 里直接单测。
 *
 * 纵向四段：信息条（收集区计数）/ 牌桌（5、7 或 9 列）/ 底部按钮。
 * 底部按钮基线 = height - insets.bottom - 16，再往上放按钮本体，
 * 保证实机手势条不会压住按钮（规范 §5 的硬约束）。
 *
 * ⚠️ 本次改造的两个几何要点：
 *   ① **牌桌贴顶**：table.y === availTop（旧版是 `availTop + (availH - tableH) / 2`
 *      垂直居中）。牌桌高度铺满整个可用带，牌从牌桌顶部往下排，
 *      **下方多出来的木色空白就是放置区**（不再是一块悬在中间的木板）。
 *   ② **列数按难度**（5/7/9）：牌宽随列数变少而放大，但受「最坏列高」限制
 *      （见 MIN_STRIP_RATIO），免得简单档把牌放大到点数都看不清。
 *
 * @param {number} width  逻辑宽
 * @param {number} height 逻辑高
 * @param {{top:number,bottom:number}} insets 安全区
 * @param {object} [view] 可选：当前快照（估算列高，并作为列数的第一来源）
 * @param {string} [levelKey] 可选：难度 key（列数/开局张数的来源；缺省从 view.key 推断）
 */
export function computeLayout(width, height, insets, view = null, levelKey = null) {
  const safeTop = Math.max(0, Math.round(insets?.top ?? 0));
  const safeBottom = Math.max(0, Math.round(insets?.bottom ?? 0));
  const pad = Math.max(8, Math.round(width * 0.026));

  // 难度：调用方给的优先，其次快照自带的 key，最后退回简单档
  const lk = (typeof levelKey === 'string' && levelKey) ? levelKey : ((view && view.key) || 'easy');
  const cfg = levelConfig(lk);

  // 列数：优先真实快照的列数（手工造的视图也正确），否则用难度配置。
  // **渲染层不再假设「一定是 10 列」**。
  const cols = Math.max(1, Math.round(
    (view && view.columns && view.columns.length) ? view.columns.length : columnsOf(cfg.key),
  ));

  // 集成层在左上/右上画了返回与齿轮，各占约 56×56 的角区；信息条要完整落在它们下面。
  // ⚠️ insets.top 很小时（例如 0）safeTop + cornerSize 可能不到 56，所以再夹一道硬下限
  //    ——「顶部不与 56px 角区相交」是本次硬要求，不能只靠 insets 兜。
  const CORNER_KEEPOUT = 56;
  const cornerSize = Math.max(30, Math.round(pad * 2.6));
  const infoH = Math.max(26, Math.round(Math.min(width, height) * 0.045));
  const info = {
    x: pad,
    y: Math.max(safeTop + cornerSize + Math.round(pad * 0.4), CORNER_KEEPOUT),
    w: width - pad * 2,
    h: infoH,
  };

  // 底部：手势条让位 + 16 余量
  const btnH = Math.max(38, Math.round(Math.min(52, height * 0.058)));
  const btnBottom = height - safeBottom - 16;
  const btnY = Math.round(btnBottom - btnH);
  const footer = { y: btnY, h: 16, baseline: btnBottom };   // y − 16 起算横幅区（含 16px 余量）

  // ── 「提示」胶囊：**绝不能放左上/右上角**（集成层在那里画返回键与齿轮，约各占 56px）──
  // 放在底部按钮那一排的上方一行、水平居中，既躲开两个角落，也不挤收集区。
  const hintSide = Math.round(pad * 0.7);
  const hintW = Math.max(56, Math.round(width * 0.17));
  const hintH = Math.max(26, Math.round(Math.min(38, height * 0.042)));
  const hintRowBottom = btnY - hintSide;
  const hintButton = {
    key: 'hint',
    x: Math.round((width - hintW) / 2),
    y: Math.round(hintRowBottom - hintH),
    w: hintW,
    h: hintH,
  };

  // 纵向可用空间：信息条下方 → 提示按钮上方（再留一点余量，绝不与提示按钮/底部按钮重叠）
  const availTop = info.y + info.h + Math.round(pad * 0.8);
  const availBottom = hintButton.y - Math.round(pad * 0.8);
  const availH = Math.max(120, availBottom - availTop);

  // ── 牌宽：列宽给上限，再被「最坏列高」压一道 ──
  // 列数越少 → 每列越宽 → 牌越大（用户要求「列变少时把纸牌适度放大」）；
  // 但简单档只有 3 列有牌、104 张最终挤成 ~21 张/列，牌放太大就只能把间距压到
  // 点数都看不清。所以按「最坏列（开局最高的那一列 + 全部发牌轮次）」反推一个高度上限。
  const gap = Math.max(2, Math.round(pad * 0.35));
  const tableW = width - pad * 2;
  const colW = Math.floor((tableW - gap * (cols - 1)) / cols);

  const fill = Math.max(1, cols - emptyColsOf(cfg.key));       // 开局真正发牌的列数
  const rounds = stockRoundsOf(cfg.key);                       // 牌堆能发几轮
  const deepest = Math.ceil(initialDealOf(cfg.key) / fill) + rounds;   // 最坏列张数（静态上界）
  // 解「牌高 ≤ (可用高 − 2×牌桌内边距) / (最坏列张数 × 最小露白比例)」，
  // 其中牌桌内边距 = 16% 牌高 → 展开成 maxCardH = availH / (比例×张数 + 0.32)
  const maxCardH = availH / (MIN_STRIP_RATIO * deepest + 0.32);
  const cappedW = Math.floor(maxCardH / CARD_ASPECT);
  const cardW = Math.max(16, Math.min(colW, Math.max(cappedW, Math.round(colW * MIN_CARD_W_RATIO))));
  const cardH = Math.max(24, Math.round(cardW * CARD_ASPECT));

  // 牌块在牌桌里水平居中（牌宽被高度上限压低时，两侧留对称余量，
  // 而不是把牌全挤到左边、右边空一大块）。牌桌左边界就是 pad。
  const blockW = cardW * cols + gap * (cols - 1);
  const originX = pad + Math.max(0, Math.round((tableW - blockW) / 2));

  // 牌桌内边距（上下各一份）。要用来算「真正能放牌的内容高」，所以提前算。
  const tablePad = Math.max(6, Math.round(cardH * 0.16));
  // 内容可用高 = 可用带 − 牌桌上下内边距。列高压缩以此为上限，
  // 保证「整列连最后一张牌的下边缘」始终落在牌桌内部（下方还留得出放置区）。
  const contentAvail = Math.max(60, availH - tablePad * 2);

  // ── 同列纵向错开：翻开露点数（含花色），未翻开只露一条背 ──
  // **双向自适应**：
  //   空间富裕 → 放大（明牌最多整张都露出来，暗牌最多露 22% 的背）
  //   空间不足 → 按比例压缩，保证「整列连最后一张牌」一定塞进可用空间
  const UP_MIN = 6, DOWN_MIN = 2;
  const UP_MAX = Math.max(12, Math.round(cardH * 0.42));   // 明牌最多露 42%（再多会显得牌被扯开）
  const DOWN_MAX = Math.max(4, Math.round(cardH * 0.22));  // 暗牌最多露一条较宽的背
  const UP_GROW_MIN = Math.max(12, Math.round(cardH * 0.30));
  const DOWN_GROW_MIN = Math.max(4, Math.round(cardH * 0.12));
  let faceUpGap = Math.min(UP_MAX, Math.max(12, Math.round(cardH * 0.34)));
  let faceDownGap = Math.min(DOWN_MAX, Math.max(4, Math.round(cardH * 0.15)));

  // 一列最坏要放 6 暗 + 12 明（实用上限）；给了真实快照就按真实列高算
  let maxDown = 6, maxUp = 12;
  if (view && view.columns) {
    maxDown = 0; maxUp = 0;
    for (const c of view.columns) {
      maxDown = Math.max(maxDown, c.faceDown);
      maxUp = Math.max(maxUp, c.faceUp);
    }
  }
  const stackH = (ud, uu) => ud * maxDown + uu * maxUp + cardH;   // 整列连最后一张牌

  // 1) 空间富裕 → 放大到上限（不超过「一张牌高 / 22% 背」），把可用空间用起来
  if (stackH(DOWN_GROW_MIN, UP_GROW_MIN) < contentAvail) {
    const extra = contentAvail - stackH(DOWN_GROW_MIN, UP_GROW_MIN);
    faceUpGap = Math.max(faceUpGap, Math.min(UP_MAX, UP_GROW_MIN + extra / Math.max(1, maxUp)));
    faceDownGap = Math.max(faceDownGap, Math.min(DOWN_MAX, DOWN_GROW_MIN + extra / Math.max(1, maxDown)));
  }

  // 2) 仍然溢出 → 等比压回可用空间内（含最后一张牌的下边缘，绝不越界）
  if (stackH(faceDownGap, faceUpGap) > contentAvail) {
    const minNeed = stackH(DOWN_MIN, UP_MIN);
    if (minNeed >= contentAvail) {
      // 极端小屏：连最小间距都放不下，退化成把整列等比缩小
      const k = contentAvail / minNeed;
      faceDownGap = Math.max(1, DOWN_MIN * k);
      faceUpGap = Math.max(4, UP_MIN * k);
    } else {
      const ratio = (contentAvail - cardH - DOWN_MIN * maxDown - UP_MIN * maxUp)
        / Math.max(1, (faceUpGap - UP_MIN) * maxUp + (faceDownGap - DOWN_MIN) * maxDown);
      faceUpGap = UP_MIN + (faceUpGap - UP_MIN) * Math.min(1, Math.max(0, ratio));
      faceDownGap = DOWN_MIN + (faceDownGap - DOWN_MIN) * Math.min(1, Math.max(0, ratio));
    }
  }

  // 取整（向下取整保证绝不溢出）
  faceUpGap = Math.max(UP_MIN, Math.floor(faceUpGap));
  faceDownGap = Math.max(DOWN_MIN, Math.floor(faceDownGap));

  // 各列按其真实列高算高度，取最高的那列决定「内容带」高度
  const colStackH = (col, ud, uu) => (col ? col.faceDown * ud + col.faceUp * uu + cardH : stackH(ud, uu));
  let contentH = 0;
  if (view && view.columns) {
    for (const col of view.columns) contentH = Math.max(contentH, colStackH(col, faceDownGap, faceUpGap));
  } else {
    contentH = stackH(faceDownGap, faceUpGap);
  }
  const bandH = Math.round(contentH) + tablePad * 2;                 // 内容带（牌 + 上下留白）

  // ── 牌桌几何（本次改造重点）──
  // 旧版：tableH 只取可用带的 78%，再**垂直居中**摆 → 木板悬在屏幕中间，上下都空。
  // 新版：tableH 铺满整个可用带（信息条下方 → 提示按钮上方），且 table.y 贴住 availTop。
  //       牌从牌桌顶部（bandTop = table.y + tablePad）开始往下排，
  //       因此**牌桌下方剩下的木色就是放置区**（dropZone = 实测的剩余空间）。
  const tableH = Math.max(120, availH);
  const tableTop = availTop;                       // ★ 顶部对齐，不再居中
  const table = { x: pad, y: tableTop, w: tableW, h: tableH, bottom: tableTop + tableH };
  const bandTop = table.y + tablePad;              // 内容带贴牌桌顶部
  const dropZone = Math.max(0, tableH - tablePad * 2 - Math.round(contentH));  // 下方放置区（可见纵深）

  // 各列 x：牌宽 + 列间距，整块在牌桌里水平居中（列数按难度）
  const columns = [];
  for (let i = 0; i < cols; i++) {
    columns.push({
      index: i,
      x: originX + i * (cardW + gap),
      w: cardW,
      top: table.y,
      cardH,
    });
  }

  // 每列按自身列高在「内容带」内纵向居中（矮列自然坐得低一点，视觉更稳）
  for (const geo of columns) {
    if (!view || !view.columns) continue;
    const col = view.columns[geo.index];
    if (!col) continue;
    const h = colStackH(col, faceDownGap, faceUpGap);
    geo.top = bandTop + Math.max(0, Math.round((contentH - h) / 2));
  }

  // 底部三颗胶囊：重新开始 / 撤销 / 发牌（「提示」在它们上方单独一行，见上）
  const totalW = width - pad * 2;
  const bGap = Math.round(pad * 0.7);
  const unit = Math.floor((totalW - bGap * 2) / 3);
  const buttons = [
    { x: pad, y: btnY, w: unit, h: btnH, key: 'restart' },
    { x: pad + unit + bGap, y: btnY, w: unit, h: btnH, key: 'undo' },
    { x: pad + (unit + bGap) * 2, y: btnY, w: totalW - (unit + bGap) * 2, h: btnH, key: 'deal' },
  ];

  // 发牌堆的视觉位置：「发牌」按钮的中心的。发牌动画从这里起飞（layout 无独立牌堆，
  // 按钮就是玩家认知里的发牌入口，从这里发牌「像人手从牌堆里拿」）。
  const dealBtn = buttons[buttons.length - 1] || { x: width / 2, y: height - 40, w: 0, h: 0 };

  return {
    width,
    height,
    safe: { top: safeTop, bottom: safeBottom },
    pad,
    cols,                             // 本局列数（5 / 7 / 9）
    info,
    table,
    footer,
    buttons,
    hintButton,
    stockPoint: { x: dealBtn.x + dealBtn.w / 2, y: dealBtn.y + dealBtn.h / 2 },
    columns,
    cardW,
    cardH,
    gap,
    tablePad,
    faceUpGap,
    faceDownGap,
    contentH: Math.round(contentH),   // 最高那一列占的高度（牌桌里的「内容带」）
    bandTop,                          // 内容带顶边（牌在这里往下排）
    dropZone,                         // 牌桌下方预留的放置区高度
    availTop,                         // 内容区顶边（牌桌贴住它 —— 顶部对齐的断言基准）
    availBottom,
    availH,
    contentAvail,
    bottomLimit: btnBottom,
  };
}

/**
 * 一张牌「露出来的那一条」的 y 区间。
 *
 * 同列牌纵向错开，相邻两张的完整矩形**是重叠的**，但视觉上每张牌只有
 * 一条属于自己的窄带（下一张盖住的部分不算）。点击判定必须按这条窄带来算：
 *   区间 = [本张的 y, 下一张的 y)，最后一张取到牌底。
 * 否则「点第 10 张」会被判成「点第 11 张」，整组搬错牌。
 *
 * @returns {{top:number, bottom:number}} bottom 为开区间上界
 */
export function cardStrip(layout, view, c, k) {
  const geo = layout.columns[c];
  const col = view && view.columns ? view.columns[c] : null;
  const total = col ? col.cards.length : 1;
  let y = geo.top;
  if (col) {
    for (let i = 0; i < k; i++) {
      y += col.cards[i].faceUp ? layout.faceUpGap : layout.faceDownGap;
    }
  }
  // 下一张牌的 y（决定本张露出的下边界）；最后一张到牌底
  let nextY = y + layout.cardH;
  if (col && k < total - 1) {
    nextY = y + (col.cards[k].faceUp ? layout.faceUpGap : layout.faceDownGap);
  }
  return { top: y, bottom: nextY };
}

/**
 * 逻辑坐标 → 命中哪一列的哪张牌。
 *
 * 判定用的是「露出来的窄带」，与视觉叠压顺序一致：点在哪条带上就是哪一张。
 *
 * ⚠️ 性能：旧版对每张牌都调一次 cardStrip，而 cardStrip 内部又从第 0 张累加到第 k 张
 * ——一列 n 张就是 O(n²)，而 hover/press 在鼠标环境每次移动都会走这里。
 * 现在改成**一遍前缀累加**（O(n)），n 张牌只加 n 次。
 *
 * @returns {{col:number, index:number, card:object}|null}
 */
export function columnAt(layout, view, x, y) {
  if (!view || !view.columns) return null;
  const up = layout.faceUpGap;
  const down = layout.faceDownGap;
  const cardH = layout.cardH;
  for (let c = layout.columns.length - 1; c >= 0; c--) {
    const geo = layout.columns[c];
    if (x < geo.x - 2 || x > geo.x + geo.w + 2) continue;
    const col = view.columns[c];
    if (!col) continue;
    // 空列也要能命中：否则玩家点空列拿不到 hit，永远无法把牌移进去（core 规则本就允许）
    if (col.cards.length === 0) {
      if (y >= geo.top - 1 && y <= geo.top + cardH) return { col: c, index: -1, card: null };
      continue;
    }
    if (y > geo.top + layout.table.h + 4) continue;
    const cards = col.cards;
    const total = cards.length;
    let cy = geo.top;                       // 逐张往下累加，不再从头上重算
    for (let k = 0; k < total; k++) {
      const gap = cards[k].faceUp ? up : down;
      const last = k === total - 1;
      const hi = last ? cy + cardH : cy + gap;
      if (y >= cy - 1 && y <= hi) return { col: c, index: k, card: cards[k] };
      cy += gap;
    }
  }
  return null;
}

/**
 * 第 c 列第 k 张牌的矩形（同列纵向错开：已翻开按 faceUpGap、未翻开按 faceDownGap）。
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function cardRect(layout, view, c, k) {
  const geo = layout.columns[c];
  const col = view && view.columns ? view.columns[c] : null;
  if (!col) return { x: geo.x, y: geo.top, w: layout.cardW, h: layout.cardH };

  // 累计错开量：前面的牌按各自翻面状态贡献间距（最后一张不贡献）
  let y = geo.top;
  const cards = col.cards;
  for (let i = 0; i < k; i++) {
    y += cards[i].faceUp ? layout.faceUpGap : layout.faceDownGap;
  }
  return { x: geo.x, y, w: layout.cardW, h: layout.cardH };
}

/**
 * 第 c 列最后一张牌的 y（空列返回槽位顶）。移动动画的起/落点用——
 * 残影只要落在「那叠牌」上即可，逐张精确无必要。
 */
function tailTopY(layout, view, c) {
  const geo = layout.columns[c];
  const col = view && view.columns ? view.columns[c] : null;
  if (!col || !col.cards || !col.cards.length) return geo.top;
  let y = geo.top;
  const cards = col.cards;
  for (let i = 0; i < cards.length - 1; i++) {
    y += cards[i].faceUp ? layout.faceUpGap : layout.faceDownGap;
  }
  return y;
}

/** 命中底部按钮或提示胶囊，返回 key 或 null。 */
export function hitButton(layout, x, y) {
  for (const b of layout.buttons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.key;
  }
  const h = layout.hintButton;
  if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h.key;
  return null;
}

/* ───────────────────────── 牌桌与牌 ───────────────────────── */

/**
 * 牌桌底：只在牌桌区域铺一层半透明木色卡片（不画全屏背景，
 * 集成层的青白渐变会从四周透出来，形成「桌上铺了一块木牌垫」的观感）。
 *
 * 牌桌本体已经**向下延伸**（见 computeLayout 的 dropZone）——牌下面那一段空白木色
 * 就是留给玩家的「放置区」，让「下面还有地方放牌」这件事看得见。
 *
 * ⚠️ 性能：木色渐变按高度缓存（不再每帧 new 一个渐变）；空列底槽只给**空列**画，
 * 有牌的列本来就压在槽位上，画了也看不见（原来每帧固定把整排列都画一遍虚线槽）。
 *
 * @param view 可选：当前快照，用来判断哪些列是空的
 */
export function drawTable(ctx, layout, theme, view = null) {
  const t = layout.table;
  const r = Math.max(8, Math.round(layout.pad * 0.9));

  ctx.save();
  ctx.shadowColor = tone(theme, 'boardShadow', 'rgba(0,0,0,0.5)');
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  pathRoundRect(ctx, t.x, t.y, t.w, t.h, r);
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.fill();
  ctx.restore();

  // 木色渐变（半透明，让青白底透出来）；坐标建在局部原点，按高度缓存复用
  const wood = cachedLinear(ctx, `wood|${Math.round(t.h)}`, 0, 0, 0, t.h, [
    [0, rgba(tone(theme, 'boardTop', '#efcb92'), 0.42)],
    [1, rgba(tone(theme, 'boardEdge', '#b1823a'), 0.46)],
  ]);
  ctx.save();
  ctx.translate(t.x, t.y);
  pathRoundRect(ctx, 0, 0, t.w, t.h, r);
  ctx.fillStyle = wood;
  ctx.fill();
  ctx.restore();

  // 上亮下暗的收边，做出「一块牌子」的厚度
  pathRoundRect(ctx, t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1, r);
  ctx.strokeStyle = rgba(tone(theme, 'boardEdgeSoft', '#fff0d2'), 0.55);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 木纹：几条极淡的横线，避免大片纯色
  ctx.save();
  pathRoundRect(ctx, t.x, t.y, t.w, t.h, r);
  ctx.clip();
  ctx.strokeStyle = 'rgba(120,80,30,0.06)';
  ctx.lineWidth = 1;
  const step = Math.max(18, Math.round(t.h / 14));
  ctx.beginPath();                     // 整组横线合并成一条路径，只描一次边
  for (let yy = t.y + step; yy < t.y + t.h; yy += step) {
    ctx.moveTo(t.x, yy);
    ctx.lineTo(t.x + t.w, yy + Math.sin(yy * 0.05) * 2);
  }
  ctx.stroke();
  ctx.restore();

  // 空列底槽：提示「这里可以放牌」。只画真空列——有牌的列看不见这条虚线。
  // 下方放置区里也补一行「预备槽」，把牌桌新延伸出来的纵深变成可见的落点。
  const emptyCols = [];
  if (view && view.columns) {
    for (const col of view.columns) if (col.empty) emptyCols.push(col.index);
  } else {
    for (const geo of layout.columns) emptyCols.push(geo.index);
  }
  if (emptyCols.length) {
    const slotR = Math.max(3, layout.cardW * 0.12);
    ctx.strokeStyle = 'rgba(120,80,30,0.20)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (const i of emptyCols) {
      const geo = layout.columns[i];
      subRoundRect(ctx, geo.x, geo.top, geo.w, layout.cardH, slotR);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** 牌面底色的两档色（与恒定尺寸绑定，用来建缓存渐变）。 */
const FACE_STOPS = [[0, '#fffdf8'], [1, '#f2e9da']];
/** 牌背的两档色（深靛蓝）。 */
const BACK_STOPS = [[0, '#3b4a63'], [1, '#1d2637']];

/**
 * 一帧里所有牌共用的一套「预计算样式」：字号、圆角、阴影、斜纹间距、渐变对象。
 * 它们只跟牌宽/牌高/明牌间距有关，**每帧算一次**就够了 —— 旧版是每张牌现拼字体串、
 * 现建渐变（104 张 × 60 帧），纯属把同一份结果算了一万遍。
 *
 * ⚠️ 本次新增：角上的点数字号**受「露出来的那一条」（upGap）约束**。
 * 列数变少（5/7/9）后牌变大、同列张数变多，中后盘间距一定会被压缩；
 * 若字号只跟牌宽挂钩，点数会被下一张牌切掉一半（列数越少越严重）。
 * 现在按 `min(牌宽比例, 露出来的高度)` 取小值，牌再大也不会「看不清点数」，
 * 小花色符号塞不下时干脆不画（而不是露出半截）。
 *
 * @param {number} upGap 明牌错开间距（= 一张明牌真正露出来的高度）
 */
function cardStyle(w, h, grads, upGap) {
  const strip = Math.max(6, Math.round(upGap));
  const padY = Math.max(2, Math.round(w * 0.07));
  // 数字（无下伸部）的实际墨高约 0.75×字号，所以按 1.05 倍余量反推字号，
  // 保证「字形底边」仍在露出来的那一条之内（1.05×0.75 ≈ 0.79 < 1）。
  const rank1 = Math.max(8, Math.min(Math.round(w * 0.47), Math.round((strip - padY) * 1.05)));
  const rank2 = Math.max(8, Math.min(Math.round(w * 0.40), rank1));
  const suitSmall = Math.max(6, Math.min(Math.round(w * 0.30), Math.round(rank1 * 0.72)));
  const suitSmallDy = Math.round(rank1 * 1.02);
  return {
    face: grads.face,
    back: grads.back,
    radius: Math.max(3, Math.round(w * 0.11)),
    shadowBlur: Math.max(2, w * 0.10),
    shadowDy: Math.max(1, w * 0.05),
    padY,
    rankFont1: fontOf(700, rank1),
    rankFont2: fontOf(700, rank2),
    suitSmallFont: fontOf(700, suitSmall),
    suitBigFont: fontOf(700, Math.round(w * 0.78)),
    suitSmallDy,
    showSmallSuit: padY + rank1 * 1.02 + suitSmall <= strip,
    stripe: Math.max(4, w * 0.16),
    h,
  };
}

/**
 * 一张翻开的牌（默认尺寸；收集区那种小牌用不到，所以不再有 mini 分支）。
 *
 * ⚠️ 性能（本屏最贵的绘制）：
 *   - 底色渐变**按尺寸缓存**（坐标建在局部原点，靠 translate 就位），
 *     旧版每张牌 createLinearGradient 一个（104 张 × 60 帧 = 每秒 6000+ 个原生对象）；
 *   - 牌面与描边复用**同一条路径**（旧版底色与描边各建一次 pathRoundRect）；
 *   - 字体 / 圆角 / 阴影全部来自帧级预计算的 style，牌内不再算。
 */
function drawFaceUp(ctx, x, y, w, suit, rank, st) {
  const h = st.h;
  const color = (suit === 1 || suit === 3) ? RED : BLACK;
  const label = RANK_LABELS[rank] ?? '?';
  const suitChar = SUIT_CHARS[suit] ?? '?';

  ctx.save();                       // 变换卫生（规范 §11）：translate 必须被 save/restore 包住
  ctx.translate(x, y);

  ctx.shadowColor = 'rgba(60,40,10,0.30)';
  ctx.shadowBlur = st.shadowBlur;
  ctx.shadowOffsetY = st.shadowDy;
  pathRoundRect(ctx, 0, 0, w, h, st.radius);
  ctx.fillStyle = st.face;
  ctx.fill();

  // 描边前先把阴影关掉（旧版靠一次多余的 save/restore 清状态）
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = 'rgba(120,90,40,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();                     // 复用上面那条路径

  ctx.fillStyle = color;
  setText(ctx, 'left', 'top');
  ctx.font = label.length > 1 ? st.rankFont2 : st.rankFont1;
  ctx.fillText(label, w * 0.10, st.padY);

  // 左上角的小花色：塞不进「露出来的那一条」就不画（否则只露半截更难看）
  if (st.showSmallSuit) {
    ctx.font = st.suitSmallFont;
    ctx.fillText(suitChar, w * 0.10, st.padY + st.suitSmallDy);
  }

  ctx.font = st.suitBigFont;
  setText(ctx, 'right', 'bottom');
  ctx.globalAlpha = 0.92;
  ctx.fillText(suitChar, w * 0.94, h * 0.97);
  ctx.globalAlpha = 1;
  ctx.restore();                    // 字号/对齐/透明度/变换一起还原
}

/**
 * 一张未翻开的牌。
 *
 * ⚠️ 性能（这一步是旧版绘制调用的大头）：同列纵向错开时，未被翻开的牌只露出
 * faceDownGap（约 2–11px）那么一条，**剩下的 80% 画完立刻被下一张盖住**。
 * 旧版照样整张画：一个圆角矩形 + 一个渐变 + 十几笔斜纹 + 内描边，44 张暗牌
 * 每帧白烧 600+ 次描边。现在：
 *   - 只画露出来的那一条（顶部圆角、底部平口）；
 *   - 斜纹按这一条做**解析裁剪**，只留落在条内的那几笔，并合并成一条路径一次描边；
 *   - 牌背渐变 / 圆角 / 斜纹间距都来自帧级预计算的 style。
 *
 * @param {number} vis 真正露出来的高度（列尾整张可见时传 h）
 */
function drawFaceDown(ctx, x, y, w, vis, st) {
  const h = st.h;
  const r = st.radius;
  const show = Math.max(2, Math.min(h, Math.round(vis)));
  const full = show >= h - 0.5;     // 整张都露着（列尾暗牌，罕见）

  ctx.save();
  ctx.translate(x, y);

  if (full) pathRoundRect(ctx, 0, 0, w, h, r);
  else pathRoundRectTop(ctx, 0, 0, w, show, r);
  ctx.fillStyle = st.back;
  ctx.fill();

  // 斜纹 + 高光边：合并成一条路径，一次描边
  ctx.beginPath();
  const step = st.stripe;
  const t0 = h - show;
  for (let d = -h; d < w; d += step) {
    // 原斜线 (d,h) → (d+h,0)，取落在 y∈[0,show] ∩ x∈[0,w] 的那一段
    const tA = Math.max(t0, -d);
    const tB = Math.min(h, w - d);
    if (tA >= tB) continue;
    ctx.moveTo(d + tA, h - tA);
    ctx.lineTo(d + tB, h - tB);
  }
  if (full) {
    // 整张牌背：补一圈内描边
    const rr2 = Math.max(0, Math.min(Math.max(1, r - 1), (w - 2) / 2, (h - 2) / 2));
    ctx.moveTo(1 + rr2, 1);
    ctx.lineTo(w - 1 - rr2, 1);
    ctx.lineTo(w - 1, 1 + rr2);
    ctx.lineTo(w - 1, h - 1 - rr2);
    ctx.lineTo(w - 1 - rr2, h - 1);
    ctx.lineTo(1 + rr2, h - 1);
    ctx.lineTo(1, h - 1 - rr2);
    ctx.lineTo(1, 1 + rr2);
    ctx.closePath();
  } else {
    ctx.moveTo(0.5, 0.5);           // 条顶一抹亮光，压出「一层层叠起来」的层次
    ctx.lineTo(w - 0.5, 0.5);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

/* ───────────────────────── 牌桌绘制 ───────────────────────── */

/**
 * 画各列牌叠（列数按难度，简单 5 / 普通 7 / 困难 9）。
 *
 * 高亮规则（玩家一眼能看出「这叠能整体搬走」）：
 *   - 尾部可整体搬动的同花降序牌组：牌面加一圈暖色描边；
 *   - 选中的牌组：整体上浮 + 更强阴影 + 强调色描边；
 *   - 提示的源/目标列：脉冲描边。
 */
export function drawColumns(ctx, layout, view, theme, now) {
  const accent = tone(theme, 'accent', '#f0b429');
  const sel = view.selection;
  const hint = view.hint;
  const pulse = 0.55 + 0.45 * Math.sin((now ?? 0) / 320);
  const cardW = layout.cardW;
  const cardH = layout.cardH;
  const lift = Math.max(3, cardH * 0.06);
  const upGap = layout.faceUpGap;
  const downGap = layout.faceDownGap;
  // 帧级预计算：牌样式 + 两个在循环里反复用到的颜色串（旧版每张牌现拼一次）
  const st = cardStyle(cardW, cardH, cardGradients(ctx, cardW, cardH), upGap);
  const runStroke = rgba(accent, 0.55);
  const cardR = Math.max(3, cardW * 0.11);
  // 移动动画预判：列循环里据此跳过「正在飞的那张」，
  // 避免它被列循环与末尾动画段各画一次（那看起来就是「一闪而过的牌」）。
  const maPre = view.moveAnim;
  const maFlying = !!(maPre && ((now ?? maPre.at) - maPre.at) < MOVE_DUR_MS);
  // 发牌动画：{ startedAt, total } —— 第 i 列出发时刻 = startedAt + i × DEAL_STEP_MS。
  const deal = view.dealAnim;
  // 本帧还在飞的发牌（列内不画，循环结束后统一画在所有列之上）
  const flying = [];

  for (let c = 0; c < view.columns.length; c++) {
    const col = view.columns[c];
    const cards = col.cards;
    const geo = layout.columns[c];
    if (!cards.length) {
      drawEmptySlot(ctx, layout, c, theme);
      continue;
    }

    // 先一遍前缀累加算出每张牌的 y（O(n)）。旧版每张牌都调 cardRect，
    // 而 cardRect 内部又从第 0 张累加到第 k 张 —— 一列 n 张要加 n²/2 次。
    const ys = new Array(cards.length);
    let y = geo.top;
    for (let k = 0; k < cards.length; k++) {
      ys[k] = y;
      y += cards[k].faceUp ? upGap : downGap;
    }
    const lastY = ys[cards.length - 1];

    // 提示高亮：目标列先画一层底光
    if (hint && hint.to === c) {
      ctx.save();
      ctx.globalAlpha = 0.30 + pulse * 0.35;
      pathRoundRect(ctx, geo.x - 2, lastY - 2, cardW + 4, cardH + 4, Math.max(3, cardW * 0.14));
      ctx.fillStyle = rgba(accent, 0.55);
      ctx.fill();
      ctx.restore();
    }

    for (let k = 0; k < cards.length; k++) {
      const card = cards[k];
      // 正在飞行的那张牌不在列里画（改由末尾的动画段画，避免重复绘制造成闪烁）
      if (maFlying && maPre.toCol === c && k === cards.length - 1) continue;
      const inSelection = !!(sel && sel.col === c && k >= sel.index);
      let cy = inSelection ? ys[k] - lift : ys[k];
      // 发牌动画：每列最后一张就是新发的那张。按列序串行从发牌堆飞来——
      //   相位 <0：还没轮到这列（先不画，像牌还没发到这里）；
      //   [0,1) ：在飞（收进 flying，最后统一画牌背）；
      //   >=1   ：已落地，正常绘制。
      if (deal && k === cards.length - 1) {
        const phase = ((now ?? 0) - deal.startedAt - c * DEAL_STEP_MS) / DEAL_FLY_MS;
        if (phase < 1) {
          if (phase >= 0) flying.push({ x: geo.x, y: lastY, p: phase });
          continue;   // 未落地：列内跳过（含选中/可搬描边），飞行牌画在顶层
        }
      }

      ctx.save();
      if (card.faceUp) {
        drawFaceUp(ctx, geo.x, cy, cardW, card.suit, card.rank, st);
      } else {
        // 「露出来的那一条」＝ 下一张牌的 y − 本张的 y；列尾那张整张可见
        const vis = k < cards.length - 1 ? ys[k + 1] - ys[k] : cardH;
        drawFaceDown(ctx, geo.x, cy, cardW, vis, st);
      }
      ctx.restore();

      // 尾部可搬动牌组的暖色描边
      if (card.faceUp && col.movableFrom >= 0 && k >= col.movableFrom && !inSelection) {
        pathRoundRect(ctx, geo.x + 0.5, cy + 0.5, cardW - 1, cardH - 1, cardR);
        ctx.strokeStyle = runStroke;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // 选中态描边
      if (inSelection) {
        pathRoundRect(ctx, geo.x + 0.5, cy + 0.5, cardW - 1, cardH - 1, cardR);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 提示源列：在尾部牌组外框上打脉冲
    if (hint && hint.from === c) {
      const rect = { x: geo.x, y: ys[Math.max(0, cards.length - hint.count)], w: cardW, h: cardH };
      ctx.save();
      ctx.globalAlpha = 0.4 + pulse * 0.5;
      pathRoundRect(ctx, rect.x - 2, rect.y - 2, cardW + 4, cardH + 4, Math.max(3, cardW * 0.14));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  // 无效落点反馈：整个目标列闪红
  if (view.rejectCol != null && view.rejectCol >= 0) {
    const geo = layout.columns[view.rejectCol];
    const fade = view.rejectAt ? clamp01(1 - ((now ?? view.rejectAt) - view.rejectAt) / 420) : 1;
    if (fade > 0) {
      ctx.save();
      ctx.globalAlpha = fade * 0.75;
      pathRoundRect(ctx, geo.x - 2, geo.top - 2, layout.cardW + 4, layout.table.h, Math.max(3, layout.cardW * 0.14));
      ctx.strokeStyle = tone(theme, 'danger', '#ef5f5f');
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.restore();
    }
  }

  // 发牌飞行牌：从发牌堆飞向各列列尾，画牌背、画在所有列之上。
  // 轨迹 = 发牌堆 → 列尾的直线，再叠一个上凸弧（sin 拱起），像手抛出去的一张牌。
  if (flying.length) {
    const sp = layout.stockPoint
      || { x: layout.width - layout.pad - cardW / 2, y: layout.height - layout.safe.bottom - layout.cardH };
    for (const f of flying) {
      const fx = sp.x + (f.x - sp.x) * f.p;
      const fy = sp.y + (f.y - sp.y) * f.p - Math.sin(f.p * Math.PI) * cardH * 0.55;
      ctx.save();
      ctx.globalAlpha = f.p < 0.12 ? 0.35 + 0.65 * (f.p / 0.12) : 1;   // 离手瞬间快速显形
      drawFaceDown(ctx, fx, fy, cardW, cardH, st);
      ctx.restore();
    }
  }

  // 移动动画（象棋落子三段手感）：0~40% 抬起 → 40~75% 滞空悬停 → 75~100% 加速落下。
  // 飞的是「刚落到目标列列尾的那张牌本身」（列循环里已按 maFlying 跳过它，不会重复绘制）。
  const ma = view.moveAnim;
  if (ma) {
    const raw = clamp01(((now ?? ma.at) - ma.at) / MOVE_DUR_MS);
    if (raw < 1) {
      const gA = layout.columns[ma.fromCol];
      const gB = layout.columns[ma.toCol];
      if (gA && gB) {
        // 起点 = 源列被搬走那组原来的位置（当前列尾再退一张明牌间距）；
        // 终点 = 目标列列尾（那组牌现在就在那里）。
        const yA = tailTopY(layout, view, ma.fromCol) + upGap;
        const yB = tailTopY(layout, view, ma.toCol);
        const liftH = cardH * 0.28;    // 抬起高度
        const hoverH = cardH * 0.52;   // 滞空时悬在目标上方的高度
        let xProg, dy, scale, squash;
        if (raw < 0.4) {
          // 抬起：原地略放大 + 上浮，同时小幅离手
          const q = easeOutQuad(raw / 0.4);
          xProg = 0.15 * q;
          dy = -liftH * q;
          scale = 1 + 0.06 * q;
          squash = 0;
        } else if (raw < 0.75) {
          // 滞空：easeOutCubic 先把路程走完、末端速度趋零 → 停在目标上方「悬」住
          const t = (raw - 0.4) / 0.35;
          xProg = 0.15 + 0.85 * (1 - Math.pow(1 - t, 3));
          dy = -liftH + (hoverH - liftH) * (1 - Math.pow(1 - t, 2));
          scale = 1.06;
          squash = 0;
        } else {
          // 落下：加速落到列尾，中段带一点压缩感（落地被「墩」一下）
          const q = easeInQuad((raw - 0.75) / 0.25);
          xProg = 1;
          dy = -hoverH * (1 - q);
          scale = 1.06 - 0.06 * q;
          squash = Math.sin(q * Math.PI) * 0.10;
        }
        const mx = gA.x + (gB.x - gA.x) * xProg;
        const my = yA + (yB - yA) * xProg + dy;
        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.translate(mx + cardW / 2, my + cardH / 2);
        ctx.scale(scale, scale * (1 - squash));   // 以牌中心缩放；squash 只压 y
        // 画「那张牌本身」——飞的是刚落到目标列列尾的那张（正面朝上就画正面）。
        // 不再是额外加一张牌背残影：那张牌已从列循环里跳过，这里就是它唯一的绘制点。
        const tcol = view.columns[ma.toCol];
        const tcard = tcol && tcol.cards.length ? tcol.cards[tcol.cards.length - 1] : null;
        if (tcard && tcard.faceUp) {
          drawFaceUp(ctx, -cardW / 2, -cardH / 2, cardW, tcard.suit, tcard.rank, st);
        } else {
          drawFaceDown(ctx, -cardW / 2, -cardH / 2, cardW, cardH, st);
        }
        ctx.restore();
      }
    }
  }
}

/** 空列槽位。 */
function drawEmptySlot(ctx, layout, c, theme) {
  const geo = layout.columns[c];
  pathRoundRect(ctx, geo.x, geo.top, layout.cardW, layout.cardH, Math.max(3, layout.cardW * 0.11));
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,80,30,0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/* ───────────────────────── 信息条 / 收集区 ───────────────────────── */

/**
 * 顶部信息条：收集区计数（K→A 已收几组）+ 剩余牌数 + 步数 + 用时 + 提示胶囊。
 * 集成层不画 HUD，这里自绘；左右角落留给集成层的返回/齿轮。
 */
export function drawInfoBar(ctx, layout, view, theme, now) {
  const info = layout.info;
  const accent = tone(theme, 'accent', '#f0b429');

  setText(ctx, 'left', 'middle');
  const cy = info.y + info.h / 2;

  // 收集区：8 个小方格里亮起已经收走的组数
  const box = Math.max(10, Math.round(info.h * 0.52));
  const step = box + Math.max(3, Math.round(box * 0.28));
  const totalW = box * 8 + (step - box) * 7;
  let x = info.x;

  // 先量一下文字宽度再决定把收集区放哪：这里简单左对齐，收集区排最前
  for (let i = 0; i < 8; i++) {
    const bx = x + i * step;
    const done = i < view.collected;
    pathRoundRect(ctx, bx, cy - box / 2, box, box, Math.max(2, box * 0.22));
    ctx.fillStyle = done ? rgba(accent, 0.85) : 'rgba(255,255,255,0.16)';
    ctx.fill();
    ctx.strokeStyle = done ? accent : 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (done) {
      // 已收走的那组画一个小花色点
      ctx.font = fontOf(700, box * 0.72);
      setText(ctx, 'center', 'middle');
      ctx.fillStyle = '#3a2a08';
      ctx.fillText('♠', bx + box / 2, cy + 0.5);
      setText(ctx, 'left', 'middle');
    }
  }

  // 计数与状态文字（「提示」已移到底部，信息条右侧不再被占位，可放心用整行宽度）
  const textX = info.x + totalW + Math.max(8, Math.round(layout.pad * 0.7));
  ctx.font = fontOf(700, Math.max(11, Math.round(theme.fontHud ?? 14) * 0.86));
  ctx.fillStyle = tone(theme, 'textPrimary', '#2f4f4a');
  ctx.fillText(`${view.collected}/8 组`, textX, cy);
  setText(ctx, 'left', 'middle');

  // 第二段：剩余牌堆 / 步数 / 用时
  const sec = view.elapsedMs ? formatClock(view.elapsedMs) : '00:00';
  const line2 = `牌堆 ${view.stock} · 步数 ${view.moves} · ${sec}`;
  ctx.font = fontOf(500, Math.max(10, Math.round((theme.fontSmall ?? 12) * 0.9)));
  ctx.fillStyle = tone(theme, 'textMuted', 'rgba(61,91,86,0.62)');
  setText(ctx, 'right', 'middle');
  ctx.fillText(line2, info.x + info.w, cy);
  setText(ctx, 'left', 'alphabetic');

  // 提示文案（提示按钮上方，一闪而过）
  if (view.toast && view.toast.text) {
    const age = view.toast.at ? (now ?? view.toast.at) - view.toast.at : 0;
    const fade = clamp01(1 - age / 1600);
    if (fade > 0) {
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.font = fontOf(600, Math.max(11, Math.round((theme.fontSmall ?? 12) * 0.95)));
      setText(ctx, 'center', 'middle');
      ctx.fillStyle = tone(theme, 'textPrimary', '#2f4f4a');
      ctx.fillText(view.toast.text, layout.width / 2,
        layout.hintButton.y - Math.round(layout.hintButton.h * 0.55));
      ctx.restore();
      setText(ctx, 'left', 'alphabetic');
    }
  }
}

/** 提示小胶囊（点一下给一步建议）。位置由 layout.hintButton 决定（底部一排上方、水平居中）。 */
export function drawHintPill(ctx, layout, view, theme) {
  const b = layout.hintButton;
  const accent = tone(theme, 'accent', '#f0b429');
  const pressed = view.pressButton === 'hint';

  pathRoundRect(ctx, b.x, b.y, b.w, b.h, b.h / 2);
  ctx.fillStyle = pressed ? rgba(accent, 0.34) : rgba(accent, 0.16);
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.62);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.font = fontOf(700, Math.max(10, Math.round((theme.fontSmall ?? 12) * 0.95)));
  setText(ctx, 'center', 'middle');
  ctx.fillStyle = tone(theme, 'textPrimary', '#2f4f4a');
  ctx.fillText('提示', b.x + b.w / 2, b.y + b.h / 2 + 0.5);
  setText(ctx, 'left', 'alphabetic');
}

/** 毫秒 → mm:ss（超过 99 分钟显示小时）。 */
export function formatClock(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const pad = (v) => (v < 10 ? `0${v}` : `${v}`);
  return m > 99 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* ───────────────────────── 底部按钮 ───────────────────────── */

/**
 * 底部三颗胶囊：重新开始 / 撤销 / 发牌。
 * 样式对齐 src/ui/renderer.js 的 drawButtons（主按钮强调色描边、禁用态降透明度）。
 */
export function drawButtons(ctx, layout, view, theme) {
  setText(ctx, 'center', 'middle');
  const accent = tone(theme, 'accent', '#f0b429');

  for (const btn of layout.buttons) {
    const pressed = view.pressButton === btn.key;
    const enabled = btn.key === 'restart'
      || (btn.key === 'undo' && view.canUndo)
      || (btn.key === 'deal' && view.canDeal);
    const primary = btn.key === 'deal';

    const bg = tone(theme, 'btnBg', 'rgba(255,255,255,0.08)');
    const bgPressed = tone(theme, 'btnBgPressed', 'rgba(255,255,255,0.16)');
    const border = tone(theme, 'btnBorder', 'rgba(255,255,255,0.14)');

    ctx.save();
    ctx.globalAlpha = enabled ? 1 : 0.42;
    pathRoundRect(ctx, btn.x, btn.y, btn.w, btn.h, btn.h / 2);
    ctx.fillStyle = !enabled
      ? 'rgba(120,100,70,0.10)'
      : (pressed ? bgPressed : (primary ? tone(theme, 'btnPrimaryBg', 'rgba(240,180,41,0.16)') : bg));
    ctx.fill();
    ctx.strokeStyle = primary && enabled ? tone(theme, 'btnPrimaryBorder', 'rgba(240,180,41,0.45)') : border;
    ctx.lineWidth = primary && enabled ? 1.6 : 1.1;
    ctx.stroke();

    // 文案：撤销带剩余次数，发牌带剩余轮数
    let label = '重新开始';
    if (btn.key === 'undo') label = view.canUndo ? `撤销 ${view.undoLeft}` : '撤销';
    else if (btn.key === 'deal') label = view.canDeal ? `发牌 ${view.dealsLeft}` : '发牌';

    ctx.font = fontOf(600, Math.max(12, theme.fontBtn ?? 15));
    ctx.fillStyle = !enabled
      ? tone(theme, 'textMuted', 'rgba(61,91,86,0.62)')
      : (primary ? accent : tone(theme, 'textPrimary', '#2f4f4a'));
    ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 0.5);
    ctx.restore();
  }
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 收牌动效 ───────────────────────── */

/**
 * 收走一组时的桌面提示：牌桌中央一圈暖色涟漪 + 四个角的花色符号。
 * 纯确定性 sin/cos，不引入随机数（每帧稳定，不抖动）。
 */
export function drawCollectFx(ctx, layout, view, theme, now) {
  if (!view.lastCollectAt) return;
  const age = (now ?? view.lastCollectAt) - view.lastCollectAt;
  if (age < 0 || age > 800) return;

  const t = clamp01(age / 800);
  const fade = 1 - clamp01((age - 320) / 480);
  const cx = layout.width / 2;
  const cy = layout.table.y + layout.table.h * 0.42;
  const R = Math.max(layout.table.w * 0.30, 90);
  const accent = tone(theme, 'accent', '#f0b429');

  ctx.save();
  for (let i = 0; i < 2; i++) {
    const rt = clamp01((t - i * 0.18) / 0.82);
    if (rt <= 0) continue;
    const rr = (1 - Math.pow(1 - rt, 3)) * R * (1 - i * 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.strokeStyle = i === 0 ? rgba(accent, 0.75 * fade) : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(2, layout.cardW * (i === 0 ? 0.22 : 0.14));
    ctx.stroke();
  }

  // 中央文字
  const pop = Math.min(1, age / 160);
  ctx.globalAlpha = fade * pop;
  ctx.font = fontOf(800, Math.max(18, layout.cardW * 1.5));
  setText(ctx, 'center', 'middle');
  ctx.fillStyle = accent;
  ctx.fillText('收牌 +1', cx, cy - Math.round((1 - pop) * 10));
  ctx.restore();
  setText(ctx, 'left', 'alphabetic');
}

/* ───────────────────────── 统一渲染入口 ───────────────────────── */

/**
 * 一帧完整绘制（牌桌 → 各列牌叠 → 收牌动效 → 信息条 → 底部按钮）。
 *
 * 注意：
 *   - **不画全屏背景**（集成层铺青白渐变底），只画牌桌区域；
 *   - **不画结算弹窗**（集成层读 outcome 统一画）；
 *   - **不画左上返回键与右上齿轮**（集成层画）。
 *
 * @param ctx Canvas 2D 上下文
 * @param layout computeLayout 的结果
 * @param view   渲染视图（由 index.js 组装：快照 + 交互态 + 时间戳）
 * @param theme   对局主题令牌
 * @param now     当前时间（ms，绝对时间戳）
 */
export function renderFrame(ctx, layout, view, theme, now) {
  // ⚠️ 不要在这里 clearRect：清屏与铺青白渐变底是**集成层**的职责（规范 §10）。
  // 早先这里有一句 ctx.clearRect(0,0,w,h)，会把集成层刚铺好的底色清掉，
  // canvas 变透明后露出页面深色背景（实机截图表现为整屏深灰）。
  drawTable(ctx, layout, theme, view);   // 传 view：空列底槽只给真空列画
  drawColumns(ctx, layout, view, theme, now);
  drawCollectFx(ctx, layout, view, theme, now);
  drawInfoBar(ctx, layout, view, theme, now);
  drawHintPill(ctx, layout, view, theme);
  drawButtons(ctx, layout, view, theme);

  // 胜利时给牌桌一圈金光（结算弹窗由集成层画）
  if (view.result === WON && view.winAt) {
    const age = (now ?? view.winAt) - view.winAt;
    const glow = clamp01(1 - age / 1400);
    if (glow > 0) {
      ctx.save();
      ctx.globalAlpha = glow * 0.5;
      pathRoundRect(ctx, layout.table.x - 3, layout.table.y - 3, layout.table.w + 6, layout.table.h + 6, Math.max(8, layout.pad));
      ctx.strokeStyle = tone(theme, 'success', '#4ade80');
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }
}
