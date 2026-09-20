import { modals } from '@mantine/modals';
import { RangeRequestForm } from './ai-pdf-range-form';
import type { PdfPageRange } from './ai-pdf-upload';

export function openAiPdfRangeDialog(
  fileName: string,
  totalPages: number,
  budget: number
): Promise<PdfPageRange | null> {
  return new Promise((resolve) => {
    let settled = false;
    let modalId: string | null = null;
    const finish = (range: PdfPageRange | null) => {
      if (settled) return;
      settled = true;
      resolve(range);
      if (modalId) modals.close(modalId);
    };
    modalId = modals.open({
      title: `Convert pages from "${fileName}"`,
      centered: true,
      onClose: () => finish(null),
      children: <RangeRequestForm totalPages={totalPages} budget={budget} onConfirm={finish} />
    });
  });
}
