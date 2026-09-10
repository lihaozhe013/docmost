import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Mapping, Step } from '@tiptap/pm/transform';
import {
  BufferError,
  type BufferSegment,
  type BufferEditOperation,
  type BufferInsertInput
} from './document-buffer-types';

export type FallbackBinding = {
  blockId: string;
  position: number;
  end: number;
  type: string;
  topLevel: boolean;
  parentBlockId?: string;
};

export const MAX_READ_BLOCKS = 100;
export const MAX_BLOCK_TEXT = 20_000;
export const MAX_READ_RESULT_CHARS = 80_000;
export const MAX_CHANGE_TEXT = 2_000;

// Containers whose supported children are indexed as nested editable blocks.
export const NESTED_CONTAINER_TYPES = new Set([
  'bulletList',
  'orderedList',
  'blockquote',
  'taskList',
  'callout',
  'table'
]);

// Ancestors that keep a text block editable when the block is nested.
const EDITABLE_ANCESTOR_TYPES = new Set([
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'taskList',
  'taskItem',
  'callout',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader'
]);

export function isEditableBlock(
  node: ProseMirrorNode,
  doc?: ProseMirrorNode,
  position?: number
): boolean {
  const isTextBlock =
    (node.type.name === 'paragraph' || node.type.name === 'heading') &&
    isEditableInlineContent(node);
  const isCodeBlock =
    node.type.name === 'codeBlock' &&
    node.content.content.every((child) => child.type.name === 'text');
  const isMathBlock = node.type.name === 'mathBlock';
  if (!isTextBlock && !isCodeBlock && !isMathBlock) {
    return false;
  }
  if (!doc || position === undefined) return true;

  const resolved = doc.resolve(position + 1);
  for (let depth = 1; depth < resolved.depth; depth += 1) {
    if (!EDITABLE_ANCESTOR_TYPES.has(resolved.node(depth).type.name)) {
      return false;
    }
  }
  return true;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidEditOperation(
  value: unknown
): value is BufferEditOperation {
  if (!isRecord(value)) return false;
  if (
    typeof value.blockId !== 'string' ||
    value.blockId.length < 1 ||
    value.blockId.length > 128
  ) {
    return false;
  }
  if (value.type === 'delete_block') return true;
  if (
    typeof value.oldText !== 'string' ||
    value.oldText.length > MAX_BLOCK_TEXT ||
    typeof value.newText !== 'string' ||
    value.newText.length > MAX_BLOCK_TEXT
  ) {
    return false;
  }
  if (
    (value.type === 'replace_text' ||
      value.type === 'replace_text_with_math') &&
    value.oldText.length < 1
  ) {
    return false;
  }
  if (
    value.segmentIndex !== undefined &&
    (!Number.isInteger(value.segmentIndex) ||
      value.segmentIndex < 0 ||
      value.segmentIndex > 100)
  ) {
    return false;
  }
  if (value.type === 'replace_text') return true;
  if (value.type === 'replace_code' || value.type === 'replace_math') {
    return (
      value.type === 'replace_math' ||
      value.language === undefined ||
      (typeof value.language === 'string' &&
        value.language.length <= 64 &&
        !/[\r\n]/.test(value.language))
    );
  }
  if (
    value.type === 'replace_inline_math' ||
    value.type === 'replace_text_with_math'
  ) {
    return (
      Number.isInteger(value.segmentIndex) &&
      value.segmentIndex >= 0 &&
      value.segmentIndex <= 100
    );
  }
  return false;
}

export function isValidInsertInput(value: unknown): value is BufferInsertInput {
  if (!isRecord(value)) return false;
  if (
    typeof value.expectedRevision !== 'string' ||
    value.expectedRevision.length < 1 ||
    value.expectedRevision.length > 128 ||
    typeof value.markdown !== 'string' ||
    !value.markdown.trim() ||
    value.markdown.length > 40_000 ||
    hasRawHtmlOutsideLiterals(value.markdown) ||
    !isRecord(value.target) ||
    typeof value.target.kind !== 'string'
  ) {
    return false;
  }
  if (
    value.target.kind === 'document_start' ||
    value.target.kind === 'document_end'
  ) {
    return true;
  }
  return (
    (value.target.kind === 'before_block' ||
      value.target.kind === 'after_block') &&
    typeof value.target.blockId === 'string' &&
    value.target.blockId.length > 0 &&
    value.target.blockId.length <= 128
  );
}

export function getNodeText(node: ProseMirrorNode): string {
  if (node.type.name === 'mathBlock') return String(node.attrs?.text ?? '');
  if (node.type.name === 'codeBlock') return node.textContent;
  if (node.type.name === 'paragraph' || node.type.name === 'heading') {
    return node.content.content
      .map((child) => {
        if (child.type.name === 'mathInline') {
          return `$${String(child.attrs?.text ?? '')}$`;
        }
        if (child.type.name === 'hardBreak') return '\n';
        return child.text ?? '';
      })
      .join('');
  }
  return node.textBetween(0, node.content.size, '\n');
}

export function getInlineSegments(node: ProseMirrorNode): BufferSegment[] {
  if (node.type.name !== 'paragraph' && node.type.name !== 'heading') {
    return [];
  }
  return node.content.content
    .map((child, index) => {
      if (child.type.name === 'mathInline') {
        return {
          index,
          type: 'mathInline' as const,
          text: String(child.attrs?.text ?? '')
        };
      }
      if (child.type.name === 'text') {
        return { index, type: 'text' as const, text: child.text ?? '' };
      }
      return undefined;
    })
    .filter((segment): segment is BufferSegment => segment !== undefined);
}

export function compactChange(change: {
  blockId: string;
  before: string;
  after: string;
}): {
  blockId: string;
  before: string;
  after: string;
  truncated?: boolean;
} {
  const before = change.before.slice(0, MAX_CHANGE_TEXT);
  const after = change.after.slice(0, MAX_CHANGE_TEXT);
  return {
    blockId: change.blockId,
    before,
    after,
    ...(before.length !== change.before.length ||
    after.length !== change.after.length
      ? { truncated: true }
      : {})
  };
}

export function isDirectTextBlock(node: ProseMirrorNode): boolean {
  return node.content.content.every((child) => child.type.name === 'text');
}

function isEditableInlineContent(node: ProseMirrorNode): boolean {
  return node.content.content.every(
    (child) =>
      (child.type.name === 'text' || child.type.name === 'mathInline') &&
      !hasProtectedTextMark(child)
  );
}

function hasProtectedTextMark(node: ProseMirrorNode): boolean {
  return node.marks.some((mark) => mark.type.name === 'comment');
}

export function isSingleTextNodeRange(
  node: ProseMirrorNode,
  start: number,
  length: number
): boolean {
  let offset = 0;
  for (const child of node.content.content) {
    const end = offset + (child.text?.length || 0);
    if (start >= offset && start + length <= end) return true;
    offset = end;
  }
  return false;
}

export function isSupportedInsertedNode(node: ProseMirrorNode): boolean {
  const allowed = new Set([
    'paragraph',
    'heading',
    'bulletList',
    'orderedList',
    'listItem',
    'blockquote',
    'taskList',
    'taskItem',
    'callout',
    'table',
    'tableRow',
    'tableCell',
    'tableHeader',
    'horizontalRule',
    'text',
    'hardBreak',
    'codeBlock',
    'mathBlock',
    'mathInline'
  ]);
  if (!allowed.has(node.type.name)) return false;
  if (node.type.name === 'codeBlock') {
    return node.content.content.every((child) => child.type.name === 'text');
  }
  if (node.type.name === 'mathBlock' || node.type.name === 'mathInline') {
    return true;
  }
  return node.content.content.every(isSupportedInsertedNode);
}

function hasRawHtmlOutsideLiterals(markdown: string): boolean {
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '`' || character === '~') {
      let length = 1;
      while (markdown[index + length] === character) length += 1;
      if (character === '~' && length < 3) {
        index += length - 1;
        continue;
      }
      const delimiter = character.repeat(length);
      const closing = findUnescapedDelimiter(
        markdown,
        delimiter,
        index + length
      );
      if (closing !== -1) {
        index = closing + length - 1;
        continue;
      }
    }
    if (character === '$') {
      const length = markdown[index + 1] === '$' ? 2 : 1;
      const delimiter = '$'.repeat(length);
      const closing = findUnescapedDelimiter(
        markdown,
        delimiter,
        index + length
      );
      if (
        closing !== -1 &&
        (length === 2 || isInlineMathRange(markdown, index, closing))
      ) {
        index = closing + length - 1;
        continue;
      }
    }
    if (character === '<') {
      const rest = markdown.slice(index);
      if (/^<\/?[A-Za-z][^>]*>/.test(rest) || /^<!--[\s\S]*?-->/.test(rest)) {
        return true;
      }
    }
  }
  return false;
}

