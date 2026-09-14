import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  formatElapsed,
  formatRunMeta,
  formatTokenCount,
  phaseVerb,
  toolPhase,
  toolStepLabel
} from './ai-page-editing-run-status';

describe('toolPhase', () => {
  it('maps known document tools to phases', () => {
    expect(toolPhase('read_buffer')).toBe('reading');
    expect(toolPhase('edit_buffer')).toBe('editing');
    expect(toolPhase('insert_blocks')).toBe('inserting');
  });

  it('falls back to thinking for unknown tools', () => {
    expect(toolPhase('custom_tool')).toBe('thinking');
    expect(toolPhase(undefined)).toBe('thinking');
  });
});

describe('phaseVerb', () => {
  it('returns run-status verbs per phase', () => {
    expect(phaseVerb('thinking')).toBe('Thinking…');
    expect(phaseVerb('reading')).toBe('Reading the page…');
    expect(phaseVerb('editing')).toBe('Editing the page…');
    expect(phaseVerb('inserting')).toBe('Inserting content…');
    expect(phaseVerb('applying')).toBe('Applying changes…');
    expect(phaseVerb('generating')).toBe('Generating…');
    expect(phaseVerb('idle')).toBe('');
  });
});

describe('toolStepLabel', () => {
  it('labels known tools per status', () => {
    expect(toolStepLabel('read_buffer', 'running')).toBe(
      'Reading the page…'
    );
    expect(toolStepLabel('read_buffer', 'done')).toBe('Read the page');
    expect(toolStepLabel('edit_buffer', 'done')).toBe('Applied edits');
    expect(toolStepLabel('insert_blocks', 'error')).toBe('Insert failed');
  });

  it('labels unknown tools with their raw name', () => {
    expect(toolStepLabel('my_tool', 'running')).toBe('Running my_tool…');
    expect(toolStepLabel('my_tool', 'done')).toBe('my_tool completed');
    expect(toolStepLabel('my_tool', 'error')).toBe('my_tool failed');
  });
});

describe('estimateTokens', () => {
  it('estimates latin text at about four characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('hello world there')).toBe(5);
  });

  it('counts CJK characters close to one token each', () => {
    expect(estimateTokens('你好，世界')).toBe(5);
    expect(estimateTokens('改写这段话')).toBe(5);
  });

  it('mixes CJK and latin ranges', () => {
    expect(estimateTokens('你好 hello')).toBe(4);
  });
});

describe('formatTokenCount', () => {
  it('keeps small counts exact', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(128)).toBe('128');
  });

  it('compresses thousands with a k suffix', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(12300)).toBe('12k');
  });
});

describe('formatElapsed', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(4200)).toBe('4.2s');
    expect(formatElapsed(45000)).toBe('45s');
  });

  it('formats longer durations with minutes', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(83_000)).toBe('1m 23s');
  });
});

describe('formatRunMeta', () => {
  it('returns null without meaningful data', () => {
    expect(formatRunMeta(undefined)).toBeNull();
    expect(formatRunMeta({})).toBeNull();
  });

  it('prefers totalTokens and falls back to the sum', () => {
    expect(
      formatRunMeta({
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 1500 }
      })
    ).toBe('1.5k tokens');
    expect(
      formatRunMeta({ usage: { inputTokens: 1200, outputTokens: 300 } })
    ).toBe('1.5k tokens');
  });

  it('joins usage and elapsed time with a separator', () => {
    expect(
      formatRunMeta({
        usage: { totalTokens: 250 },
        elapsedMs: 3000
      })
    ).toBe('250 tokens · 3.0s');
  });
});
