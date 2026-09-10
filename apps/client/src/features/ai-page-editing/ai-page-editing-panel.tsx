import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowUp,
  IconPhoto,
  IconPlayerStop,
  IconPlus,
  IconRotate2,
  IconSparkles,
  IconX
} from '@tabler/icons-react';
import { useAtom } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { socketAtom } from '@/features/websocket/atoms/socket-atom.ts';
import { pageEditorAtom } from '@/features/editor/atoms/editor-atoms.ts';
import { uploadFile } from '@/features/page/services/page-service.ts';
import { IAttachment } from '@/features/attachments/types/attachment.types.ts';
import {
  BufferError,
  BrowserToolResult,
  DocumentBuffer
} from './document-buffer';
import {
  AI_IMAGE_ACCEPT,
  MAX_AI_IMAGES,
  compressImageForAi,
  isSupportedAiImage,
  validateAiImageBatch
} from './ai-image-upload';
import { MarkdownContent } from '@/components/common/markdown-content';
import classes from './ai-page-editing-panel.module.css';

const MAX_STORED_TOOL_RESULTS = 24;
const MAX_HISTORY_CHARS = 80_000;
const MAX_CANCELLED_RUN_IDS = 32;

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  images?: ChatMessageImage[];
};

type ChatMessageImage = {
  attachmentId: string;
  url: string;
  fileName: string;
};

type PendingImage = {
  localId: string;
  file: File;
  previewUrl: string;
  status: 'uploading' | 'ready' | 'error';
  attachmentId?: string;
  url?: string;
  error?: string;
};

