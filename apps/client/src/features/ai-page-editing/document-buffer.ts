import { Editor } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { nanoid } from 'nanoid';
import { BufferError } from './document-buffer-types';
import { validateMermaidSource } from './document-buffer-content';
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
  ensureNotAborted,
  getNodeText,
  isRecord,
  isValidEditOperation,
  isValidInsertInput,
  MAX_READ_BLOCKS,
  MAX_READ_RESULT_CHARS,
  rebaseFallbackBindings
} from './document-buffer-utils';
import type { FallbackBinding } from './document-buffer-utils';
import {
  collectLocations,
  readEditorSelection,
  toBufferBlock
} from './document-buffer-locations';
import type { BlockLocation } from './document-buffer-locations';
import {
  applyPreparedOperations,
  prepareEditOperations
} from './document-buffer-edit';
import {
  prepareInsertContent,
  resolveInsertTarget
} from './document-buffer-insert';
import {
  captureInverseSteps,
  mapAffectedRanges,
  rebaseUndoEntries
} from './document-buffer-undo';
import type { UndoEntry } from './document-buffer-undo';
import { assertToolInput } from './document-buffer-tools';

export { BufferError };
export type {
  BufferErrorCode,
  BufferCapability,
  BrowserToolResult,
  BufferBlock,
  BufferEditOperation,
  BufferEditResult,
  BufferInsertInput,
  BufferInsertResult,
  BufferReadInput,
  BufferReadResult,
  BufferSegment,
  DeleteBlockOperation,
  ReplaceCodeOperation,
  ReplaceInlineMathOperation,
  ReplaceMathOperation,
  ReplaceTextOperation,
  ReplaceTextWithMathOperation
} from './document-buffer-types';

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
    rebaseUndoEntries(this.undoEntries, transaction, this.getRevision());
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
        assertToolInput(toolName, input);
        return this.read(input?.blockIds, input);
      case 'edit_buffer':
        assertToolInput(toolName, input);
        return this.edit(input?.expectedRevision, input?.operations, signal);
      case 'insert_blocks':
        assertToolInput(toolName, input);
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
      const block = toBufferBlock(visibleLocations[index]);
      const blockChars = JSON.stringify(block).length + 1;
      if (
        blocks.length > 0 &&
        resultChars + blockChars > MAX_READ_RESULT_CHARS
      ) {
        break;
      }
      blocks.push(block);
      resultChars += blockChars;
    }
    const selection = readEditorSelection(this.editor);

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

  async edit(
    expectedRevision: string,
    operations: BufferEditOperation[],
    signal?: AbortSignal
  ): Promise<BufferEditResult> {
    this.ensureEditable();
    ensureNotAborted(signal);
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
    await this.validateEditContent(expectedRevision, operations, signal);
    this.ensureEditable();
    ensureNotAborted(signal);

    const locations = this.getLocations();
    const byId = new Map(
      locations.map((location) => [location.blockId, location])
    );
    const prepared = prepareEditOperations(byId, operations);

    const beforeDoc = this.editor.state.doc;
    const transaction = this.editor.state.tr;
    const changes = applyPreparedOperations(
      this.editor,
      transaction,
      locations,
      prepared
    );
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
    const content = await prepareInsertContent(this.editor, input.markdown);

    this.ensureAvailable();
    ensureNotAborted(signal);
    this.ensureRevision(input.expectedRevision);
    const locations = this.getTopLevelLocations();
    const { position, insertionIndex, replaceEmptyDocument } =
      resolveInsertTarget(input, locations, this.editor.state.doc.content.size);

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

  private async validateEditContent(
    expectedRevision: string,
    operations: BufferEditOperation[],
    signal?: AbortSignal
  ): Promise<void> {
    this.ensureAvailable();
    ensureNotAborted(signal);
    this.ensureRevision(expectedRevision);
    const locations = new Map(
      this.getLocations().map((location) => [location.blockId, location])
    );
    for (const operation of operations) {
      ensureNotAborted(signal);
      if (operation.type !== 'replace_code') continue;
      const location = locations.get(operation.blockId);
      if (!location || location.node.type.name !== 'codeBlock') continue;
      const language =
        operation.language ?? String(location.node.attrs?.language ?? '');
      if (language === 'mermaid') {
        await validateMermaidSource(operation.newText, operation.blockId);
      }
      ensureNotAborted(signal);
      this.ensureAvailable();
      this.ensureRevision(expectedRevision);
    }
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
    const inverseSteps = captureInverseSteps(transaction, beforeDoc);
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
      affectedRanges: mapAffectedRanges(transaction, affectedRanges),
      conflicted: false
    });
    if (this.undoEntries.length > 20) this.undoEntries.shift();
  }

  private getLocations(): BlockLocation[] {
    const { locations, nextCounter } = collectLocations(
      this.editor.state.doc,
      this.fallbackBindings,
      this.fallbackBlockCounter
    );
    this.fallbackBlockCounter = nextCounter;
    return locations;
  }

  private getTopLevelLocations(): BlockLocation[] {
    return this.getLocations().filter((location) => location.topLevel);
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
