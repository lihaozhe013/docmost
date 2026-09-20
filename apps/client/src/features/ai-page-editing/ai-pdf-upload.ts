// Keep in sync with apps/server/src/integrations/ai-page-editing/contracts.ts

export const MAX_AI_PDF_PAGES = 20;
export const AI_PDF_ACCEPT = '.pdf';
export const AI_ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.pdf';

const RENDER_MAX_EDGE = 2048;
const RENDER_MAX_SCALE = 4;
const RENDER_JPEG_QUALITY = 0.9;

export type PdfLoadErrorCode = 'PASSWORD_PROTECTED' | 'INVALID_PDF' | 'PDF_LOAD_FAILED';

export class PdfLoadError extends Error {
  constructor(
    public readonly code: PdfLoadErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PdfLoadError';
  }
}

export interface PdfPageRange {
  from: number;
  to: number;
}

let pdfjsLoading: Promise<typeof import('pdfjs-dist')> | null = null;

async function loadPdfjs() {
  if (!pdfjsLoading) {
    pdfjsLoading = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url'))
        .default as unknown as string;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsLoading;
}

export function isSupportedAiPdf(file: File): boolean {
  if (file.type === 'application/pdf') return true;
  return file.name.toLowerCase().endsWith('.pdf');
}

function mapPdfLoadError(error: unknown): PdfLoadError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') {
    return new PdfLoadError('PASSWORD_PROTECTED', 'Password-protected PDFs are not supported.');
  }
  if (name === 'InvalidPDFException') {
    return new PdfLoadError('INVALID_PDF', 'The file could not be read as a PDF.');
  }
  return new PdfLoadError(
    'PDF_LOAD_FAILED',
    error instanceof Error ? error.message : 'The PDF could not be opened.'
  );
}

async function openPdfDocument(file: File) {
  const pdfjs = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  try {
    const doc = await task.promise;
    return { doc, dispose: () => task.destroy() };
  } catch (error) {
    await task.destroy().catch(() => undefined);
    throw mapPdfLoadError(error);
  }
}

export async function getPdfPageCount(file: File): Promise<number> {
  const { doc, dispose } = await openPdfDocument(file);
  try {
    return doc.numPages;
  } finally {
    await dispose().catch(() => undefined);
  }
}

export interface ResolvedPdfPageRange extends PdfPageRange {
  pageCount: number;
}

// Optional-field result instead of a discriminated union: the client tsconfig
// disables strictNullChecks, which would erase the literal discriminants.
export interface PdfPageRangeResult {
  ok: boolean;
  value?: ResolvedPdfPageRange;
  error?: string;
}

export function resolvePdfPageRange(
  total: number,
  range: PdfPageRange,
  budget: number
): PdfPageRangeResult {
  const from = Math.floor(range.from);
  const to = Math.floor(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to > total || from > to) {
    return { ok: false, error: `Enter a page range within 1-${total}.` };
  }
  const pageCount = to - from + 1;
  if (pageCount > budget) {
    return {
      ok: false,
      error: `Only ${budget} image slot${budget === 1 ? '' : 's'} left for this message.`
    };
  }
  return { ok: true, value: { from, to, pageCount } };
}

function pdfStem(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '') || 'document';
}

export interface RenderPdfPagesOptions {
  range: PdfPageRange;
  budget: number;
  onPageProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export async function renderPdfPagesToImages(
  file: File,
  options: RenderPdfPagesOptions
): Promise<File[]> {
  const { doc, dispose } = await openPdfDocument(file);
  try {
    const resolved = resolvePdfPageRange(doc.numPages, options.range, options.budget);
    if (!resolved.ok) {
      throw new PdfLoadError('INVALID_PDF', resolved.error);
    }
    const { from, to, pageCount } = resolved.value;
    const images: File[] = [];
    const stem = pdfStem(file.name);
    for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
      if (options.isCancelled?.()) {
        throw new PdfLoadError('PDF_LOAD_FAILED', 'PDF conversion was cancelled.');
      }
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        RENDER_MAX_SCALE,
        Math.max(1, RENDER_MAX_EDGE / Math.max(base.width, base.height))
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvas, viewport }).promise;
      // Composite over white so pages without an opaque background do not
      // turn solid black once encoded as JPEG.
      const output = document.createElement('canvas');
      output.width = canvas.width;
      output.height = canvas.height;
      const context = output.getContext('2d');
      if (!context) {
        throw new PdfLoadError(
          'PDF_LOAD_FAILED',
          'Canvas rendering is unavailable in this browser.'
        );
      }
      context.fillStyle = 'rgb(255, 255, 255)';
      context.fillRect(0, 0, output.width, output.height);
      context.drawImage(canvas, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        output.toBlob(resolve, 'image/jpeg', RENDER_JPEG_QUALITY)
      );
      if (!blob) {
        throw new PdfLoadError('PDF_LOAD_FAILED', `Page ${pageNumber} could not be rendered.`);
      }
      images.push(
        new File([blob], `${stem}-p${pageNumber}.jpg`, {
          type: 'image/jpeg',
          lastModified: Date.now()
        })
      );
      options.onPageProgress?.(pageNumber - from + 1, pageCount);
    }
    return images;
  } finally {
    await dispose().catch(() => undefined);
  }
}
