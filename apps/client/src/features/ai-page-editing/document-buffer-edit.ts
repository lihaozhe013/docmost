import type { Editor } from '@tiptap/core';
import { BufferError } from './document-buffer-types';
import type { BufferEditOperation } from './document-buffer-types';
import {
  replaceInlineSegmentText,
  replaceInlineSegmentWithMath,
  validateLatex
} from './document-buffer-content';
import {
  getNodeText,
  isDirectTextBlock,
  isSingleTextNodeRange
} from './document-buffer-utils';
import { getInlineChildLocation } from './document-buffer-locations';
import type { BlockLocation } from './document-buffer-locations';

export type PreparedOperation = {
  operation: BufferEditOperation;
  location: BlockLocation;
  kind: 'text' | 'code' | 'node' | 'inline-node' | 'text-to-inline-math';
  from: number;
  to: number;
  before: string;
  after: string;
  attrs?: Record<string, unknown>;
};

export type EditChange = { blockId: string; before: string; after: string };

/**
 * Validates every operation against the current block locations and converts
 * it into a PreparedOperation describing the exact transaction step needed.
 */
export function prepareEditOperations(
  byId: Map<string, BlockLocation>,
  operations: BufferEditOperation[]
): PreparedOperation[] {
  const seen = new Set<string>();
  const prepared: PreparedOperation[] = [];

  for (const operation of operations) {
    if (seen.has(operation.blockId)) {
      throw new BufferError(
        'UNSUPPORTED_RANGE',
        `Multiple operations target block ${operation.blockId}`
      );
    }
    seen.add(operation.blockId);
    const location = byId.get(operation.blockId);
    if (!location) {
      throw new BufferError(
        'BLOCK_NOT_FOUND',
        `Block ${operation.blockId} was not found`
      );
    }
    if (!location.editable) {
      throw new BufferError(
        'UNSUPPORTED_RANGE',
        `Block ${operation.blockId} is protected or unsupported`
      );
    }

    if (operation.type === 'delete_block') {
      prepared.push({
        operation,
        location,
        kind: 'node',
        from: location.position,
        to: location.position + location.node.nodeSize,
        before: getNodeText(location.node),
        after: ''
      });
      continue;
    }

    if (operation.type === 'replace_code') {
      if (location.node.type.name !== 'codeBlock') {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Block ${operation.blockId} is not a code block`
        );
      }
      const before = location.node.textContent;
      if (before !== operation.oldText) {
        throw new BufferError(
          'TEXT_NOT_FOUND',
          `The complete code source was not found in block ${operation.blockId}`
        );
      }
      const attrs =
        operation.language === undefined
          ? undefined
          : { ...location.node.attrs, language: operation.language };
      prepared.push({
        operation,
        location,
        kind: 'code',
        from: location.position + 1,
        to: location.position + location.node.nodeSize - 1,
        before,
        after: operation.newText,
        ...(attrs ? { attrs } : {})
      });
      continue;
    }

    if (operation.type === 'replace_math') {
      if (location.node.type.name !== 'mathBlock') {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Block ${operation.blockId} is not a block formula`
        );
      }
      const before = String(location.node.attrs?.text ?? '');
      if (before !== operation.oldText) {
        throw new BufferError(
          'TEXT_NOT_FOUND',
          `The complete formula source was not found in block ${operation.blockId}`
        );
      }
      validateLatex(operation.newText, true, operation.blockId);
      prepared.push({
        operation,
        location,
        kind: 'node',
        from: location.position,
        to: location.position + location.node.nodeSize,
        before,
        after: operation.newText,
        attrs: { ...location.node.attrs, text: operation.newText }
      });
      continue;
    }

    if (
      operation.type === 'replace_inline_math' ||
      operation.type === 'replace_text_with_math'
    ) {
      if (
        location.node.type.name !== 'paragraph' &&
        location.node.type.name !== 'heading'
      ) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Block ${operation.blockId} does not contain inline formula segments`
        );
      }
      const segment = getInlineChildLocation(
        location.node,
        location.position,
        operation.segmentIndex
      );
      if (!segment) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Segment ${operation.segmentIndex} was not found in block ${operation.blockId}`
        );
      }
      if (
        operation.type === 'replace_inline_math' &&
        segment.node.type.name !== 'mathInline'
      ) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Segment ${operation.segmentIndex} is not an inline formula`
        );
      }
      if (
        operation.type === 'replace_text_with_math' &&
        segment.node.type.name !== 'text'
      ) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Segment ${operation.segmentIndex} is not text`
        );
      }
      const segmentText =
        segment.node.type.name === 'mathInline'
          ? String(segment.node.attrs?.text ?? '')
          : (segment.node.text ?? '');
      let before = segmentText;
      let matchOffset = 0;
      if (operation.type === 'replace_inline_math') {
        if (segmentText !== operation.oldText) {
          throw new BufferError(
            'TEXT_NOT_FOUND',
            `The complete segment text was not found in block ${operation.blockId}`
          );
        }
      } else {
        matchOffset = segmentText.indexOf(operation.oldText);
        if (matchOffset === -1) {
          throw new BufferError(
            'TEXT_NOT_FOUND',
            `The exact text was not found in segment ${operation.segmentIndex}`
          );
        }
        if (matchOffset !== segmentText.lastIndexOf(operation.oldText)) {
          throw new BufferError(
            'AMBIGUOUS_MATCH',
            `The exact text occurs more than once in segment ${operation.segmentIndex}`
          );
        }
        before = getNodeText(location.node);
      }
      if (
        operation.newText.includes('\n') ||
        operation.newText.includes('\r')
      ) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          'Inline formulas cannot contain line breaks'
        );
      }
      validateLatex(operation.newText, false, operation.blockId);
      const attrs = { text: operation.newText };
      prepared.push({
        operation,
        location,
        kind:
          operation.type === 'replace_inline_math'
            ? 'inline-node'
            : 'text-to-inline-math',
        from: segment.position + matchOffset,
        to:
          segment.position +
          (operation.type === 'replace_inline_math'
            ? segment.node.nodeSize
            : matchOffset + operation.oldText.length),
        before,
        after:
          operation.type === 'replace_inline_math'
            ? operation.newText
            : replaceInlineSegmentWithMath(
                location.node,
                operation.segmentIndex,
                operation.oldText,
                operation.newText
              ),
        attrs
      });
      continue;
    }

    if (
      location.node.type.name !== 'paragraph' &&
      location.node.type.name !== 'heading'
    ) {
      throw new BufferError(
        'UNSUPPORTED_RANGE',
        `Block ${operation.blockId} does not contain editable text`
      );
    }
    if (operation.newText.includes('\n') || operation.newText.includes('\r')) {
      throw new BufferError(
        'UNSUPPORTED_RANGE',
        `Block ${operation.blockId} replacements cannot contain line breaks`
      );
    }

    let from: number;
    let before: string;
    let first: number;
    if (operation.segmentIndex !== undefined) {
      const segment = getInlineChildLocation(
        location.node,
        location.position,
        operation.segmentIndex
      );
      if (!segment || segment.node.type.name !== 'text') {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Segment ${operation.segmentIndex} is not editable text`
        );
      }
      before = segment.node.text ?? '';
      first = before.indexOf(operation.oldText);
      if (first === -1) {
        throw new BufferError(
          'TEXT_NOT_FOUND',
          `The exact text was not found in segment ${operation.segmentIndex}`
        );
      }
      if (first !== before.lastIndexOf(operation.oldText)) {
        throw new BufferError(
          'AMBIGUOUS_MATCH',
          `The exact text occurs more than once in segment ${operation.segmentIndex}`
        );
      }
      from = segment.position + first;
    } else {
      if (!isDirectTextBlock(location.node)) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Block ${operation.blockId} contains inline content; provide segmentIndex`
        );
      }
      before = location.node.textContent;
      first = before.indexOf(operation.oldText);
      if (first === -1) {
        throw new BufferError(
          'TEXT_NOT_FOUND',
          `The exact text was not found in block ${operation.blockId}`
        );
      }
      if (first !== before.lastIndexOf(operation.oldText)) {
        throw new BufferError(
          'AMBIGUOUS_MATCH',
          `The exact text occurs more than once in block ${operation.blockId}`
        );
      }
      if (
        !isSingleTextNodeRange(location.node, first, operation.oldText.length)
      ) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `The replacement in block ${operation.blockId} crosses formatting boundaries`
        );
      }
      from = location.position + 1 + first;
    }
    prepared.push({
      operation,
      location,
      kind: 'text',
      from,
      to: from + operation.oldText.length,
      before: getNodeText(location.node),
      after:
        operation.segmentIndex === undefined
          ? getNodeText(location.node).slice(0, first) +
            operation.newText +
            getNodeText(location.node).slice(first + operation.oldText.length)
          : replaceInlineSegmentText(
              location.node,
              operation.segmentIndex,
              operation.oldText,
              operation.newText
            )
    });
  }

  return prepared;
}

