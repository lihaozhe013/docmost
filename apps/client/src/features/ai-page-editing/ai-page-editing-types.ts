import type { BrowserToolResult } from './document-buffer';

export type AiRunUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ToolStepStatus = 'running' | 'done' | 'error';

export type ToolStep = {
  toolName: string;
  status: ToolStepStatus;
  summary?: string;
  error?: string;
};

export type AiCitation = {
  startIndex: number;
  endIndex: number;
  url: string;
  title: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  images?: ChatMessageImage[];
  toolStep?: ToolStep;
  citations?: AiCitation[];
  meta?: { usage?: AiRunUsage; elapsedMs?: number };
};

export type RunPhase =
  'idle' | 'thinking' | 'web-searching' | 'reading' | 'editing' | 'inserting' | 'writing';

export type ChatMessageImage = {
  attachmentId: string;
  url: string;
  fileName: string;
};

export type PendingImage = {
  localId: string;
  // Absent only for 'converting' PDF placeholder chips, which show progress instead.
  file?: File;
  previewUrl?: string;
  name: string;
  status: 'converting' | 'uploading' | 'ready' | 'error';
  progress?: { done: number; total: number };
  attachmentId?: string;
  url?: string;
  error?: string;
};

export type EditingEvent = {
  operation: 'aiPageEditing.event';
  sessionId?: string;
  sequence?: number;
  pageId?: string;
  runId: string;
  event: string;
  status?: RunPhase;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  usage?: AiRunUsage;
  citations?: AiCitation[];
  error?: { code?: string; message: string; details?: unknown };
};

export type ToolRequest = {
  operation: 'aiPageEditing.toolRequest';
  sessionId?: string;
  sequence?: number;
  pageId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type ToolResponse = {
  ok: boolean;
  result?: BrowserToolResult;
  error?: { code: string; message: string; details?: unknown };
};
