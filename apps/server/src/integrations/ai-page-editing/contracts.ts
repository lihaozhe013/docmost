import { z } from 'zod';

export const AI_PAGE_EDITING_OPERATION = 'aiPageEditing';

// Keep in sync with apps/client/src/features/ai-page-editing/ai-image-upload.ts
export const MAX_AI_IMAGES = 4;

export const aiPageEditingOperation = z.enum([
  'start',
  'stop',
  'toolResult',
  'event'
]);

export type AiPageEditingOperation = z.infer<typeof aiPageEditingOperation>;

export const aiPageEditingMessageSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('aiPageEditing.start'),
      pageId: z.string().min(1).max(128),
      prompt: z.string().trim().max(20_000),
      attachmentIds: z.array(z.string().uuid()).max(MAX_AI_IMAGES).optional(),
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(20_000)
          })
        )
        .max(20)
        .optional(),
      selection: z
        .object({
          text: z.string().max(20_000),
          from: z.number().int().nonnegative(),
          to: z.number().int().nonnegative()
        })
        .refine((selection) => selection.from <= selection.to, {
          message: 'Selection range is invalid'
        })
        .optional()
    })
    .superRefine((message, context) => {
      // A run must carry at least one prompt element; images alone are valid.
      if (!message.prompt && !message.attachmentIds?.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prompt'],
          message: 'A prompt or at least one image is required'
        });
      }
    }),
  z.object({
    operation: z.literal('aiPageEditing.stop'),
    runId: z.string().min(1).max(128)
  }),
  z
    .object({
      operation: z.literal('aiPageEditing.toolResult'),
      runId: z.string().min(1).max(128),
      toolCallId: z.string().min(1).max(128),
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z
        .object({
          code: z.string().min(1).max(80),
          message: z.string().min(1).max(2_000),
          details: z.unknown().optional()
        })
        .optional()
    })
    .superRefine((value, context) => {
      if (value.ok && value.result === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['result'],
          message: 'A successful tool result must include result'
        });
      }
      if (!value.ok && !value.error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['error'],
          message: 'A failed tool result must include error'
        });
      }
    })
]);

export type AiPageEditingMessage = z.infer<typeof aiPageEditingMessageSchema>;

export type AiPageEditingEventName =
  | 'run.started'
  | 'text.delta'
  | 'tool.started'
  | 'tool.completed'
  | 'run.completed'
  | 'run.failed'
  | 'run.stopped';

export interface AiPageEditingEvent {
  operation: 'aiPageEditing.event';
  sessionId?: string;
  sequence?: number;
  pageId?: string;
  runId: string;
  event: AiPageEditingEventName;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: {
    code?: string;
    message: string;
    details?: unknown;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface AiPageEditingToolRequest {
  operation: 'aiPageEditing.toolRequest';
  sessionId?: string;
  sequence?: number;
  pageId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type AiPageEditingOutboundMessage =
  AiPageEditingEvent | AiPageEditingToolRequest;

export interface AiPageEditingSelection {
  text: string;
  from: number;
  to: number;
}
