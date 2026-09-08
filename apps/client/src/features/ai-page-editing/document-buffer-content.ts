import { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import katex from 'katex';
import { BufferError } from './document-buffer-types';

export function replaceInlineSegmentText(
  node: ProseMirrorNode,
  childIndex: number,
  oldText: string,
  newText: string
): string {
  return node.content.content
    .map((child, index) => {
      if (index === childIndex && child.type.name === 'text') {
        const text = child.text ?? '';
        const start = text.indexOf(oldText);
        return (
          text.slice(0, start) + newText + text.slice(start + oldText.length)
        );
      }
      if (child.type.name === 'mathInline') {
        return `$${String(child.attrs?.text ?? '')}$`;
      }
      return child.text ?? '';
    })
    .join('');
}

export function replaceInlineSegmentWithMath(
  node: ProseMirrorNode,
  childIndex: number,
  oldText: string,
  newText: string
): string {
  return node.content.content
    .map((child, index) => {
      if (index === childIndex && child.type.name === 'text') {
        const text = child.text ?? '';
        const start = text.indexOf(oldText);
        return (
          text.slice(0, start) +
          `$${newText}$` +
          text.slice(start + oldText.length)
        );
      }
      if (child.type.name === 'mathInline') {
        return `$${String(child.attrs?.text ?? '')}$`;
      }
      return child.text ?? '';
    })
    .join('');
}

export function validateLatex(
  source: string,
  displayMode: boolean,
  blockId: string
): void {
  try {
    katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: 'warn'
    });
  } catch (error) {
    throw new BufferError(
      'INVALID_CONTENT',
      `The ${displayMode ? 'block' : 'inline'} formula in block ${blockId} is invalid`,
      {
        issues: [
          {
            path: 'newText',
            code: 'invalid_latex',
            message: error instanceof Error ? error.message : String(error)
          }
        ]
      }
    );
  }
}

export function validateFormulaContent(content: Fragment): void {
  content.forEach((node) => {
    validateFormulaNode(node);
    node.descendants((child) => {
      validateFormulaNode(child);
    });
  });
}

function validateFormulaNode(node: ProseMirrorNode): void {
  if (node.type.name === 'mathBlock' || node.type.name === 'mathInline') {
    validateLatex(
      String(node.attrs?.text ?? ''),
      node.type.name === 'mathBlock',
      'inserted content'
    );
  }
}

export async function validateMermaidContent(content: Fragment): Promise<void> {
  const diagrams: string[] = [];
  content.forEach((node) => {
    collectMermaidSource(node, diagrams);
  });
  for (const source of diagrams) {
    await validateMermaidSource(source, 'inserted content');
  }
}

export async function validateMermaidSource(
  source: string,
  blockId: string
): Promise<void> {
  if (!source.trim()) {
    throw new BufferError(
      'INVALID_CONTENT',
      'Mermaid diagrams cannot be empty',
      {
        issues: [
          {
            path: blockId,
            code: 'empty_mermaid',
            message: 'The Mermaid source is empty'
          }
        ]
      }
    );
  }
  try {
    const { default: mermaid } = await import('mermaid');
    const parsed = await mermaid.parse(source, { suppressErrors: true });
    if (!parsed) throw new Error('Mermaid syntax is invalid');
  } catch (error) {
    throw new BufferError('INVALID_CONTENT', 'The Mermaid diagram is invalid', {
      issues: [
        {
          path: blockId,
          code: 'invalid_mermaid',
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    });
  }
}

function collectMermaidSource(node: ProseMirrorNode, diagrams: string[]): void {
  if (node.type.name === 'codeBlock' && node.attrs?.language === 'mermaid') {
    diagrams.push(node.textContent);
  }
  node.descendants((child) => {
    if (
      child.type.name === 'codeBlock' &&
      child.attrs?.language === 'mermaid'
    ) {
      diagrams.push(child.textContent);
    }
  });
}

export function trimTrailingEmptyParagraphs(content: Fragment): Fragment {
  const nodes = content.content.slice();
  while (
    nodes.length > 1 &&
    nodes[nodes.length - 1].type.name === 'paragraph' &&
    nodes[nodes.length - 1].content.size === 0
  ) {
    nodes.pop();
  }
  return Fragment.fromArray(nodes);
}
