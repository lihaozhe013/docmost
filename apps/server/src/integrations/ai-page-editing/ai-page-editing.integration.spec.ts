import { AgentRuntime } from './agent-runtime';
import { AiPageEditingService } from './ai-page-editing.service';
import { ResponsesApiClient, ResponsesStreamOptions } from './responses-client';

describe('AI page editing session', () => {
  it('runs a read/edit loop through the runtime and browser bridge', async () => {
    const serviceRef: { current?: AiPageEditingService } = {};
    const emitted: any[] = [];
    const requests: ResponsesStreamOptions[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let modelCall = 0;
    const client: ResponsesApiClient = {
      stream: async (options) => {
        requests.push(options);
        modelCall += 1;
        if (modelCall === 1) {
          return {
            text: '',
            output: [
              {
                type: 'function_call',
                id: 'fc-read',
                call_id: 'read-1',
                name: 'read_buffer',
                arguments: '{}'
              }
            ],
            functionCalls: [
              { callId: 'read-1', name: 'read_buffer', arguments: '{}' }
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
          };
        }
        if (modelCall === 2) {
          return {
            text: '',
            output: [
              {
                type: 'function_call',
                id: 'fc-edit',
                call_id: 'edit-1',
                name: 'edit_buffer',
                arguments: JSON.stringify({
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
              }
            ],
            functionCalls: [
              {
                callId: 'edit-1',
                name: 'edit_buffer',
                arguments: JSON.stringify({
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
              }
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
          };
        }
        await options.onTextDelta?.('Applied.');
        return {
          text: 'Applied.',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Applied.' }]
            }
          ],
          functionCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        };
      }
    };

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
      { create: () => client, getModel: () => 'test-model' } as any,
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
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      'read_buffer',
      'edit_buffer',
      'insert_blocks'
    ]);
    expect(requests[0]?.tools[0]?.strict).toBe(false);
    expect(requests[0]?.tools[0]?.parameters).not.toHaveProperty('$schema');
    expect(JSON.stringify(requests[1]?.input)).toContain('r1');
    expect(JSON.stringify(requests[2]?.input)).toContain('change-1');
  });
});
