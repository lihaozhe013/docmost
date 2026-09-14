import { useEffect, useState } from 'react';
import { Box, Group, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import type { RunPhase } from './ai-page-editing-types';
import { formatTokenCount, phaseVerb } from './ai-page-editing-run-status';
import classes from './ai-page-editing-panel.module.css';

function useAnimatedEllipsis(): string {
  const [dots, setDots] = useState(3);
  useEffect(() => {
    const id = setInterval(() => setDots((current) => (current % 3) + 1), 420);
    return () => clearInterval(id);
  }, []);
  return dots === 3 ? '…' : '.'.repeat(dots);
}

function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, []);
  return seconds;
}

export function RunStatus({
  phase,
  tokenEstimate
}: {
  phase: RunPhase;
  tokenEstimate: number;
}) {
  const dots = useAnimatedEllipsis();
  const seconds = useElapsedSeconds();
  const verb = `${phaseVerb(phase).replace(/…+$/, '')}${dots}`;
  return (
    <Group
      gap="xs"
      wrap="nowrap"
      className={classes.runStatus}
      role="status"
      aria-live="polite"
    >
      <Box component="span" className={classes.spinIcon} aria-hidden>
        <IconSparkles size={14} />
      </Box>
      <Text size="sm" className={classes.runStatusVerb}>
        {verb}
      </Text>
      <Box flex={1} />
      {tokenEstimate > 0 && (
        <Text size="xs" c="dimmed">
          ~{formatTokenCount(tokenEstimate)} tokens
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {seconds}s
      </Text>
    </Group>
  );
}
