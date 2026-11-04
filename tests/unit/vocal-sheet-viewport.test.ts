import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 弹层 / 歌词滚动区高度上限的回归测试。
 *
 * 背景（2026-10-31 真机 QA）：`src/styles/vocal-practice.css` 里 `.vocal-sheet` 只有
 * `max-height: 88dvh`。在丢弃该声明的 WebView 上（真机实测 computed max-height=none），
 * 弹层涨到内容高，backdrop 又是 align-items:flex-end，顶部被顶出视口且无法滚动，
 * 段落按钮点不到、无法合并。
 *
 * 因此约定：凡是靠「视口高度百分比」限高并配合 `overflow-y:auto` 的弹层或歌词区，
 * 都必须留一条不依赖动态视口单位（dvh/svh/lvh）的兜底——先写 `vh`，再写 `dvh`。
 * 本测试按「浏览器丢弃不支持的声明」的方式重放这些规则，不需要真机即可守住该缺陷。
 */

const FILES = {
  practice: readFileSync(resolve(process.cwd(), 'src/styles/vocal-practice.css'), 'utf8'),
  performance: readFileSync(resolve(process.cwd(), 'src/styles/vocal-performance.css'), 'utf8'),
  global: readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8'),
};

/** 取出某选择器的声明块（源码是格式化 CSS，单条规则一行）。 */
function ruleOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`找不到规则：${selector}`);
  return match[1];
}

/** 把每条声明拆成 [property, value]。 */
function declarations(block: string): Array<[string, string]> {
  return block
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const index = chunk.indexOf(':');
      return [chunk.slice(0, index).trim(), chunk.slice(index + 1).trim()] as [string, string];
    });
}

/** 模拟不认动态视口单位的 WebView：整条声明被丢弃。 */
function survivorsFor(block: string): Array<[string, string]> {
  return declarations(block).filter(([, value]) => !/\d(dvh|svh|lvh)\b/.test(value));
}

/** 按 CSS 层叠取最后一个生效值。 */
function lastValue(list: Array<[string, string]>, property: string): string | undefined {
  return list.filter(([name]) => name === property).pop()?.[1];
}

/** 本轮覆盖：唱歌弹层、练唱歌词、演出歌词、通用收录/核对弹层、沉浸页地图抽屉。 */
const CASES: Array<{ name: string; css: string; selector: string }> = [
  { name: '.vocal-sheet（练习设置 / 结构校准）', css: FILES.practice, selector: '.vocal-sheet' },
  { name: '.vocal-lyrics（练唱同步歌词）', css: FILES.practice, selector: '.vocal-lyrics' },
  { name: '.vocal-drawer（沉浸页地图抽屉 / 结构工作室抽屉）', css: FILES.practice, selector: '.vocal-drawer' },
  { name: '.perform-lyrics（演出同步歌词）', css: FILES.performance, selector: '.perform-lyrics' },
  { name: '.import-sheet（收录 / 批量收录 / 导入核对）', css: FILES.global, selector: '.import-sheet' },
];

describe.each(CASES)('$name 高度上限', ({ css, selector }) => {
  it('支持动态视口单位的浏览器上仍然限高并可滚动', () => {
    const block = ruleOf(css, selector);
    expect(lastValue(declarations(block), 'max-height')).toMatch(/\d/);
    expect(lastValue(declarations(block), 'overflow-y')).toBe('auto');
  });

  it('丢弃 dvh 声明后仍有非动态单位的 max-height 兜底', () => {
    const survivors = survivorsFor(ruleOf(css, selector));
    const maxHeight = lastValue(survivors, 'max-height');
    expect(maxHeight, '缺少 vh 兜底：旧 WebView 会把 max-height 退成 none').toBeDefined();
    expect(maxHeight).not.toMatch(/dvh|svh|lvh/);
    expect(maxHeight).toMatch(/^\d+(\.\d+)?(vh|px|%)$/);
  });

  it('兜底上限不超过九成视口，留出点击背景关闭或看下方内容的余量', () => {
    const survivors = survivorsFor(ruleOf(css, selector));
    const maxHeight = lastValue(survivors, 'max-height') ?? '';
    if (maxHeight.endsWith('vh')) {
      expect(Number.parseFloat(maxHeight)).toBeLessThanOrEqual(90);
      expect(Number.parseFloat(maxHeight)).toBeGreaterThan(30);
    }
    // 兜底失败时 max-height 会缺席，overflow-y:auto 也救不回来——这里一并守住。
    expect(lastValue(survivors, 'overflow-y')).toBe('auto');
  });

  it('兜底写在 dvh 之前，支持的浏览器仍取增强值', () => {
    const list = declarations(ruleOf(css, selector)).filter(([name]) => name === 'max-height');
    expect(list.length).toBeGreaterThanOrEqual(2);
    const last = list[list.length - 1][1];
    expect(last, 'dvh 必须写在最后，否则增强值会被 vh 覆盖').toMatch(/dvh$/);
  });
});
