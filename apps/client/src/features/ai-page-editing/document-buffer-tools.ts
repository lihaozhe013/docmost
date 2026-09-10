import { BufferError } from './document-buffer-types';
import {
  isRecord,
  isValidEditOperation,
  MAX_READ_BLOCKS
} from './document-buffer-utils';

function hasInvalidBlockIds(blockIds: unknown): boolean {
  return (
    !Array.isArray(blockIds) ||
    blockIds.some(
      (blockId: unknown) =>
        typeof blockId !== 'string' ||
        blockId.length < 1 ||
        blockId.length > 128
    )
  );
}

/**
 * Rejects malformed agent tool payloads before they reach the buffer
 * primitives, mirroring the checks those primitives perform.
 */
export function assertToolInput(toolName: string, input: any): void {
  if (toolName === 'read_buffer') {
    if (
      (input !== undefined && !isRecord(input)) ||
      (input !== undefined &&
        input.blockIds !== undefined &&
        hasInvalidBlockIds(input.blockIds)) ||
      (input !== undefined &&
        input.offset !== undefined &&
        (!Number.isInteger(input.offset) ||
          input.offset < 0 ||
          input.offset > 10_000)) ||
      (input !== undefined &&
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > MAX_READ_BLOCKS))
    ) {
      throw new BufferError(
        'INVALID_CONTENT',
        'read_buffer requires valid block IDs and pagination'
      );
    }
    return;
  }

  if (toolName === 'edit_buffer') {
    if (
      !isRecord(input) ||
      typeof input.expectedRevision !== 'string' ||
      input.expectedRevision.length < 1 ||
      input.expectedRevision.length > 128 ||
      !Array.isArray(input.operations) ||
      input.operations.length < 1 ||
      input.operations.length > 20 ||
      input.operations.some(
        (operation: unknown) => !isValidEditOperation(operation)
      )
    ) {
      throw new BufferError(
        'INVALID_CONTENT',
        'edit_buffer requires a revision and operations'
      );
    }
    return;
  }

  if (toolName === 'insert_blocks') {
    if (
      !isRecord(input) ||
      typeof input.expectedRevision !== 'string' ||
      input.expectedRevision.length < 1 ||
      input.expectedRevision.length > 128 ||
      !input.target ||
      typeof input.markdown !== 'string' ||
      !input.markdown.trim() ||
      input.markdown.length > 40_000 ||
      ![
        'document_start',
        'document_end',
        'before_block',
        'after_block'
      ].includes(input.target.kind) ||
      (['before_block', 'after_block'].includes(input.target.kind) &&
        (typeof input.target.blockId !== 'string' ||
          input.target.blockId.length < 1 ||
          input.target.blockId.length > 128))
    ) {
      throw new BufferError(
        'INVALID_CONTENT',
        'insert_blocks requires a revision, target, and Markdown'
      );
    }
  }
}
