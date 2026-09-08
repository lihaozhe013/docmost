import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageEditorAtom } from '@/features/editor/atoms/editor-atoms';
import { socketAtom } from '@/features/websocket/atoms/socket-atom';
import { AiPageEditingPanel } from './ai-page-editing-panel';

const PAGE_ID = 'page-1';
const SOCKET_ID = 'socket-1';

const mocks = vi.hoisted(() => ({
  read: vi.fn(() => ({ selection: undefined })),
  executeTool: vi.fn(),
  undo: vi.fn(),
  getLatestChangeId: vi.fn(() => ''),
  revealBlock: vi.fn()
}));

vi.mock('./document-buffer', () => {
  class TestBufferError extends Error {
    code = 'SESSION_UNAVAILABLE';
    details?: unknown;
  }

  class TestDocumentBuffer {
    constructor(
      private readonly editor: unknown,
      private readonly pageId: string
    ) {}

    destroy = vi.fn();

    getPageId() {
      return this.pageId;
    }

    read = mocks.read;
    executeTool = mocks.executeTool;
    undo = mocks.undo;
    getLatestChangeId = mocks.getLatestChangeId;
    revealBlock = mocks.revealBlock;
  }

  return {
    BufferError: TestBufferError,
    DocumentBuffer: TestDocumentBuffer
  };
});

type MessageHandler = (message: Record<string, unknown>) => void;

function createSocket() {
  let messageHandler: MessageHandler | undefined;
  const socket = {
    id: SOCKET_ID,
    connected: true,
    on: vi.fn((event: string, handler: MessageHandler) => {
      if (event === 'message') messageHandler = handler;
    }),
    off: vi.fn(),
    emit: vi.fn()
  };

  return {
    socket,
    emitMessage(message: Record<string, unknown>) {
      act(() => {
        messageHandler?.(message);
      });
    }
  };
}

function renderPanel() {
  const { socket, emitMessage } = createSocket();
  const editor = {
    isDestroyed: false,
    storage: { pageId: PAGE_ID },
    on: vi.fn(),
    off: vi.fn()
  };
  const store = createStore();
  store.set(socketAtom as never, socket as never);
  store.set(pageEditorAtom as never, editor as never);

  render(
    <Provider store={store}>
      <MantineProvider>
        <AiPageEditingPanel pageId={PAGE_ID} enabled />
      </MantineProvider>
    </Provider>
  );
  fireEvent.click(screen.getByLabelText('Open Page AI'));

  return { socket, emitMessage };
}

describe('AiPageEditingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
    );
  });

  it('uses a wrapping textarea and keeps Shift+Enter local', () => {
    const { socket } = renderPanel();
    const input = screen.getByPlaceholderText('Ask Page AI…');

    expect(input.tagName).toBe('TEXTAREA');
    fireEvent.change(input, { target: { value: 'line one\nline two' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect((input as HTMLTextAreaElement).value).toBe('line one\nline two');
    expect(socket.emit).not.toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ operation: 'aiPageEditing.start' })
    );
  });

  it('sends the prompt when Enter is pressed', () => {
    const { socket } = renderPanel();
    const input = screen.getByPlaceholderText('Ask Page AI…');

    fireEvent.change(input, { target: { value: 'Rewrite this paragraph' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(socket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        operation: 'aiPageEditing.start',
        pageId: PAGE_ID,
        prompt: 'Rewrite this paragraph'
      })
    );
  });

  it('clears the session and ignores events from the stopped run', () => {
    const { socket, emitMessage } = renderPanel();
    const input = screen.getByPlaceholderText('Ask Page AI…');

    fireEvent.change(input, { target: { value: 'First request' } });
    fireEvent.click(screen.getByLabelText('Send to Page AI'));
    emitMessage({
      operation: 'aiPageEditing.event',
      sessionId: SOCKET_ID,
      pageId: PAGE_ID,
      runId: 'run-1',
      event: 'run.started'
    });

    expect(screen.getByText('First request')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('New session'));

    expect(screen.queryByText('First request')).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(socket.emit).toHaveBeenCalledWith('message', {
      operation: 'aiPageEditing.stop',
      runId: 'run-1'
    });

    emitMessage({
      operation: 'aiPageEditing.event',
      sessionId: SOCKET_ID,
      pageId: PAGE_ID,
      runId: 'run-1',
      event: 'text.delta',
      text: 'Late response'
    });

    expect(screen.queryByText('Late response')).toBeNull();
  });

  it('stops a run that starts after a new session was requested', () => {
    const { socket, emitMessage } = renderPanel();
    const input = screen.getByPlaceholderText('Ask Page AI…');

    fireEvent.change(input, { target: { value: 'First request' } });
    fireEvent.click(screen.getByLabelText('Send to Page AI'));
    fireEvent.click(screen.getByLabelText('New session'));

    emitMessage({
      operation: 'aiPageEditing.event',
      sessionId: SOCKET_ID,
      pageId: PAGE_ID,
      runId: 'late-run',
      event: 'run.started'
    });
    emitMessage({
      operation: 'aiPageEditing.event',
      sessionId: SOCKET_ID,
      pageId: PAGE_ID,
      runId: 'late-run',
      event: 'text.delta',
      text: 'Late response'
    });

    expect(socket.emit).toHaveBeenCalledWith('message', {
      operation: 'aiPageEditing.stop',
      runId: 'late-run'
    });
    expect(screen.queryByText('Late response')).toBeNull();
  });

  it('clears the previous change controls when starting a new session', () => {
    const { emitMessage } = renderPanel();
    const input = screen.getByPlaceholderText('Ask Page AI…');

    fireEvent.change(input, { target: { value: 'Make a change' } });
    fireEvent.click(screen.getByLabelText('Send to Page AI'));
    emitMessage({
      operation: 'aiPageEditing.event',
      sessionId: SOCKET_ID,
      pageId: PAGE_ID,
      runId: 'run-2',
      event: 'run.started'
    });
    emitMessage({
      operation: 'aiPageEditing.event',
      sessionId: SOCKET_ID,
      pageId: PAGE_ID,
      runId: 'run-2',
      event: 'tool.completed',
      toolCallId: 'call-2',
      toolName: 'edit_buffer',
      output: {
        ok: true,
        result: {
          changeId: 'change-2',
          affectedBlockIds: ['block-2']
        }
      }
    });
    emitMessage({
      operation: 'aiPageEditing.event',
      sessionId: SOCKET_ID,
      pageId: PAGE_ID,
      runId: 'run-2',
      event: 'run.completed'
    });

    expect(screen.getByText('Undo last AI change')).toBeTruthy();
    expect(screen.getByText('Go to change')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('New session'));

    expect(screen.queryByText('Undo last AI change')).toBeNull();
    expect(screen.queryByText('Go to change')).toBeNull();
  });
});
