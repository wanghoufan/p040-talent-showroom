import { describe, expect, it } from 'vitest';
import {
  A4_PDF_PIXELS, buildPdf, exportSheetPdf, renderPagesToJpeg, type RenderedPage,
} from '../../src/lib/vocal/pdf-export';
import type { A4SheetPage } from '../../src/lib/vocal/a4-sheet';

/** 零依赖 PDF：结构合法、xref 偏移可解析、页数正确。 */

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const fakeJpeg = (seed: number): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed, seed + 1, 0xff, 0xd9]);

const renderer = async (_page: A4SheetPage, index: number): Promise<RenderedPage> => ({
  jpeg: fakeJpeg(index),
  width: A4_PDF_PIXELS.width,
  height: A4_PDF_PIXELS.height,
});

const emptyPage = (index: number): A4SheetPage => ({ index, total: 2, runs: [], rules: [] });

const fakePages = (count: number): A4SheetPage[] =>
  Array.from({ length: count }, (_, i) => emptyPage(i + 1));

function startXref(text: string): number {
  const at = text.lastIndexOf('startxref');
  expect(at).toBeGreaterThan(0);
  const tail = text.slice(at + 'startxref'.length).trimStart();
  return Number.parseInt(tail.split(/\s+/)[0], 10);
}

describe('PDF 导出', () => {
  it('以 %PDF- 开头、以 %%EOF 结尾', () => {
    const bytes = buildPdf([
      { jpeg: fakeJpeg(1), width: 1240, height: 1754 },
      { jpeg: fakeJpeg(2), width: 1240, height: 1754 },
    ]);
    const text = latin1(bytes);

    expect(text.startsWith('%PDF-1.')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('页数与 /MediaBox 正确', async () => {
    const pages = fakePages(3);
    const bytes = buildPdf(await renderPagesToJpeg(pages, renderer));
    const text = latin1(bytes);

    expect(text).toContain('/Type /Pages /Kids [3 0 R 6 0 R 9 0 R] /Count 3');
    expect(text.match(/\/Type \/Page\b/g)).toHaveLength(3);
    expect(text.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)).toHaveLength(3);
    expect(text.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
  });

  it('xref 偏移能指回每个对象，图片字节原样写入', async () => {
    const pages = fakePages(2);
    const rendered = await renderPagesToJpeg(pages, renderer);
    const bytes = buildPdf(rendered);
    const text = latin1(bytes);

    const offset = startXref(text);
    expect(text.slice(offset, offset + 4)).toBe('xref');

    const header = text.slice(offset).match(/^xref\s+0\s+(\d+)\s+/);
    expect(header).not.toBeNull();
    const size = Number.parseInt(header![1], 10);
    expect(size).toBe(3 + pages.length * 3);

    const entries = text.slice(offset).split('\n').slice(2, 2 + size);
    expect(entries[0]).toBe('0000000000 65535 f ');
    for (let id = 1; id < size; id += 1) {
      const entry = entries[id];
      const objectOffset = Number.parseInt(entry.slice(0, 10), 10);
      expect(Number.isFinite(objectOffset)).toBe(true);
      expect(text.slice(objectOffset, objectOffset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
      expect(entry.endsWith('n ')).toBe(true);
    }

    for (const page of rendered) {
      const at = bytes.findIndex((_, i) => bytes[i] === page.jpeg[0]
        && bytes.slice(i, i + page.jpeg.byteLength).every((byte, j) => byte === page.jpeg[j]));
      expect(at).toBeGreaterThan(0);
    }
  });

  it('渲染器按页序调用，空文档直接报错而不是产出坏 PDF', async () => {
    const seen: number[] = [];
    const pages = fakePages(2);
    await renderPagesToJpeg(pages, async (page, index) => {
      seen.push(index);
      expect(page.index).toBe(index + 1);
      return renderer(page, index);
    });
    expect(seen).toEqual([0, 1]);

    expect(() => buildPdf([])).toThrowError('EMPTY_DOCUMENT');
    await expect(renderPagesToJpeg([], renderer)).rejects.toThrowError('EMPTY_DOCUMENT');
    await expect(exportSheetPdf([])).rejects.toThrowError('EMPTY_DOCUMENT');
  });
});
