import { Box, Group, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconLoader2,
  IconSparkles
} from '@tabler/icons-react';
import { MarkdownContent } from '@/components/common/markdown-content';
import type { ChatMessage, RunPhase } from './ai-page-editing-types';
import { formatRunMeta, toolStepLabel } from './ai-page-editing-run-status';
import classes from './ai-page-editing-panel.module.css';

type MessageBlock =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'steps'; messages: ChatMessage[] };

function toBlocks(messages: ChatMessage[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (const message of messages) {
    if (message.role === 'tool' && message.toolStep) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'steps') {
        last.messages.push(message);
        continue;
      }
      blocks.push({ kind: 'steps', messages: [message] });
      continue;
    }
    blocks.push({ kind: 'message', message });
  }
  return blocks;
}

function ToolStepRow({ message }: { message: ChatMessage }) {
  const step = message.toolStep;
  if (!step) return null;
  const label = toolStepLabel(step.toolName, step.status);
  return (
    <div
      className={classes.toolStep}
      data-status={step.status}
      aria-label={label}
      title={step.summary}
    >
      {step.status === 'running' ? (
        <Box component="span" className={classes.spinIcon}>
          <IconLoader2 size={12} />
        </Box>
      ) : step.status === 'done' ? (
        <IconCheck size={12} className={classes.toolStepCheck} />
      ) : (
        <IconAlertTriangle size={12} className={classes.toolStepError} />
      )}
      <Text size="xs" span component="span" className={classes.toolStepLabel}>
        {label}
      </Text>
      {step.status === 'error' && message.content && (
        <Text size="xs" span className={classes.toolStepErrorText}>
          {message.content}
        </Text>
      )}
    </div>
  );
}

function UserRow({ message }: { message: ChatMessage }) {
  return (
    <div className={classes.userRow} role="article" aria-label="You said:">
      <div className={classes.userBubble}>
        {message.images?.length ? (
          <Group gap={4} mb={message.content ? 4 : 0}>
            {message.images.map((image) => (
              <img
                key={image.attachmentId}
                src={image.url}
                alt={image.fileName}
                title={image.fileName}
                className={classes.bubbleImage}
              />
            ))}
          </Group>
        ) : null}
        {message.content && (
          <Text size="sm" className={classes.userText}>
            {message.content}
          </Text>
        )}
      </div>
    </div>
  );
}

function AssistantRow({
  message,
  streaming
}: {
  message: ChatMessage;
  streaming: boolean;
}) {
  const meta = formatRunMeta(message.meta);
  return (
    <div
      className={classes.assistantRow}
      role="article"
      aria-label="Page AI said:"
    >
      <Box
        component="span"
        className={[
          classes.assistantAvatar,
          streaming ? classes.spinIcon : ''
        ].join(' ')}
      >
        <IconSparkles size={13} />
      </Box>
      <div className={classes.assistantBody}>
        <MarkdownContent
          content={message.content}
          className={classes.markdownMessage}
        />
        {streaming && <span className={classes.streamCaret} aria-hidden />}
        {meta && (
          <Text size="xs" c="dimmed" className={classes.messageMeta}>
            {meta}
          </Text>
        )}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  running,
  phase
}: {
  messages: ChatMessage[];
  running: boolean;
  phase: RunPhase;
}) {
  const blocks = toBlocks(messages);
  return (
    <>
      {blocks.map((block, index) => {
        const isLast = index === blocks.length - 1;
        if (block.kind === 'steps') {
          return (
            <div
              key={`steps:${block.messages[0].id}`}
              className={classes.toolRail}
            >
              {block.messages.map((message) => (
                <ToolStepRow key={message.id} message={message} />
              ))}
            </div>
          );
        }
        const { message } = block;
        if (message.role === 'user') {
          return <UserRow key={message.id} message={message} />;
        }
        if (message.role === 'assistant') {
          return (
            <AssistantRow
              key={message.id}
              message={message}
              streaming={running && isLast && phase === 'generating'}
            />
          );
        }
        return (
          <div key={message.id} className={classes.systemRow}>
            <IconInfoCircle size={12} />
            <Text size="xs" span>
              {message.content}
            </Text>
          </div>
        );
      })}
    </>
  );
}
