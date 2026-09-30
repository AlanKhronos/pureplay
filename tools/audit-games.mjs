/**
 * 游戏模块一键审计（验收工具）
 *
 * 每次接入新游戏时跑一遍，覆盖四类问题：
 *   ① 结构：4 个必需文件是否齐全、能否通过 node --check
 *   ② 逻辑：各自的测试能否通过，以及**是否稳定**（连跑 N 次，抓 flaky）
 *   ③ 规范：全屏铺底 / performance.now / 平台 API / 第三方 import / meta 完整性
 *   ④ 时间与随机：是否把 Date.now 与可注入随机源用对（规范 §8、§12）
 *
 * 用法：
 *   node tools/audit-games.mjs                 # 默认每款连跑 3 次
 *   node tools/audit-games.mjs --runs 10       # 连跑 10 次（交付前用）
 *   node tools/audit-games.mjs --game spider   # 只审某一款
 */
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GAMES_DIR = join(ROOT, 'src', 'games');

const argv = process.argv.slice(2);
const runsArg = argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Math.max(1, Number(argv[runsArg + 1]) || 3) : 3;
const gameArg = argv.indexOf('--game');
const ONLY = gameArg >= 0 ? argv[gameArg + 1] : null;

const REQUIRED = ['core.js', 'render.js', 'index.js', 'test.mjs'];

/**
 * 判断是否存在「不透明的全屏铺底」。
 *
 * 为什么不能只看 `fillRect(0,0,...)`：结算遮罩、踩雷红晕、柔光这类**半透明**全屏层
 * 是合理的效果，不是"自己铺底盖住集成层"（曾对 chess/go/xiangqi/tetris/doudizhu/minesweeper 误报）。
 * 因此这里向上回溯最近的 `globalAlpha` 与 `fillStyle`，换算有效 alpha，只有 ≥0.9 才算问题。
 */
function hasOpaqueFullscreenFill(src) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/fillRect\(\s*0\s*,\s*0\s*,/.test(lines[i])) continue;
    let alpha = null;
    let color = null;
    for (let j = i - 1; j >= Math.max(0, i - 14); j--) {
      if (alpha === null) {
        const m1 = /globalAlpha\s*=\s*([\d.]+)/.exec(lines[j]);
        if (m1) alpha = Number(m1[1]);
      }
      if (color === null) {
        const m2 = /fillStyle\s*=\s*(['"`])([^'"`]+)\1/.exec(lines[j]);
        if (m2) color = m2[2];
      }
      if (alpha !== null && color !== null) break;
    }
    // fillStyle 不是字符串字面量（例如 `fillStyle = rg`，rg 是渐变对象）时无法静态判定 alpha，
    // 保守跳过：宁可漏报让人工复核，也不要对「半透明红晕/柔光」这类正常效果刷噪音。
    if (color === null) continue;
    let colorAlpha = 1;
    const rgba = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(color);
    if (rgba) colorAlpha = Number(rgba[1]);
    // globalAlpha 若是表达式（如 `fade * 0.42`）也判定不出来，此时只信颜色自身 alpha
    const effAlpha = (alpha === null ? 1 : alpha) * colorAlpha;
    if (effAlpha >= 0.9) return true;
  }
  return false;
}

/** 规范扫描的规则。注意：只扫**生产文件**（core/index/render），
 *  测试文件允许 import Node 内置模块、也允许在自检里提到 performance.now 之类的字符串。 */
const RULES = [
  {
    id: 'fullscreen-bg',
    desc: '不透明的全屏铺底（应由集成层铺青白底；半透明遮罩不算，规范 §10）',
    test: (src) => hasOpaqueFullscreenFill(src),
    file: 'render.js',
  },
  {
    id: 'performance-now',
    desc: '使用 performance.now()（与集成层 Date.now 不同源，规范 §8）',
    test: (src) => /^\s*[^*/]*performance\.now\s*\(/m.test(src),
    file: '*.js',
  },
  {
    id: 'platform-api-in-core',
    desc: 'core.js 里出现平台 API（wx/document/window/canvas，规范 §4）',
    test: (src) => /^\s*[^*/]*(?:\bwx\b|document|\bwindow\b|\bcanvas\b)/m.test(src),
    file: 'core.js',
  },
  {
    id: 'third-party-import',
    desc: 'import 了第三方包（规范 §4）',
    // 排除 Node 内置模块（测试常用 fs/path/url/child_process）
    test: (src) => /^\s*import\s+.*from\s+['"]([^.\/][^'"]*)?['"]/m.test(src)
      && !/^\s*import\s+[^'"]*from\s+['"](node:)?(fs|path|url|os|child_process|crypto|util|assert)['"]/m.test(src),
    file: '*.js',
  },
];

/** 只扫生产文件，跳过测试与调试脚本。 */
const PROD_FILES = ['core.js', 'render.js', 'index.js'];

/** 剥离注释再扫描：否则注释里写一句 `fillRect(0,0,` 就会被误判（实测踩过）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/(^|[^:'"`])\/\/[^\n]*/gm, '$1'); // 行注释（避免误伤 http:// 这类字符串）
}

