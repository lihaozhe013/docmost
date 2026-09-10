// Keep in sync with apps/server/src/integrations/ai-page-editing/contracts.ts
export const MAX_AI_IMAGES = 4;
export const MAX_AI_IMAGE_BYTES = 10 * 1024 * 1024;
export const AI_IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif';

const COMPRESS_MAX_EDGE = 2048;
const COMPRESS_SKIP_BYTES = 512 * 1024;
const COMPRESS_QUALITY = 0.9;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

export function isSupportedAiImage(file: File): boolean {
  if (!file.type.startsWith('image/')) return false;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.includes(extension);
}

export function validateAiImageBatch(
  currentCount: number,
  incoming: File[]
): string | null {
  if (currentCount + incoming.length > MAX_AI_IMAGES) {
    return `You can attach at most ${MAX_AI_IMAGES} images per message.`;
  }
  const oversized = incoming.find((file) => file.size > MAX_AI_IMAGE_BYTES);
  if (oversized) {
    return `"${oversized.name}" exceeds the ${Math.floor(
      MAX_AI_IMAGE_BYTES / (1024 * 1024)
    )}MB image limit.`;
  }
  return null;
}

/**
 * Downscale and re-encode oversized images so the request body and provider
 * token cost stay reasonable. Falls back to the original file when the canvas
 * pipeline is unavailable or fails.
 */
export async function compressImageForAi(file: File): Promise<File> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const width = bitmap.width;
    const height = bitmap.height;
    const maxEdge = Math.max(width, height);
    if (maxEdge <= COMPRESS_MAX_EDGE && file.size <= COMPRESS_SKIP_BYTES) {
      return file;
    }
    const scale = Math.min(1, COMPRESS_MAX_EDGE / maxEdge);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', COMPRESS_QUALITY)
    );
    if (!blob || blob.size >= file.size) return file;
    const baseName = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now()
    });
  } catch {
    return file;
  } finally {
    bitmap?.close?.();
  }
}
