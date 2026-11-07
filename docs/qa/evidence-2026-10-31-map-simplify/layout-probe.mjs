import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * 只读版式探针：把 vitest 落盘的真实抽屉 DOM 塞进 headless Chrome，
 * 用 CDP 把视口设成 393×791（Redmi WebView 实测值）与 360×640（小屏兜底），
 * 量：标题/关闭是否唯一、首屏能否看见选段与试听、保存键是否常驻、横向是否溢出、字号下限。
 */

const ROOT = '/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅';
const DIR = join(ROOT, '.local/map-probe');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CSS_FILES = ['src/app/theme.css', 'src/index.css', 'src/styles/vocal-practice.css'];
const VIEWPORTS = [
  { name: '393x791', width: 393, height: 791 },
  { name: '360x640', width: 360, height: 640 },
  { name: '340x700', width: 340, height: 700 },
];
const DOMS = ['dom-ref', 'dom-empty'];

const MEASURE = `(() => {
  const drawer = document.querySelector('.vocal-drawer');
  if (!drawer) return { error: 'no drawer' };
  const vw = innerWidth, vh = innerHeight;
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), height: +b.height.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1) }; };
  const cs = getComputedStyle(drawer);
  const byText = (text) => [...document.querySelectorAll('.vocal-drawer button')].find((b) => b.textContent.trim() === text) || null;
  const visible = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const inside = b.top >= 0 && b.bottom <= vh && b.width > 0; const hit = inside ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null; return { rect: r(el), insideViewport: inside, hittable: !!(hit && (hit === el || el.contains(hit))) }; };
  const headings = [...drawer.querySelectorAll('h1,h2,h3')].map((h) => h.textContent.trim());
  const closes = [...drawer.querySelectorAll('button')].filter((b) => /关闭/.test(b.getAttribute('aria-label') || ''));
  const steps = [...drawer.querySelectorAll('.vocal-map__steplabel')].map((n) => n.textContent.trim());
  const details = drawer.querySelector('details');
  const fontSizes = [...drawer.querySelectorAll('p,span,button,legend,summary,li')]
    .filter((el) => el.textContent.trim() && !el.querySelector('p,span,button,legend'))
    .map((el) => ({ tag: el.tagName.toLowerCase(), cls: el.className || '', size: parseFloat(getComputedStyle(el).fontSize), text: el.textContent.trim().slice(0, 18) }));
  const tooSmall = fontSizes.filter((entry) => entry.size < 14);
  const bodyTooSmall = fontSizes.filter((entry) => entry.size < 15 && !/__time|__flag|ruler|__index|__meta|clock/.test(entry.cls));
  let overflowX = 0;
  drawer.querySelectorAll('*').forEach((el) => { const b = el.getBoundingClientRect(); if (b.width && (b.right > vw + 0.5 || b.left < -0.5)) overflowX += 1; });
  drawer.scrollTop = 0;
  const out = {
    vw, vh, drawer: r(drawer), computedMaxHeight: cs.maxHeight, clientHeight: drawer.clientHeight, scrollHeight: drawer.scrollHeight,
    scrollable: drawer.scrollHeight - drawer.clientHeight > 1,
    headings, closeButtons: closes.length, steps,
    detailsOpen: details ? details.open : null,
    atTop: {
      chips: visible(drawer.querySelector('.vocal-map')),
      nowCard: visible(drawer.querySelector('.vocal-map__now')),
      play: visible(byText('▶ 试听')),
      loop: visible(byText('整段循环')),
      save: visible(byText('保存为人工结构')),
      emptyHint: visible(drawer.querySelector('.vocal-map__empty')),
      wave: visible(drawer.querySelector('.vocal-wave')),
    },
    overflowX, drawerScrollWidth: drawer.scrollWidth, drawerClientWidth: drawer.clientWidth,
    minFont: fontSizes.length ? Math.min(...fontSizes.map((entry) => entry.size)) : null,
    tooSmall,
    bodyTooSmall,
  };
  // 滚到底再看保存键与最后一个技术控件
  drawer.scrollTop = drawer.scrollHeight;
  out.atBottom = { save: visible(byText('保存为人工结构')), loadFile: visible(byText('载入参考文件')) };
  drawer.scrollTop = 0;
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
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
  return { call, close: () => socket.close() };
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9335',
  `--user-data-dir=${join(DIR, 'chrome-profile')}`,
  'about:blank',
], { stdio: 'ignore' });

try {
  let version = null;
  for (let i = 0; i < 50 && !version; i += 1) {
    await wait(200);
    try { version = await (await fetch('http://127.0.0.1:9335/json/version')).json(); } catch { /* 等 Chrome 起来 */ }
  }
  if (!version) throw new Error('Chrome DevTools 未就绪');

  const pages = await (await fetch('http://127.0.0.1:9335/json/list')).json();
  const page = pages.find((entry) => entry.type === 'page');
  const session = await cdp(page.webSocketDebuggerUrl);
  await session.call('Page.enable');
  await session.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const results = [];
  for (const dom of DOMS) {
    for (const view of VIEWPORTS) {
      const dir = join(DIR, 'out', `${dom}-${view.name}`);
      mkdirSync(dir, { recursive: true });
      const links = CSS_FILES.map((file) => {
        const source = readFileSync(join(ROOT, file), 'utf8');
        const name = file.split('/').pop();
        writeFileSync(join(dir, name), source, 'utf8');
        return `<link rel="stylesheet" href="${name}" />`;
      }).join('');
      const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />${links}
<style>:root{--tabbar-height:72px;--android-inset-top:24px;--android-inset-bottom:16px}body{margin:0}</style>
</head><body>${readFileSync(join(DIR, `${dom}.html`), 'utf8')}</body></html>`;
      const pagePath = join(dir, 'page.html');
      writeFileSync(pagePath, html, 'utf8');

      await session.call('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 2, mobile: true });
      await session.call('Page.navigate', { url: `file://${pagePath}` });
      await wait(700);
      const shot = await session.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(dir, 'shot-top.png'), Buffer.from(shot.data, 'base64'));
      const measured = await session.call('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      const value = measured.result.value ?? {};
      // 展开「参考与导入」再截一张：确认技术说明展开后不挤坏版式
      await session.call('Runtime.evaluate', { expression: "const d=document.querySelector('.vocal-map__more'); if(d) d.open=true; const dr=document.querySelector('.vocal-drawer'); dr.scrollTop = dr.scrollHeight;" });
      await wait(250);
      const shotMore = await session.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(dir, 'shot-more.png'), Buffer.from(shotMore.data, 'base64'));
      await session.call('Runtime.evaluate', { expression: "const d=document.querySelector('.vocal-map__more'); if(d) d.open=false;" });
      // 真实手势滚到底再截一张
      for (let step = 0; step < 12; step += 1) {
        await session.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(view.width / 2), y: Math.round(view.height / 2), deltaX: 0, deltaY: 200, pointerType: 'mouse' });
        await wait(40);
      }
      const shotBottom = await session.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(dir, 'shot-bottom.png'), Buffer.from(shotBottom.data, 'base64'));
      const scrolled = await session.call('Runtime.evaluate', { expression: "document.querySelector('.vocal-drawer').scrollTop", returnByValue: true });
      results.push({ dom, viewport: view.name, touchScrollTop: scrolled.result.value, ...value });
      writeFileSync(join(dir, 'result.json'), JSON.stringify(value, null, 2), 'utf8');
    }
  }

  console.log(JSON.stringify(results.map((entry) => ({
    页面: entry.dom, 视口: entry.viewport,
    标题: entry.headings, 关闭键数: entry.closeButtons, 步骤: entry.steps,
    '抽屉 高/可视/内容': `${entry.drawer?.height}/${entry.clientHeight}/${entry.scrollHeight}`,
    '可滚动': entry.scrollable, '技术区默认展开': entry.detailsOpen,
    '首屏·段卡': !!entry.atTop?.chips?.insideViewport,
    '首屏·选中段卡': !!entry.atTop?.nowCard?.insideViewport,
    '首屏·试听': !!entry.atTop?.play?.hittable,
    '首屏·循环': !!entry.atTop?.loop?.hittable,
    '首屏·保存': !!entry.atTop?.save?.hittable,
    '首屏·波形': !!entry.atTop?.wave?.insideViewport,
    '首屏·空态提示': !!entry.atTop?.emptyHint?.insideViewport,
    '横向溢出元素': entry.overflowX,
    '最小字号': entry.minFont,
    '低于14px': entry.tooSmall?.length,
    '正文低于15px': entry.bodyTooSmall?.map((e) => `${e.size}px ${e.cls}` ).slice(0, 6),
    '触控滚到底': entry.touchScrollTop,
    '底部·保存可点': !!entry.atBottom?.save?.hittable,
  })), null, 2));
  writeFileSync(join(DIR, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  session.close();
} finally {
  chrome.kill('SIGTERM');
}