function findUnescapedDelimiter(
  markdown: string,
  delimiter: string,
  start: number
): number {
  let index = start;
  while (index < markdown.length) {
    const candidate = markdown.indexOf(delimiter, index);
    if (candidate === -1) return -1;
    let backslashes = 0;
    for (
      let cursor = candidate - 1;
      cursor >= 0 && markdown[cursor] === '\\';
      cursor -= 1
    ) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return candidate;
    index = candidate + delimiter.length;
  }
  return -1;
}

function isInlineMathRange(
  markdown: string,
  opening: number,
  closing: number
): boolean {
  const contentStart = opening + 1;
  return (
    (opening === 0 || markdown[opening - 1] === ' ') &&
    closing > contentStart &&
    !/\s/.test(markdown[contentStart]) &&
    !/\s/.test(markdown[closing - 1]) &&
    (closing + 1 >= markdown.length || !/\d/.test(markdown[closing + 1]))
  );
}

export function rangesOverlap(
  ranges: Array<{ from: number; to: number }>,
  mapping: Mapping,
  steps: Step[] = []
): boolean {
  for (const range of ranges) {
    for (const map of mapping.maps) {
      let overlaps = false;
      map.forEach((oldStart, oldEnd) => {
        if (oldStart === oldEnd) {
          overlaps ||=
            range.from === range.to
              ? oldStart === range.from
              : oldStart > range.from && oldStart < range.to;
        } else {
          overlaps ||= oldStart < range.to && oldEnd > range.from;
        }
      });
      if (overlaps) return true;
    }
  }
  for (const step of steps) {
    const candidate = step as Step & { from?: number; to?: number };
    if (
      typeof candidate.from !== 'number' ||
      typeof candidate.to !== 'number'
    ) {
      continue;
    }
    for (const range of ranges) {
      if (candidate.from === candidate.to) {
        if (
          range.from === range.to
            ? candidate.from === range.from
            : candidate.from > range.from && candidate.from < range.to
        ) {
          return true;
        }
      } else if (candidate.from < range.to && candidate.to > range.from) {
        return true;
      }
    }

    const position = (candidate as Step & { pos?: number }).pos;
    if (typeof position === 'number') {
      for (const range of ranges) {
        if (
          range.from === range.to
            ? position === range.from
            : position >= range.from && position <= range.to
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function rebaseFallbackBindings(
  bindings: Map<string, FallbackBinding>,
  transaction: { mapping: Mapping; steps?: Step[] }
): void {
  for (const [blockId, binding] of bindings) {
    const removedByStep = transaction.steps?.some((step) => {
      const candidate = step as Step & { from?: number; to?: number };
      return (
        typeof candidate.from === 'number' &&
        typeof candidate.to === 'number' &&
        candidate.to > candidate.from &&
        candidate.from <= binding.position &&
        candidate.to >= binding.end
      );
    });
    const from = transaction.mapping.mapResult(binding.position, 1);
    const to = transaction.mapping.mapResult(binding.end, -1);
    if (
      removedByStep ||
      from.deletedAcross ||
      to.deletedAcross ||
      from.pos > to.pos
    ) {
      bindings.delete(blockId);
      continue;
    }
    binding.position = from.pos;
    binding.end = to.pos;
  }
}

export function resolveBlockId(
  bindings: Map<string, FallbackBinding>,
  node: ProseMirrorNode,
  position: number,
  topLevel: boolean,
  parentBlockId: string | undefined,
  nextCounter: number
): { blockId: string; nextCounter: number } {
  const explicitId = node.attrs?.id;
  if (explicitId) return { blockId: String(explicitId), nextCounter };

  const existing = [...bindings.values()].find(
    (binding) =>
      binding.position === position &&
      binding.type === node.type.name &&
      binding.topLevel === topLevel &&
      binding.parentBlockId === parentBlockId
  );
  if (existing) {
    existing.end = position + node.nodeSize;
    return { blockId: existing.blockId, nextCounter };
  }

  const blockId = `b${nextCounter}`;
  bindings.set(blockId, {
    blockId,
    position,
    end: position + node.nodeSize,
    type: node.type.name,
    topLevel,
    ...(parentBlockId ? { parentBlockId } : {})
  });
  return { blockId, nextCounter: nextCounter + 1 };
}

export function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BufferError('CANCELLED', 'The document operation was cancelled');
  }
}