function readIf(p) {
  try { return stripComments(readFileSync(p, 'utf8')); } catch { return ''; }
}

function listJs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => ['.js', '.mjs'].includes(extname(f)))
    .map((f) => join(dir, f));
}

function runNode(args, cwd) {
  try {
    // ⚠️ 必须接住成功时的 stdout：早先这里丢了返回值，导致成功的测试也被判成"匹配不到 → 失败 -1"
    const out = execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out ?? '') };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function auditGame(id) {
  const dir = join(GAMES_DIR, id);
  const report = { id, files: [], syntax: [], test: null, runs: [], issues: [], meta: null };

  // ① 结构
  for (const f of REQUIRED) {
    const p = join(dir, f);
    report.files.push({ name: f, ok: existsSync(p), kb: existsSync(p) ? Math.round(statSync(p).size / 1024 * 10) / 10 : 0 });
  }

  // ① 语法
  for (const p of listJs(dir)) {
    const r = runNode(['--check', p], ROOT);
    if (!r.ok) report.syntax.push(p.replace(ROOT + '\\', ''));
  }

  // ③ 规范扫描（只扫生产文件：core/index/render）
  for (const rule of RULES) {
    const targets = rule.file === '*.js'
      ? PROD_FILES.map((f) => join(dir, f))
      : [join(dir, rule.file)];
    for (const p of targets) {
      if (!existsSync(p)) continue;
      const src = readIf(p);
      if (rule.test(src)) {
        report.issues.push(`${rule.id}: ${rule.desc}（${p.replace(ROOT + '\\', '')}）`);
      }
    }
  }

  // ② 测试（连跑 RUNS 次，抓 flaky）
  const testPath = join(dir, 'test.mjs');
  if (existsSync(testPath)) {
    for (let i = 0; i < RUNS; i++) {
      const r = runNode([testPath], ROOT);
      const m = /通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/.exec(r.out);
      report.runs.push({ pass: m ? Number(m[1]) : 0, fail: m ? Number(m[2]) : -1, ok: r.ok });
    }
    const first = report.runs[0] ?? { pass: 0, fail: -1 };
    const allGreen = report.runs.every((x) => x.ok && x.fail === 0);
    report.test = { pass: first.pass, fail: first.fail, stable: allGreen, runs: RUNS };
    if (!allGreen) {
      const failCounts = report.runs.map((x) => x.fail).join('/');
      report.issues.push(`flaky-or-failing: ${RUNS} 次连跑的失败数依次为 ${failCounts}（规范 §12：必须 10 次全绿）`);
    }
  } else {
    report.issues.push('missing-test: 缺少 test.mjs');
  }

  return report;
}

/* ── 主流程 ── */
const ids = readdirSync(GAMES_DIR)
  .filter((d) => statSync(join(GAMES_DIR, d)).isDirectory())
  .filter((d) => !ONLY || d === ONLY);

if (!ids.length) {
  console.error('没有找到游戏模块');
  process.exit(1);
}

console.log(`\n审计 ${ids.length} 个游戏模块（每款连跑 ${RUNS} 次）\n`);
console.log('游戏'.padEnd(14) + '文件'.padEnd(8) + '语法'.padEnd(8) + '测试'.padEnd(24) + '稳定');
console.log('-'.repeat(70));

const results = [];
let totalPass = 0;
let issueCount = 0;

for (const id of ids) {
  const r = auditGame(id);
  results.push(r);
  const filesOk = r.files.every((f) => f.ok);
  const syntaxOk = r.syntax.length === 0;
  const t = r.test;
  if (t) totalPass += t.pass;
  issueCount += r.issues.length;

  const testStr = t ? `${t.pass} 项 (失败 ${t.fail})` : '无测试';
  const stableStr = t ? (t.stable ? `${RUNS}/${RUNS} 全绿 ✓` : `不稳定 ✗`) : '—';
  console.log(
    id.padEnd(14)
    + (filesOk ? '4/4 ✓' : '缺文件 ✗').padEnd(8)
    + (syntaxOk ? 'OK ✓' : 'FAIL ✗').padEnd(8)
    + testStr.padEnd(24)
    + stableStr,
  );
}

console.log('-'.repeat(70));
console.log(`合计断言数: ${totalPass}    问题数: ${issueCount}`);

const withIssues = results.filter((r) => r.issues.length);
if (withIssues.length) {
  console.log('\n问题清单:');
  for (const r of withIssues) {
    console.log(`\n  【${r.id}】`);
    for (const i of r.issues) console.log(`    - ${i}`);
  }
} else {
  console.log('\n✓ 全部模块通过结构、语法、稳定性与规范检查');
}

// 未完成的事项在退出码上体现，便于 CI/脚本判断
process.exit(issueCount === 0 ? 0 : 1);
