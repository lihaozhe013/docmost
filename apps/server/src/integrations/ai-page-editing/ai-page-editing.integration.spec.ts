import { AgentRuntime } from './agent-runtime';
import { AiPageEditingImageService } from './ai-page-editing-image.service';
import {
  AiPageEditingService,
  normalizeInsertBlocksInput
} from './ai-page-editing.service';
import { ResponsesApiClient, ResponsesStreamOptions } from './responses-client';

const allowAllImages = {
  resolveImages: async () => []
} as unknown as AiPageEditingImageService;

function imageServiceFor(
  attachments: Record<string, any>,
  fileContents: Record<string, Buffer> = {}
): AiPageEditingImageService {
  const attachmentRepo = {
    findById: async (id: string) => attachments[id] ?? null
  } as any;
  const storageService = {
    read: async (filePath: string) => {
      const content = fileContents[filePath];
      if (!content) throw new Error(`missing file ${filePath}`);
      return content;
    }
  } as any;
  return new AiPageEditingImageService(attachmentRepo, storageService);
}

describe('AI page editing session', () => {
  it('normalizes provider-encoded insertion targets once', () => {
    const input = {
      expectedRevision: 'r1',
      target: JSON.stringify({ kind: 'after_block', blockId: 'b1' }),
      markdown: 'New paragraph'
    };

    expect(normalizeInsertBlocksInput(input)).toEqual({
      expectedRevision: 'r1',
      target: { kind: 'after_block', blockId: 'b1' },
      markdown: 'New paragraph'
    });
    expect(
      normalizeInsertBlocksInput({
        ...input,
        target: 'document_start'
      })
    ).toEqual({
      expectedRevision: 'r1',
      target: { kind: 'document_start' },
      markdown: 'New paragraph'
    });
    expect(
      normalizeInsertBlocksInput({
        ...input,
        target: '{"kind":"unknown"}'
      })
    ).toEqual({
      ...input,
      target: { kind: 'unknown' }
    });
    expect(
      normalizeInsertBlocksInput({
        ...input,
        target: '{kind:"document_end"}'
      })
    ).toEqual({
      ...input,
      target: '{kind:"document_end"}'
    });
  });

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
            ? {
                revision: 'r1',
                complete: true,
                blocks: [
                  {
                    blockId: 'b0',
                    type: 'paragraph',
                    editable: true,
                    capabilities: ['replace_text'],
                    text: 'before'
                  }
                ]
              }
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
      new AgentRuntime(),
      allowAllImages
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
    expect(requests[0]?.tools[2]?.description).toContain(
      'target must be an object'
    );
    expect(requests[0]?.tools[2]?.parameters).toMatchObject({
      properties: {
        target: expect.any(Object)
      }
    });
    expect(JSON.stringify(requests[0]?.tools[1]?.parameters)).toContain(
      'replace_code'
    );
    expect(JSON.stringify(requests[0]?.tools[1]?.parameters)).toContain(
      'replace_inline_math'
    );
    expect(requests[0]?.instructions).toContain('capabilities: replace_text');
    expect(requests[0]?.instructions).toContain('Mermaid');
    expect(requests[0]?.instructions).toContain('LaTeX');
    expect(JSON.stringify(requests[1]?.input)).toContain('r1');
    expect(JSON.stringify(requests[2]?.input)).toContain('change-1');
  });

  it('forwards structured tool errors and stops repeated failures', async () => {
    const serviceRef: { current?: AiPageEditingService } = {};
    const emitted: any[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let modelCall = 0;
    const client: ResponsesApiClient = {
      stream: async () => {
        modelCall += 1;
        const argumentsValue = JSON.stringify({
          expectedRevision: 'r1',
          target: { kind: 'document_end' },
          markdown: 'New paragraph'
        });
        return {
          text: '',
          output: [
            {
              type: 'function_call',
              id: `fc-insert-${modelCall}`,
              call_id: `insert-${modelCall}`,
              name: 'insert_blocks',
              arguments: argumentsValue
            }
          ],
          functionCalls: [
            {
              callId: `insert-${modelCall}`,
              name: 'insert_blocks',
              arguments: argumentsValue
            }
          ]
        };
      }
    };

    const socket: any = {
      id: 'socket-2',
      connected: true,
      data: { userId: 'user-1', workspaceId: 'workspace-1' },
      emit: (_event: string, payload: any) => {
        emitted.push(payload);
        if (payload?.event === 'run.failed') finish();
        if (payload?.operation !== 'aiPageEditing.toolRequest') return;
        void serviceRef.current?.handleMessage(socket, {
          operation: 'aiPageEditing.toolResult',
          runId: payload.runId,
          toolCallId: payload.toolCallId,
          ...(payload.toolName === 'read_buffer'
            ? {
                ok: true,
                result: { revision: 'r1', complete: true, blocks: [] }
              }
            : {
                ok: false,
                error: {
                  code: 'UNSUPPORTED_RANGE',
                  message: 'The target block is not supported'
                }
              })
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
      new AgentRuntime(),
      allowAllImages
    );
    serviceRef.current = service;

    await service.handleMessage(socket, {
      operation: 'aiPageEditing.start',
      pageId: 'page-1',
      prompt: 'Insert content',
      messages: []
    });
    await completed;

    expect(modelCall).toBe(2);
    const failedToolEvents = emitted.filter(
      (event) => event.event === 'tool.completed' && event.error
    );
    expect(failedToolEvents).toHaveLength(2);
    expect(failedToolEvents[0]?.error).toMatchObject({
      code: 'UNSUPPORTED_RANGE'
    });
    expect(
      emitted.find((event) => event.event === 'run.failed')?.error
    ).toMatchObject({ code: 'TOOL_RETRY_LIMIT' });
  });

  it('sends current-run images as input parts to the model', async () => {
    const serviceRef: { current?: AiPageEditingService } = {};
    const emitted: any[] = [];
    const requests: ResponsesStreamOptions[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const attachmentId = '6f2f1a2b-3c4d-4e5f-aa7b-8c9d0e1f2a3b';
    const png = Buffer.from('fake-png-bytes');
    const imageService = imageServiceFor(
      {
        [attachmentId]: {
          id: attachmentId,
          creatorId: 'user-1',
          workspaceId: 'workspace-1',
          pageId: 'page-1',
          deletedAt: null,
          fileExt: '.png',
          fileSize: String(png.length),
          mimeType: 'image/png',
          filePath: 'workspace-1/files/att-1.png'
        }
      },
      { 'workspace-1/files/att-1.png': png }
    );
    const client: ResponsesApiClient = {
      stream: async (options) => {
        requests.push(options);
        await options.onTextDelta?.('Seen it.');
        return { text: 'Seen it.', output: [], functionCalls: [] };
      }
    };

    const socket: any = {
      id: 'socket-images',
      connected: true,
      data: { userId: 'user-1', workspaceId: 'workspace-1' },
      emit: (_event: string, payload: any) => {
        emitted.push(payload);
        if (payload?.event === 'run.completed') finish();
        if (payload?.operation !== 'aiPageEditing.toolRequest') return;
        void serviceRef.current?.handleMessage(socket, {
          operation: 'aiPageEditing.toolResult',
          runId: payload.runId,
          toolCallId: payload.toolCallId,
          ok: true,
          result: { revision: 'r1', complete: true, blocks: [] }
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
      new AgentRuntime(),
      imageService
    );
    serviceRef.current = service;

    await service.handleMessage(socket, {
      operation: 'aiPageEditing.start',
      pageId: 'page-1',
      prompt: 'What is in this image?',
      attachmentIds: [attachmentId],
      messages: []
    });
    await completed;

    const userItem = requests[0]?.input.at(-1) as Record<string, unknown>;
    expect(userItem.role).toBe('user');
    expect(userItem.content).toEqual([
      { type: 'input_text', text: 'What is in this image?' },
      {
        type: 'input_image',
        image_url: `data:image/png;base64,${png.toString('base64')}`
      }
    ]);
    expect(emitted.some((event) => event.event === 'run.completed')).toBe(true);
  });

  it('fails the run when a referenced image is not the uploader own', async () => {
    const emitted: any[] = [];
    const requests: ResponsesStreamOptions[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const attachmentId = '7a3b2c1d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const imageService = imageServiceFor({
      [attachmentId]: {
        id: attachmentId,
        creatorId: 'user-2',
        workspaceId: 'workspace-1',
        pageId: 'page-1',
        deletedAt: null,
        fileExt: '.png',
        fileSize: '10',
        mimeType: 'image/png',
        filePath: 'workspace-1/files/att-2.png'
      }
    });
    const client: ResponsesApiClient = {
      stream: async (options) => {
        requests.push(options);
        return { text: '', output: [], functionCalls: [] };
      }
    };

    const socket: any = {
      id: 'socket-foreign-image',
      connected: true,
      data: { userId: 'user-1', workspaceId: 'workspace-1' },
      emit: (_event: string, payload: any) => {
        emitted.push(payload);
        if (payload?.event === 'run.failed') finish();
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
      new AgentRuntime(),
      imageService
    );

    await service.handleMessage(socket, {
      operation: 'aiPageEditing.start',
      pageId: 'page-1',
      prompt: 'What is in this image?',
      attachmentIds: [attachmentId],
      messages: []
    });
    await completed;

    expect(
      emitted.find((event) => event.event === 'run.failed')?.error
    ).toMatchObject({ code: 'INVALID_ATTACHMENT' });
    expect(requests).toHaveLength(0);
  });
});
