import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './markdown-content';

describe('MarkdownContent', () => {
  it('renders common Markdown elements', () => {
    const { container } = render(
      <MarkdownContent
        content={[
          '# Heading',
          '',
          '**Bold** and *italic*',
          '',
          '- one',
          '- two',
          '',
          '```ts',
          'const answer = 42;',
          '```'
        ].join('\n')}
      />
    );

    expect(container.querySelector('h1')?.textContent).toBe('Heading');
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const answer = 42;'
    );
  });

  it('renders GFM tables and task lists', () => {
    const { container } = render(
      <MarkdownContent
        content={`| Name | Value |
| --- | ---: |
| answer | 42 |

- [x] done`}
      />
    );

    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelector('td')?.textContent).toBe('answer');
    expect(container.querySelector('li[data-type="taskItem"]')).toBeTruthy();
  });

  it('sanitizes unsafe HTML and links', () => {
    const { container } = render(
      <MarkdownContent
        content={`<script>window.__xss = true</script>

<img src="x" onerror="window.__xss = true">

[unsafe](javascript:alert(1))`}
      />
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(
      container.querySelector('a')?.getAttribute('href') ?? null
    ).toBeNull();
    expect(container.textContent).toContain('unsafe');
  });

  it('updates when streaming content changes', () => {
    const { container, rerender } = render(<MarkdownContent content="Draft" />);

    rerender(<MarkdownContent content="## Finished" />);

    expect(container.querySelector('h2')?.textContent).toBe('Finished');
    expect(container.textContent).not.toContain('Draft');
  });

  it('handles empty content', () => {
    const { container } = render(<MarkdownContent content="" />);

    expect(container.firstElementChild?.innerHTML).toBe('');
  });
});
