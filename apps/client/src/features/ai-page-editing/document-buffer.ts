import { markdownToHtml } from '@docmost/editor-ext';
import { Editor } from '@tiptap/core';
import { DOMParser, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Step } from '@tiptap/pm/transform';
import { nanoid } from 'nanoid';
import { BufferError } from './document-buffer-types';
import type {
  BrowserToolResult,
  BufferBlock,
  BufferEditOperation,
  BufferEditResult,
  BufferInsertInput,
  BufferInsertResult,
  BufferReadResult
} from './document-buffer-types';
import {
  compactChange,
  getNodeText,
  isDirectTextBlock,
  isEditableBlock,
  isRecord,
  isSingleTextNodeRange,
  isSupportedInsertedNode,
  isValidEditOperation,
  isValidInsertInput,
  MAX_BLOCK_TEXT,
  MAX_READ_BLOCKS,
  MAX_READ_RESULT_CHARS,
  rangesOverlap,
  rebaseFallbackBindings,
  resolveBlockId
} from './document-buffer-utils';
import type { FallbackBinding } from './document-buffer-utils';

export { BufferError };
export type {
  BufferErrorCode,
  BrowserToolResult,
  BufferBlock,
  BufferEditOperation,
  BufferEditResult,
  BufferInsertInput,
  BufferInsertResult,
  BufferReadInput,
  BufferReadResult,
  DeleteBlockOperation,
  ReplaceTextOperation
} from './document-buffer-types';

type BlockLocation = {
  blockId: string;
  node: ProseMirrorNode;
  position: number;
  editable: boolean;
  topLevel: boolean;
  depth: number;
  parentBlockId?: string;
};

type UndoEntry = {
  changeId: string;
  revision: string;
  inverseSteps: Step[];
  affectedRanges: Array<{ from: number; to: number }>;
  conflicted: boolean;
};

/**
 * Editor-only document capability used by the page agent bridge. It owns
 * projection, revision checks, localized transactions, and conservative undo;
 * it has no dependency on the agent runtime or transport.
 */
export class DocumentBuffer {
  private revisionNumber = 0;
  private readonly epoch = nanoid(8);
  private readonly undoEntries: UndoEntry[] = [];
  private readonly fallbackBindings = new Map<string, FallbackBinding>();
  private fallbackBlockCounter = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private destroyed = false;

  private readonly handleTransaction = ({
    transaction
  }: {
    transaction: any;
  }) => {
    if (!transaction.docChanged) return;
    this.revisionNumber += 1;
    rebaseFallbackBindings(this.fallbackBindings, transaction);
    this.rebaseUndoEntries(transaction);
  };

  constructor(
    private readonly editor: Editor,
    private readonly pageId: string
  ) {
    editor.on('transaction', this.handleTransaction);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.editor.off('transaction', this.handleTransaction);
    this.undoEntries.length = 0;
    this.fallbackBindings.clear();
  }

  getPageId(): string {
    return this.pageId;
  }

  getRevision(): string {
    return `${this.epoch}-${this.revisionNumber}`;
  }