/**
 * Applies prepared operations to the transaction from the highest position
 * downward and returns the change summaries in application order.
 */
export function applyPreparedOperations(
  editor: Editor,
  transaction: any,
  locations: BlockLocation[],
  prepared: PreparedOperation[]
): EditChange[] {
  const changes: EditChange[] = [];
  const topLevelLocations = locations.filter((location) => location.topLevel);
  const deletedBlockIds = new Set(
    prepared
      .filter(
        (item) =>
          item.operation.type === 'delete_block' && item.location.topLevel
      )
      .map((item) => item.operation.blockId)
  );
  const preservedFinalBlockId =
    deletedBlockIds.size === topLevelLocations.length &&
    deletedBlockIds.size > 0
      ? topLevelLocations[0].blockId
      : undefined;
  for (const item of [...prepared].sort((a, b) => b.from - a.from)) {
    if (item.operation.type === 'delete_block') {
      if (!item.location.topLevel) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Block ${item.operation.blockId} is nested and cannot be deleted`
        );
      }
      const preserveFinalBlock =
        item.operation.blockId === preservedFinalBlockId &&
        item.location.node.content.size > 0 &&
        (item.location.node.type.name === 'paragraph' ||
          item.location.node.type.name === 'heading');
      if (
        item.operation.blockId === preservedFinalBlockId &&
        item.location.node.content.size === 0
      ) {
        const isEmptyTextBlock =
          item.location.node.type.name === 'paragraph' ||
          item.location.node.type.name === 'heading';
        if (isEmptyTextBlock) {
          throw new BufferError(
            'UNSUPPORTED_RANGE',
            'The final empty block cannot be deleted'
          );
        }
      }
      transaction.delete(
        preserveFinalBlock ? item.from + 1 : item.from,
        preserveFinalBlock ? item.to - 1 : item.to
      );
    } else if (item.kind === 'text' || item.kind === 'code') {
      const operation = item.operation as
        | Extract<BufferEditOperation, { type: 'replace_text' }>
        | Extract<BufferEditOperation, { type: 'replace_code' }>;
      transaction.insertText(operation.newText, item.from, item.to);
      if (item.kind === 'code' && item.attrs) {
        transaction.setNodeMarkup(
          item.location.position,
          undefined,
          item.attrs
        );
      }
    } else if (item.kind === 'node') {
      transaction.setNodeMarkup(item.location.position, undefined, item.attrs);
    } else if (item.kind === 'inline-node') {
      transaction.setNodeMarkup(item.from, undefined, item.attrs);
    } else {
      const operation = item.operation as Extract<
        BufferEditOperation,
        { type: 'replace_text_with_math' }
      >;
      const mathInline = editor.schema.nodes.mathInline;
      if (!mathInline) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          'Inline formulas are not supported by this editor'
        );
      }
      transaction.replaceWith(
        item.from,
        item.to,
        mathInline.create({ text: operation.newText })
      );
    }
    changes.push({
      blockId: item.operation.blockId,
      before: item.before,
      after: item.after
    });
  }
  return changes;
}
