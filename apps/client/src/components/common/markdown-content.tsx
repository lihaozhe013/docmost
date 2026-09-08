import { markdownToHtml } from '@docmost/editor-ext';
import DOMPurify from 'dompurify';
import { useMemo } from 'react';
import classes from './markdown-content.module.css';

export interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  const sanitizedHtml = useMemo(() => {
    const html = markdownToHtml(content) as string;
    return DOMPurify.sanitize(html);
  }, [content]);

  return (
    <div
      className={[classes.content, className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
}
