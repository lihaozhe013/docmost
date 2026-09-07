import { ServiceUnavailableException } from '@nestjs/common';

export type ResponsesJsonSchema = Record<string, unknown>;

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: ResponsesJsonSchema;
  strict: false;
}

export type ResponsesInputItem = Record<string, unknown>;

export interface ResponsesUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ResponsesFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ResponsesStreamResult {
  text: string;
  output: ResponsesInputItem[];
  functionCalls: ResponsesFunctionCall[];
  usage?: ResponsesUsage;
  responseId?: string;
}

export interface ResponsesStreamOptions {
  model: string;
  instructions: string;
  input: ResponsesInputItem[];
  tools: ResponsesFunctionTool[];
  signal: AbortSignal;
  onTextDelta?: (text: string) => void | Promise<void>;
}

export interface ResponsesApiClient {
  stream(options: ResponsesStreamOptions): Promise<ResponsesStreamResult>;
}

type SseEvent = {
  type?: unknown;
  [key: string]: unknown;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeUsage(value: unknown): ResponsesUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const normalized = {
    inputTokens: finiteNumber(usage.input_tokens ?? usage.inputTokens),
    outputTokens: finiteNumber(usage.output_tokens ?? usage.outputTokens),
    totalTokens: finiteNumber(usage.total_tokens ?? usage.totalTokens)
  };
  return Object.values(normalized).some((item) => item !== undefined)
    ? normalized
    : undefined;
}

function appendSseData(buffer: string): {
  blocks: string[];
  remainder: string;
} {
  const normalized = buffer.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const blocks = normalized.split('\n\n');
  return {
    blocks: blocks.slice(0, -1),
    remainder: blocks[blocks.length - 1] || ''
  };
}

function parseSseBlock(block: string): SseEvent | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();

  if (!data || data === '[DONE]') return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('The Responses API returned a non-object event');
    }
    return parsed as SseEvent;
  } catch (error) {
    throw new Error(
      `Invalid Responses API stream event: ${errorMessage(error)}`
    );
  }
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), {
        stream: !chunk.done
      });

      const parsed = appendSseData(buffer);
      buffer = parsed.remainder;
      for (const block of parsed.blocks) {
        const event = parseSseBlock(block);
        if (event) yield event;
      }

      if (chunk.done) break;
    }

    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function outputItemIndex(event: SseEvent): number {
  return typeof event.output_index === 'number' ? event.output_index : -1;
}

function outputItemFromEvent(event: SseEvent): ResponsesInputItem | undefined {
  if (!event.item || typeof event.item !== 'object') return undefined;
  return event.item as ResponsesInputItem;
}

function functionCallFromItem(
  item: ResponsesInputItem
): ResponsesFunctionCall | undefined {
  if (item.type !== 'function_call') return undefined;
  const callId = typeof item.call_id === 'string' ? item.call_id : undefined;
  const name = typeof item.name === 'string' ? item.name : undefined;
  const args = typeof item.arguments === 'string' ? item.arguments : undefined;
  if (!callId || !name || args === undefined) return undefined;
  return { callId, name, arguments: args };
}

function responseError(event: SseEvent): Error {
  const response = event.response;
  if (response && typeof response === 'object') {
    const value = response as Record<string, unknown>;
    const error = value.error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return new Error(message);
    }
    if (typeof value.status === 'string') {
      return new Error(
        `The Responses API response ended with status ${value.status}`
      );
    }
  }
  if (event.error && typeof event.error === 'object') {
    const message = (event.error as Record<string, unknown>).message;
    if (typeof message === 'string') return new Error(message);
  }
  return new Error('The Responses API response failed');
}

function httpErrorDetail(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = parsed as Record<string, unknown>;
    const error = value.error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message.slice(0, 1_000);
    }
    if (typeof value.message === 'string') return value.message.slice(0, 1_000);
  } catch {
    return undefined;
  }
  return undefined;
}

function responseOutput(event: SseEvent): ResponsesInputItem[] {
  if (!event.response || typeof event.response !== 'object') return [];
  const output = (event.response as Record<string, unknown>).output;
  return Array.isArray(output)
    ? output.filter(
        (item): item is ResponsesInputItem =>
          Boolean(item) && typeof item === 'object'
      )
    : [];
}

