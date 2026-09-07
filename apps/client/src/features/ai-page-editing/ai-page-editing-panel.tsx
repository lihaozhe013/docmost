import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core';
import {
  IconArrowUp,
  IconPlayerStop,
  IconRotate2,
  IconSparkles,
  IconX
} from '@tabler/icons-react';
import { useAtom } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { socketAtom } from '@/features/websocket/atoms/socket-atom.ts';
import { pageEditorAtom } from '@/features/editor/atoms/editor-atoms.ts';
import {
  BufferError,
  BrowserToolResult,
  DocumentBuffer
} from './document-buffer';
import classes from './ai-page-editing-panel.module.css';

const MAX_STORED_TOOL_RESULTS = 24;
const MAX_HISTORY_CHARS = 80_000;

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
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
  error?: { code?: string; message: string };
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
  error?: { code: string; message: string };
};

function messageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getError(error: unknown): { code: string; message: string } {
  if (error instanceof BufferError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'SESSION_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error)
  };
}

function getToolError(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const envelope = output as {
    ok?: boolean;
    error?: { message?: unknown };
  };
  return envelope.ok === false && typeof envelope.error?.message === 'string'
    ? envelope.error.message
    : undefined;
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
  const adapterRef = useRef<DocumentBuffer | null>(null);
  const runIdRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  const assistantMessageIdRef = useRef<string | null>(null);
  const toolResultsRef = useRef(new Map<string, ToolResponse>());
  const toolPromisesRef = useRef(new Map<string, Promise<ToolResponse>>());
  const lastSequenceRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);

  messagesRef.current = messages;

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
      const isRunStarted = 'event' in raw && raw.event === 'run.started';
      if (isRunStarted) {
        if (runIdRef.current) return;
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
        setMessages((current) =>
          current.map((item) =>
            item.id === `tool:${raw.toolCallId}`
              ? {
                  ...item,
                  content:
                    raw.error || toolError
                      ? `${raw.toolName || 'Document tool'} failed: ${raw.error?.message || toolError}`
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
          setMessages((current) => [
            ...current,
            { id: messageId(), role: 'tool', content: raw.error.message }
          ]);
        }
      }
    };

    const handleDisconnect = () => {
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
        let error: { code: string; message: string } | undefined;
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

  const handleSend = () => {
    const value = prompt.trim();
    if (!value || running || !socket || !adapterRef.current) return;
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
      { id: messageId(), role: 'user', content: value }
    ]);
    setPrompt('');
    setOpen(true);
    setRunning(true);
    socket.emit('message', {
      operation: 'aiPageEditing.start',
      pageId,
      prompt: value,
      messages: history,
      ...(selection ? { selection } : {})
    });
  };

  const handleStop = () => {
    if (!socket || !runIdRef.current) return;
    runAbortRef.current?.abort();
    socket.emit('message', {
      operation: 'aiPageEditing.stop',
      runId: runIdRef.current
    });
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
            <ActionIcon
              variant="subtle"
              onClick={() => setOpen(false)}
              aria-label="Close Page AI"
            >
              <IconX size={16} />
            </ActionIcon>
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
                  <Text
                    size="sm"
                    className={
                      message.role === 'tool' ? classes.tool : classes.message
                    }
                  >
                    {message.content}
                  </Text>
                </div>
              ))}
            </Stack>
          </ScrollArea>
          <Group gap="xs" mt="sm" align="flex-end">
            <TextInput
              flex={1}
              value={prompt}
              disabled={running}
              placeholder="Ask Page AI…"
              onChange={(event) => setPrompt(event.currentTarget.value)}
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
                disabled={!prompt.trim()}
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
