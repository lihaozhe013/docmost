import type { Editor } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { BufferError } from './document-buffer-types';
import type {
  BufferBlock,
  BufferCapability,
  BufferReadResult
} from './document-buffer-types';
import {
  getInlineSegments,
  getNodeText,
  isEditableBlock,
  MAX_BLOCK_TEXT,
  NESTED_CONTAINER_TYPES,
  resolveBlockId
} from './document-buffer-utils';
import type { FallbackBinding } from './document-buffer-utils';

export type BlockLocation = {
  blockId: string;
  node: ProseMirrorNode;
  position: number;
  editable: boolean;
  topLevel: boolean;
  depth: number;
  parentBlockId?: string;
};

/**
 * Walks the document and resolves stable block IDs for top-level blocks and
 * for supported text blocks nested inside container nodes.
 */
export function collectLocations(
  doc: ProseMirrorNode,
  fallbackBindings: Map<string, FallbackBinding>,
  startCounter: number
): { locations: BlockLocation[]; nextCounter: number } {
  const locations: BlockLocation[] = [];
  const seen = new Set<string>();
  let nextCounter = startCounter;
  let position = 0;
  doc.forEach((node, _offset) => {
    const block = resolveBlockId(
      fallbackBindings,
      node,
      position,
      true,
      undefined,
      nextCounter
    );
    nextCounter = block.nextCounter;
    const blockId = block.blockId;
    if (seen.has(blockId)) {
      throw new BufferError(
        'INVALID_CONTENT',
        `The document contains duplicate block ID ${blockId}`
      );
    }
    seen.add(blockId);
    locations.push({
      blockId,
      node,
      position,
      editable: isEditableBlock(node, doc, position),
      topLevel: true,
      depth: 0
    });
    if (NESTED_CONTAINER_TYPES.has(node.type.name)) {
      node.descendants((child, childPosition) => {
        if (
          child.type.name !== 'paragraph' &&
          child.type.name !== 'heading' &&
          child.type.name !== 'codeBlock' &&
          child.type.name !== 'mathBlock'
        ) {
          return;
        }

        const nested = resolveBlockId(
          fallbackBindings,
          child,
          position + 1 + childPosition,
          false,
          blockId,
          nextCounter
        );
        nextCounter = nested.nextCounter;
        const nestedBlockId = nested.blockId;
        if (seen.has(nestedBlockId)) {
          throw new BufferError(
            'INVALID_CONTENT',
            `The document contains duplicate block ID ${nestedBlockId}`
          );
        }
        seen.add(nestedBlockId);
        const nestedPosition = position + 1 + childPosition;
        const resolved = doc.resolve(nestedPosition + 1);
        locations.push({
          blockId: nestedBlockId,
          node: child,
          position: nestedPosition,
          editable: isEditableBlock(child, doc, nestedPosition),
          topLevel: false,
          depth: Math.max(1, resolved.depth - 1),
          parentBlockId: blockId
        });
      });
    }
    position += node.nodeSize;
  });
  return { locations, nextCounter };
}

export function getInlineChildLocation(
  node: ProseMirrorNode,
  blockPosition: number,
  childIndex: number
): { node: ProseMirrorNode; position: number } | undefined {
  if (childIndex < 0 || childIndex >= node.childCount) return undefined;
  let offset = 0;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (index === childIndex) {
      return {
        node: child,
        position: blockPosition + 1 + offset
      };
    }
    offset += child.nodeSize;
  }
  return undefined;
}

export function toBufferBlock(location: BlockLocation): BufferBlock {
  const editable = location.editable;
  const fullText = getNodeText(location.node);
  const truncated = fullText.length > MAX_BLOCK_TEXT;
  const capabilities: BufferCapability[] = [];
  if (editable && !truncated) {
    if (
      location.node.type.name === 'paragraph' ||
      location.node.type.name === 'heading'
    ) {
      capabilities.push('replace_text');
      const segments = getInlineSegments(location.node);
      if (segments.some((segment) => segment.type === 'mathInline')) {
        capabilities.push('replace_inline_math');
      }
      if (segments.some((segment) => segment.type === 'text')) {
        capabilities.push('replace_text_with_math');
      }
    } else if (location.node.type.name === 'codeBlock') {
      capabilities.push('replace_code');
    } else if (location.node.type.name === 'mathBlock') {
      capabilities.push('replace_math');
    }
  }
  if (editable) {
    if (location.topLevel) {
      capabilities.push('delete_block', 'insert_before', 'insert_after');
    }
  }
  const segments = getInlineSegments(location.node);
  return {
    blockId: location.blockId,
    type: location.node.type.name,
    depth: location.depth,
    ...(location.parentBlockId
      ? { parentBlockId: location.parentBlockId }
      : {}),
    text: fullText.slice(0, MAX_BLOCK_TEXT),
    editable,
    capabilities,
    ...(location.node.type.name === 'codeBlock' &&
    typeof location.node.attrs?.language === 'string'
      ? { language: location.node.attrs.language }
      : {}),
    ...(segments.length
      ? {
          segments: segments.map((segment) => ({
            ...segment,
            text: segment.text.slice(0, MAX_BLOCK_TEXT)
          }))
        }
      : {}),
    ...(truncated ? { truncated: true } : {})
  };
}

export function readEditorSelection(
  editor: Editor
): BufferReadResult['selection'] {
  const { from, to } = editor.state.selection;
  if (from === to) return undefined;
  return {
    text: editor.state.doc.textBetween(from, to, '\n').slice(0, MAX_BLOCK_TEXT),
    from,
    to
  };
}