function responseId(event: SseEvent): string | undefined {
  if (!event.response || typeof event.response !== 'object') return undefined;
  const id = (event.response as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

export class OpenAiResponsesHttpClient implements ResponsesApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string
  ) {}

  async stream(
    options: ResponsesStreamOptions
  ): Promise<ResponsesStreamResult> {
    let httpResponse: Response;
    try {
      httpResponse = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: options.model,
          instructions: options.instructions,
          input: options.input,
          tools: options.tools,
          stream: true,
          store: false,
          include: ['reasoning.encrypted_content']
        }),
        signal: options.signal
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw new Error(`The AI provider request failed: ${errorMessage(error)}`);
    }

    if (!httpResponse.ok) {
      const body = await httpResponse.text().catch(() => '');
      const detail = httpErrorDetail(body);
      throw new Error(
        `The AI provider returned HTTP ${httpResponse.status}${detail ? `: ${detail}` : ''}`
      );
    }
    if (!httpResponse.body) {
      throw new Error('The AI provider returned an empty stream');
    }

    const outputItems = new Map<number, ResponsesInputItem>();
    let completedEvent: SseEvent | undefined;
    let text = '';

    for await (const event of parseSseStream(httpResponse.body)) {
      const eventType = typeof event.type === 'string' ? event.type : '';
      if (eventType === 'response.output_text.delta') {
        if (typeof event.delta === 'string') {
          text += event.delta;
          await options.onTextDelta?.(event.delta);
        }
        continue;
      }

      if (eventType === 'response.output_item.added') {
        const item = outputItemFromEvent(event);
        if (item) outputItems.set(outputItemIndex(event), item);
        continue;
      }

      if (eventType === 'response.function_call_arguments.delta') {
        const index = outputItemIndex(event);
        const item = outputItems.get(index);
        if (
          item &&
          item.type === 'function_call' &&
          typeof event.delta === 'string'
        ) {
          item.arguments = `${typeof item.arguments === 'string' ? item.arguments : ''}${event.delta}`;
        }
        continue;
      }

      if (eventType === 'response.function_call_arguments.done') {
        const index = outputItemIndex(event);
        const item = outputItems.get(index);
        if (
          item &&
          item.type === 'function_call' &&
          typeof event.arguments === 'string'
        ) {
          item.arguments = event.arguments;
        }
        continue;
      }

      if (eventType === 'response.output_item.done') {
        const item = outputItemFromEvent(event);
        if (item) outputItems.set(outputItemIndex(event), item);
        continue;
      }

      if (eventType === 'response.completed') {
        completedEvent = event;
        continue;
      }

      if (
        eventType === 'response.failed' ||
        eventType === 'response.incomplete' ||
        eventType === 'error'
      ) {
        throw responseError(event);
      }
    }

    if (!completedEvent) {
      throw new Error('The AI provider stream ended before response.completed');
    }

    const completedOutput = responseOutput(completedEvent);
    const output = completedOutput.length
      ? completedOutput
      : [...outputItems.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, item]) => item);
    const functionCalls = output
      .map(functionCallFromItem)
      .filter((call): call is ResponsesFunctionCall => Boolean(call));
    const responsePayload = completedEvent.response;
    const usage =
      responsePayload && typeof responsePayload === 'object'
        ? normalizeUsage((responsePayload as Record<string, unknown>).usage)
        : undefined;

    return {
      text,
      output,
      functionCalls,
      usage,
      responseId: responseId(completedEvent)
    };
  }
}

export function createOpenAiResponsesClient(
  apiUrl: string | undefined,
  apiKey: string | undefined
): OpenAiResponsesHttpClient {
  if (!apiUrl || !apiKey) {
    throw new ServiceUnavailableException(
      'AI page editing is not configured. Set AI_API_URL, AI_API_KEY, and AI_MODEL.'
    );
  }
  return new OpenAiResponsesHttpClient(apiUrl, apiKey);
}
