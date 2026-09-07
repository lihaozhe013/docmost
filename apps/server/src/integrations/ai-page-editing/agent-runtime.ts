import { z } from 'zod';
import {
  ResponsesApiClient,
  ResponsesFunctionTool,
  ResponsesInputItem,
  ResponsesUsage
} from './responses-client';

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

export interface RuntimeMessage {
  role: 'user' | 'assistant';
  content: string;
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
  usage?: ResponsesUsage;
}

export interface AgentRuntimeRunOptions {
  client: ResponsesApiClient;
  model: string;
  system: string;
  prompt: string;
  messages?: RuntimeMessage[];
  tools: Record<string, RuntimeToolDefinition>;
  signal: AbortSignal;
  maxSteps?: number;
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _schema, ...parameters } = jsonSchema;
  return parameters;
}

function runtimeTools(
  definitions: Record<string, RuntimeToolDefinition>
): ResponsesFunctionTool[] {
  return Object.entries(definitions).map(([name, definition]) => ({
    type: 'function',
    name,
    description: definition.description,
    parameters: jsonSchemaFor(definition.inputSchema),
    strict: false
  }));
}

function mergeUsage(
  current: ResponsesUsage | undefined,
  next: ResponsesUsage | undefined
): ResponsesUsage | undefined {
  if (!current && !next) return undefined;
  const sum = (left: number | undefined, right: number | undefined) => {
    if (left === undefined && right === undefined) return undefined;
    return (left || 0) + (right || 0);
  };
  return {
    inputTokens: sum(current?.inputTokens, next?.inputTokens),
    outputTokens: sum(current?.outputTokens, next?.outputTokens),
    totalTokens: sum(current?.totalTokens, next?.totalTokens)
  };
}

function toolOutputString(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output) || 'null';
  } catch {
    return JSON.stringify({
      error: 'The tool returned an unserializable value'
    });
  }
}

function cancellationError(): Error {
  const error = new Error('The AI run was cancelled');
  error.name = 'AbortError';
  return error;
}

function inputFromMessages(
  messages: RuntimeMessage[] | undefined
): ResponsesInputItem[] {
  return (messages || []).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

type CachedToolResult = {
  arguments: string;
  output: unknown;
  error?: unknown;
};

/**
 * Provider-independent tool loop. The runtime owns orchestration only; the
 * Responses client owns HTTP and wire-format details.
 */
export class AgentRuntime {
  async run(options: AgentRuntimeRunOptions): Promise<{ text: string }> {
    const input: ResponsesInputItem[] = [
      ...inputFromMessages(options.messages),
      { role: 'user', content: options.prompt }
    ];
    const tools = runtimeTools(options.tools);
    const cachedToolResults = new Map<string, CachedToolResult>();
    const maxSteps = options.maxSteps ?? 8;
    let text = '';
    let usage: ResponsesUsage | undefined;

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        if (options.signal.aborted) throw cancellationError();

        const response = await options.client.stream({
          model: options.model,
          instructions: options.system,
          input,
          tools,
          signal: options.signal,
          onTextDelta: async (delta) => {
            text += delta;
            await options.onEvent?.({ type: 'text-delta', text: delta });
          }
        });
        usage = mergeUsage(usage, response.usage);
        input.push(...response.output);

        if (response.functionCalls.length === 0) {
          await options.onEvent?.({ type: 'finish', usage });
          return { text };
        }

        for (const call of response.functionCalls) {
          if (options.signal.aborted) throw cancellationError();
          const cached = cachedToolResults.get(call.callId);
          if (cached) {
            if (cached.arguments !== call.arguments) {
              throw new Error(
                `The tool call ID ${call.callId} was reused with different arguments`
              );
            }
            input.push({
              type: 'function_call_output',
              call_id: call.callId,
              output: toolOutputString(cached.output)
            });
            continue;
          }

          const definition = options.tools[call.name];
          await options.onEvent?.({
            type: 'tool-start',
            toolCallId: call.callId,
            toolName: call.name,
            input: call.arguments
          });

          let result: CachedToolResult;
          if (!definition) {
            result = {
              arguments: call.arguments,
              output: { error: `Unknown tool: ${call.name}` },
              error: new Error(`Unknown tool: ${call.name}`)
            };
          } else {
            try {
              const parsedArguments: unknown = JSON.parse(call.arguments);
              const parsed = definition.inputSchema.safeParse(parsedArguments);
              if (!parsed.success) {
                throw new Error(
                  `Invalid arguments for ${call.name}: ${parsed.error.message}`
                );
              }
              const output = await definition.execute(parsed.data, {
                toolCallId: call.callId,
                signal: options.signal
              });
              result = { arguments: call.arguments, output };
            } catch (error) {
              result = {
                arguments: call.arguments,
                output: { error: errorMessage(error) },
                error
              };
            }
          }

          cachedToolResults.set(call.callId, result);
          if (result.error) {
            await options.onEvent?.({
              type: 'tool-error',
              toolCallId: call.callId,
              toolName: call.name,
              input: call.arguments,
              error: result.error
            });
          } else {
            await options.onEvent?.({
              type: 'tool-result',
              toolCallId: call.callId,
              toolName: call.name,
              input: call.arguments,
              output: result.output
            });
          }
          input.push({
            type: 'function_call_output',
            call_id: call.callId,
            output: toolOutputString(result.output)
          });
        }
      }

      throw new Error(`The AI run exceeded its ${maxSteps}-step limit`);
    } catch (error) {
      await options.onEvent?.({ type: 'error', error });
      throw error;
    }
  }
}