  async executeTool(
    toolName: string,
    input: any,
    signal?: AbortSignal
  ): Promise<BrowserToolResult> {
    const operation = this.operationQueue.then(() =>
      this.executeToolNow(toolName, input, signal)
    );
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async executeToolNow(
    toolName: string,
    input: any,
    signal?: AbortSignal
  ): Promise<BrowserToolResult> {
    ensureNotAborted(signal);
    switch (toolName) {
      case 'read_buffer':
        if (
          (input !== undefined && !isRecord(input)) ||
          (input !== undefined &&
            input.blockIds !== undefined &&
            (!Array.isArray(input.blockIds) ||
              input.blockIds.length > MAX_READ_BLOCKS ||
              input.blockIds.some(
                (blockId: unknown) =>
                  typeof blockId !== 'string' ||
                  blockId.length < 1 ||
                  blockId.length > 128
              ))) ||
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
        return this.read(input?.blockIds, input);
      case 'edit_buffer':
        if (
          !isRecord(input) ||
          typeof input.expectedRevision !== 'string' ||
          input.expectedRevision.length < 1 ||
          input.expectedRevision.length > 128 ||
          !Array.isArray(input.operations) ||
          input.operations.length < 1 ||
          input.operations.length > 20 ||
          input.operations.some(
            (operation: any) =>
              !operation ||
              typeof operation.blockId !== 'string' ||
              operation.blockId.length < 1 ||
              operation.blockId.length > 128 ||
              (operation.type === 'replace_text' &&
                (typeof operation.oldText !== 'string' ||
                  !operation.oldText.length ||
                  operation.oldText.length > MAX_BLOCK_TEXT ||
                  typeof operation.newText !== 'string' ||
                  operation.newText.length > MAX_BLOCK_TEXT)) ||
              !['replace_text', 'delete_block'].includes(operation.type)
          )
        ) {
          throw new BufferError(
            'INVALID_CONTENT',
            'edit_buffer requires a revision and operations'
          );
        }
        return this.edit(input?.expectedRevision, input?.operations);
      case 'insert_blocks':
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
        return this.insert(input as BufferInsertInput, signal);
      default:
        throw new BufferError(
          'INVALID_CONTENT',
          `Unknown document tool: ${toolName}`
        );
    }
  }

  read(
    blockIds?: string[],
    options: { offset?: number; limit?: number } = {}
  ): BufferReadResult {
    this.ensureAvailable();
    if (!isRecord(options)) {
      throw new BufferError('INVALID_CONTENT', 'The read options are invalid');
    }
    if (
      blockIds !== undefined &&
      (!Array.isArray(blockIds) ||
        blockIds.length > MAX_READ_BLOCKS ||
        blockIds.some(
          (blockId) =>
            typeof blockId !== 'string' ||
            blockId.length < 1 ||
            blockId.length > 128
        ))
    ) {
      throw new BufferError(
        'INVALID_CONTENT',
        'read_buffer requires valid block IDs'
      );
    }
    if (
      options.offset !== undefined &&
      (!Number.isInteger(options.offset) ||
        options.offset < 0 ||
        options.offset > 10_000)
    ) {
      throw new BufferError('INVALID_CONTENT', 'The read offset is invalid');
    }
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) ||
        options.limit < 1 ||
        options.limit > MAX_READ_BLOCKS)
    ) {
      throw new BufferError('INVALID_CONTENT', 'The read limit is invalid');
    }
    const locations = this.getLocations();
    const requested = blockIds?.length ? new Set(blockIds) : undefined;

    if (requested) {
      for (const blockId of requested) {
        if (!locations.some((location) => location.blockId === blockId)) {
          throw new BufferError(
            'BLOCK_NOT_FOUND',
            `Block ${blockId} was not found`
          );
        }
      }
    }

    const offset = options.offset ?? 0;
    const limit = options.limit ?? MAX_READ_BLOCKS;
    const visibleLocations = locations.filter(
      (location) => !requested || requested.has(location.blockId)
    );
    const blocks: BufferBlock[] = [];
    let resultChars = 0;
    for (
      let index = offset;
      index < visibleLocations.length && blocks.length < limit;
      index += 1
    ) {
      const block = this.toBlock(visibleLocations[index]);
      const blockChars = block.text.length + block.blockId.length + 64;
      if (
        blocks.length > 0 &&
        resultChars + blockChars > MAX_READ_RESULT_CHARS
      ) {
        break;
      }
      blocks.push(block);
      resultChars += blockChars;
    }
    const selection = this.readSelection();

