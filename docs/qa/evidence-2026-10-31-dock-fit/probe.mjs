import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * 只读版式探针：把 vitest 由当前源码导出的沉浸页 DOM 塞进 headless Chrome，
 * 按 390/384/380/360/340 五个宽度量底部每条按钮：
 * 按钮盒宽、文字实际绘制宽（Range 量文本节点）、文字是否越出按钮盒、是否压到相邻按钮、
 * 是否被祖先 overflow 裁掉、字号是否低于 15px。用于回答「循环设置等是否被挤压或覆盖」。
 */

const ROOT = '/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅';
const DIR = join(ROOT, 'docs/qa/evidence-2026-10-31-dock-fit');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** 默认用仓库当前 CSS；CSS_DIR 指向一份旧样式副本时可直接复现「修复前」数值。 */
const CSS_DIR = process.env.CSS_DIR || join(ROOT, 'src');
const OUT = process.env.PROBE_OUT || 'layout-probe.json';
const THUMB = process.env.PROBE_THUMB || 'dock';
const CSS_FILES = ['src/index.css', 'src/app/theme.css', 'src/styles/vocal-practice.css'];
const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '393x791', width: 393, height: 791 },
  { name: '412x915', width: 412, height: 915 },
  { name: '428x926', width: 428, height: 926 },
  { name: '384x800', width: 384, height: 800 },
  { name: '380x800', width: 380, height: 800 },
  { name: '360x800', width: 360, height: 800 },
  { name: '353x800', width: 353, height: 800 },
  { name: '340x800', width: 340, height: 800 },
];
const DOMS = ['dump-immersive', 'dump-immersive-custom'];

