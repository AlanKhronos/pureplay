/**
 * 主题令牌（纯数据，无平台依赖）
 *
 * 两套视觉：
 *   THEME —— 对局界面：深色底衬托暖木棋盘，棋子用径向渐变做实体感
 *   MENU  —— 主界面：青白渐变底 + 木质感卡片/按钮（与棋盘同一套木色）
 */
export const THEME = {
  // ── 底色与容器（对局背景统一为青白渐变，与主界面同源）──
  bgTop: '#d7ecec',
  bgMid: '#e9f5f5',
  bgBottom: '#fbfdfd',
  panel: 'rgba(255,255,255,0.78)',
  panelBorder: 'rgba(150,110,50,0.28)',

  // ── 棋盘（木色）──
  boardTop: '#efcb92',
  boardBottom: '#d8a860',
  boardDark: '#7a5220',   // 深木边（投影/暗部用；此前多处引用它却不存在，拿到 undefined
  boardEdge: '#b1823a',
  boardEdgeSoft: 'rgba(255,240,210,0.55)',
  boardShadow: 'rgba(90,70,30,0.30)',
  gridLine: 'rgba(86,52,18,0.5)',
  gridLineStrong: 'rgba(70,40,12,0.72)',
  starPoint: 'rgba(70,40,12,0.9)',
  hoverGhost: 'rgba(60,50,30,0.28)',

  // ── 棋子 ──
  stoneBlackHi: '#5a5a68',
  stoneBlackMid: '#23232c',
  stoneBlackLo: '#0a0a0e',
  stoneWhiteHi: '#ffffff',
  stoneWhiteMid: '#f0f0f4',
  stoneWhiteLo: '#b9b9c6',
  stoneShadow: 'rgba(90,70,30,0.35)',

  // ── 文字与强调（浅底必须用深色文字）──
  textPrimary: '#2f4f4a',
  textMuted: 'rgba(61,91,86,0.62)',
  textOnWood: '#4a2f08',
  accent: '#b07d16',
  accentSoft: 'rgba(176,125,22,0.18)',
  danger: '#c0392b',
  success: '#2e7d4f',

  // ── 按钮（木质化，配合 drawWoodButton）──
  btnBg: 'rgba(255,255,255,0.94)',
  btnBgPressed: 'rgba(240,232,215,0.9)',
  btnBorder: 'rgba(170,135,80,0.45)',
  btnPrimaryBg: '#eec98f',
  btnPrimaryBorder: 'rgba(150,105,40,0.55)',
  woodTop: '#eec98f',
  woodBottom: '#d9a95f',
  woodEdge: '#b98a41',
  woodDeep: '#8a5f22',
  cardBg: 'rgba(255,255,255,0.85)',
  cardShadow: 'rgba(90,70,30,0.20)',

  // ── 字号（逻辑像素）──
  fontTitle: 22,
  fontHud: 14,
  fontBtn: 15,
  fontBig: 34,
  fontSmall: 12,

  // ── 节奏 ──
  placeAnimMs: 140,
  winPulseMs: 1200,
  aiThinkMinMs: 260,
};

/** 主界面主题：青白渐变 + 木质感。 */
export const MENU = {
  // 背景：青 → 白
  bgTop: '#d7ecec',
  bgMid: '#e9f5f5',
  bgBottom: '#fbfdfd',

  // 木质元素（与棋盘同一套色）
  woodTop: '#eec98f',
  woodBottom: '#d9a95f',
  woodEdge: '#b98a41',
  woodDeep: '#8a5f22',
  woodInk: '#5c3d10',

  cardBg: 'rgba(255,255,255,0.78)',
  cardBorder: 'rgba(150,110,50,0.28)',
  cardShadow: 'rgba(90,70,30,0.18)',

  selectedTop: '#e9bd75',
  selectedBottom: '#cf9a4c',
  selectedText: '#4a2f08',

  textTitle: '#2f4f4a',
  textBody: '#3d5b56',
  textMuted: 'rgba(61,91,86,0.62)',
  textOnWood: '#4a2f08',

  accentLine: 'rgba(120,170,165,0.55)',

  fontTitle: 30,
  fontSub: 13,
  fontCard: 17,
  fontCardSub: 11,
  fontLevel: 14,
  fontStart: 18,
};