    return {
      revision: this.getRevision(),
      complete: offset + blocks.length >= visibleLocations.length,
      blocks,
      ...(offset + blocks.length < visibleLocations.length
        ? { nextOffset: offset + blocks.length }
        : {}),
      ...(selection ? { selection } : {})
    };
  }

  edit(
    expectedRevision: string,
    operations: BufferEditOperation[]
  ): BufferEditResult {
    this.ensureEditable();
    if (
      typeof expectedRevision !== 'string' ||
      expectedRevision.length < 1 ||
      expectedRevision.length > 128
    ) {
      throw new BufferError(
        'INVALID_CONTENT',
        'edit_buffer requires a valid revision'
      );
    }
    this.ensureRevision(expectedRevision);
    if (!Array.isArray(operations) || !operations.length) {
      throw new BufferError(
        'INVALID_CONTENT',
        'At least one edit operation is required'
      );
    }
    if (
      operations.length > 20 ||
      operations.some((operation) => !isValidEditOperation(operation))
    ) {
      throw new BufferError(
        'INVALID_CONTENT',
        'edit_buffer contains invalid operations'
      );
    }

    const locations = this.getLocations();
    const byId = new Map(
      locations.map((location) => [location.blockId, location])
    );
    const seen = new Set<string>();
    const changes: Array<{ blockId: string; before: string; after: string }> =
      [];
    const prepared: Array<{
      operation: BufferEditOperation;
      location: BlockLocation;
      from: number;
      to: number;
      before: string;
      after: string;
    }> = [];

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
          from: location.position,
          to: location.position + location.node.nodeSize,
          before: location.node.textContent,
          after: ''
        });
        continue;
      }

      if (!isDirectTextBlock(location.node)) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Block ${operation.blockId} contains inline or nested content`
        );
      }
      if (
        operation.newText.includes('\n') ||
        operation.newText.includes('\r')
      ) {
        throw new BufferError(
          'UNSUPPORTED_RANGE',
          `Block ${operation.blockId} replacements cannot contain line breaks`
        );
      }
      const first = location.node.textContent.indexOf(operation.oldText);
      if (first === -1) {
        throw new BufferError(
          'TEXT_NOT_FOUND',
          `The exact text was not found in block ${operation.blockId}`
        );
      }
      if (first !== location.node.textContent.lastIndexOf(operation.oldText)) {
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
      const from = location.position + 1 + first;
      prepared.push({
        operation,
        location,
        from,
        to: from + operation.oldText.length,
        before: location.node.textContent,
        after:
          location.node.textContent.slice(0, first) +
          operation.newText +
          location.node.textContent.slice(first + operation.oldText.length)
      });
    }

    const beforeDoc = this.editor.state.doc;
    const transaction = this.editor.state.tr;
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
        if (
          item.operation.blockId === preservedFinalBlockId &&
          item.location.node.content.size === 0
        ) {
          throw new BufferError(
            'UNSUPPORTED_RANGE',
            'The final empty block cannot be deleted'
          );
        }
        transaction.delete(
          item.operation.blockId === preservedFinalBlockId
            ? item.from + 1
            : item.from,
          item.operation.blockId === preservedFinalBlockId
            ? item.to - 1
            : item.to
        );
      } else {
        transaction.insertText(item.operation.newText, item.from, item.to);
      }
      changes.push({
        blockId: item.operation.blockId,
        before: item.before,
        after: item.after
      });
    }
    this.dispatch(
      transaction,
      beforeDoc,
      changes,
      prepared.map((item) => ({ from: item.from, to: item.to }))
    );

    return {
      changeId: this.undoEntries[this.undoEntries.length - 1].changeId,
      revision: this.getRevision(),
      status: 'applied',
      affectedBlockIds: prepared.map((item) => item.operation.blockId),
      changes: changes.reverse().map(compactChange)
    };
  }

  async insert(
    input: BufferInsertInput,
    signal?: AbortSignal
  ): Promise<BufferInsertResult> {
    this.ensureEditable();
    ensureNotAborted(signal);
    if (!isValidInsertInput(input)) {
      throw new BufferError(
        'INVALID_CONTENT',
        'insert_blocks requires a valid revision, target, and Markdown'
      );
    }
    this.ensureRevision(input.expectedRevision);
    let content;
    try {
      const html = await markdownToHtml(input.markdown);
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      const parser = DOMParser.fromSchema(this.editor.schema);
      content = parser.parseSlice(wrapper, {
        preserveWhitespace: true
      }).content;
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

    this.ensureAvailable();
    ensureNotAborted(signal);
    this.ensureRevision(input.expectedRevision);
    const locations = this.getTopLevelLocations();
    let position: number;
    let insertionIndex: number;
    let replaceEmptyDocument = false;
    const isEmptyDocument =
      locations.length === 1 &&
      (locations[0].node.type.name === 'paragraph' ||
        locations[0].node.type.name === 'heading') &&
      locations[0].node.content.size === 0;
    switch (input.target.kind) {
      case 'document_start':
        position = locations[0]?.position ?? 0;
        insertionIndex = 0;
        replaceEmptyDocument = isEmptyDocument;
        break;
      case 'document_end':
        {
          const trailingFootnotes = locations[locations.length - 1];
          const hasTrailingFootnotes =
            trailingFootnotes?.node.type.name === 'footnotes';
          position = hasTrailingFootnotes
            ? trailingFootnotes.position
            : this.editor.state.doc.content.size;
          insertionIndex = hasTrailingFootnotes
            ? locations.length - 1
            : locations.length;
          if (isEmptyDocument && !hasTrailingFootnotes) {
            position = locations[0].position;
            insertionIndex = 0;
            replaceEmptyDocument = true;
          }
        }
        break;
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
        position =
          target.kind === 'before_block'
            ? location.position
            : location.position + location.node.nodeSize;
        insertionIndex =
          locations.findIndex((item) => item.blockId === target.blockId) +
          (target.kind === 'after_block' ? 1 : 0);
        break;
      }
    }

    const beforeDoc = this.editor.state.doc;
    const transaction = replaceEmptyDocument
      ? this.editor.state.tr.replaceWith(
          position,
          position + locations[0].node.nodeSize,
          content
        )
      : this.editor.state.tr.insert(position, content);
    const provisionalChanges = [
      {
        blockId: `inserted:${this.epoch}:${this.revisionNumber + 1}`,
        before: '',
        after: content.content.map(getNodeText).join('\n')
      }
    ];
    this.dispatch(transaction, beforeDoc, provisionalChanges, [
      { from: position, to: position + content.size }
    ]);
    const insertedLocations = this.getTopLevelLocations().slice(
      insertionIndex,
      insertionIndex + content.childCount
    );
    const changes = insertedLocations.map((location) => ({
      blockId: location.blockId,
      before: '',
      after: getNodeText(location.node)
    }));
    return {
      changeId: this.undoEntries[this.undoEntries.length - 1].changeId,
      revision: this.getRevision(),
      status: 'applied',
      affectedBlockIds: changes.length
        ? changes.map((change) => change.blockId)
        : provisionalChanges.map((change) => change.blockId),
      changes: changes.length
        ? changes.map(compactChange)
        : provisionalChanges.map(compactChange)
    };
  }

  undo(changeId?: string): { changeId: string; revision: string } {
    this.ensureEditable();
    const entry = changeId
      ? this.undoEntries.find((candidate) => candidate.changeId === changeId)
      : this.undoEntries[this.undoEntries.length - 1];
    if (!entry) {
      throw new BufferError(
        'UNSUPPORTED_RANGE',
        'No AI change is available to undo'
      );
    }
    if (entry !== this.undoEntries[this.undoEntries.length - 1]) {
      throw new BufferError(
        'UNSUPPORTED_RANGE',
        'Only the most recent AI change can be undone safely'
      );
    }
    if (entry.conflicted) {
      throw new BufferError(
        'STALE_REVISION',
        'The document changed within this AI edit; it cannot be undone safely'
      );
    }
    if (entry.revision !== this.getRevision()) {
      throw new BufferError(
        'STALE_REVISION',
        'The document changed after this AI edit; it cannot be undone safely'
      );
    }

    const transaction = this.editor.state.tr;
    try {
      for (const step of [...entry.inverseSteps].reverse()) {
        transaction.step(step);
      }
      transaction.setMeta('aiPageEditingUndo', true);
      transaction.setMeta('addToHistory', false);
      this.editor.view.dispatch(transaction);
    } catch (error) {
      throw new BufferError(
        'STALE_REVISION',
        error instanceof Error ? error.message : String(error)
      );
    }
    const index = this.undoEntries.indexOf(entry);
    this.undoEntries.splice(index, 1);
    return { changeId: entry.changeId, revision: this.getRevision() };
  }

  getLatestChangeId(): string | undefined {
    return this.undoEntries[this.undoEntries.length - 1]?.changeId;
  }

  revealBlock(blockId: string): void {
    this.ensureAvailable();
    if (typeof blockId !== 'string' || !blockId.length) {
      throw new BufferError(
        'BLOCK_NOT_FOUND',
        'The requested block is invalid'
      );
    }
    const location = this.getLocations().find(
      (candidate) => candidate.blockId === blockId
    );
    if (!location) {
      throw new BufferError(
        'BLOCK_NOT_FOUND',
        `Block ${blockId} was not found`
      );
    }
    const from = location.position + 1;
    const to = Math.max(from, location.position + location.node.nodeSize - 1);
    try {
      this.editor.commands.setTextSelection({ from, to });
      this.editor.commands.scrollIntoView();
    } catch (error) {
      throw new BufferError(
        'SESSION_UNAVAILABLE',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private dispatch(
    transaction: any,
    beforeDoc: ProseMirrorNode,
    changes: Array<{ blockId: string; before: string; after: string }>,
    affectedRanges: Array<{ from: number; to: number }>
  ): void {
    if (transaction.docChanged === false) {
      throw new BufferError(
        'INVALID_CONTENT',
        'The edit produced no document change'
      );
    }
    if (!changes.length) {
      throw new BufferError(
        'INVALID_CONTENT',
        'The edit did not produce a change summary'
      );
    }
    const inverseSteps: Step[] = [];
    let currentDoc = beforeDoc;
    for (const step of transaction.steps) {
      inverseSteps.push(step.invert(currentDoc));
      const applied = step.apply(currentDoc);
      if (applied.failed || !applied.doc) {
        throw new BufferError(
          'INVALID_CONTENT',
          applied.failed || 'The edit is invalid'
        );
      }
      currentDoc = applied.doc;
    }
    transaction.setMeta('aiPageEditingMutation', true);
    transaction.setMeta('addToHistory', false);
    try {
      this.editor.view.dispatch(transaction);
    } catch (error) {
      throw new BufferError(
        'INVALID_CONTENT',
        error instanceof Error ? error.message : String(error)
      );
    }
    const changeId = nanoid(12);
    this.undoEntries.push({
      changeId,
      revision: this.getRevision(),
      inverseSteps,
      affectedRanges: affectedRanges.map((range) => ({
        from: transaction.mapping.map(range.from, 1),
        to: transaction.mapping.map(range.to, -1)
      })),
      conflicted: false
    });
    if (this.undoEntries.length > 20) this.undoEntries.shift();
  }

  private rebaseUndoEntries(transaction: any): void {
    const isUndo = transaction.getMeta?.('aiPageEditingUndo') === true;
    const isAiMutation =
      transaction.getMeta?.('aiPageEditingMutation') === true;
    const isUniqueIdUpdate =
      transaction.getMeta?.('__uniqueIDTransaction') === true;
    for (const entry of this.undoEntries) {
      if (entry.conflicted) continue;

      if (
        !isUndo &&
        !isAiMutation &&
        !isUniqueIdUpdate &&
        rangesOverlap(
          entry.affectedRanges,
          transaction.mapping,
          transaction.steps
        )
      ) {
        entry.conflicted = true;
        continue;
      }

      const mappedSteps = entry.inverseSteps.map((step) =>
        step.map(transaction.mapping)
      );
      if (mappedSteps.some((step) => !step)) {
        entry.conflicted = true;
        continue;
      }

      entry.inverseSteps = mappedSteps as Step[];
      entry.affectedRanges = entry.affectedRanges.map((range) => ({
        from: transaction.mapping.map(range.from, 1),
        to: transaction.mapping.map(range.to, -1)
      }));
      entry.revision = this.getRevision();
    }
  }

  private getLocations(): BlockLocation[] {
    const locations: BlockLocation[] = [];
    const seen = new Set<string>();
    let position = 0;
    this.editor.state.doc.forEach((node, _offset) => {
      const block = resolveBlockId(
        this.fallbackBindings,
        node,
        position,
        true,
        undefined,
        this.fallbackBlockCounter
      );
      this.fallbackBlockCounter = block.nextCounter;
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
        editable: isEditableBlock(node, this.editor.state.doc, position),
        topLevel: true,
        depth: 0
      });
      if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
        node.descendants((child, childPosition) => {
          if (
            child.type.name !== 'paragraph' &&
            child.type.name !== 'heading'
          ) {
            return;
          }

          const nested = resolveBlockId(
            this.fallbackBindings,
            child,
            position + 1 + childPosition,
            false,
            blockId,
            this.fallbackBlockCounter
          );
          this.fallbackBlockCounter = nested.nextCounter;
          const nestedBlockId = nested.blockId;
          if (seen.has(nestedBlockId)) {
            throw new BufferError(
              'INVALID_CONTENT',
              `The document contains duplicate block ID ${nestedBlockId}`
            );
          }
          seen.add(nestedBlockId);
          const nestedPosition = position + 1 + childPosition;
          const resolved = this.editor.state.doc.resolve(nestedPosition + 1);
          locations.push({
            blockId: nestedBlockId,
            node: child,
            position: nestedPosition,
            editable: isEditableBlock(
              child,
              this.editor.state.doc,
              nestedPosition
            ),
            topLevel: false,
            depth: Math.max(1, resolved.depth - 1),
            parentBlockId: blockId
          });
        });
      }
      position += node.nodeSize;
    });
    return locations;
  }

  private getTopLevelLocations(): BlockLocation[] {
    return this.getLocations().filter((location) => location.topLevel);
  }

  private toBlock(location: BlockLocation): BufferBlock {
    const editable = location.editable;
    const capabilities: BufferBlock['capabilities'] = [];
    if (editable) {
      capabilities.push('replace_text');
      if (location.topLevel) {
        capabilities.push('delete_block', 'insert_before', 'insert_after');
      }
    }
    return {
      blockId: location.blockId,
      type: location.node.type.name,
      depth: location.depth,
      ...(location.parentBlockId
        ? { parentBlockId: location.parentBlockId }
        : {}),
      text: getNodeText(location.node).slice(0, MAX_BLOCK_TEXT),
      editable,
      capabilities
    };
  }

  private readSelection(): BufferReadResult['selection'] {
    const { from, to } = this.editor.state.selection;
    if (from === to) return undefined;
    return {
      text: this.editor.state.doc
        .textBetween(from, to, '\n')
        .slice(0, MAX_BLOCK_TEXT),
      from,
      to
    };
  }

  private ensureAvailable(): void {
    if (this.destroyed || this.editor.isDestroyed) {
      throw new BufferError(
        'SESSION_UNAVAILABLE',
        'The page editor is unavailable'
      );
    }
  }

  private ensureEditable(): void {
    this.ensureAvailable();
    if (!this.editor.isEditable) {
      throw new BufferError('ACCESS_DENIED', 'The page editor is read-only');
    }
  }

  private ensureRevision(expectedRevision: string): void {
    if (expectedRevision !== this.getRevision()) {
      throw new BufferError(
        'STALE_REVISION',
        `The document changed; read the current buffer before editing`,
        { expectedRevision, actualRevision: this.getRevision() }
      );
    }
  }
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BufferError('CANCELLED', 'The document operation was cancelled');
  }
}
