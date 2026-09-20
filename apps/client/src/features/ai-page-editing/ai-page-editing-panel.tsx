import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip,
  Box
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowUp,
  IconFileTypePdf,
  IconPhoto,
  IconPlayerStop,
  IconPlus,
  IconRotate2,
  IconSparkles,
  IconWorldSearch,
  IconX
} from '@tabler/icons-react';
import { useAtom } from 'jotai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { socketAtom } from '@/features/websocket/atoms/socket-atom.ts';
import { pageEditorAtom } from '@/features/editor/atoms/editor-atoms.ts';
import { uploadFile } from '@/features/page/services/page-service.ts';
import { IAttachment } from '@/features/attachments/types/attachment.types.ts';
import {
  MAX_AI_IMAGES,
  compressImageForAi,
  isSupportedAiImage,
  validateAiImageBatch
} from './ai-image-upload';
import {
  AI_ATTACHMENT_ACCEPT,
  MAX_AI_PDF_PAGES,
  getPdfPageCount,
  isSupportedAiPdf,
  renderPdfPagesToImages,
  type PdfPageRange
} from './ai-pdf-upload';
import { openAiPdfRangeDialog } from './ai-pdf-range-dialog';
import { getError, messageId } from './ai-page-editing-utils';
import type { PendingImage } from './ai-page-editing-types';
import { useAiPageEditingRun } from './use-ai-page-editing-run';
import { MessageList } from './message-list';
import { RunStatus } from './run-status';
import classes from './ai-page-editing-panel.module.css';

