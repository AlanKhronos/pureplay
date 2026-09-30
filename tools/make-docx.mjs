/**
 * Markdown → .docx 生成器（零依赖：手写 OOXML + ZIP）
 *
 * 为什么自己写：项目坚持零依赖；pandoc 未安装；Word COM 依赖 Office 且会弹窗。
 * docx 本质是一个 ZIP，内含 [Content_Types].xml / _rels/.rels / word/document.xml 等。
 * 这里用 STORE（不压缩）方式打包，Word / WPS / LibreOffice 都能正常打开。
 *
 * 支持的 Markdown 语法：标题 #~######、段落、无序/有序列表、表格、代码块、
 * 引用、分隔线、**加粗**、*斜体*、`行内代码`、[链接](url)。
 *
 * 用法：
 *   node tools/make-docx.mjs <输入.md> <输出.docx> ["文档标题"]
 *   node tools/make-docx.mjs --batch <清单.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';

/* ───────────────────────── ZIP ───────────────────────── */

/** CRC32（ZIP 必需）。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 打一个 ZIP（STORE 方式，足够 docx 使用）。 */
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // 需要的版本
    local.writeUInt16LE(0x0800, 6);    // 标志位：文件名 UTF-8
    local.writeUInt16LE(0, 8);         // 压缩方式 0 = 存储
    local.writeUInt16LE(0, 10);        // 修改时间
    local.writeUInt16LE(0x2821, 12);   // 修改日期（2000-01-01 的固定值，保证可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, cdBuf, eocd]);
}

/* ───────────────────────── Markdown 解析 ───────────────────────── */

/** 行内解析：把 **粗体**、*斜体*、`代码`、[文字](链接) 拆成 run 数组。 */
function parseInline(text) {
  const runs = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) runs.push({ text: m[2], code: true });
    else if (m[3] !== undefined) runs.push({ text: m[3], italic: true });
    else if (m[4] !== undefined) runs.push({ text: m[5] === m[4] ? m[4] : `${m[4]}（${m[5]}）` });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text: '' }];
}

/** 把 Markdown 拆成块。 */
function parseBlocks(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 表格：| a | b | 后跟分隔行
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) {
          rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim()));
        }
        i++;
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }

    // 代码块
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); i++; continue; }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    // 引用
    if (/^>\s?/.test(line)) { blocks.push({ type: 'quote', text: line.replace(/^>\s?/, '') }); i++; continue; }

    // 列表（含任务清单）
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /^\d/.test(li[1]);
      let text = li[2];
      let checked = null;
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
      if (task) { checked = task[1].toLowerCase() === 'x'; text = task[2]; }
      blocks.push({ type: 'list', ordered, text, checked });
      i++;
      continue;
    }

    if (!line.trim()) { i++; continue; }

    blocks.push({ type: 'para', text: line.trim() });
    i++;
  }
  return blocks;
}

