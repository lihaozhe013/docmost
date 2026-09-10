import { Injectable, Logger } from '@nestjs/common';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { StorageService } from '../../integrations/storage/storage.service';
import { getMimeType } from '../../common/helpers';
import { MAX_AI_IMAGES } from './contracts';

export const MAX_AI_IMAGE_BYTES = 10 * 1024 * 1024;

const AI_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

export class AiPageEditingImageError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AiPageEditingImageError';
  }
}

export interface AiImageScope {
  userId: string;
  workspaceId: string;
  pageId: string;
}

/**
 * Resolves uploaded page attachments into `data:` URLs for the current AI
 * page editing run only. Images are never replayed in later runs.
 */
@Injectable()
export class AiPageEditingImageService {
  private readonly logger = new Logger(AiPageEditingImageService.name);

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService
  ) {}

  async resolveImages(
    attachmentIds: string[],
    scope: AiImageScope
  ): Promise<string[]> {
    if (!attachmentIds.length) return [];
    if (attachmentIds.length > MAX_AI_IMAGES) {
      throw new AiPageEditingImageError(
        'INVALID_ATTACHMENT',
        `A prompt can include at most ${MAX_AI_IMAGES} images`
      );
    }

    const dataUrls: string[] = [];
    for (const attachmentId of new Set(attachmentIds)) {
      const attachment =
        (await this.attachmentRepo.findById(attachmentId)) ?? null;
      if (
        !attachment ||
        attachment.deletedAt ||
        attachment.creatorId !== scope.userId ||
        attachment.workspaceId !== scope.workspaceId ||
        attachment.pageId !== scope.pageId
      ) {
        throw new AiPageEditingImageError(
          'INVALID_ATTACHMENT',
          'One of the referenced images is unavailable for this page'
        );
      }

      const extension = (attachment.fileExt || '')
        .toLowerCase()
        .replace(/^\./, '');
      if (!AI_IMAGE_EXTENSIONS.has(extension)) {
        throw new AiPageEditingImageError(
          'UNSUPPORTED_IMAGE_TYPE',
          `Files with the ${extension || 'unknown'} extension cannot be sent as images`
        );
      }
      if (Number(attachment.fileSize ?? 0) > MAX_AI_IMAGE_BYTES) {
        throw new AiPageEditingImageError(
          'ATTACHMENT_TOO_LARGE',
          `Each image must stay under ${Math.floor(MAX_AI_IMAGE_BYTES / (1024 * 1024))}MB`
        );
      }

      let buffer: Buffer;
      try {
        buffer = await this.storageService.read(attachment.filePath);
      } catch (error) {
        this.logger.error(
          `[ai_page_editing] failed to read attachment ${attachmentId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        throw new AiPageEditingImageError(
          'INVALID_ATTACHMENT',
          'One of the referenced images could not be read from storage'
        );
      }
      const mimeType = attachment.mimeType || getMimeType(attachment.filePath);
      dataUrls.push(`data:${mimeType};base64,${buffer.toString('base64')}`);
    }
    return dataUrls;
  }
}
