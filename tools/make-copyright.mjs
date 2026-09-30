/**
 * 软著（计算机软件著作权登记）材料生成器
 *
 * 依据《计算机软件著作权登记办法》与登记指南的规格：
 *   - 源程序：提交前、后各连续 30 页（共 60 页）；不足 60 页则全部提交
 *   - 每页不少于 50 行（最后一页应是程序结束页）
 *   - 页眉标注软件名称与版本号（须与申请表完全一致），右上角标注页码
 *   - A4、纵向、单面、黑白打印
 *
 * 本脚本产出：
 *   docs/copyright/<软件名>_源程序.txt     —— 纯文本版（含页眉页码，可直接打印）
 *   docs/copyright/<软件名>_源程序.html    —— 打印友好版（A4 分页，浏览器 Ctrl+P 存 PDF）
 *   docs/copyright/<软件名>_源代码统计.txt —— 行数统计（填申请表用，避免"申请表与材料不符"被补正）
 *
 * 用法：
 *   node tools/make-copyright.mjs "纯净玩棋类益智游戏合集软件" "V1.0"
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = join(ROOT, 'docs', 'copyright');

const SOFT_NAME = process.argv[2] ?? '纯净玩棋类益智游戏合集软件';
const SOFT_VERSION = process.argv[3] ?? 'V1.0';

const PAGE_LINES = 50;     // 每页行数（官方要求不少于 50 行）
const HEAD_PAGES = 30;     // 前 30 页
const TAIL_PAGES = 30;     // 后 30 页

/** 需要收进软著材料的源码目录/文件（按这个顺序拼接，前面放主入口与核心）。 */
const SOURCE_PLAN = [
  'game.js',
  'src/app.js',
  'src/core/board.js',
  'src/core/rules.js',
  'src/core/ai.js',
  'src/ui/theme.js',
  'src/ui/layout.js',
  'src/ui/renderer.js',
  'src/ui/screens.js',
  'src/audio/bgm.js',
];

/** 递归收集 src/ 下全部源码（预留给后续新增的游戏模块）。 */
function collectAll(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectAll(p, acc);
    else if (['.js', '.mjs'].includes(extname(name))) acc.push(p);
  }
  return acc;
}

/** 读取源码并转成"行数组"（去掉空行，符合"每页不少于50行且删空行"的实操惯例）。 */
function readLines(absPath) {
  const text = readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n').map((l) => l.replace(/\t/g, '  '));
  // 保留注释（软著材料里注释是合法代码组成），仅剔除纯空行
  return lines.filter((l) => l.trim().length > 0);
}

/** 组装全部源码行：先按 SOURCE_PLAN 顺序，再补上遗漏的源码文件。 */
function buildSourceLines() {
  const picked = new Set();
  const chunks = [];

  const pushFile = (absPath) => {
    if (!existsSync(absPath)) return;
    const rel = relative(ROOT, absPath).replace(/\\/g, '/');
    picked.add(rel);
    const lines = readLines(absPath);
    chunks.push({ rel, lines });
  };

  for (const rel of SOURCE_PLAN) pushFile(join(ROOT, rel));

  // 其余源码（例如后续新增的 games/ 模块）按路径排序补齐
  const rest = collectAll(join(ROOT, 'src'))
    .map((p) => relative(ROOT, p).replace(/\\/g, '/'))
    .filter((rel) => !picked.has(rel))
    .sort();
  for (const rel of rest) pushFile(join(ROOT, rel));

  return chunks;
}

/** 生成带页眉页码的分页文本。 */
function paginate(chunks) {
  const pages = [];
  let current = [];

  const flush = () => {
    if (current.length) { pages.push(current); current = []; }
  };

  for (const { rel, lines } of chunks) {
    // 文件之间加一行分隔注释，便于审核看到结构
    current.push(`// ===== FILE: ${rel} =====`);
    if (current.length >= PAGE_LINES) flush();
    for (const line of lines) {
      current.push(line);
      if (current.length >= PAGE_LINES) flush();
    }
  }
  flush();
  return pages;
}

/** 渲染一页的文本形态。 */
function renderTextPage(pageLines, pageNo, totalPages) {
  const header = `${SOFT_NAME} ${SOFT_VERSION}`;
  const right = `第 ${pageNo} / ${totalPages} 页`;
  const pad = Math.max(1, 96 - header.length - right.length);
  const out = [];
  out.push(header + ' '.repeat(pad) + right);
  out.push('-'.repeat(96));
  out.push(...pageLines);
  out.push('');
  out.push('\f'); // 换页符
  return out.join('\n');
}

