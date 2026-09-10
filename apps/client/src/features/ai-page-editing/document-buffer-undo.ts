import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Step } from '@tiptap/pm/transform';
import { BufferError } from './document-buffer-types';
import { rangesOverlap } from './document-buffer-utils';

export type UndoEntry = {
  changeId: string;
  revision: string;
  inverseSteps: Step[];
  affectedRanges: Array<{ from: number; to: number }>;
  conflicted: boolean;
};

type AffectedRange = { from: number; to: number };

/**
 * Computes the inverse of every step in the transaction while the document is
 * still the pre-dispatch snapshot.
 */
export function captureInverseSteps(
  transaction: any,
  beforeDoc: ProseMirrorNode
): Step[] {
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
  return inverseSteps;
}

export function mapAffectedRanges(
  transaction: any,
  affectedRanges: AffectedRange[]
): AffectedRange[] {
  return affectedRanges.map((range) => ({
    from: transaction.mapping.map(range.from, 1),
    to: transaction.mapping.map(range.to, -1)
  }));
}

/**
 * Updates stored undo entries after an arbitrary document transaction so that
 * undo remains positionally correct, or marks entries conflicted when the
 * transaction touched the same ranges.
 */
export function rebaseUndoEntries(
  entries: UndoEntry[],
  transaction: any,
  revision: string
): void {
  const isUndo = transaction.getMeta?.('aiPageEditingUndo') === true;
  const isAiMutation = transaction.getMeta?.('aiPageEditingMutation') === true;
  const isUniqueIdUpdate =
    transaction.getMeta?.('__uniqueIDTransaction') === true;
  for (const entry of entries) {
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
    entry.revision = revision;
  }
}
