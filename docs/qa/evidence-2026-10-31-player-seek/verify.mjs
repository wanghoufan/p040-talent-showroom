/**
 * 只读取证探针（本轮：顶栏/歌词字重行距/底部按钮在窄屏是否越界/抽屉关闭键是否常驻）。
 * 把 tmp-dump 生成的静态 DOM 灌进 headless Chrome，量真实几何；不改产品代码、不驱动 React。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const ROOT = '/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅';
const DIR = join(ROOT, '.local/probe-seek');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CSS_FILES = ['src/index.css', 'src/app/theme.css', 'src/styles/vocal-practice.css'];
const VIEWPORTS = [
  { name: '393x791', width: 393, height: 791 },
  { name: '360x800', width: 360, height: 800 },
  { name: '340x700', width: 340, height: 700 },
  { name: '428x926', width: 428, height: 926 },
];

const MEASURE_IMMERSIVE = `(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { left:+b.left.toFixed(1), right:+b.right.toFixed(1), top:+b.top.toFixed(1), bottom:+b.bottom.toFixed(1), width:+b.width.toFixed(1), height:+b.height.toFixed(1) }; };
  const root = document.querySelector('.vocal-practice.is-immersive');
  if (!root) return { error: 'no immersive root' };
  const bar = root.querySelector('.vocal-immersive__bar');
  const title = root.querySelector('.vocal-immersive__title');
  const sub = root.querySelector('.vocal-immersive__sub');
  const seg = root.querySelector('.vocal-immersive__segments');
  const more = root.querySelector('.vocal-immersive__more');
  const back = root.querySelector('.vocal-immersive__back');
  const chips = [...root.querySelectorAll('.vocal-segments__chip')].map((el) => ({ text: el.textContent.trim(), ...r(el) }));
  const line = root.querySelector('.vocal-line__text');
  const trans = root.querySelector('.vocal-line__translation-text');
  const lineStyle = line ? getComputedStyle(line) : null;
  const transStyle = trans ? getComputedStyle(trans) : null;
  const lineBox = line ? r(line.closest('.vocal-line')) : null;
  const items = [...root.querySelectorAll('.vocal-lyric-item')].slice(0, 3).map((el) => r(el));
  // 按钮逐行：文字是否越出按钮盒 / 是否压到相邻按钮
  const rows = ['.vocal-immersive__transport', '.vocal-immersive__practice', '.vocal-immersive__tools'];
  const bad = [];
  const overflow = [];
  for (const sel of rows) {
    const row = root.querySelector(sel);
    if (!row) continue;
    const buttons = [...row.querySelectorAll('button')];
    const boxes = buttons.map((b) => ({ label: b.textContent.trim(), ...r(b) }));
    for (let i = 0; i < buttons.length; i += 1) {
      const b = buttons[i];
      const box = boxes[i];
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (node.textContent.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width < 0.5) continue;
            if (rect.left < box.left - 0.5 || rect.right > box.right + 0.5) bad.push({ label: box.label, text: node.textContent.trim(), box, textRect: { left:+rect.left.toFixed(1), right:+rect.right.toFixed(1) } });
          }
        }
        node = walker.nextNode();
      }
      const style = getComputedStyle(b);
      if (box.left < -0.5 || box.right > innerWidth + 0.5) overflow.push(box.label);
      if (parseFloat(style.fontSize) < 15) bad.push({ label: box.label, fontSize: style.fontSize });
      if (i < buttons.length - 1 && box.right > boxes[i + 1].left + 0.5 && Math.abs(box.top - boxes[i + 1].top) < 10) bad.push({ overlap: [box.label, boxes[i + 1].label], overBy: +(box.right - boxes[i + 1].left).toFixed(1) });
    }
  }
  const dock = root.querySelector('.vocal-dock--immersive');
  const dockStyle = dock ? getComputedStyle(dock) : null;
  return {
    vw: innerWidth, vh: innerHeight, docScrollWidth: document.documentElement.scrollWidth,
    bar: bar ? r(bar) : null,
    back: back ? r(back) : null,
    title: title ? { ...r(title), fontSize: getComputedStyle(title).fontSize, weight: getComputedStyle(title).fontWeight, textAlign: getComputedStyle(title.parentElement).textAlign } : null,
    sub: sub ? r(sub) : null,
    seg: seg ? r(seg) : null,
    more: more ? r(more) : null,
    titleOverlapsSeg: title && seg ? r(title).right > r(seg).left + 0.5 : null,
    subOverlapsSeg: sub && seg ? r(sub).right > r(seg).left + 0.5 : null,
    chips,
    lyric: lineStyle ? { fontSize: lineStyle.fontSize, fontWeight: lineStyle.fontWeight, lineHeight: lineStyle.lineHeight, color: lineStyle.color, box: lineBox } : null,
    translation: transStyle ? { fontSize: transStyle.fontSize, fontWeight: transStyle.fontWeight, lineHeight: transStyle.lineHeight, color: transStyle.color } : null,
    lyricItemHeights: items.map((b) => b.height),
    dock: dock ? { ...r(dock), border: dockStyle.borderTopWidth, radius: dockStyle.borderRadius } : null,
    buttonTextOutOfBox: bad,
    buttonBeyondViewport: overflow,
    lyricsClientHeight: root.querySelector('.vocal-lyrics')?.clientHeight ?? null,
    lyricsScrollHeight: root.querySelector('.vocal-lyrics')?.scrollHeight ?? null,
  };
})()`;

const MEASURE_DRAWER = `(async () => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { left:+b.left.toFixed(1), right:+b.right.toFixed(1), top:+b.top.toFixed(1), bottom:+b.bottom.toFixed(1), width:+b.width.toFixed(1), height:+b.height.toFixed(1) }; };
  const drawer = document.querySelector('.vocal-drawer');
  if (!drawer) return { error: 'no drawer' };
  const closes = [...document.querySelectorAll('.vocal-drawer button')].filter((b) => (b.getAttribute('aria-label') || '').includes('关闭'));
  const close = closes[0];
  const before = close ? r(close) : null;
  drawer.scrollTop = drawer.scrollHeight;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const after = close ? r(close) : null;
  const center = close ? { x: (after.left + after.right) / 2, y: (after.top + after.bottom) / 2 } : null;
  const hit = center ? document.elementFromPoint(center.x, center.y) : null;
  const head = document.querySelector('.vocal-drawer .vocal-map__head');
  return {
    vw: innerWidth, vh: innerHeight,
    closeCount: closes.length,
    drawer: r(drawer), scrollTop: drawer.scrollTop, scrollHeight: drawer.scrollHeight, clientHeight: drawer.clientHeight,
    closeBefore: before, closeAfter: after,
    closeVisibleAfterScroll: after ? (after.top >= -0.5 && after.bottom <= innerHeight + 0.5) : false,
    hitIsClose: hit ? (hit === close || close.contains(hit)) : false,
    hitTag: hit ? hit.tagName + '.' + (hit.className || '') : null,
    headPosition: head ? getComputedStyle(head).position : null,
    headRect: head ? r(head) : null,
    saveBar: (() => { const el = document.querySelector('.vocal-studio__save'); return el ? r(el) : null; })(),
  };
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

mkdirSync(join(DIR, 'chrome'), { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--remote-debugging-port=9338', `--user-data-dir=${join(DIR, 'chrome/profile')}`, 'about:blank',
], { stdio: 'ignore' });

try {
  let version = null;
  for (let i = 0; i < 50 && !version; i += 1) {
    await wait(200);
    try { version = await (await fetch('http://127.0.0.1:9338/json/version')).json(); } catch { /* 等启动 */ }
  }
  if (!version) throw new Error('Chrome DevTools 未就绪');
  const pages = await (await fetch('http://127.0.0.1:9338/json/list')).json();
  const page = pages.find((entry) => entry.type === 'page');
  const session = await cdp(page.webSocketDebuggerUrl);
  await session.call('Page.enable');

  const results = [];
  for (const view of VIEWPORTS) {
    const sub = join(DIR, 'run', view.name);
    mkdirSync(sub, { recursive: true });
    const links = CSS_FILES.map((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const name = file.split('/').pop();
      writeFileSync(join(sub, name), source, 'utf8');
      return `<link rel="stylesheet" href="${name}" />`;
    }).join('');
    const wrap = (body) => `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />${links}
<style>:root{--tabbar-height:72px;--android-inset-top:24px;--android-inset-bottom:16px}
html,body{margin:0;background:var(--bg);width:${view.width}px;height:${view.height}px;overflow:hidden}body{font-size:19px}</style>
</head><body>${body}</body></html>`;

    for (const [name, file, expression] of [
      ['immersive', 'immersive.html', MEASURE_IMMERSIVE],
      ['drawer', 'drawer.html', MEASURE_DRAWER],
    ]) {
      const pagePath = join(sub, `${name}.html`);
      writeFileSync(pagePath, wrap(readFileSync(join(DIR, file), 'utf8')), 'utf8');
      await session.call('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 2, mobile: true });
      await session.call('Page.navigate', { url: `file://${pagePath}` });
      await wait(500);
      const measured = await session.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      const value = measured.result.value ?? {};
      if (measured.exceptionDetails) value.exception = measured.exceptionDetails.text;
      const shot = await session.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(DIR, `${name}-${view.name}.png`), Buffer.from(shot.data, 'base64'));
      results.push({ view: view.name, name, ...value });
    }
  }
  writeFileSync(join(DIR, 'verify.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results, null, 2));
  session.close();
} finally {
  chrome.kill('SIGTERM');
}