/** 渲染打印友好的 HTML（A4 分页）。 */
function renderHtml(pages, selected) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sheets = selected.map(({ page, index }) => `
  <section class="sheet">
    <header><span>${esc(SOFT_NAME)} ${esc(SOFT_VERSION)}</span><span>第 ${index + 1} / ${pages.length} 页</span></header>
    <pre>${esc(page.join('\n'))}</pre>
  </section>`).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(SOFT_NAME)} ${esc(SOFT_VERSION)} · 源程序</title>
<style>
  @page { size: A4 portrait; margin: 12mm 10mm; }
  body { margin: 0; background: #f2f2f2; font-family: "Consolas", "Courier New", monospace; }
  .sheet {
    width: 210mm; min-height: 297mm; box-sizing: border-box;
    padding: 12mm 10mm; margin: 8mm auto; background: #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,.15);
    page-break-after: always; break-after: page;
  }
  .sheet header {
    display: flex; justify-content: space-between;
    font-size: 10.5pt; font-weight: 700; color: #000;
    border-bottom: 1px solid #000; padding-bottom: 3px; margin-bottom: 6px;
  }
  pre { font-size: 9.5pt; line-height: 1.35; margin: 0; white-space: pre-wrap; word-break: break-all; color: #000; }
  @media print {
    body { background: #fff; }
    .sheet { margin: 0; box-shadow: none; width: auto; min-height: auto; page-break-after: always; }
  }
</style>
</head>
<body>
${sheets}
</body>
</html>`;
}

/* ── 主流程 ── */
const chunks = buildSourceLines();
const totalLines = chunks.reduce((n, c) => n + c.lines.length, 0);
const pages = paginate(chunks);

const needSplit = pages.length > HEAD_PAGES + TAIL_PAGES;
const selected = needSplit
  ? [
    ...pages.slice(0, HEAD_PAGES).map((page, i) => ({ page, index: i })),
    ...pages.slice(pages.length - TAIL_PAGES).map((page, i) => ({ page, index: pages.length - TAIL_PAGES + i })),
  ]
  : pages.map((page, i) => ({ page, index: i }));

mkdirSync(OUT_DIR, { recursive: true });

// 1) 纯文本
const txt = selected.map(({ page, index }) => renderTextPage(page, index + 1, pages.length)).join('');
const txtPath = join(OUT_DIR, `${SOFT_NAME}_源程序.txt`);
writeFileSync(txtPath, txt, 'utf8');

// 2) 打印友好 HTML
const htmlPath = join(OUT_DIR, `${SOFT_NAME}_源程序.html`);
writeFileSync(htmlPath, renderHtml(pages, selected), 'utf8');

// 3) 统计（填申请表用：源程序总行数、页数必须与提交材料自洽）
const statsLines = [
  `软件名称：${SOFT_NAME}`,
  `版本号：${SOFT_VERSION}`,
  '',
  `源程序总行数（已去空行）：${totalLines}`,
  `按每页 ${PAGE_LINES} 行计，共 ${pages.length} 页`,
  needSplit
    ? `提交策略：前 ${HEAD_PAGES} 页 + 后 ${TAIL_PAGES} 页（共 ${selected.length} 页）`
    : `提交策略：总页数不足 ${HEAD_PAGES + TAIL_PAGES} 页，按规定全部提交（共 ${pages.length} 页）`,
  '',
  '包含的源文件（按材料中的顺序）：',
  ...chunks.map((c) => `  - ${c.rel}  (${c.lines.length} 行)`),
  '',
  '提示：',
  '  1. 申请表里填写的"源程序行数"应与上面一致，否则会被要求补正；',
  '  2. 页眉的软件名称、版本号必须与申请表完全相同；',
  '  3. HTML 版用浏览器打开 → Ctrl+P → 目标选"另存为 PDF" → 纸张 A4、纵向、页边距默认、勾选"背景图形"可留页眉线；',
  '  4. 打印后每页右上角应有页码，最后一页应是程序的结束页。',
].join('\n');
const statsPath = join(OUT_DIR, `${SOFT_NAME}_源代码统计.txt`);
writeFileSync(statsPath, statsLines, 'utf8');

console.log('软著材料已生成：');
console.log(`  软件名称：${SOFT_NAME}   版本号：${SOFT_VERSION}`);
console.log(`  源程序：${totalLines} 行 → ${pages.length} 页；本次提交 ${selected.length} 页`);
console.log(`  ${txtPath}`);
console.log(`  ${htmlPath}`);
console.log(`  ${statsPath}`);