/* ───────────────────────── OOXML 生成 ───────────────────────── */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 行内 runs → OOXML。 */
function runsXml(text) {
  return parseInline(text).map((r) => {
    const props = [];
    if (r.bold) props.push('<w:b/><w:bCs/>');
    if (r.italic) props.push('<w:i/>');
    if (r.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:shd w:val="clear" w:fill="F1F3F5"/>');
    const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
    return `<w:r>${rPr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
  }).join('');
}

/** 段落。 */
function paraXml(text, opts = {}) {
  const { style, indent, spacingBefore, spacingAfter } = opts;
  const pPr = [];
  if (style) pPr.push(`<w:pStyle w:val="${style}"/>`);
  if (indent) pPr.push(`<w:ind w:left="${indent}"/>`);
  if (spacingBefore || spacingAfter) {
    pPr.push(`<w:spacing${spacingBefore ? ` w:before="${spacingBefore}"` : ''}${spacingAfter ? ` w:after="${spacingAfter}"` : ''}/>`);
  }
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${runsXml(text)}</w:p>`;
}

/** 表格。 */
function tableXml(rows) {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const totalW = 9000;
  const colW = Math.floor(totalW / cols);
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('');
  const grid = `<w:tblGrid>${Array(cols).fill(`<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`;
  const body = rows.map((row, ri) => {
    const cells = [];
    for (let c = 0; c < cols; c++) {
      const cellText = row[c] ?? '';
      const shade = ri === 0 ? '<w:shd w:val="clear" w:fill="F5EFE2"/>' : '';
      const pStyle = ri === 0 ? 'TableHead' : null;
      cells.push(
        `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${shade}<w:vAlign w:val="center"/></w:tcPr>`
        + paraXml(cellText, { style: pStyle }).replace('<w:p>', '<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>')
        + '</w:tc>',
      );
    }
    return `<w:tr>${cells.join('')}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${grid}${body}</w:tbl><w:p/>`;
}

/** 组装 document.xml 的 body。 */
function buildBody(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        const lv = Math.min(4, Math.max(1, b.level));
        out.push(paraXml(b.text, { style: `Heading${lv}` }));
        break;
      }
      case 'para':
        out.push(paraXml(b.text));
        break;
      case 'quote':
        out.push(paraXml(b.text, { style: 'Quote' }));
        break;
      case 'list': {
        const mark = b.checked === null || b.checked === undefined
          ? (b.ordered ? '•' : '•')
          : (b.checked ? '☑' : '☐');
        out.push(paraXml(`${mark} ${b.text}`, { indent: 340 }));
        break;
      }
      case 'code':
        for (const ln of b.text.split('\n')) {
          out.push(paraXml(ln || ' ', { style: 'CodeBlock' }));
        }
        break;
      case 'table':
        out.push(tableXml(b.rows));
        break;
      case 'hr':
        out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>');
        break;
      default:
        break;
    }
  }
  return out.join('\n');
}

/* ───────────────────────── 固定部件 ───────────────────────── */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/** 样式：中文用等线/微软雅黑，正文 10.5pt，标题分级。 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="微软雅黑" w:cs="Segoe UI"/>
<w:sz w:val="21"/><w:szCs w:val="21"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:before="60" w:after="60" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="260" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="34"/><w:szCs w:val="34"/><w:color w:val="2F4F4A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/><w:color w:val="3D5B56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="180" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="8A5F22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="3"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="340"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D9A95F"/></w:pBdr></w:pPr>
<w:rPr><w:i/><w:color w:val="5A6B68"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="240"/><w:spacing w:before="0" w:after="0" w:line="260" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableHead"><w:name w:val="Table Head"/><w:basedOn w:val="Normal"/>
<w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/>
</w:sectPr>
</w:body>
</w:document>`;
}

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title>
<dc:creator>纯净玩项目</dc:creator>
<cp:lastModifiedBy>纯净玩项目</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>pureplay-docx</Application>
</Properties>`;

/* ───────────────────────── 对外接口 ───────────────────────── */

/** 把一段 Markdown 转成 docx Buffer。 */
export function markdownToDocx(markdown, title = '文档') {
  const blocks = parseBlocks(markdown);
  const body = buildBody(blocks);
  return makeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/document.xml', data: documentXml(body) },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'docProps/core.xml', data: coreXml(title) },
    { name: 'docProps/app.xml', data: APP_XML },
  ]);
}

/** 命令行：单文件或按清单批量。 */
function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--batch') {
    const manifest = JSON.parse(readFileSync(argv[1], 'utf8'));
    for (const item of manifest) {
      const md = readFileSync(item.input, 'utf8');
      const buf = markdownToDocx(md, item.title ?? basename(item.input, '.md'));
      mkdirSync(dirname(item.output), { recursive: true });
      writeFileSync(item.output, buf);
      console.log(`  ✓ ${item.output}  (${Math.round(buf.length / 1024)} KB)`);
    }
    return;
  }

  const [input, output, title] = argv;
  if (!input || !output) {
    console.error('用法: node tools/make-docx.mjs <输入.md> <输出.docx> ["标题"]');
    process.exit(2);
  }
  const md = readFileSync(resolve(input), 'utf8');
  const buf = markdownToDocx(md, title ?? basename(input, '.md'));
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), buf);
  console.log(`✓ ${output}  (${Math.round(buf.length / 1024)} KB)`);
}

if (process.argv[1] && process.argv[1].endsWith('make-docx.mjs')) main();
