import { Anchor, Group, Stack, Text } from '@mantine/core';
import { MarkdownContent } from '@/components/common/markdown-content';
import type { AiCitation } from './ai-page-editing-types';
import classes from './ai-page-editing-panel.module.css';

type CitationSource = {
  number: number;
  url: string;
  title: string;
  hostname: string;
};

type CitationMarker = {
  endIndex: number;
  number: number;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character] || character;
  });
}

function safeUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function normalizeOffset(content: string, offset: number): number {
  const bounded = Math.max(0, Math.min(offset, content.length));
  if (bounded > 0 && bounded < content.length) {
    const previous = content.charCodeAt(bounded - 1);
    const current = content.charCodeAt(bounded);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      return bounded + 1;
    }
  }
  return bounded;
}

function decorateContent(
  content: string,
  citations: AiCitation[]
): { content: string; sources: CitationSource[] } {
  const sources: CitationSource[] = [];
  const sourceNumbers = new Map<string, number>();
  const markers: CitationMarker[] = [];

  citations
    .map((citation, index) => ({ citation, index }))
    .filter(({ citation }) => {
      if (!citation || typeof citation !== 'object') return false;
      if (
        !Number.isInteger(citation.startIndex) ||
        !Number.isInteger(citation.endIndex) ||
        citation.startIndex < 0 ||
        citation.endIndex < citation.startIndex ||
        citation.endIndex > content.length ||
        typeof citation.url !== 'string' ||
        typeof citation.title !== 'string'
      ) {
        return false;
      }
      return Boolean(safeUrl(citation.url));
    })
    .sort(
      (left, right) =>
        left.citation.startIndex - right.citation.startIndex ||
        left.citation.endIndex - right.citation.endIndex ||
        left.index - right.index
    )
    .forEach(({ citation }) => {
      const parsedUrl = safeUrl(citation.url);
      if (!parsedUrl) return;
      let number = sourceNumbers.get(citation.url);
      if (!number) {
        number = sources.length + 1;
        sourceNumbers.set(citation.url, number);
        sources.push({
          number,
          url: citation.url,
          title: citation.title || citation.url,
          hostname: parsedUrl.hostname
        });
      }
      const endIndex = normalizeOffset(content, citation.endIndex);
      if (!markers.some((marker) => marker.endIndex === endIndex && marker.number === number)) {
        markers.push({ endIndex, number });
      }
    });

  const decorated = [...markers]
    .sort((left, right) => right.endIndex - left.endIndex || right.number - left.number)
    .reduce((value, marker) => {
      const href = escapeHtml(sources[marker.number - 1]?.url || '');
      const title = escapeHtml(sources[marker.number - 1]?.title || '');
      if (!href) return value;
      const markerHtml = `<sup class="${classes.citationMarker}"><a href="${href}" title="${title}" target="_blank" rel="noopener noreferrer">[${marker.number}]</a></sup>`;
      return `${value.slice(0, marker.endIndex)}${markerHtml}${value.slice(marker.endIndex)}`;
    }, content);

  return { content: decorated, sources };
}

export function CitedMarkdownContent({
  content,
  citations,
  className
}: {
  content: string;
  citations?: AiCitation[];
  className?: string;
}) {
  const decorated = decorateContent(content, citations ?? []);
  return (
    <>
      <MarkdownContent content={decorated.content} className={className} preserveLinkTargets />
      {decorated.sources.length > 0 && (
        <Stack gap={2} className={classes.citationSources}>
          <Text size="xs" fw={600} c="dimmed">
            Sources
          </Text>
          {decorated.sources.map((source) => (
            <Group key={source.number} gap={4} wrap="nowrap" className={classes.citationSource}>
              <Text size="xs" c="dimmed" className={classes.citationSourceNumber}>
                [{source.number}]
              </Text>
              <Anchor
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                size="xs"
                title={source.title}
                className={classes.citationLink}
              >
                {source.title}{' '}
                <Text span c="dimmed">
                  ({source.hostname})
                </Text>
              </Anchor>
            </Group>
          ))}
        </Stack>
      )}
    </>
  );
}
