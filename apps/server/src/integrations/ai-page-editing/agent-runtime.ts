import { LanguageModel, ModelMessage, streamText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

export interface RuntimeToolContext {
  toolCallId: string;
  signal: AbortSignal;
}

export interface RuntimeToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  description: string;
  inputSchema: TSchema;
  execute: (
    input: z.infer<TSchema>,
    context: RuntimeToolContext
  ) => Promise<unknown>;
}

export interface AgentRuntimeEvent {
  type:
    | 'text-delta'
    | 'tool-start'
    | 'tool-result'
    | 'tool-error'
    | 'finish'
    | 'error';
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  text?: string;
  usage?: unknown;
}

export interface AgentRuntimeRunOptions {
  model: LanguageModel;
  system: string;
  prompt: string;
  messages?: ModelMessage[];
  tools: Record<string, RuntimeToolDefinition>;
  signal: AbortSignal;
  maxSteps?: number;
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
}

/**
 * Thin provider-facing runtime wrapper. It deliberately knows nothing about
 * pages, editors, collaboration, or application services.
 */
export class AgentRuntime {
  async run(options: AgentRuntimeRunOptions): Promise<{ text: string }> {
    let previousTool: Promise<void> = Promise.resolve();
    const runtimeTools = Object.fromEntries(
      Object.entries(options.tools).map(([name, definition]) => [
        name,
        tool({
          description: definition.description,
          inputSchema: definition.inputSchema,
          execute: async (input, context) => {
            const executeTool = async () => {
              await options.onEvent?.({
                type: 'tool-start',
                toolCallId: context.toolCallId,
                toolName: name,
                input
              });

              try {
                const output = await definition.execute(input, {
                  toolCallId: context.toolCallId,
                  signal: options.signal
                });
                await options.onEvent?.({
                  type: 'tool-result',
                  toolCallId: context.toolCallId,
                  toolName: name,
                  input,
                  output
                });
                return output;
              } catch (error) {
                await options.onEvent?.({
                  type: 'tool-error',
                  toolCallId: context.toolCallId,
                  toolName: name,
                  input,
                  error
                });
                throw error;
              }
            };

            const currentTool = previousTool.then(executeTool, executeTool);
            previousTool = currentTool.then(
              () => undefined,
              () => undefined
            );
            return currentTool;
          }
        })
      ])
    );

    try {
      const result = streamText({
        model: options.model,
        system: options.system,
        messages: [
          ...(options.messages ?? []),
          { role: 'user', content: options.prompt }
        ],
        tools: runtimeTools,
        stopWhen: stepCountIs(options.maxSteps ?? 8),
        maxRetries: 1,
        abortSignal: options.signal
      });

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          await options.onEvent?.({ type: 'text-delta', text: part.text });
        } else if (part.type === 'finish') {
          await options.onEvent?.({
            type: 'finish',
            usage: part.totalUsage
          });
        } else if (part.type === 'error') {
          await options.onEvent?.({ type: 'error', error: part.error });
        }
      }

      return { text: await result.text };
    } catch (error) {
      await options.onEvent?.({ type: 'error', error });
      throw error;
    }
  }
}
