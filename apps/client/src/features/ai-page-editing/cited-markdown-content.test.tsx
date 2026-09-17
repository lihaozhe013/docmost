import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MantineProvider } from '@mantine/core';
import { CitedMarkdownContent } from './cited-markdown-content';

describe('CitedMarkdownContent', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });
  });

  it('renders safe inline markers and a deduplicated source list', () => {
    const { container } = render(
      <MantineProvider>
        <CitedMarkdownContent
          content="Alpha beta"
          citations={[
            {
              startIndex: 0,
              endIndex: 5,
              url: 'https://example.com/source',
              title: 'Example source'
            },
            {
              startIndex: 6,
              endIndex: 10,
              url: 'https://example.com/source',
              title: 'Example source'
            },
            {
              startIndex: 0,
              endIndex: 5,
              url: 'javascript:alert(1)',
              title: 'Unsafe source'
            },
            {
              startIndex: 100,
              endIndex: 101,
              url: 'https://example.com/invalid',
              title: 'Invalid source'
            },
            null as never
          ]}
        />
      </MantineProvider>
    );

    expect(screen.getByText('Sources')).toBeTruthy();
    expect(screen.getByText(/Example source/)).toBeTruthy();
    expect(screen.queryByText('Unsafe source')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelectorAll('a[target="_blank"]').length).toBe(3);
    expect(container.querySelectorAll('a[rel="noopener noreferrer"]').length).toBe(3);
  });
});