type EditingEvent = {
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

type ToolRequest = {
  operation: 'aiPageEditing.toolRequest';
  sessionId?: string;
  sequence?: number;
  pageId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

type ToolResponse = {
  ok: boolean;
  result?: BrowserToolResult;
  error?: { code: string; message: string; details?: unknown };
};

function messageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getError(error: unknown): {
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

function getToolError(
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

function formatDisplayedError(error: {
  code?: string;
  message: string;
  details?: unknown;
}): string {
  const prefix = error.code ? `[${error.code}] ` : '';
  const details = formatErrorDetails(error.details);
  return `${prefix}${error.message}${details ? ` (${details})` : ''}`;
}

function getToolChange(output: unknown): {
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

function getBoundedHistory(messages: ChatMessage[]) {
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

function rememberCancelledRun(
  cancelledRunIds: Set<string>,
  runId: string | null
): void {
  if (!runId) return;
  cancelledRunIds.add(runId);
  if (cancelledRunIds.size <= MAX_CANCELLED_RUN_IDS) return;
  const oldest = cancelledRunIds.values().next().value;
  if (typeof oldest === 'string') cancelledRunIds.delete(oldest);
}

export function AiPageEditingPanel({
  pageId,
  enabled
}: {
  pageId: string;
  enabled: boolean;
}) {
  const [socket] = useAtom(socketAtom);
  const [editor] = useAtom(pageEditorAtom);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [latestChangeId, setLatestChangeId] = useState<string | null>(null);
  const [latestAffectedBlockId, setLatestAffectedBlockId] = useState<
    string | null
  >(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const adapterRef = useRef<DocumentBuffer | null>(null);
  const pendingImagesRef = useRef(pendingImages);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const runIdRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  const assistantMessageIdRef = useRef<string | null>(null);
  const toolResultsRef = useRef(new Map<string, ToolResponse>());
  const toolPromisesRef = useRef(new Map<string, Promise<ToolResponse>>());
  const lastSequenceRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);
  const cancelledRunIdsRef = useRef(new Set<string>());
  const pendingStartRef = useRef(false);
  const cancelledPendingStartRef = useRef(false);

  messagesRef.current = messages;

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => {
    if (
      !editor ||
      editor.isDestroyed ||
      (editor.storage as any).pageId !== pageId
    ) {
      adapterRef.current?.destroy();
      adapterRef.current = null;
      return;
    }
    const adapter = new DocumentBuffer(editor, pageId);
    adapterRef.current = adapter;
    return () => {
      if (adapterRef.current === adapter) adapterRef.current = null;
      adapter.destroy();
    };
  }, [editor, pageId]);

  useEffect(() => {
    if (!socket || !enabled || !editor || editor.isDestroyed) return;

    const handleMessage = (raw: EditingEvent | ToolRequest) => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.sessionId && socket.id && raw.sessionId !== socket.id) return;
      if (raw.pageId && raw.pageId !== pageId) return;
      if (raw.runId !== 'none' && cancelledRunIdsRef.current.has(raw.runId)) {
        return;
      }
      const isRunStarted = 'event' in raw && raw.event === 'run.started';
      if (isRunStarted) {
        if (cancelledPendingStartRef.current) {
          cancelledPendingStartRef.current = false;
          pendingStartRef.current = false;
          rememberCancelledRun(cancelledRunIdsRef.current, raw.runId);
          if (socket.connected) {
            socket.emit('message', {
              operation: 'aiPageEditing.stop',
              runId: raw.runId
            });
          }
          return;
        }
        if (runIdRef.current || !pendingStartRef.current) return;
        pendingStartRef.current = false;
        lastSequenceRef.current = (raw.sequence ?? 1) - 1;
      } else if (raw.runId !== 'none') {
        if (!runIdRef.current || raw.runId !== runIdRef.current) return;
      }
      if (
        raw.runId !== 'none' &&
        raw.sequence !== undefined &&
        raw.sequence <= lastSequenceRef.current
      ) {
        return;
      }
      if (raw.runId !== 'none' && raw.sequence !== undefined) {
        lastSequenceRef.current = raw.sequence;
      }
      if (raw.operation === 'aiPageEditing.toolRequest') {
        if (runIdRef.current !== raw.runId) return;
        void executeTool(raw);
        return;
      }

      if (raw.event === 'run.started') {
        runAbortRef.current?.abort();
        runAbortRef.current = new AbortController();
        runIdRef.current = raw.runId;
        assistantMessageIdRef.current = null;
        toolResultsRef.current.clear();
        toolPromisesRef.current.clear();
        setRunning(true);
        return;
      }
      if (raw.event === 'text.delta') {
        setMessages((current) => {
          const last = current[current.length - 1];
          if (
            last?.role === 'assistant' &&
            last.id === assistantMessageIdRef.current
          ) {
            return [
              ...current.slice(0, -1),
              { ...last, content: last.content + (raw.text || '') }
            ];
          }
          const id = `assistant:${messageId()}`;
          assistantMessageIdRef.current = id;
          return [
            ...current,
            { id, role: 'assistant', content: raw.text || '' }
          ];
        });
        return;
      }
      if (raw.event === 'tool.started') {
        setMessages((current) => [
          ...current,
          {
            id: `tool:${raw.toolCallId || messageId()}`,
            role: 'tool',
            content: `Running ${raw.toolName || 'document tool'}…`
          }
        ]);
        return;
      }
      if (raw.event === 'tool.completed') {
        const change = getToolChange(raw.output);
        if (change.changeId) setLatestChangeId(change.changeId);
        if (change.affectedBlockId) {
          setLatestAffectedBlockId(change.affectedBlockId);
        }
        const toolError = getToolError(raw.output);
        const error = raw.error || toolError;
        setMessages((current) =>
          current.map((item) =>
            item.id === `tool:${raw.toolCallId}`
              ? {
                  ...item,
                  content: error
                    ? `${raw.toolName || 'Document tool'} failed: ${formatDisplayedError(error)}`
                    : change.summary
                      ? `${raw.toolName || 'Document tool'} applied: ${change.summary}`
                      : `${raw.toolName || 'Document tool'} completed`
                }
              : item
          )
        );
        return;
      }
      if (
        raw.event === 'run.completed' ||
        raw.event === 'run.failed' ||
        raw.event === 'run.stopped'
      ) {
        pendingStartRef.current = false;
        cancelledPendingStartRef.current = false;
        if (
          raw.event === 'run.completed' &&
          raw.text &&
          !assistantMessageIdRef.current
        ) {
          setMessages((current) => [
            ...current,
            {
              id: `assistant:${messageId()}`,
              role: 'assistant',
              content: raw.text
            }
          ]);
        }
        runAbortRef.current?.abort();
        runAbortRef.current = null;
        setRunning(false);
        runIdRef.current = null;
        assistantMessageIdRef.current = null;
        if (raw.event !== 'run.completed' && raw.error?.message) {
          const runError = formatDisplayedError(raw.error);
          setMessages((current) => [
            ...current,
            { id: messageId(), role: 'tool', content: runError }
          ]);
        }
      }
    };

    const handleDisconnect = () => {
      pendingStartRef.current = false;
      cancelledPendingStartRef.current = false;
      rememberCancelledRun(cancelledRunIdsRef.current, runIdRef.current);
      runAbortRef.current?.abort();
      runAbortRef.current = null;
      if (runIdRef.current) {
        setMessages((current) => [
          ...current,
          {
            id: messageId(),
            role: 'tool',
            content: 'The editor connection closed; the AI run was stopped.'
          }
        ]);
      }
      runIdRef.current = null;
      assistantMessageIdRef.current = null;
      toolPromisesRef.current.clear();
      lastSequenceRef.current = 0;
      setRunning(false);
    };

    socket.on('message', handleMessage);
    socket.on('disconnect', handleDisconnect);
    return () => {
      socket.off('message', handleMessage);
      socket.off('disconnect', handleDisconnect);
      if (runIdRef.current && socket.connected) {
        rememberCancelledRun(cancelledRunIdsRef.current, runIdRef.current);
        runAbortRef.current?.abort();
        runAbortRef.current = null;
        socket.emit('message', {
          operation: 'aiPageEditing.stop',
          runId: runIdRef.current
        });
        runIdRef.current = null;
        assistantMessageIdRef.current = null;
        toolPromisesRef.current.clear();
        lastSequenceRef.current = 0;
        setRunning(false);
      } else {
        pendingStartRef.current = false;
        cancelledPendingStartRef.current = false;
        runAbortRef.current?.abort();
        runAbortRef.current = null;
      }
    };

    async function executeTool(request: ToolRequest) {
      const previous = toolResultsRef.current.get(request.toolCallId);
      if (previous) {
        emitToolResult(request, previous);
        return;
      }
      const inFlight = toolPromisesRef.current.get(request.toolCallId);
      if (inFlight) {
        emitToolResult(request, await inFlight);
        return;
      }

      const operation = (async (): Promise<ToolResponse> => {
        let result: BrowserToolResult | undefined;
        let error:
          { code: string; message: string; details?: unknown } | undefined;
        const signal = runAbortRef.current?.signal;
        try {
          const adapter = adapterRef.current;
          if (!adapter) {
            throw new BufferError(
              'SESSION_UNAVAILABLE',
              'The page editor is unavailable'
            );
          }
          if (request.pageId !== pageId || adapter.getPageId() !== pageId) {
            throw new BufferError(
              'ACCESS_DENIED',
              'The AI run is bound to a different page'
            );
          }
          result = await adapter.executeTool(
            request.toolName,
            request.input,
            signal
          );
        } catch (caught) {
          error = getError(caught);
        }
        return {
          ok: !error,
          ...(result ? { result } : {}),
          ...(error ? { error } : {})
        };
      })();
      toolPromisesRef.current.set(request.toolCallId, operation);
      const response = await operation;
      toolPromisesRef.current.delete(request.toolCallId);
      if (cancelledRunIdsRef.current.has(request.runId)) return;
      toolResultsRef.current.set(request.toolCallId, response);
      if (toolResultsRef.current.size > MAX_STORED_TOOL_RESULTS) {
        const oldest = toolResultsRef.current.keys().next().value;
        if (oldest) toolResultsRef.current.delete(oldest);
      }
      const change = getToolChange(response);
      if (change.changeId) setLatestChangeId(change.changeId);
      if (change.affectedBlockId) {
        setLatestAffectedBlockId(change.affectedBlockId);
      }
      if (runIdRef.current === request.runId && socket.connected) {
        emitToolResult(request, response);
      }
    }

    function emitToolResult(request: ToolRequest, response: ToolResponse) {
      socket.emit('message', {
        operation: 'aiPageEditing.toolResult',
        runId: request.runId,
        toolCallId: request.toolCallId,
        ...response
      });
    }
  }, [editor, enabled, socket, pageId]);

  useEffect(() => {
    if (enabled || !socket || !runIdRef.current) return;
    rememberCancelledRun(cancelledRunIdsRef.current, runIdRef.current);
    runAbortRef.current?.abort();
    runAbortRef.current = null;
    socket.emit('message', {
      operation: 'aiPageEditing.stop',
      runId: runIdRef.current
    });
    runIdRef.current = null;
    setRunning(false);
  }, [enabled, socket]);

  useEffect(() => {
    if (editor && !editor.isDestroyed && adapterRef.current) return;
    if (!socket || !runIdRef.current) return;
    rememberCancelledRun(cancelledRunIdsRef.current, runIdRef.current);
    runAbortRef.current?.abort();
    runAbortRef.current = null;
    socket.emit('message', {
      operation: 'aiPageEditing.stop',
      runId: runIdRef.current
    });
    runIdRef.current = null;
    assistantMessageIdRef.current = null;
    setRunning(false);
  }, [editor, pageId, socket]);

  if (!enabled || !editor || editor.isDestroyed) return null;

  const clearPendingImages = () => {
    setPendingImages((current) => {
      for (const image of current) {
        URL.revokeObjectURL(image.previewUrl);
      }
      return [];
    });
  };

  const removePendingImage = (localId: string) => {
    setPendingImages((current) => {
      const target = current.find((image) => image.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((image) => image.localId !== localId);
    });
  };

  const handleAddImages = (files: File[]) => {
    const supported = files.filter(isSupportedAiImage);
    if (supported.length !== files.length) {
      reportLocalError(
        `Unsupported files were ignored. Allowed image types: ${AI_IMAGE_ACCEPT}`
      );
    }
    const rejection = validateAiImageBatch(
      pendingImagesRef.current.length,
      supported
    );
    if (rejection) {
      reportLocalError(rejection);
      return;
    }
    for (const file of supported) {
      const localId = messageId();
      const previewUrl = URL.createObjectURL(file);
      setPendingImages((current) => [
        ...current,
        { localId, file, previewUrl, status: 'uploading' }
      ]);
      void (async () => {
        try {
          const compressed = await compressImageForAi(file);
          const attachment = await uploadFile(compressed, pageId);
          const url = (attachment as IAttachment & { url?: string }).url;
          if (!attachment.id || !url) {
            throw new Error('The upload response was missing the attachment');
          }
          setPendingImages((current) =>
            current.map((image) =>
              image.localId === localId && image.status === 'uploading'
                ? {
                    ...image,
                    file: compressed,
                    attachmentId: attachment.id,
                    url,
                    status: 'ready'
                  }
                : image
            )
          );
        } catch (error) {
          const parsed = getError(error);
          setPendingImages((current) =>
            current.map((image) =>
              image.localId === localId && image.status === 'uploading'
                ? { ...image, status: 'error', error: parsed.message }
                : image
            )
          );
        }
      })();
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    );
    if (!files.length) return;
    event.preventDefault();
    handleAddImages(files);
  };

  const handleSend = () => {
    const value = prompt.trim();
    const readyImages = pendingImages.filter(
      (image) => image.status === 'ready' && image.attachmentId && image.url
    );
    const blockedImages = pendingImages.some(
      (image) => image.status === 'uploading' || image.status === 'error'
    );
    if (running || blockedImages) return;
    if (!value && readyImages.length === 0) return;
    if (!socket) {
      reportLocalError('The editor connection is not available yet.');
      return;
    }
    if (!socket.connected) {
      reportLocalError(
        'The editor connection is not ready. Wait for it to reconnect and try again.'
      );
      return;
    }
    if (!adapterRef.current) {
      reportLocalError(
        'The page editor is still loading. Wait for the editor to finish loading and try again.'
      );
      return;
    }
    let selection;
    try {
      selection = adapterRef.current.read().selection;
    } catch (error) {
      const parsed = getError(error);
      setMessages((current) => [
        ...current,
        { id: messageId(), role: 'tool', content: parsed.message }
      ]);
      return;
    }
    const history = getBoundedHistory(messagesRef.current.slice(-20));
    setMessages((current) => [
      ...current,
      {
        id: messageId(),
        role: 'user',
        content: value,
        ...(readyImages.length
          ? {
              images: readyImages.map((image) => ({
                attachmentId: image.attachmentId as string,
                url: image.url as string,
                fileName: image.file.name
              }))
            }
          : {})
      }
    ]);
    setPrompt('');
    setOpen(true);
    setRunning(true);
    pendingStartRef.current = true;
    cancelledPendingStartRef.current = false;
    socket.emit('message', {
      operation: 'aiPageEditing.start',
      pageId,
      prompt: value,
      ...(readyImages.length
        ? {
            attachmentIds: readyImages.map(
              (image) => image.attachmentId as string
            )
          }
        : {}),
      messages: history,
      ...(selection ? { selection } : {})
    });
    clearPendingImages();
  };

  const reportLocalError = (message: string) => {
    console.warn(`[ai_page_editing] ${message}`);
    setMessages((current) => [
      ...current,
      { id: messageId(), role: 'tool', content: message }
    ]);
    setOpen(true);
  };

  const handleStop = () => {
    if (!socket || !runIdRef.current) return;
    runAbortRef.current?.abort();
    socket.emit('message', {
      operation: 'aiPageEditing.stop',
      runId: runIdRef.current
    });
  };

  const handleNewSession = () => {
    const activeRunId = runIdRef.current;
    if (pendingStartRef.current) {
      pendingStartRef.current = false;
      cancelledPendingStartRef.current = true;
    }
    rememberCancelledRun(cancelledRunIdsRef.current, activeRunId);
    runAbortRef.current?.abort();
    runAbortRef.current = null;
    if (activeRunId && socket?.connected) {
      socket.emit('message', {
        operation: 'aiPageEditing.stop',
        runId: activeRunId
      });
    }
    runIdRef.current = null;
    assistantMessageIdRef.current = null;
    toolResultsRef.current.clear();
    toolPromisesRef.current.clear();
    lastSequenceRef.current = 0;
    messagesRef.current = [];
    setMessages([]);
    setPrompt('');
    clearPendingImages();
    setRunning(false);
    setLatestChangeId(null);
    setLatestAffectedBlockId(null);
  };

  const handleUndo = () => {
    if (!latestChangeId || !adapterRef.current) return;
    try {
      adapterRef.current.undo(latestChangeId);
      setLatestChangeId(adapterRef.current.getLatestChangeId() || null);
      setLatestAffectedBlockId(null);
      setMessages((current) => [
        ...current,
        {
          id: messageId(),
          role: 'tool',
          content: 'The last AI change was undone.'
        }
      ]);
    } catch (error) {
      const parsed = getError(error);
      setMessages((current) => [
        ...current,
        {
          id: messageId(),
          role: 'tool',
          content: `Undo failed: ${parsed.message}`
        }
      ]);
    }
  };

  const handleReveal = () => {
    if (!latestAffectedBlockId || !adapterRef.current) return;
    try {
      adapterRef.current.revealBlock(latestAffectedBlockId);
    } catch (error) {
      const parsed = getError(error);
      setMessages((current) => [
        ...current,
        {
          id: messageId(),
          role: 'tool',
          content: `Navigation failed: ${parsed.message}`
        }
      ]);
    }
  };

  const readyImageCount = pendingImages.filter(
    (image) => image.status === 'ready'
  ).length;
  const blockedByPendingImages = pendingImages.some(
    (image) => image.status === 'uploading' || image.status === 'error'
  );
  const canSend =
    !blockedByPendingImages && (Boolean(prompt.trim()) || readyImageCount > 0);

  return (
    <div className={classes.root}>
      {open && (
        <Paper className={classes.panel} withBorder shadow="md" p="md">
          <Group justify="space-between" mb="xs">
            <Group gap="xs">
              <IconSparkles size={18} />
              <Text fw={600}>Page AI</Text>
              {running && <Badge size="xs">Working</Badge>}
            </Group>
            <Group gap={4}>
              <Tooltip label="New session">
                <ActionIcon
                  variant="subtle"
                  onClick={handleNewSession}
                  aria-label="New session"
                >
                  <IconPlus size={16} />
                </ActionIcon>
              </Tooltip>
              <ActionIcon
                variant="subtle"
                onClick={() => setOpen(false)}
                aria-label="Close Page AI"
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
          </Group>
          <Divider mb="sm" />
          <ScrollArea className={classes.messages} offsetScrollbars>
            <Stack gap="sm">
              {messages.length === 0 && (
                <Text size="sm" c="dimmed">
                  Ask me to rewrite or extend this page. Changes are applied to
                  the open editor.
                </Text>
              )}
              {messages.map((message) => (
                <div key={message.id}>
                  <Text size="xs" c="dimmed" mb={2}>
                    {message.role === 'user'
                      ? 'You'
                      : message.role === 'assistant'
                        ? 'Page AI'
                        : 'Tool'}
                  </Text>
                  {message.role === 'user' && message.images?.length ? (
                    <Group gap={4} mb={2}>
                      {message.images.map((image) => (
                        <img
                          key={image.attachmentId}
                          src={image.url}
                          alt={image.fileName}
                          title={image.fileName}
                          className={classes.bubbleImage}
                        />
                      ))}
                    </Group>
                  ) : null}
                  {message.role === 'assistant' ? (
                    <MarkdownContent
                      content={message.content}
                      className={classes.markdownMessage}
                    />
                  ) : (
                    <Text
                      size="sm"
                      className={
                        message.role === 'tool' ? classes.tool : classes.message
                      }
                    >
                      {message.content}
                    </Text>
                  )}
                </div>
              ))}
            </Stack>
          </ScrollArea>
          {pendingImages.length > 0 && (
            <Group gap="xs" mt="sm" wrap="nowrap">
              {pendingImages.map((image) => (
                <div
                  key={image.localId}
                  className={classes.imageChip}
                  data-status={image.status}
                >
                  <img
                    src={image.previewUrl}
                    alt={image.file.name}
                    title={image.error ?? image.file.name}
                    className={classes.imageThumb}
                  />
                  {image.status === 'uploading' && (
                    <Box className={classes.imageChipOverlay}>
                      <Loader size={14} />
                    </Box>
                  )}
                  {image.status === 'error' && (
                    <Tooltip label={image.error || 'Upload failed'}>
                      <Box className={classes.imageChipOverlay}>
                        <IconAlertTriangle
                          size={14}
                          color="var(--mantine-color-red-filled)"
                        />
                      </Box>
                    </Tooltip>
                  )}
                  <ActionIcon
                    size="xs"
                    className={classes.imageChipRemove}
                    variant="filled"
                    color="dark"
                    onClick={() => removePendingImage(image.localId)}
                    disabled={running}
                    aria-label={`Remove ${image.file.name}`}
                  >
                    <IconX size={10} />
                  </ActionIcon>
                </div>
              ))}
            </Group>
          )}
          <Group gap="xs" mt="sm" align="flex-end">
            <Tooltip label={`Attach up to ${MAX_AI_IMAGES} images`}>
              <ActionIcon
                variant="subtle"
                onClick={() => fileInputRef.current?.click()}
                disabled={running || pendingImages.length >= MAX_AI_IMAGES}
                aria-label="Attach images to Page AI"
              >
                <IconPhoto size={16} />
              </ActionIcon>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              accept={AI_IMAGE_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                if (files.length) handleAddImages(files);
              }}
            />
            <Textarea
              flex={1}
              className={classes.promptInput}
              value={prompt}
              disabled={running}
              autosize
              minRows={1}
              maxRows={5}
              resize="none"
              placeholder="Ask Page AI…"
              onChange={(event) => setPrompt(event.currentTarget.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
            />
            {running ? (
              <Tooltip label="Stop run">
                <ActionIcon
                  color="red"
                  variant="filled"
                  onClick={handleStop}
                  aria-label="Stop Page AI"
                >
                  <IconPlayerStop size={16} />
                </ActionIcon>
              </Tooltip>
            ) : (
              <ActionIcon
                color="blue"
                variant="filled"
                disabled={!canSend}
                onClick={handleSend}
                aria-label="Send to Page AI"
              >
                <IconArrowUp size={16} />
              </ActionIcon>
            )}
          </Group>
          {latestChangeId && !running && (
            <Group mt="sm" gap="xs">
              {latestAffectedBlockId && (
                <Button size="xs" variant="subtle" onClick={handleReveal}>
                  Go to change
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconRotate2 size={14} />}
                onClick={handleUndo}
              >
                Undo last AI change
              </Button>
            </Group>
          )}
        </Paper>
      )}
      <Tooltip label="Open Page AI">
        <ActionIcon
          size="lg"
          radius="xl"
          color="blue"
          variant="filled"
          onClick={() => setOpen((value) => !value)}
          aria-label="Open Page AI"
        >
          <IconSparkles size={18} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
