import { describe, expect, it } from 'vitest';
import { MAX_AI_PDF_PAGES, isSupportedAiPdf, resolvePdfPageRange } from './ai-pdf-upload';

function makeFile(name: string, type: string): File {
  return new File([new Uint8Array(16)], name, { type });
}

describe('ai-pdf-upload helpers', () => {
  it('accepts PDF files by mime type or extension', () => {
    expect(isSupportedAiPdf(makeFile('spec.pdf', 'application/pdf'))).toBe(true);
    expect(isSupportedAiPdf(makeFile('spec.PDF', 'application/octet-stream'))).toBe(true);
    expect(isSupportedAiPdf(makeFile('notes.txt', 'text/plain'))).toBe(false);
  });

  it('resolves a valid page range within the budget', () => {
    const result = resolvePdfPageRange(50, { from: 3, to: 12 }, MAX_AI_PDF_PAGES);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ from: 3, to: 12, pageCount: 10 });
    }
  });

  it('rejects ranges outside the document', () => {
    expect(resolvePdfPageRange(5, { from: 0, to: 3 }, 20).ok).toBe(false);
    expect(resolvePdfPageRange(5, { from: 2, to: 6 }, 20).ok).toBe(false);
    expect(resolvePdfPageRange(5, { from: 4, to: 2 }, 20).ok).toBe(false);
  });

  it('rejects ranges beyond the remaining attachment budget', () => {
    const result = resolvePdfPageRange(50, { from: 1, to: 21 }, 20);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('20 image slots');
    }
  });
});
