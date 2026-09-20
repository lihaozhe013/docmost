import { Button, Group, NumberInput, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { resolvePdfPageRange, type PdfPageRange } from './ai-pdf-upload';

interface RangeRequestProps {
  totalPages: number;
  budget: number;
  onConfirm: (range: PdfPageRange | null) => void;
}

export function RangeRequestForm({ totalPages, budget, onConfirm }: RangeRequestProps) {
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(Math.min(totalPages, budget));
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    const resolved = resolvePdfPageRange(totalPages, { from, to }, budget);
    if (!resolved.ok) {
      setError(resolved.error ?? 'Invalid page range.');
      return;
    }
    onConfirm({ from: resolved.value.from, to: resolved.value.to });
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        This PDF has {totalPages} pages. A message fits at most {budget} page image
        {budget === 1 ? '' : 's'}. Send a consecutive range instead.
      </Text>
      <Group gap="sm">
        <NumberInput
          label="From page"
          value={from}
          onChange={(value) => setFrom(Number(value))}
          min={1}
          max={totalPages}
          allowDecimal={false}
          style={{ width: 120 }}
        />
        <NumberInput
          label="To page"
          value={to}
          onChange={(value) => setTo(Number(value))}
          min={1}
          max={totalPages}
          allowDecimal={false}
          style={{ width: 120 }}
        />
      </Group>
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
      <Group justify="flex-end">
        <Button variant="subtle" onClick={() => onConfirm(null)}>
          Cancel
        </Button>
        <Button onClick={confirm}>Convert pages</Button>
      </Group>
    </Stack>
  );
}
