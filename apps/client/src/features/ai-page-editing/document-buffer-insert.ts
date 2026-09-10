import { markdownToHtml } from '@docmost/editor-ext';
import type { Editor } from '@tiptap/core';
import { DOMParser, Fragment } from '@tiptap/pm/model';
import { BufferError } from './document-buffer-types';
import type { BufferInsertInput } from './document-buffer-types';
import {
  trimTrailingEmptyParagraphs,
  validateFormulaContent,
  validateMermaidContent
} from './document-buffer-content';
import { isSupportedInsertedNode } from './document-buffer-utils';
import type { BlockLocation } from './document-buffer-locations';

/**
 * Converts Markdown into a validated fragment that is safe to insert into the
 * editor document.
 */
export async function prepareInsertContent(
  editor: Editor,
  markdown: string
): Promise<Fragment> {
  let content;
  try {
    const html = await markdownToHtml(markdown);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const parser = DOMParser.fromSchema(editor.schema);
    content = parser.parseSlice(wrapper, {
      preserveWhitespace: true
    }).content;
    content = trimTrailingEmptyParagraphs(content);
  } catch (error) {
    throw new BufferError(
      'INVALID_CONTENT',
      `The Markdown insertion could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!content.size || !content.content.every(isSupportedInsertedNode)) {
    throw new BufferError(
      'INVALID_CONTENT',
      'The insertion contains unsupported or empty content'
    );
  }

  validateFormulaContent(content);
  await validateMermaidContent(content);
  return content;
}

/**
 * Resolves the transaction position and block index for an insertion target.
 */
export function resolveInsertTarget(
  input: BufferInsertInput,
  locations: BlockLocation[],
  docContentSize: number
): {
  position: number;
  insertionIndex: number;
  replaceEmptyDocument: boolean;
} {
  const isEmptyDocument =
    locations.length === 1 &&
    (locations[0].node.type.name === 'paragraph' ||
      locations[0].node.type.name === 'heading') &&
    locations[0].node.content.size === 0;
  switch (input.target.kind) {
    case 'document_start':
      return {
        position: locations[0]?.position ?? 0,
        insertionIndex: 0,
        replaceEmptyDocument: isEmptyDocument
      };
    case 'document_end': {
      const trailingFootnotes = locations[locations.length - 1];
      const hasTrailingFootnotes =
        trailingFootnotes?.node.type.name === 'footnotes';
      if (isEmptyDocument && !hasTrailingFootnotes) {
        return {
          position: locations[0].position,
          insertionIndex: 0,
          replaceEmptyDocument: true
        };
      }
      return {
        position: hasTrailingFootnotes
          ? trailingFootnotes.position
          : docContentSize,
        insertionIndex: hasTrailingFootnotes
          ? locations.length - 1
          : locations.length,
        replaceEmptyDocument: false
      };
    }
    case 'before_block':
    case 'after_block': {
      const target = input.target;
      const location = locations.find(
        (item) => item.blockId === target.blockId
      );
      if (!location) {
        throw new BufferError(
          'BLOCK_NOT_FOUND',
          `Block ${target.blockId} was not found`
        );
      }
      if (
        target.kind === 'after_block' &&
        location.node.type.name === 'footnotes'
      ) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          'Content cannot be inserted after footnotes'
        );
      }
      return {
        position:
          target.kind === 'before_block'
            ? location.position
            : location.position + location.node.nodeSize,
        insertionIndex:
          locations.findIndex((item) => item.blockId === target.blockId) +
          (target.kind === 'after_block' ? 1 : 0),
        replaceEmptyDocument: false
      };
    }
  }
}
