import { Editor } from '@tiptap/core';
import { Socket } from 'socket.io-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BufferError, DocumentBuffer } from './document-buffer';
import type { BrowserToolResult } from './document-buffer';
import type {
  ChatMessage,
  ChatMessageImage,
  EditingEvent,
  ToolRequest,
  ToolResponse
} from './ai-page-editing-types';
import {
  getBoundedHistory,
  getError,
  getToolChange,
  getToolError,
  formatDisplayedError,
  MAX_STORED_TOOL_RESULTS,
  messageId,
  rememberCancelledRun
} from './ai-page-editing-utils';

/**
 * Owns the Page AI run protocol: adapter lifecycle, socket event reduction,
 * tool execution, revision-sensitive actions, and chat transcript state.
 */
export function useAiPageEditingRun({
  socket,
  editor,
  pageId,
  enabled,
  onShowPanel
}: {
  socket: Socket | null;
  editor: Editor | null;
  pageId: string;
  enabled: boolean;
  onShowPanel: () => void;
}) {
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
  const cancelledRunIdsRef = useRef(new Set<string>());
  const pendingStartRef = useRef(false);
  const cancelledPendingStartRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  const appendToolMessage = useCallback((content: string) => {
    setMessages((current) => [
      ...current,
      { id: messageId(), role: 'tool', content }
    ]);
  }, []);

  const reportLocalError = useCallback(
    (message: string) => {
      console.warn(`[ai_page_editing] ${message}`);
      appendToolMessage(message);
      onShowPanel();
    },
    [appendToolMessage, onShowPanel]
  );

  /**
   * Validates preconditions and emits the run start request. Returns false
   * when the request was not sent; local errors are already reported.
   */
  const startRun = (
    value: string,
    readyImages: ChatMessageImage[]
  ): boolean => {
    if (!socket) {
      reportLocalError('The editor connection is not available yet.');
      return false;
    }
    if (!socket.connected) {
      reportLocalError(
        'The editor connection is not ready. Wait for it to reconnect and try again.'
      );
      return false;
    }
    if (!adapterRef.current) {
      reportLocalError(
        'The page editor is still loading. Wait for the editor to finish loading and try again.'
      );
      return false;
    }
    let selection;
    try {
      selection = adapterRef.current.read().selection;
    } catch (error) {
      appendToolMessage(getError(error).message);
      return false;
    }
    const history = getBoundedHistory(messagesRef.current.slice(-20));
    setMessages((current) => [
      ...current,
      {
        id: messageId(),
        role: 'user',
        content: value,
        ...(readyImages.length ? { images: readyImages } : {})
      }
    ]);
    setRunning(true);
    pendingStartRef.current = true;
    cancelledPendingStartRef.current = false;
    socket.emit('message', {
      operation: 'aiPageEditing.start',
      pageId,
      prompt: value,
      ...(readyImages.length
        ? {
            attachmentIds: readyImages.map((image) => image.attachmentId)
          }
        : {}),
      messages: history,
      ...(selection ? { selection } : {})
    });
    return true;
  };

  const stopRun = () => {
    if (!socket || !runIdRef.current) return;
    runAbortRef.current?.abort();
    socket.emit('message', {
      operation: 'aiPageEditing.stop',
      runId: runIdRef.current
    });
  };

  const resetSession = () => {
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
    setRunning(false);
    setLatestChangeId(null);
    setLatestAffectedBlockId(null);
  };

  const undoLastChange = () => {
    if (!latestChangeId || !adapterRef.current) return;
    try {
      adapterRef.current.undo(latestChangeId);
      setLatestChangeId(adapterRef.current.getLatestChangeId() || null);
      setLatestAffectedBlockId(null);
      appendToolMessage('The last AI change was undone.');
    } catch (error) {
      const parsed = getError(error);
      appendToolMessage(`Undo failed: ${parsed.message}`);
    }
  };

  const revealLatestChange = () => {
    if (!latestAffectedBlockId || !adapterRef.current) return;
    try {
      adapterRef.current.revealBlock(latestAffectedBlockId);
    } catch (error) {
      const parsed = getError(error);
      appendToolMessage(`Navigation failed: ${parsed.message}`);
    }
  };

  return {
    messages,
    running,
    latestChangeId,
    latestAffectedBlockId,
    startRun,
    stopRun,
    resetSession,
    undoLastChange,
    revealLatestChange,
    reportLocalError
  };
}
