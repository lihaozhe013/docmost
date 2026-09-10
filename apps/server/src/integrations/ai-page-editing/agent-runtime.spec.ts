import { z } from 'zod';
import { AgentRuntime } from './agent-runtime';
import { normalizeInsertBlocksInput } from './ai-page-editing.service';
import { ResponsesApiClient, ResponsesInputItem } from './responses-client';

describe('AgentRuntime', () => {
  it('rejects reuse of a tool call ID with different arguments', async () => {
    let modelCall = 0;
    let executions = 0;
    const client: ResponsesApiClient = {
      stream: async () => {
        modelCall += 1;
        const argumentsValue = JSON.stringify({ value: modelCall });
        return {
          text: '',
          output: [
            {
              type: 'function_call',
              call_id: 'duplicate-call',
              name: 'edit_buffer',
              arguments: argumentsValue
            }
          ],
          functionCalls: [
            {
              callId: 'duplicate-call',
              name: 'edit_buffer',
              arguments: argumentsValue
            }
          ]
        };
      }
    };

    await expect(
      new AgentRuntime().run({
        client,
        model: 'test-model',
        system: 'Use the tool',
        prompt: 'Edit the page',
        tools: {
          edit_buffer: {
            description: 'Apply an edit',
            inputSchema: z.object({ value: z.number() }),
            execute: async () => {
              executions += 1;
              return { ok: true };
            }
          }
        },
        signal: new AbortController().signal,
        maxSteps: 3
      })
    ).rejects.toThrow('was reused with different arguments');

    expect(modelCall).toBe(2);
    expect(executions).toBe(1);
  });

  it('normalizes a legacy insert target before schema validation', async () => {
    let executedInput: unknown;
    let modelCall = 0;
    const client: ResponsesApiClient = {
      stream: async (options) => {
        modelCall += 1;
        if (modelCall === 1) {
          return {
            text: '',
            output: [
              {
                type: 'function_call',
                call_id: 'insert-call',
                name: 'insert_blocks',
                arguments: JSON.stringify({
                  expectedRevision: 'r1',
                  target: JSON.stringify({ kind: 'document_end' }),
                  markdown: 'New paragraph'
                })
              }
            ],
            functionCalls: [
              {
                callId: 'insert-call',
                name: 'insert_blocks',
                arguments: JSON.stringify({
                  expectedRevision: 'r1',
                  target: JSON.stringify({ kind: 'document_end' }),
                  markdown: 'New paragraph'
                })
              }
            ]
          };
        }
        await options.onTextDelta?.('Inserted');
        return {
          text: 'Inserted',
          output: [],
          functionCalls: []
        };
      }
    };

    await expect(
      new AgentRuntime().run({
        client,
        model: 'test-model',
        system: 'Use the tool',
        prompt: 'Insert content',
        tools: {
          insert_blocks: {
            description: 'Insert content',
            normalizeInput: normalizeInsertBlocksInput,
            inputSchema: z.object({
              expectedRevision: z.string(),
              target: z.object({ kind: z.literal('document_end') }),
              markdown: z.string()
            }),
            execute: async (input) => {
              executedInput = input;
              return { ok: true };
            }
          }
        },
        signal: new AbortController().signal
      })
    ).resolves.toEqual({ text: 'Inserted' });

    expect(executedInput).toEqual({
      expectedRevision: 'r1',
      target: { kind: 'document_end' },
      markdown: 'New paragraph'
    });
  });

  it('classifies failed tool envelopes and stops repeated identical failures', async () => {
    let modelCall = 0;
    const events: Array<{ type: string; error?: unknown }> = [];
    const client: ResponsesApiClient = {
      stream: async () => {
        modelCall += 1;
        const argumentsValue = JSON.stringify({
          expectedRevision: 'r1',
          target: 'after_block',
          markdown: 'New paragraph'
        });
        return {
          text: '',
          output: [
            {
              type: 'function_call',
              call_id: `failed-call-${modelCall}`,
              name: 'insert_blocks',
              arguments: argumentsValue
            }
          ],
          functionCalls: [
            {
              callId: `failed-call-${modelCall}`,
              name: 'insert_blocks',
              arguments: argumentsValue
            }
          ]
        };
      }
    };

    await expect(
      new AgentRuntime().run({
        client,
        model: 'test-model',
        system: 'Use the tool',
        prompt: 'Insert content',
        tools: {
          insert_blocks: {
            description: 'Insert content',
            inputSchema: z.object({
              expectedRevision: z.string(),
              target: z.string(),
              markdown: z.string()
            }),
            execute: async () => ({
              ok: false,
              error: {
                code: 'UNSUPPORTED_RANGE',
                message: 'The target block is not supported'
              }
            })
          }
        },
        signal: new AbortController().signal,
        maxSteps: 5,
        onEvent: async (event) => {
          events.push({ type: event.type, error: event.error });
        }
      })
    ).rejects.toMatchObject({
      code: 'TOOL_RETRY_LIMIT',
      message: expect.stringContaining('stopping')
    });

    expect(modelCall).toBe(2);
    expect(events.filter((event) => event.type === 'tool-error')).toHaveLength(
      2
    );
    expect(events[events.length - 1]?.type).toBe('error');
  });

  it('sends prompt images as content parts on the user item', async () => {
    let capturedInput: ResponsesInputItem[] | undefined;
    const client: ResponsesApiClient = {
      stream: async (options) => {
        capturedInput = options.input;
        return { text: 'ok', output: [], functionCalls: [] };
      }
    };

    await new AgentRuntime().run({
      client,
      model: 'test-model',
      system: 'Answer',
      prompt: 'What is in this image?',
      images: ['data:image/png;base64,YWJj'],
      messages: [{ role: 'assistant', content: 'Earlier reply' }],
      tools: {},
      signal: new AbortController().signal
    });

    expect(capturedInput?.[0]).toEqual({
      role: 'assistant',
      content: 'Earlier reply'
    });
    expect(capturedInput?.[1]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is in this image?' },
        { type: 'input_image', image_url: 'data:image/png;base64,YWJj' }
      ]
    });
  });

  it('omits the text part when a message carries only images', async () => {
    let capturedInput: ResponsesInputItem[] | undefined;
    const client: ResponsesApiClient = {
      stream: async (options) => {
        capturedInput = options.input;
        return { text: 'ok', output: [], functionCalls: [] };
      }
    };

    await new AgentRuntime().run({
      client,
      model: 'test-model',
      system: 'Answer',
      prompt: '',
      images: ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='],
      tools: {},
      signal: new AbortController().signal
    });

    expect(capturedInput?.[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/jpeg;base64,YQ==' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,Yg==' }
      ]
    });
  });
});
