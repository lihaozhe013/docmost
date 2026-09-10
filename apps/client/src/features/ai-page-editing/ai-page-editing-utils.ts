import { BufferError } from './document-buffer';
import type { BrowserToolResult } from './document-buffer';
import type { ChatMessage } from './ai-page-editing-types';

export const MAX_STORED_TOOL_RESULTS = 24;
export const MAX_HISTORY_CHARS = 80_000;
export const MAX_CANCELLED_RUN_IDS = 32;

export function messageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof BufferError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {})
    };
  }
  return {
    code: 'SESSION_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error)
  };
}

export function getToolError(
  output: unknown
): { code?: string; message: string; details?: unknown } | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const envelope = output as {
    ok?: boolean;
    error?: { code?: unknown; message?: unknown; details?: unknown };
  };
  return envelope.ok === false && typeof envelope.error?.message === 'string'
    ? {
        ...(typeof envelope.error.code === 'string'
          ? { code: envelope.error.code }
          : {}),
        message: envelope.error.message,
        ...(envelope.error.details !== undefined
          ? { details: envelope.error.details }
          : {})
      }
    : undefined;
}

function formatErrorDetails(details: unknown): string | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  const messages = issues
    .slice(0, 4)
    .map((issue) => {
      if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
        return undefined;
      }
      const value = issue as {
        path?: unknown;
        code?: unknown;
        message?: unknown;
      };
      if (typeof value.message !== 'string') return undefined;
      const path = typeof value.path === 'string' ? value.path : '$';
      const code = typeof value.code === 'string' ? value.code : 'invalid';
      return `${path} [${code}]: ${value.message}`;
    })
    .filter((message): message is string => Boolean(message));
  return messages.length ? messages.join('; ').slice(0, 1_000) : undefined;
}

export function formatDisplayedError(error: {
  code?: string;
  message: string;
  details?: unknown;
}): string {
  const prefix = error.code ? `[${error.code}] ` : '';
  const details = formatErrorDetails(error.details);
  return `${prefix}${error.message}${details ? ` (${details})` : ''}`;
}

export function getToolChange(output: unknown): {
  changeId?: string;
  affectedBlockId?: string;
  summary?: string;
} {
  if (!output || typeof output !== 'object') return {};
  const envelope = output as {
    ok?: boolean;
    result?: BrowserToolResult;
  };
  if (!envelope.ok || !envelope.result) return {};
  const changes = Array.isArray(envelope.result.changes)
    ? envelope.result.changes.filter(
        (change) =>
          change &&
          typeof change.blockId === 'string' &&
          typeof change.before === 'string' &&
          typeof change.after === 'string'
      )
    : [];
  const firstChange = changes?.[0];
  const summary = changes?.length
    ? changes
        .slice(0, 3)
        .map((change) => {
          const before = change.before.slice(0, 120);
          const after = change.after.slice(0, 120);
          return `${change.blockId}: ${before ? `"${before}"` : '∅'} → ${after ? `"${after}"` : '∅'}`;
        })
        .join('; ')
    : undefined;
  return {
    changeId:
      typeof envelope.result.changeId === 'string'
        ? envelope.result.changeId
        : undefined,
    affectedBlockId:
      (Array.isArray(envelope.result.affectedBlockIds) &&
        typeof envelope.result.affectedBlockIds[0] === 'string' &&
        envelope.result.affectedBlockIds[0]) ||
      firstChange?.blockId,
    summary
  };
}

export function getBoundedHistory(messages: ChatMessage[]) {
  const selected: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let totalChars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = message.content.slice(0, 20_000);
    if (
      selected.length > 0 &&
      totalChars + content.length > MAX_HISTORY_CHARS
    ) {
      break;
    }
    selected.unshift({ role: message.role, content });
    totalChars += content.length;
  }
  return selected;
}

export function rememberCancelledRun(
  cancelledRunIds: Set<string>,
  runId: string | null
): void {
  if (!runId) return;
  cancelledRunIds.add(runId);
  if (cancelledRunIds.size <= MAX_CANCELLED_RUN_IDS) return;
  const oldest = cancelledRunIds.values().next().value;
  if (typeof oldest === 'string') cancelledRunIds.delete(oldest);
}
