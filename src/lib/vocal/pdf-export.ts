import { SHEET_FONT_STACK, type A4SheetPage } from './a4-sheet';

/**
 * 零依赖 PDF 生成（P040 §6）。
 *
 * 结构：每页一张 JPEG（DCTDecode）图像 XObject，画满 A4 纵向 `/MediaBox [0 0 595.28 841.89]`。
 * 不嵌字体、不联网、不引第三方库：中文/韩文由 canvas 在生成图像时落成像素，
 * 因此 PDF 里没有字体文件，也不存在字体子集缺失导致乱码的问题（最终效果取决于设备字体）。
 *
 * 测试用假 renderer 注入：`buildPdf` 只认字节，和 canvas 完全解耦。
 */

export interface RenderedPage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** 注入式渲染器：把一页排版数据画成 JPEG。 */
export type PageImageRenderer = (page: A4SheetPage, index: number) => Promise<RenderedPage>;

/** 150DPI 下 A4 的像素尺寸（1240 × 1754）。 */
export const A4_PDF_PIXELS = { width: 1240, height: 1754, dpi: 150, scale: 150 / 72 } as const;

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const encoder = new TextEncoder();

interface ByteSink {
  chunks: Uint8Array[];
  length: number;
}

function write(sink: ByteSink, data: Uint8Array | string): void {
  const chunk = typeof data === 'string' ? encoder.encode(data) : data;
  sink.chunks.push(chunk);
  sink.length += chunk.byteLength;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * 把已渲染的页面拼成一份可被 Preview / Chrome 打开的 PDF。
 * 每页三件对象：Page、Contents 流、Image XObject。
 */
export function buildPdf(pages: readonly RenderedPage[]): Uint8Array {
  if (!pages.length) throw new Error('EMPTY_DOCUMENT');
  const sink: ByteSink = { chunks: [], length: 0 };
  const offsets: number[] = [];

  /** 记录对象起始偏移，xref 才能指向真正的 `N 0 obj`。 */
  const beginObject = (id: number): void => {
    offsets[id] = sink.length;
    write(sink, `${id} 0 obj\n`);
  };

  write(sink, '%PDF-1.4\n');
  // 二进制标记，告诉传输/编辑器这不是纯文本。
  write(sink, new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');

  beginObject(1);
  write(sink, '<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  write(sink, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, i) => {
    const pageId = 3 + i * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;

    beginObject(pageId);
    write(sink, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);

    const content = `q\n${PAGE_W} 0 0 ${PAGE_H} 0 0 cm\n/Im0 Do\nQ\n`;
    beginObject(contentId);
    write(sink, `<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    const jpeg = page.jpeg;
    beginObject(imageId);
    write(sink, `<< /Type /XObject /Subtype /Image /Width ${Math.round(page.width)} /Height ${Math.round(page.height)} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`);
    write(sink, jpeg);
    write(sink, '\nendstream\nendobj\n');
  });

  const size = 3 + pages.length * 3;
  const xrefOffset = sink.length;
  write(sink, `xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id += 1) {
    const offset = offsets[id];
    if (typeof offset !== 'number') throw new Error('MISSING_OBJECT');
    write(sink, `${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  write(sink, `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return concat(sink.chunks, sink.length);
}

/** 依次调用注入的渲染器；任何一页失败都抛错，不输出缺页 PDF。 */
export async function renderPagesToJpeg(
  pages: readonly A4SheetPage[],
  renderer: PageImageRenderer,
): Promise<RenderedPage[]> {
  if (!pages.length) throw new Error('EMPTY_DOCUMENT');
  const rendered: RenderedPage[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    rendered.push(await renderer(pages[i], i));
  }
  return rendered;
}

/**
 * 真实渲染路径：`document.createElement('canvas')` + `toBlob('image/jpeg', 0.92)`。
 * 安卓 WebView 的字体与 canvas JPEG 质量仍需真机验证（见回报的 BLOCKED 项）。
 */
export function createCanvasRenderer(scale: number = A4_PDF_PIXELS.scale): PageImageRenderer {
  return async (page) => {
    if (typeof document === 'undefined') throw new Error('CANVAS_UNAVAILABLE');
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(PAGE_W * scale);
    canvas.height = Math.round(PAGE_H * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('CANVAS_UNAVAILABLE');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);

    for (const rule of page.rules) {
      ctx.beginPath();
      ctx.strokeStyle = rule.dashed ? '#b9b9b9' : '#8a8a8a';
      ctx.lineWidth = 0.6;
      ctx.setLineDash(rule.dashed ? [2, 2] : []);
      ctx.moveTo(rule.x1, rule.y1);
      ctx.lineTo(rule.x2, rule.y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.textBaseline = 'top';
    for (const run of page.runs) {
      ctx.font = `${run.weight} ${run.size}px ${SHEET_FONT_STACK}`;
      ctx.textAlign = run.align;
      ctx.fillStyle = run.muted ? '#4a4a4a' : '#111111';
      ctx.fillText(run.text, run.x, run.y);
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('JPEG_ENCODE_FAILED'));
      }, 'image/jpeg', 0.92);
    });
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    return { jpeg, width: canvas.width, height: canvas.height };
  };
}

/** 一步到位：排版数据 → JPEG → PDF 字节。 */
export async function exportSheetPdf(
  pages: readonly A4SheetPage[],
  renderer: PageImageRenderer = createCanvasRenderer(),
): Promise<Uint8Array> {
  return buildPdf(await renderPagesToJpeg(pages, renderer));
}