const MEASURE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const dock = document.querySelector('.vocal-dock--immersive');
  if (!dock) return { error: 'no immersive dock' };
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: +b.left.toFixed(1), right: +b.right.toFixed(1), top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1) }; };
  // 逐文本节点量：每个节点自己的 client rects 数量＝该节点被排成几行（避免把图标与文字混算成多行）
  const textBox = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node = walker.nextNode();
    while (node) { if (node.textContent.trim()) nodes.push(node); node = walker.nextNode(); }
    if (!nodes.length) return null;
    const all = [];
    const perNode = [];
    for (const textNode of nodes) {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rects = [...range.getClientRects()].filter((b) => b.width > 0.5 && b.height > 0.5);
      if (!rects.length) continue;
      all.push(...rects);
      perNode.push({ text: textNode.textContent.trim().slice(0, 10), lines: rects.length });
    }
    if (!all.length) return null;
    return {
      left: +Math.min(...all.map((b) => b.left)).toFixed(1),
      right: +Math.max(...all.map((b) => b.right)).toFixed(1),
      nodes: perNode,
    };
  };
  const rows = ['.vocal-immersive__timeline', '.vocal-immersive__transport', '.vocal-immersive__practice', '.vocal-immersive__custom', '.vocal-immersive__tools'];
  const out = { vw, vh, dock: r(dock), dockBottom: +dock.getBoundingClientRect().bottom.toFixed(1), rows: [] };
  for (const selector of rows) {
    const row = dock.querySelector(selector);
    if (!row) continue;
    const buttons = [...row.querySelectorAll('button')];
    const items = buttons.map((button) => {
      const box = r(button);
      const t = textBox(button);
      const cs = getComputedStyle(button);
      const label = (button.getAttribute('aria-label') || '') + '｜' + button.textContent.trim().replace(/\\s+/g, ' ');
      const style = getComputedStyle(button);
      const overflowX = box.left < -0.5 || box.right > vw + 0.5;
      const textOverflowsBox = t ? (t.left < box.left - 0.5 || t.right > box.right + 0.5) : false;
      const clipped = style.overflow !== 'visible' || style.overflowX !== 'visible';
      return { label, box, text: t, fontSize: parseFloat(cs.fontSize), whiteSpace: cs.whiteSpace, textOverflowsBox, overflowX, clipped, disabled: button.disabled };
    });
    // 相邻按钮只在同一行内比较：多列换行时，上一行末尾与下一行开头不是邻居
    const sameRow = (a, b) => Math.abs((a.box.top + a.box.bottom) / 2 - (b.box.top + b.box.bottom) / 2) < 20;
    const overlaps = [];
    for (let i = 0; i < items.length - 1; i += 1) {
      const a = items[i], b = items[i + 1];
      if (!sameRow(a, b)) continue;
      if (a.text && a.text.right > b.box.left + 0.5) overlaps.push({ from: a.label, to: b.label, overBy: +(a.text.right - b.box.left).toFixed(1) });
    }
    // 相邻按钮盒本身是否重叠（grid 定宽一般不会）
    const boxOverlaps = [];
    for (let i = 0; i < items.length - 1; i += 1) {
      const a = items[i], b = items[i + 1];
      if (!sameRow(a, b)) continue;
      if (a.box.right > b.box.left + 0.5) boxOverlaps.push({ from: a.label, to: b.label, overBy: +(a.box.right - b.box.left).toFixed(1) });
    }
    out.rows.push({ selector, row: r(row), columns: getComputedStyle(row).gridTemplateColumns, items, overlaps, boxOverlaps });
  }
  // 全局：底部区域任何文字是否越出视口
  out.dockTextBeyondViewport = out.rows.flatMap((row) => row.items).filter((item) => item.text && (item.text.left < -0.5 || item.text.right > vw + 0.5)).map((item) => item.label);
  out.minFontInDock = Math.min(...out.rows.flatMap((row) => row.items).map((item) => item.fontSize));
  // 状态行（自由练习 / 合练中 / 逐句循环…）也是底部要读的文字，单独量字号与是否越界
  const mode = dock.querySelector('.vocal-dock__mode');
  out.modeLine = mode ? { text: mode.textContent.trim(), fontSize: parseFloat(getComputedStyle(mode).fontSize), rect: r(mode) } : null;
  out.docScrollWidth = document.documentElement.scrollWidth;
  // 播放器不得超出视口底部（底部安全区由 --inset-bottom 计入 padding）
  out.dockFitsViewport = out.dockBottom <= vh + 0.5;
  out.buttonsBeyondViewport = out.rows.flatMap((row) => row.items).filter((item) => item.box.bottom > vh + 0.5 || item.box.top < -0.5).map((item) => item.label);
  return out;
})()`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  });
  return {
    call(method, params = {}) {
      id += 1;
      const messageId = id;
      socket.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
    },
    close() { socket.close(); },
  };
}

mkdirSync(join(DIR, 'probe'), { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--remote-debugging-port=9337',
  `--user-data-dir=${join(DIR, 'probe/chrome-profile')}`,
  'about:blank',
], { stdio: 'ignore' });

try {
  let version = null;
  for (let i = 0; i < 50 && !version; i += 1) {
    await wait(200);
    try { version = await (await fetch('http://127.0.0.1:9337/json/version')).json(); } catch { /* 等 Chrome 起来 */ }
  }
  if (!version) throw new Error('Chrome DevTools 未就绪');

  const pages = await (await fetch('http://127.0.0.1:9337/json/list')).json();
  const page = pages.find((entry) => entry.type === 'page');
  const session = await cdp(page.webSocketDebuggerUrl);
  await session.call('Page.enable');

  const results = [];
  for (const dom of DOMS) {
    for (const view of VIEWPORTS) {
      const sub = join(DIR, 'probe', `${dom}-${view.name}`);
      mkdirSync(sub, { recursive: true });
      const links = CSS_FILES.map((file) => {
        const source = readFileSync(join(CSS_DIR, file.replace(/^src\//, '')), 'utf8');
        const name = file.split('/').pop();
        writeFileSync(join(sub, name), source, 'utf8');
        return `<link rel="stylesheet" href="${name}" />`;
      }).join('');
      const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />${links}
<style>:root{--tabbar-height:72px;--android-inset-top:24px;--android-inset-bottom:16px}
html,body{margin:0;background:var(--bg);width:${view.width}px;height:${view.height}px;overflow:hidden}body{font-size:19px}</style>
</head><body>${readFileSync(join(ROOT, '.local', `${dom}.html`), 'utf8')}</body></html>`;
      const pagePath = join(sub, 'page.html');
      writeFileSync(pagePath, html, 'utf8');

      await session.call('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 2, mobile: true });
      await session.call('Page.navigate', { url: `file://${pagePath}` });
      await wait(600);
      const measured = await session.call('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      const value = measured.result.value ?? {};
      const shot = await session.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(DIR, `${THUMB}-${dom.replace('dump-immersive', 'immersive')}-${view.name}.png`), Buffer.from(shot.data, 'base64'));
      results.push({ dom, viewport: view.name, ...value });
    }
  }

  writeFileSync(join(DIR, OUT), JSON.stringify(results, null, 2), 'utf8');
  for (const entry of results) {
    console.log(`\n=== ${entry.dom} @ ${entry.viewport} minFont=${entry.minFontInDock} docScrollWidth=${entry.docScrollWidth} ===`);
    for (const row of entry.rows ?? []) {
      console.log(`  ${row.selector} columns=${row.columns}`);
      for (const item of row.items) {
        const t = item.text ? `text ${item.text.left}~${item.text.right} ${JSON.stringify(item.text.nodes)}` : 'text -';
        console.log(`    ${item.fontSize}px ${item.label}  box ${item.box.left}~${item.box.right} (${item.box.width}) ${t}${item.textOverflowsBox ? ' ✗文字越出按钮' : ''}${item.overflowX ? ' ✗按钮越出视口' : ''}`);
      }
      if (row.overlaps.length) console.log('    ✗ 文字压到相邻按钮:', JSON.stringify(row.overlaps));
      if (row.boxOverlaps.length) console.log('    ✗ 按钮盒重叠:', JSON.stringify(row.boxOverlaps));
    }
  }
  session.close();
} finally {
  chrome.kill('SIGTERM');
}
