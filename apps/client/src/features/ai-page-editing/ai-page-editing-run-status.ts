import type { AiRunUsage, RunPhase, ToolStepStatus } from './ai-page-editing-types';

const TOOL_PHASES: Record<string, RunPhase> = {
  read_buffer: 'reading',
  edit_buffer: 'editing',
  insert_blocks: 'inserting'
};

export function toolPhase(toolName?: string): RunPhase {
  return (toolName && TOOL_PHASES[toolName]) || 'thinking';
}

const PHASE_VERBS: Record<RunPhase, string> = {
  idle: '',
  thinking: 'Thinking…',
  reading: 'Reading the page…',
  editing: 'Editing the page…',
  inserting: 'Inserting content…',
  applying: 'Applying changes…',
  generating: 'Generating…'
};

export function phaseVerb(phase: RunPhase): string {
  return PHASE_VERBS[phase];
}

const TOOL_STEP_LABELS: Record<string, Record<ToolStepStatus, string>> = {
  read_buffer: {
    running: 'Reading the page…',
    done: 'Read the page',
    error: 'Read failed'
  },
  edit_buffer: {
    running: 'Editing the page…',
    done: 'Applied edits',
    error: 'Edit failed'
  },
  insert_blocks: {
    running: 'Inserting content…',
    done: 'Inserted content',
    error: 'Insert failed'
  }
};

export function toolStepLabel(toolName: string, status: ToolStepStatus): string {
  const labels = TOOL_STEP_LABELS[toolName];
  if (labels) return labels[status];
  if (status === 'running') return `Running ${toolName}…`;
  if (status === 'done') return `${toolName} completed`;
  return `${toolName} failed`;
}

const CJK_TOKEN_RE =
  /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{1b000}-\u{1caff}\u{1f200}-\u{1faf1}]/gu;

/**
 * Rough token estimate: CJK text is close to one token per character, while
 * latin and punctuation average around four characters per token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_TOKEN_RE)?.length ?? 0;
  const other = text.length - cjk;
  return Math.max(1, cjk + Math.ceil(other / 4));
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const value = tokens / 1000;
    const decimals = value >= 10 ? 0 : 1;
    return `${value.toFixed(decimals).replace(/\.0$/, '')}k`;
  }
  return `${tokens}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatRunMeta(meta?: { usage?: AiRunUsage; elapsedMs?: number }): string | null {
  if (!meta) return null;
  const parts: string[] = [];
  const usage = meta.usage;
  if (usage) {
    const total = usage.totalTokens ?? (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (total > 0) parts.push(`${formatTokenCount(total)} tokens`);
  }
  if (meta.elapsedMs !== undefined) {
    parts.push(formatElapsed(meta.elapsedMs));
  }
  return parts.length ? parts.join(' · ') : null;
}
