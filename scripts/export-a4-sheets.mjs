#!/usr/bin/env node
/**
 * A4 学习稿导出（电脑端，2026-11-04 起）
 *
 * 用法：
 *   node scripts/export-a4-sheets.mjs --api http://127.0.0.1:28794/api/repertoire \
 *     --out 导出/A4学习稿 --song <曲目id>:<文件名> [--song ...] [--all]
 *
 * 版式：`src/lib/vocal/a4-compact.ts`（双栏；重复段进右栏并与首次出现处顶部对齐；
 *       中文一页，带中文译文的外语歌两页；无时间轴、无序号）。
 * 产物：`<out>/PDF/*.pdf` 与 `<out>/HTML/*.html` 分目录，互不混放。
 *
 * 依赖：本机 Chrome（headless 打印 PDF）、npx esbuild（打包 TS 排版模块）。
 * 找不到 Chrome 时用 --chrome <路径> 覆盖。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Songti SC",system-ui,sans-serif';
const SIZE_LADDER = [20, 19, 18, 17, 16, 15, 14.5, 14, 13.5, 13, 12.5, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6];

function parseArgs(argv) {
  const args = { api: '', out: '', songs: [], all: false, chrome: CHROME_DEFAULT, projectRoot: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--api') { args.api = next; i += 1; }
    else if (key === '--out') { args.out = next; i += 1; }
    else if (key === '--song') { args.songs.push(next); i += 1; }
    else if (key === '--chrome') { args.chrome = next; i += 1; }
    else if (key === '--project-root') { args.projectRoot = next; i += 1; }
    else if (key === '--all') args.all = true;
  }
  if (!args.api || !args.out) throw new Error('必须给 --api 与 --out');
  if (!args.all && !args.songs.length) throw new Error('必须给 --song <id>:<文件名> 或 --all');
  return args;
}

/** 用 esbuild 把 TS 排版模块打成临时 ESM，导出完即删。 */
function bundleLayout(projectRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-a4-'));
  const outfile = join(dir, 'a4-compact.mjs');
  execFileSync('npx', ['esbuild', 'src/lib/vocal/a4-compact.ts', '--bundle', '--format=esm', '--platform=node', `--outfile=${outfile}`], { cwd: projectRoot, stdio: 'ignore' });
  return { outfile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function htmlFor(sheet) {
  const body = sheet.pages.map((page) => {
    const runs = page.runs.map((run) => {
      const pos = run.align === 'right' ? `right:${(595.28 - run.x).toFixed(2)}pt` : `left:${run.x.toFixed(2)}pt`;
      return `<div class="run" style="${pos};top:${run.y.toFixed(2)}pt;font-size:${run.size}pt;font-weight:${run.weight};color:${run.muted ? '#555' : '#000'};${run.align === 'right' ? 'text-align:right;' : ''}">${escapeHtml(run.text)}</div>`;
    }).join('');
    const rules = page.rules.map((rule) => `<div style="position:absolute;left:${rule.x1.toFixed(2)}pt;top:${rule.y1.toFixed(2)}pt;width:${Math.abs(rule.x2 - rule.x1).toFixed(2)}pt;height:0;border-top:0.6pt ${rule.dashed ? 'dashed' : 'solid'} #bbb"></div>`).join('');
    return `<div class="page">${runs}${rules}</div>`;
  }).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(sheet.meta.title)}</title>
<style>
  @page { size: 595.28pt 841.89pt; margin: 0; }
  html,body { margin:0; padding:0; background:#fff; }
  .page { position:relative; width:595.28pt; height:841.89pt; overflow:hidden; page-break-after:always; break-after:page; }
  .page:last-child { page-break-after:auto; break-after:auto; }
  .run { position:absolute; font-family:${FONT}; line-height:1.34; white-space:pre; }
</style></head><body>${body}</body></html>`;
}

function printPdf(chrome, html, pdfPath) {
  const htmlPath = `${pdfPath}.tmp.html`;
  writeFileSync(htmlPath, html);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { stdio: 'ignore' });
  rmSync(htmlPath, { force: true });
  const raw = readFileSync(pdfPath).toString('latin1');
  return (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

const args = parseArgs(process.argv.slice(2));
const outRoot = resolve(args.out);
const pdfDir = join(outRoot, 'PDF');
const htmlDir = join(outRoot, 'HTML');
mkdirSync(pdfDir, { recursive: true });
mkdirSync(htmlDir, { recursive: true });

const { outfile, cleanup } = bundleLayout(args.projectRoot);
const { buildCompactSheet } = await import(`file://${outfile}`);

const items = (await (await fetch(args.api)).json()).items;
const targets = args.all
  ? items.filter((item) => item.kind === 'VOCAL').map((item) => ({ id: item.id, file: item.title }))
  : args.songs.map((entry) => {
      const [id, file] = entry.includes(':') ? entry.split(':') : [entry, entry];
      return { id, file };
    });

const made = [];
for (const target of targets) {
  const item = items.find((candidate) => candidate.id === target.id);
  if (!item) { console.error(`跳过 ${target.id}：清单里没有这首`); continue; }
  const auto = buildCompactSheet(item, item.sections || [], {});
  const ladder = SIZE_LADDER.filter((size) => size <= auto.meta.layout.fontSizePt);
  let chosen = null;
  for (const size of ladder) {
    const sheet = buildCompactSheet(item, item.sections || [], { size });
    if (sheet.meta.pageCount >= 99) break;
    const pdfPath = join(pdfDir, `${target.file}.pdf`);
    const pages = printPdf(args.chrome, htmlFor(sheet), pdfPath);
    if (pages === sheet.meta.pageCount) { chosen = { sheet, size, pages }; break; }
  }
  if (!chosen) {
    const sheet = buildCompactSheet(item, item.sections || [], { size: 6 });
    chosen = { sheet, size: 6, pages: printPdf(args.chrome, htmlFor(sheet), join(pdfDir, `${target.file}.pdf`)) };
  }
  writeFileSync(join(htmlDir, `${target.file}.html`), htmlFor(chosen.sheet));
  made.push({ file: target.file, pages: chosen.pages, lines: chosen.sheet.meta.lineCount, fontPt: chosen.size });
}
cleanup();
console.log(JSON.stringify(made, null, 2));
