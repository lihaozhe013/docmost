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
  normalizeInput?: (input: unknown) => unknown;
  execute: (
    input: z.infer<TSchema>,
    context: RuntimeToolContext
  ) => Promise<unknown>;
}

export interface RuntimeToolError {
  code: string;
  message: string;
  details?: unknown;
}

export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
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
  images?: string[];
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

function userPromptItem(text: string, images?: string[]): ResponsesInputItem {
  if (!images?.length) return { role: 'user', content: text };
  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: 'input_text', text });
  for (const imageUrl of images) {
    content.push({ type: 'input_image', image_url: imageUrl });
  }
  return { role: 'user', content };
}

type CachedToolResult = {
  arguments: string;
  output: unknown;
  error?: RuntimeToolError;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runtimeToolError(value: unknown): RuntimeToolError | undefined {
  if (!isRecord(value) || typeof value.message !== 'string') return undefined;
  return {
    code: typeof value.code === 'string' ? value.code : 'TOOL_FAILED',
    message: value.message,
    ...(value.details !== undefined ? { details: value.details } : {})
  };
}

function toolFailureFromOutput(output: unknown): RuntimeToolError | undefined {
  if (!isRecord(output) || output.ok !== false) return undefined;
  return (
    runtimeToolError(output.error) || {
      code: 'TOOL_FAILED',
      message: 'The document tool failed without an error description'
    }
  );
}

function validationIssues(error: z.ZodError): Array<{
  path: string;
  code: string;
  message: string;
}> {
  return error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.join('.') : '$',
    code: issue.code,
    message: issue.message
  }));
}

function toolErrorFromUnknown(error: unknown): RuntimeToolError {
  if (error instanceof AgentRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {})
    };
  }
  if (isRecord(error)) {
    const structured = runtimeToolError(error);
    if (structured) return structured;
  }
  return { code: 'TOOL_EXECUTION_FAILED', message: errorMessage(error) };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

function toolFingerprint(
  toolName: string,
  argumentsValue: string,
  normalizeInput?: (input: unknown) => unknown
): string {
  try {
    const parsed = JSON.parse(argumentsValue);
    const normalized = normalizeInput ? normalizeInput(parsed) : parsed;
    return `${toolName}:${JSON.stringify(canonicalValue(normalized))}`;
  } catch {
    return `${toolName}:${argumentsValue}`;
  }
}

function isFatalToolError(error: RuntimeToolError): boolean {
  return new Set([
    'ACCESS_DENIED',
    'SESSION_UNAVAILABLE',
    'CANCELLED',
    'RESULT_UNKNOWN',
    'TOOL_LIMIT'
  ]).has(error.code);
}

/**
 * Provider-independent tool loop. The runtime owns orchestration only; the
 * Responses client owns HTTP and wire-format details.
 */
export class AgentRuntime {
  async run(options: AgentRuntimeRunOptions): Promise<{ text: string }> {
    const input: ResponsesInputItem[] = [
      ...inputFromMessages(options.messages),
      userPromptItem(options.prompt, options.images)
    ];
    const tools = runtimeTools(options.tools);
    const cachedToolResults = new Map<string, CachedToolResult>();
    const failedToolAttempts = new Map<string, number>();
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
              throw new AgentRuntimeError(
                'TOOL_CALL_REUSE',
                `The tool call ID ${call.callId} was reused with different arguments`
              );
            }
            input.push({
              type: 'function_call_output',
              call_id: call.callId,
              output: toolOutputString(cached.output)
            });
            if (cached.error) {
              const fingerprint = toolFingerprint(
                call.name,
                call.arguments,
                options.tools[call.name]?.normalizeInput
              );
              const attempts = (failedToolAttempts.get(fingerprint) || 0) + 1;
              failedToolAttempts.set(fingerprint, attempts);
              throw new AgentRuntimeError(
                isFatalToolError(cached.error)
                  ? cached.error.code
                  : 'TOOL_RETRY_LIMIT',
                isFatalToolError(cached.error)
                  ? cached.error.message
                  : `The ${call.name} tool failed twice with the same arguments; stopping to preserve partial changes`,
                isFatalToolError(cached.error)
                  ? cached.error.details
                  : { toolName: call.name, attempts }
              );
            }
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
            const unknownToolError: RuntimeToolError = {
              code: 'UNKNOWN_TOOL',
              message: `Unknown tool: ${call.name}`
            };
            result = {
              arguments: call.arguments,
              output: { ok: false, error: unknownToolError },
              error: unknownToolError
            };
          } else {
            try {
              let parsedArguments: unknown;
              try {
                parsedArguments = JSON.parse(call.arguments);
              } catch {
                throw new AgentRuntimeError(
                  'INVALID_CONTENT',
                  `Invalid JSON arguments for ${call.name}`,
                  {
                    issues: [
                      { path: '$', message: 'Arguments must be valid JSON' }
                    ]
                  }
                );
              }
              const normalizedArguments = definition.normalizeInput
                ? definition.normalizeInput(parsedArguments)
                : parsedArguments;
              const parsed =
                definition.inputSchema.safeParse(normalizedArguments);
              if (!parsed.success) {
                throw new AgentRuntimeError(
                  'INVALID_CONTENT',
                  `Invalid arguments for ${call.name}`,
                  { issues: validationIssues(parsed.error) }
                );
              }
              const output = await definition.execute(parsed.data, {
                toolCallId: call.callId,
                signal: options.signal
              });
              const toolError = toolFailureFromOutput(output);
              result = {
                arguments: call.arguments,
                output,
                ...(toolError ? { error: toolError } : {})
              };
            } catch (error) {
              const structuredError = toolErrorFromUnknown(error);
              result = {
                arguments: call.arguments,
                output: { ok: false, error: structuredError },
                error: structuredError
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

          if (result.error) {
            const fingerprint = toolFingerprint(
              call.name,
              call.arguments,
              definition?.normalizeInput
            );
            const attempts = (failedToolAttempts.get(fingerprint) || 0) + 1;
            failedToolAttempts.set(fingerprint, attempts);
            if (isFatalToolError(result.error)) {
              throw new AgentRuntimeError(
                result.error.code,
                result.error.message,
                result.error.details
              );
            }
            if (attempts >= 2) {
              throw new AgentRuntimeError(
                'TOOL_RETRY_LIMIT',
                `The ${call.name} tool failed twice with the same arguments; stopping to preserve partial changes`,
                {
                  toolName: call.name,
                  attempts
                }
              );
            }
          }
        }
      }

      throw new AgentRuntimeError(
        'STEP_LIMIT',
        `The AI run exceeded its ${maxSteps}-step limit`
      );
    } catch (error) {
      await options.onEvent?.({ type: 'error', error });
      throw error;
    }
  }
}
