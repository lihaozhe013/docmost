import { z } from 'zod';
import { AgentRuntime } from './agent-runtime';
import { ResponsesApiClient } from './responses-client';

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
});