export function AiPageEditingPanel({ pageId, enabled }: { pageId: string; enabled: boolean }) {
  const [socket] = useAtom(socketAtom);
  const [editor] = useAtom(pageEditorAtom);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingImagesRef = useRef(pendingImages);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const showPanel = useCallback(() => setOpen(true), []);

  const {
    messages,
    running,
    phase,
    tokenEstimate,
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
        if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
      }
      return [];
    });
  };

  const removePendingImage = (localId: string) => {
    setPendingImages((current) => {
      const target = current.find((image) => image.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((image) => image.localId !== localId);
    });
  };

  const countPendingSlots = (images: PendingImage[]) =>
    images.reduce(
      (total, image) => total + (image.status === 'converting' ? (image.progress?.total ?? 1) : 1),
      0
    );

  const usedAttachmentSlots = () => countPendingSlots(pendingImagesRef.current);

  const addImageFile = (file: File, compress: boolean) => {
    const localId = messageId();
    const previewUrl = URL.createObjectURL(file);
    setPendingImages((current) => [
      ...current,
      { localId, file, previewUrl, name: file.name, status: 'uploading' }
    ]);
    void (async () => {
      try {
        const prepared = compress ? await compressImageForAi(file) : file;
        if (prepared !== file) {
          URL.revokeObjectURL(previewUrl);
          const nextPreviewUrl = URL.createObjectURL(prepared);
          setPendingImages((current) =>
            current.map((image) =>
              image.localId === localId
                ? { ...image, file: prepared, name: prepared.name, previewUrl: nextPreviewUrl }
                : image
            )
          );
        }
        const attachment = await uploadFile(prepared, pageId);
        const url = (attachment as IAttachment & { url?: string }).url;
        if (!attachment.id || !url) {
          throw new Error('The upload response was missing the attachment');
        }
        setPendingImages((current) =>
          current.map((image) =>
            image.localId === localId && image.status === 'uploading'
              ? {
                  ...image,
                  file: prepared,
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
  };

  const convertPdfToImages = async (file: File) => {
    const remaining = MAX_AI_IMAGES - usedAttachmentSlots();
    if (remaining <= 0) {
      reportLocalError(`"${file.name}" was skipped because there are no attachment slots left.`);
      return;
    }
    let pageCount: number;
    try {
      pageCount = await getPdfPageCount(file);
    } catch (error) {
      const parsed = getError(error);
      reportLocalError(`"${file.name}": ${parsed.message}`);
      return;
    }
    const cap = Math.min(remaining, MAX_AI_PDF_PAGES);
    let range: PdfPageRange = { from: 1, to: Math.min(pageCount, cap) };
    if (pageCount > cap) {
      const chosen = await openAiPdfRangeDialog(file.name, pageCount, cap);
      if (!chosen) return;
      range = chosen;
    }
    const pages = range.to - range.from + 1;
    const localId = messageId();
    setPendingImages((current) => [
      ...current,
      {
        localId,
        file,
        name: file.name,
        status: 'converting',
        progress: { done: 0, total: pages }
      }
    ]);
    try {
      const rendered = await renderPdfPagesToImages(file, {
        range,
        budget: cap,
        onPageProgress: (done, total) =>
          setPendingImages((current) =>
            current.map((image) =>
              image.localId === localId && image.status === 'converting'
                ? { ...image, progress: { done, total } }
                : image
            )
          ),
        isCancelled: () => !pendingImagesRef.current.some((image) => image.localId === localId)
      });
      setPendingImages((current) => {
        const target = current.find((image) => image.localId === localId);
        if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
        return current.filter((image) => image.localId !== localId);
      });
      for (const imageFile of rendered) addImageFile(imageFile, false);
    } catch (error) {
      const parsed = getError(error);
      setPendingImages((current) =>
        current.map((image) =>
          image.localId === localId && image.status === 'converting'
            ? { ...image, status: 'error', error: parsed.message }
            : image
        )
      );
    }
  };

  const handleAddFiles = (files: File[]) => {
    const images = files.filter(isSupportedAiImage);
    const pdfs = files.filter((file) => isSupportedAiPdf(file) && !isSupportedAiImage(file));
    if (images.length + pdfs.length !== files.length) {
      reportLocalError(`Unsupported files were ignored. Allowed types: ${AI_ATTACHMENT_ACCEPT}`);
    }
    if (!images.length && !pdfs.length) return;
    const rejection = validateAiImageBatch(usedAttachmentSlots(), images);
    if (rejection) {
      reportLocalError(rejection);
      return;
    }
    for (const file of images) addImageFile(file, true);
    void (async () => {
      for (const file of pdfs) await convertPdfToImages(file);
    })();
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    const supported = files.filter(
      (file) => file.type.startsWith('image/') || isSupportedAiPdf(file)
    );
    if (!supported.length) return;
    event.preventDefault();
    handleAddFiles(supported);
  };

  const handleSend = () => {
    const value = prompt.trim();
    const readyImages = pendingImages
      .filter((image) => image.status === 'ready' && image.attachmentId && image.url)
      .map((image) => ({
        attachmentId: image.attachmentId as string,
        url: image.url as string,
        fileName: image.name
      }));
    const blockedImages = pendingImages.some(
      (image) =>
        image.status === 'uploading' || image.status === 'converting' || image.status === 'error'
    );
    if (running || blockedImages) return;
    if (!value && readyImages.length === 0) return;
    if (!startRun(value, readyImages, webSearch)) return;
    setPrompt('');
    setOpen(true);
    clearPendingImages();
  };

  const handleNewSession = () => {
    resetSession();
    setPrompt('');
    setWebSearch(false);
    clearPendingImages();
  };

  const readyImageCount = pendingImages.filter((image) => image.status === 'ready').length;
  const blockedByPendingImages = pendingImages.some(
    (image) =>
      image.status === 'uploading' || image.status === 'converting' || image.status === 'error'
  );
  const canSend = !blockedByPendingImages && (Boolean(prompt.trim()) || readyImageCount > 0);

  return (
    <div className={classes.root}>
      {open && (
        <Paper className={classes.panel} withBorder shadow="md" p="md">
          <Group justify="space-between" mb="xs">
            <Group gap="xs">
              <IconSparkles size={18} />
              <Text fw={600}>Page AI</Text>
            </Group>
            <Group gap={4}>
              <Tooltip label="New session">
                <ActionIcon variant="subtle" onClick={handleNewSession} aria-label="New session">
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
                  Ask me to rewrite or extend this page. Changes are applied to the open editor.
                </Text>
              )}
              <MessageList messages={messages} running={running} phase={phase} />
            </Stack>
          </ScrollArea>
          {running && (
            <Box mt="xs" flex="none">
              <RunStatus phase={phase} tokenEstimate={tokenEstimate} />
            </Box>
          )}
          {pendingImages.length > 0 && (
            <Group gap="xs" mt="sm" wrap="nowrap">
              {pendingImages.map((image) => (
                <div key={image.localId} className={classes.imageChip} data-status={image.status}>
                  {image.previewUrl ? (
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      title={image.error ?? image.name}
                      className={classes.imageThumb}
                    />
                  ) : (
                    <Box className={classes.pdfChip} title={image.error ?? image.name}>
                      {image.status === 'error' ? (
                        <IconAlertTriangle size={18} color="var(--mantine-color-red-6)" />
                      ) : (
                        <>
                          <IconFileTypePdf size={18} />
                          <Text fz={10} lh={1} fw={600}>
                            {image.progress
                              ? `${image.progress.done}/${image.progress.total}`
                              : 'PDF'}
                          </Text>
                        </>
                      )}
                    </Box>
                  )}
                  {(image.status === 'uploading' || image.status === 'converting') && (
                    <Box className={classes.imageChipOverlay}>
                      <Loader size={14} />
                    </Box>
                  )}
                  {image.status === 'error' && image.previewUrl && (
                    <Tooltip label={image.error || 'Upload failed'}>
                      <Box className={classes.imageChipOverlay}>
                        <IconAlertTriangle size={14} color="var(--mantine-color-red-6)" />
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
                    aria-label={`Remove ${image.name}`}
                  >
                    <IconX size={10} />
                  </ActionIcon>
                </div>
              ))}
            </Group>
          )}
          <Group gap="xs" mt="sm" align="flex-end">
            <Tooltip label={`Attach images or PDF pages, up to ${MAX_AI_IMAGES} per message`}>
              <ActionIcon
                variant="subtle"
                onClick={() => fileInputRef.current?.click()}
                disabled={running || countPendingSlots(pendingImages) >= MAX_AI_IMAGES}
                aria-label="Attach images or PDFs to Page AI"
              >
                <IconPhoto size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={webSearch ? 'Disable web search' : 'Enable web search'}>
              <ActionIcon
                variant={webSearch ? 'light' : 'subtle'}
                color={webSearch ? 'blue' : undefined}
                onClick={() => setWebSearch((current) => !current)}
                disabled={running}
                aria-label={webSearch ? 'Disable web search' : 'Enable web search'}
                aria-pressed={webSearch}
              >
                <IconWorldSearch size={16} />
              </ActionIcon>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              accept={AI_ATTACHMENT_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                if (files.length) handleAddFiles(files);
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
