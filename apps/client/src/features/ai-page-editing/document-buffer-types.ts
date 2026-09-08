export type BufferErrorCode =
  | 'STALE_REVISION'
  | 'BLOCK_NOT_FOUND'
  | 'TEXT_NOT_FOUND'
  | 'AMBIGUOUS_MATCH'
  | 'UNSUPPORTED_RANGE'
  | 'INVALID_CONTENT'
  | 'ACCESS_DENIED'
  | 'SESSION_UNAVAILABLE'
  | 'RESULT_UNKNOWN'
  | 'CANCELLED';

export type BufferCapability =
  | 'replace_text'
  | 'replace_code'
  | 'replace_math'
  | 'replace_inline_math'
  | 'replace_text_with_math'
  | 'delete_block'
  | 'insert_before'
  | 'insert_after';

export class BufferError extends Error {
  constructor(
    public readonly code: BufferErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'BufferError';
  }
}

export interface BufferBlock {
  blockId: string;
  type: string;
  depth: number;
  parentBlockId?: string;
  text: string;
  editable: boolean;
  capabilities: BufferCapability[];
  language?: string;
  truncated?: boolean;
  segments?: BufferSegment[];
}

export interface BufferSegment {
  index: number;
  type: 'text' | 'mathInline';
  text: string;
}

export interface BufferReadResult {
  revision: string;
  complete: boolean;
  blocks: BufferBlock[];
  nextOffset?: number;
  selection?: {
    text: string;
    from: number;
    to: number;
  };
}

export interface BufferReadInput {
  blockIds?: string[];
  offset?: number;
  limit?: number;
}

export interface ReplaceTextOperation {
  type: 'replace_text';
  blockId: string;
  oldText: string;
  newText: string;
  segmentIndex?: number;
}

export interface ReplaceCodeOperation {
  type: 'replace_code';
  blockId: string;
  oldText: string;
  newText: string;
  language?: string;
}

export interface ReplaceMathOperation {
  type: 'replace_math';
  blockId: string;
  oldText: string;
  newText: string;
}

export interface ReplaceInlineMathOperation {
  type: 'replace_inline_math';
  blockId: string;
  segmentIndex: number;
  oldText: string;
  newText: string;
}

export interface ReplaceTextWithMathOperation {
  type: 'replace_text_with_math';
  blockId: string;
  segmentIndex: number;
  oldText: string;
  newText: string;
}

export interface DeleteBlockOperation {
  type: 'delete_block';
  blockId: string;
}

export type BufferEditOperation =
  | ReplaceTextOperation
  | ReplaceCodeOperation
  | ReplaceMathOperation
  | ReplaceInlineMathOperation
  | ReplaceTextWithMathOperation
  | DeleteBlockOperation;

export interface BufferEditResult {
  changeId: string;
  revision: string;
  status: 'applied';
  affectedBlockIds: string[];
  changes: Array<{
    blockId: string;
    before: string;
    after: string;
    truncated?: boolean;
  }>;
}

export interface BufferInsertResult {
  changeId: string;
  revision: string;
  status: 'applied';
  affectedBlockIds: string[];
  changes: Array<{
    blockId: string;
    before: string;
    after: string;
    truncated?: boolean;
  }>;
}

export interface BufferInsertInput {
  expectedRevision: string;
  target:
    | { kind: 'document_start' }
    | { kind: 'document_end' }
    | { kind: 'before_block' | 'after_block'; blockId: string };
  markdown: string;
}

export interface BrowserToolResult {
  revision?: string;
  complete?: boolean;
  status?: 'applied';
  nextOffset?: number;
  blocks?: BufferBlock[];
  selection?: BufferReadResult['selection'];
  changeId?: string;
  affectedBlockIds?: string[];
  changes?: Array<{
    blockId: string;
    before: string;
    after: string;
    truncated?: boolean;
  }>;
}
