import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowUp,
  IconPhoto,
  IconPlayerStop,
  IconPlus,
  IconRotate2,
  IconSparkles,
  IconX
} from '@tabler/icons-react';
import { useAtom } from 'jotai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { socketAtom } from '@/features/websocket/atoms/socket-atom.ts';
import { pageEditorAtom } from '@/features/editor/atoms/editor-atoms.ts';
import { uploadFile } from '@/features/page/services/page-service.ts';
import { IAttachment } from '@/features/attachments/types/attachment.types.ts';
import {
  AI_IMAGE_ACCEPT,
  MAX_AI_IMAGES,
  compressImageForAi,
  isSupportedAiImage,
  validateAiImageBatch
} from './ai-image-upload';
import { getError, messageId } from './ai-page-editing-utils';
import type { PendingImage } from './ai-page-editing-types';
import { useAiPageEditingRun } from './use-ai-page-editing-run';
import { MarkdownContent } from '@/components/common/markdown-content';
import classes from './ai-page-editing-panel.module.css';

export function AiPageEditingPanel({
  pageId,
  enabled
}: {
  pageId: string;
  enabled: boolean;
}) {
  const [socket] = useAtom(socketAtom);
  const [editor] = useAtom(pageEditorAtom);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingImagesRef = useRef(pendingImages);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const showPanel = useCallback(() => setOpen(true), []);

  const {
    messages,
    running,
    latestChangeId,
    latestAffectedBlockId,
    startRun,
    stopRun,
    resetSession,
    undoLastChange,
    revealLatestChange,
    reportLocalError
  } = useAiPageEditingRun({
    socket,
    editor,
    pageId,
    enabled,
    onShowPanel: showPanel
  });

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  if (!enabled || !editor || editor.isDestroyed) return null;

  const clearPendingImages = () => {
    setPendingImages((current) => {
      for (const image of current) {
        URL.revokeObjectURL(image.previewUrl);
      }
      return [];
    });
  };

  const removePendingImage = (localId: string) => {
    setPendingImages((current) => {
      const target = current.find((image) => image.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((image) => image.localId !== localId);
    });
  };

  const handleAddImages = (files: File[]) => {
    const supported = files.filter(isSupportedAiImage);
    if (supported.length !== files.length) {
      reportLocalError(
        `Unsupported files were ignored. Allowed image types: ${AI_IMAGE_ACCEPT}`
      );
    }
    const rejection = validateAiImageBatch(
      pendingImagesRef.current.length,
      supported
    );
    if (rejection) {
      reportLocalError(rejection);
      return;
    }
    for (const file of supported) {
      const localId = messageId();
      const previewUrl = URL.createObjectURL(file);
      setPendingImages((current) => [
        ...current,
        { localId, file, previewUrl, status: 'uploading' }
      ]);
      void (async () => {
        try {
          const compressed = await compressImageForAi(file);
          const attachment = await uploadFile(compressed, pageId);
          const url = (attachment as IAttachment & { url?: string }).url;
          if (!attachment.id || !url) {
            throw new Error('The upload response was missing the attachment');
          }
          setPendingImages((current) =>
            current.map((image) =>
              image.localId === localId && image.status === 'uploading'
                ? {
                    ...image,
                    file: compressed,
                    attachmentId: attachment.id,
                    url,
                    status: 'ready'
                  }
                : image
            )
          );
        } catch (error) {
          const parsed = getError(error);
          setPendingImages((current) =>
            current.map((image) =>
              image.localId === localId && image.status === 'uploading'
                ? { ...image, status: 'error', error: parsed.message }
                : image
            )
          );
        }
      })();
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    );
    if (!files.length) return;
    event.preventDefault();
    handleAddImages(files);
  };

  const handleSend = () => {
    const value = prompt.trim();
    const readyImages = pendingImages
      .filter(
        (image) => image.status === 'ready' && image.attachmentId && image.url
      )
      .map((image) => ({
        attachmentId: image.attachmentId as string,
        url: image.url as string,
        fileName: image.file.name
      }));
    const blockedImages = pendingImages.some(
      (image) => image.status === 'uploading' || image.status === 'error'
    );
    if (running || blockedImages) return;
    if (!value && readyImages.length === 0) return;
    if (!startRun(value, readyImages)) return;
    setPrompt('');
    setOpen(true);
    clearPendingImages();
  };

  const handleNewSession = () => {
    resetSession();
    setPrompt('');
    clearPendingImages();
  };

  const readyImageCount = pendingImages.filter(
    (image) => image.status === 'ready'
  ).length;
  const blockedByPendingImages = pendingImages.some(
    (image) => image.status === 'uploading' || image.status === 'error'
  );
  const canSend =
    !blockedByPendingImages && (Boolean(prompt.trim()) || readyImageCount > 0);

  return (
    <div className={classes.root}>
      {open && (
        <Paper className={classes.panel} withBorder shadow="md" p="md">
          <Group justify="space-between" mb="xs">
            <Group gap="xs">
              <IconSparkles size={18} />
              <Text fw={600}>Page AI</Text>
              {running && <Badge size="xs">Working</Badge>}
            </Group>
            <Group gap={4}>
              <Tooltip label="New session">
                <ActionIcon
                  variant="subtle"
                  onClick={handleNewSession}
                  aria-label="New session"
                >
                  <IconPlus size={16} />
                </ActionIcon>
              </Tooltip>
              <ActionIcon
                variant="subtle"
                onClick={() => setOpen(false)}
                aria-label="Close Page AI"
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
          </Group>
          <Divider mb="sm" />
          <ScrollArea className={classes.messages} offsetScrollbars>
            <Stack gap="sm">
              {messages.length === 0 && (
                <Text size="sm" c="dimmed">
                  Ask me to rewrite or extend this page. Changes are applied to
                  the open editor.
                </Text>
              )}
              {messages.map((message) => (
                <div key={message.id}>
                  <Text size="xs" c="dimmed" mb={2}>
                    {message.role === 'user'
                      ? 'You'
                      : message.role === 'assistant'
                        ? 'Page AI'
                        : 'Tool'}
                  </Text>
                  {message.role === 'user' && message.images?.length ? (
                    <Group gap={4} mb={2}>
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
                  {message.role === 'assistant' ? (
                    <MarkdownContent
                      content={message.content}
                      className={classes.markdownMessage}
                    />
                  ) : (
                    <Text
                      size="sm"
                      className={
                        message.role === 'tool' ? classes.tool : classes.message
                      }
                    >
                      {message.content}
                    </Text>
                  )}
                </div>
              ))}
            </Stack>
          </ScrollArea>
          {pendingImages.length > 0 && (
            <Group gap="xs" mt="sm" wrap="nowrap">
              {pendingImages.map((image) => (
                <div
                  key={image.localId}
                  className={classes.imageChip}
                  data-status={image.status}
                >
                  <img
                    src={image.previewUrl}
                    alt={image.file.name}
                    title={image.error ?? image.file.name}
                    className={classes.imageThumb}
                  />
                  {image.status === 'uploading' && (
                    <Box className={classes.imageChipOverlay}>
                      <Loader size={14} />
                    </Box>
                  )}
                  {image.status === 'error' && (
                    <Tooltip label={image.error || 'Upload failed'}>
                      <Box className={classes.imageChipOverlay}>
                        <IconAlertTriangle
                          size={14}
                          color="var(--mantine-color-red-filled)"
                        />
                      </Box>
                    </Tooltip>
                  )}
                  <ActionIcon
                    size="xs"
                    className={classes.imageChipRemove}
                    variant="filled"
                    color="dark"
                    onClick={() => removePendingImage(image.localId)}
                    disabled={running}
                    aria-label={`Remove ${image.file.name}`}
                  >
                    <IconX size={10} />
                  </ActionIcon>
                </div>
              ))}
            </Group>
          )}
          <Group gap="xs" mt="sm" align="flex-end">
            <Tooltip label={`Attach up to ${MAX_AI_IMAGES} images`}>
              <ActionIcon
                variant="subtle"
                onClick={() => fileInputRef.current?.click()}
                disabled={running || pendingImages.length >= MAX_AI_IMAGES}
                aria-label="Attach images to Page AI"
              >
                <IconPhoto size={16} />
              </ActionIcon>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              accept={AI_IMAGE_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                if (files.length) handleAddImages(files);
              }}
            />
            <Textarea
              flex={1}
              className={classes.promptInput}
              value={prompt}
              disabled={running}
              autosize
              minRows={1}
              maxRows={5}
              resize="none"
              placeholder="Ask Page AI…"
              onChange={(event) => setPrompt(event.currentTarget.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
            />
            {running ? (
              <Tooltip label="Stop run">
                <ActionIcon
                  color="red"
                  variant="filled"
                  onClick={stopRun}
                  aria-label="Stop Page AI"
                >
                  <IconPlayerStop size={16} />
                </ActionIcon>
              </Tooltip>
            ) : (
              <ActionIcon
                color="blue"
                variant="filled"
                disabled={!canSend}
                onClick={handleSend}
                aria-label="Send to Page AI"
              >
                <IconArrowUp size={16} />
              </ActionIcon>
            )}
          </Group>
          {latestChangeId && !running && (
            <Group mt="sm" gap="xs">
              {latestAffectedBlockId && (
                <Button size="xs" variant="subtle" onClick={revealLatestChange}>
                  Go to change
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconRotate2 size={14} />}
                onClick={undoLastChange}
              >
                Undo last AI change
              </Button>
            </Group>
          )}
        </Paper>
      )}
      <Tooltip label="Open Page AI">
        <ActionIcon
          size="lg"
          radius="xl"
          color="blue"
          variant="filled"
          onClick={() => setOpen((value) => !value)}
          aria-label="Open Page AI"
        >
          <IconSparkles size={18} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
