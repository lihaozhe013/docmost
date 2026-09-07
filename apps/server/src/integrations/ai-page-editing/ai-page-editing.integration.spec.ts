import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { AgentRuntime } from './agent-runtime';
import { AiPageEditingService } from './ai-page-editing.service';

describe('AI page editing session', () => {
  it('runs a read/edit loop through the runtime and browser bridge', async () => {
    const serviceRef: { current?: AiPageEditingService } = {};
    const emitted: any[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const usage = {
      inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: 0,
        cacheWrite: 0
      },
      outputTokens: { total: 1, text: 1, reasoning: 0 }
    };
    let modelCall = 0;
    let modelPrompt: unknown;
    const model = new MockLanguageModelV3({
      doStream: async (options: any) => {
        modelPrompt = options.prompt;
        modelCall += 1;
        const chunks =
          modelCall === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'read-1',
                  toolName: 'read_buffer',
                  input: '{}'
                },
                { type: 'finish', usage, finishReason: 'tool-calls' }
              ]
            : modelCall === 2
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'edit-1',
                    toolName: 'edit_buffer',
                    input: JSON.stringify({
                      expectedRevision: 'r1',
                      operations: [
                        {
                          type: 'replace_text',
                          blockId: 'b0',
                          oldText: 'before',
                          newText: 'after'
                        }
                      ]
                    })
                  },
                  { type: 'finish', usage, finishReason: 'tool-calls' }
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'text-1' },
                  { type: 'text-delta', id: 'text-1', delta: 'Applied.' },
                  { type: 'text-end', id: 'text-1' },
                  { type: 'finish', usage, finishReason: 'stop' }
                ];
        return {
          stream: simulateReadableStream({ chunks: chunks as any[] })
        };
      }
    });

    const socket: any = {
      id: 'socket-1',
      connected: true,
      data: { userId: 'user-1', workspaceId: 'workspace-1' },
      emit: (_event: string, payload: any) => {
        emitted.push(payload);
        if (payload?.event === 'run.completed') finish();
        if (payload?.operation !== 'aiPageEditing.toolRequest') return;
        expect(payload.pageId).toBe('page-1');

        const result =
          payload.toolName === 'read_buffer'
            ? { revision: 'r1', complete: true, blocks: [] }
            : {
                changeId: 'change-1',
                revision: 'r2',
                affectedBlockIds: ['b0'],
                changes: [{ blockId: 'b0', before: 'before', after: 'after' }]
              };
        void serviceRef.current?.handleMessage(socket, {
          operation: 'aiPageEditing.toolResult',
          runId: payload.runId,
          toolCallId: payload.toolCallId,
          ok: true,
          result
        });
      }
    };

    const service = new AiPageEditingService(
      {
        findById: async () => ({ id: 'user-1', workspaceId: 'workspace-1' })
      } as any,
      {
        findById: async () => ({
          id: 'page-1',
          workspaceId: 'workspace-1',
          deletedAt: null
        })
      } as any,
      { validateCanEdit: async () => undefined } as any,
      { create: () => model } as any,
      new AgentRuntime()
    );
    serviceRef.current = service;

    await service.handleMessage(socket, {
      operation: 'aiPageEditing.start',
      pageId: 'page-1',
      prompt: 'Update the page',
      messages: []
    });
    await completed;

    expect(emitted.some((event) => event.event === 'run.started')).toBe(true);
    expect(
      emitted.find((event) => event.event === 'run.started')
    ).toMatchObject({
      sessionId: socket.id,
      sequence: 1
    });
    expect(emitted.some((event) => event.event === 'tool.started')).toBe(true);
    expect(emitted.some((event) => event.event === 'tool.completed')).toBe(
      true
    );
    expect(emitted.some((event) => event.event === 'text.delta')).toBe(true);
    expect(emitted.some((event) => event.event === 'run.completed')).toBe(true);
    expect(modelCall).toBe(3);
    expect(JSON.stringify(modelPrompt)).toContain('revision: r1');
  });
});
