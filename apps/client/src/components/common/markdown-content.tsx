import { markdownToHtml } from '@docmost/editor-ext';
import DOMPurify from 'dompurify';
import { useMemo } from 'react';
import classes from './markdown-content.module.css';

export interface MarkdownContentProps {
  content: string;
  className?: string;
  preserveLinkTargets?: boolean;
}

export function MarkdownContent({ content, className, preserveLinkTargets }: MarkdownContentProps) {
  const sanitizedHtml = useMemo(() => {
    const html = markdownToHtml(content) as string;
    return DOMPurify.sanitize(html, preserveLinkTargets ? { ADD_ATTR: ['target'] } : undefined);
  }, [content, preserveLinkTargets]);

  return (
    <div
      className={[classes.content, className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
}
