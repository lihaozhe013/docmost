import { describe, expect, it } from 'vitest';
import {
  MAX_AI_IMAGES,
  MAX_AI_IMAGE_BYTES,
  compressImageForAi,
  isSupportedAiImage,
  validateAiImageBatch
} from './ai-image-upload';

function makeFile(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('ai-image-upload helpers', () => {
  it('accepts supported image files only', () => {
    expect(isSupportedAiImage(makeFile('a.png', 'image/png'))).toBe(true);
    expect(isSupportedAiImage(makeFile('b.webp', 'image/webp'))).toBe(true);
    expect(isSupportedAiImage(makeFile('c.svg', 'image/svg+xml'))).toBe(false);
    expect(isSupportedAiImage(makeFile('d.txt', 'text/plain'))).toBe(false);
  });

  it('rejects batches beyond the per-message limit', () => {
    const files = Array.from({ length: MAX_AI_IMAGES }, (_, index) =>
      makeFile(`img-${index}.png`, 'image/png')
    );
    expect(validateAiImageBatch(1, files)).toContain(
      `at most ${MAX_AI_IMAGES} images`
    );
    expect(validateAiImageBatch(0, files)).toBeNull();
  });

  it('rejects oversized images', () => {
    const big = new File([new Uint8Array(2)], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: MAX_AI_IMAGE_BYTES + 1 });
    expect(validateAiImageBatch(0, [big])).toContain('big.png');
  });

  it('falls back to the original file when the canvas pipeline is unavailable', async () => {
    const file = makeFile('shot.png', 'image/png');
    expect(typeof createImageBitmap).toBe('undefined');
    await expect(compressImageForAi(file)).resolves.toBe(file);
  });
});
