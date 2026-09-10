import type { BrowserToolResult } from './document-buffer';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  images?: ChatMessageImage[];
};

export type ChatMessageImage = {
  attachmentId: string;
  url: string;
  fileName: string;
};

export type PendingImage = {
  localId: string;
  file: File;
  previewUrl: string;
  status: 'uploading' | 'ready' | 'error';
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
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
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
