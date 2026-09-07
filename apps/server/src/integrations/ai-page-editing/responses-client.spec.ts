import {
  createOpenAiResponsesClient,
  OpenAiResponsesHttpClient,
  redactResponsesEndpoint,
  resolveResponsesEndpoint
} from './responses-client';

function sseEvent(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function responseWithChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

describe('OpenAiResponsesHttpClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each([
    ['https://api.openai.com', 'https://api.openai.com/v1/responses'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/responses'],
    [
      'https://api.openai.com/chat/completions',
      'https://api.openai.com/v1/responses'
    ],
    [
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/responses'
    ],
    ['https://api.deepseek.com', 'https://api.deepseek.com/responses'],
    [
      'https://api.deepseek.com/responses/',
      'https://api.deepseek.com/responses'
    ],
    ['https://gateway.example/v1', 'https://gateway.example/v1/responses'],
    [
      'https://gateway.example/v1/chat/completions',
      'https://gateway.example/v1/responses'
    ],
    [
      'https://gateway.example/proxy/openai',
      'https://gateway.example/proxy/openai/responses'
    ]
  ])('resolves %s to %s', (rawUrl, expected) => {
    expect(resolveResponsesEndpoint(rawUrl)).toBe(expected);
  });

  it('preserves query parameters and removes URL fragments', () => {
    expect(
      resolveResponsesEndpoint(
        'https://gateway.example/v1?api-version=2026-01-01#responses'
      )
    ).toBe('https://gateway.example/v1/responses?api-version=2026-01-01');
  });

  it('redacts credentials and query data from endpoint logs', () => {
    expect(
      redactResponsesEndpoint(
        'https://user:secret@gateway.example/v1/responses?token=secret'
      )
    ).toBe('https://gateway.example/v1/responses');
  });

  it('rejects non-HTTP endpoint URLs', () => {
    expect(() => resolveResponsesEndpoint('ftp://gateway.example')).toThrow(
      'AI_API_URL must be a valid HTTP(S) URL'
    );
  });

  it('parses streamed text and function calls while preserving output items', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs-1',
      encrypted_content: 'encrypted-reasoning'
    };
    const functionCall = {
      type: 'function_call',
      id: 'fc-1',
      call_id: 'call-1',
      name: 'edit_buffer',
      arguments: '{"blockId":"b0"}'
    };
    const events = [
      sseEvent({
        type: 'response.output_item.added',
        output_index: 0,
        item: reasoning
      }),
      sseEvent({
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...functionCall, arguments: '' }
      }),
      sseEvent({
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        delta: '{"blockId"'
      }),
      sseEvent({
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        delta: ':"b0"}'
      }),
      sseEvent({ type: 'response.output_text.delta', delta: 'Applied' }),
      sseEvent({
        type: 'response.completed',
        response: {
          id: 'resp-1',
          output: [reasoning, functionCall],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
        }
      })
    ];
    const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(
      responseWithChunks([
        events[0]!.slice(0, 17),
        events[0]!.slice(17) + events[1]!,
        events[2]! + events[3]! + events[4]!,
        events[5]!
      ])
    );
    globalThis.fetch = fetchMock;
    const textDeltas: string[] = [];
    const client = new OpenAiResponsesHttpClient(
      'https://example.test/v1',
      'secret-key'
    );

    const result = await client.stream({
      model: 'test-model',
      instructions: 'Use the tools',
      input: [{ role: 'user', content: 'Edit this page' }],
      tools: [
        {
          type: 'function',
          name: 'edit_buffer',
          description: 'Edit the page',
          parameters: { type: 'object' },
          strict: false
        }
      ],
      signal: new AbortController().signal,
      onTextDelta: (delta) => {
        textDeltas.push(delta);
      }
    });

    expect(result.text).toBe('Applied');
    expect(textDeltas).toEqual(['Applied']);
    expect(result.responseId).toBe('resp-1');
    expect(result.functionCalls).toEqual([
      { callId: 'call-1', name: 'edit_buffer', arguments: '{"blockId":"b0"}' }
    ]);
    expect(result.output).toEqual([reasoning, functionCall]);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(request?.body));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.test/v1/responses'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request?.headers).toMatchObject({
      authorization: 'Bearer secret-key',
      'content-type': 'application/json',
      accept: 'text/event-stream'
    });
    expect(body).toMatchObject({
      model: 'test-model',
      instructions: 'Use the tools',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content']
    });
  });

  it('rejects HTTP failures and incomplete streams', async () => {
    const failedFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    failedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'provider unavailable' } }),
        {
          status: 503,
          headers: { 'content-type': 'application/json' }
        }
      )
    );
    globalThis.fetch = failedFetch;
    const client = new OpenAiResponsesHttpClient('https://example.test', 'key');
    const options = {
      model: 'test-model',
      instructions: '',
      input: [],
      tools: [],
      signal: new AbortController().signal
    };

    await expect(client.stream(options)).rejects.toThrow(
      'HTTP 503: provider unavailable'
    );

    const incompleteFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    incompleteFetch.mockResolvedValue(
      responseWithChunks([
        sseEvent({ type: 'response.output_text.delta', delta: 'partial' })
      ])
    );
    globalThis.fetch = incompleteFetch;
    await expect(client.stream(options)).rejects.toThrow(
      'before response.completed'
    );
  });

  it('requires all connection settings when creating the configured client', () => {
    expect(() => createOpenAiResponsesClient('', 'key')).toThrow(
      'AI page editing is not configured'
    );
    expect(() =>
      createOpenAiResponsesClient('https://example.test', '')
    ).toThrow('AI page editing is not configured');
  });
});
