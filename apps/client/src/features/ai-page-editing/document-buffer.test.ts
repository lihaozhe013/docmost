import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MathBlock, MathInline } from '@docmost/editor-ext';
import CodeBlock from '@tiptap/extension-code-block';
import { describe, expect, it } from 'vitest';
import { BufferError, DocumentBuffer } from './document-buffer';

const TestNodeView = (() => null) as any;

function createEditor(content: any): Editor {
  return new Editor({
    extensions: [StarterKit],
    content
  });
}

function createRichEditor(content: any): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      MathInline.configure({ view: TestNodeView }),
      MathBlock.configure({ view: TestNodeView }),
      CodeBlock.configure({ languageClassPrefix: 'language-' })
    ],
    content
  });
}

describe('DocumentBuffer', () => {
  it('reads and edits code, block formulas, and inline formula segments', async () => {
    const editor = createRichEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Euler: ' },
            { type: 'mathInline', attrs: { text: 'e^{i\\pi}+1=0' } },
            { type: 'text', text: ' is famous.' }
          ]
        },
        { type: 'mathBlock', attrs: { text: '\\frac{1}{2}' } },
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const value = 1;\n' }]
        }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const initial = buffer.read();
    const paragraph = initial.blocks[0];
    expect(paragraph).toMatchObject({
      type: 'paragraph',
      text: 'Euler: $e^{i\\pi}+1=0$ is famous.',
      capabilities: expect.arrayContaining([
        'replace_inline_math',
        'replace_text_with_math'
      ])
    });
    expect(paragraph.segments).toEqual([
      { index: 0, type: 'text', text: 'Euler: ' },
      { index: 1, type: 'mathInline', text: 'e^{i\\pi}+1=0' },
      { index: 2, type: 'text', text: ' is famous.' }
    ]);
    expect(initial.blocks[1]).toMatchObject({
      type: 'mathBlock',
      text: '\\frac{1}{2}',
      capabilities: expect.arrayContaining(['replace_math'])
    });
    expect(initial.blocks[2]).toMatchObject({
      type: 'codeBlock',
      language: 'typescript',
      text: 'const value = 1;\n',
      capabilities: expect.arrayContaining(['replace_code'])
    });

    const inline = await buffer.executeTool('edit_buffer', {
      expectedRevision: initial.revision,
      operations: [
        {
          type: 'replace_inline_math',
          blockId: paragraph.blockId,
          segmentIndex: 1,
          oldText: 'e^{i\\pi}+1=0',
          newText: 'a^2+b^2=c^2'
        }
      ]
    });
    const afterInline = buffer.read();
    expect(inline.status).toBe('applied');
    expect(afterInline.blocks[0].text).toContain('$a^2+b^2=c^2$');

    const converted = await buffer.executeTool('edit_buffer', {
      expectedRevision: afterInline.revision,
      operations: [
        {
          type: 'replace_text_with_math',
          blockId: paragraph.blockId,
          segmentIndex: 2,
          oldText: 'famous',
          newText: '\\text{true}'
        }
      ]
    });
    expect(converted.status).toBe('applied');
    expect(buffer.read().blocks[0].text).toContain(' is $\\text{true}$.');

    const formula = buffer.read();
    await buffer.executeTool('edit_buffer', {
      expectedRevision: formula.revision,
      operations: [
        {
          type: 'replace_math',
          blockId: formula.blocks[1].blockId,
          oldText: '\\frac{1}{2}',
          newText: '\\frac{2}{3}'
        },
        {
          type: 'replace_code',
          blockId: formula.blocks[2].blockId,
          oldText: 'const value = 1;\n',
          newText: 'const value = 2;\n',
          language: 'javascript'
        }
      ]
    });
    const final = buffer.read();
    expect(final.blocks[1].text).toBe('\\frac{2}{3}');
    expect(final.blocks[2]).toMatchObject({
      text: 'const value = 2;\n',
      language: 'javascript'
    });
    buffer.undo(buffer.getLatestChangeId());
    const undone = buffer.read();
    expect(undone.blocks[1].text).toBe('\\frac{1}{2}');
    expect(undone.blocks[2]).toMatchObject({
      text: 'const value = 1;\n',
      language: 'typescript'
    });

    editor.destroy();
    buffer.destroy();
  });

  it('inserts mixed formulas, code, and Mermaid while preserving source', async () => {
    const editor = createRichEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const revision = buffer.read().revision;
    const insertion = await buffer.insert({
      expectedRevision: revision,
      target: { kind: 'document_end' },
      markdown:
        'Inline $\\alpha + \\beta$\n\n$$\n\\begin{matrix}a&b\\\\c&d\\end{matrix}\n$$\n\n```typescript\nconst html = "<tag>";\n```\n\n```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```'
    });

    expect(insertion.status).toBe('applied');
    const blocks = buffer.read().blocks;
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'mathBlock',
      'codeBlock',
      'codeBlock',
      'paragraph'
    ]);
    expect(blocks[1].text).toBe('Inline $\\alpha + \\beta$');
    expect(blocks[2].text).toBe('\\begin{matrix}a&b\\\\c&d\\end{matrix}');
    expect(blocks[3]).toMatchObject({
      language: 'typescript',
      text: 'const html = "<tag>";\n'
    });
    expect(blocks[4]).toMatchObject({
      language: 'mermaid',
      text: 'flowchart TD\n  A[Start] --> B[End]\n'
    });

    await expect(
      buffer.insert({
        expectedRevision: buffer.read().revision,
        target: { kind: 'document_end' },
        markdown: '```mermaid\nthis is not a diagram\n```'
      })
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
    expect(buffer.read().blocks).toHaveLength(6);
    await expect(
      buffer.insert({
        expectedRevision: buffer.read().revision,
        target: { kind: 'document_end' },
        markdown: '$$\\unknowncommand$$'
      })
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
    expect(buffer.read().blocks).toHaveLength(6);

    editor.destroy();
    buffer.destroy();
  });

  it('validates Mermaid source before replacing an existing diagram', async () => {
    const editor = createRichEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'mermaid' },
          content: [{ type: 'text', text: 'flowchart TD\n  A --> B' }]
        }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const initial = buffer.read();
    const block = initial.blocks[0];

    await expect(
      buffer.executeTool('edit_buffer', {
        expectedRevision: initial.revision,
        operations: [
          {
            type: 'replace_code',
            blockId: block.blockId,
            oldText: block.text,
            newText: 'this is not Mermaid'
          }
        ]
      })
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
    expect(buffer.read().blocks[0].text).toBe(block.text);

    const valid = await buffer.executeTool('edit_buffer', {
      expectedRevision: buffer.read().revision,
      operations: [
        {
          type: 'replace_code',
          blockId: block.blockId,
          oldText: block.text,
          newText: 'flowchart TD\n  A --> C'
        }
      ]
    });
    expect(valid.status).toBe('applied');
    expect(buffer.read().blocks[0].text).toBe('flowchart TD\n  A --> C');

    editor.destroy();
    buffer.destroy();
  });

  it('reads blocks and applies an exact replacement with a revision', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second block' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const initial = buffer.read();

    expect(initial.blocks.map((block) => block.blockId)).toEqual(['b0', 'b1']);
    expect(initial.blocks[0].editable).toBe(true);

    const change = await buffer.edit(initial.revision, [
      {
        type: 'replace_text',
        blockId: 'b0',
        oldText: 'Hello',
        newText: 'Hi'
      }
    ]);

    expect(editor.state.doc.textContent).toBe('Hi worldSecond block');
    expect(change.changes[0]).toMatchObject({
      blockId: 'b0',
      before: 'Hello world',
      after: 'Hi world'
    });
    expect(buffer.read().revision).toBe(change.revision);

    editor.destroy();
    buffer.destroy();
  });

  it('rejects stale and ambiguous edits without mutating the document', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'repeat repeat' }]
        }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const revision = buffer.read().revision;

    await expect(
      buffer.edit('old-revision', [
        {
          type: 'replace_text',
          blockId: 'b0',
          oldText: 'repeat',
          newText: 'once'
        }
      ])
    ).rejects.toThrowError(BufferError);
    await expect(
      buffer.edit(revision, [
        {
          type: 'replace_text',
          blockId: 'b0',
          oldText: 'repeat',
          newText: 'once'
        }
      ])
    ).rejects.toThrowError(/more than once/);
    expect(editor.state.doc.textContent).toBe('repeat repeat');

    editor.destroy();
    buffer.destroy();
  });

  it('inserts supported Markdown and undoes only the inserted change', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Existing' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const revision = buffer.read().revision;
    const insertion = await buffer.insert({
      expectedRevision: revision,
      target: { kind: 'document_end' },
      markdown: '## Added\n\n- one\n- two'
    });

    expect(editor.state.doc.textContent).toContain('Added');
    expect(editor.state.doc.textContent).toContain('one');
    expect(insertion.affectedBlockIds).toContain('b1');
    const edited = await buffer.edit(insertion.revision, [
      {
        type: 'replace_text',
        blockId: 'b1',
        oldText: 'Added',
        newText: 'Updated'
      }
    ]);
    expect(edited.changes[0].after).toBe('Updated');
    buffer.undo(edited.changeId);
    buffer.undo(insertion.changeId);
    expect(editor.state.doc.textContent).toBe('Existing');

    editor.destroy();
    buffer.destroy();
  });

  it('applies disjoint replacements against one original revision atomically', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First value' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second value' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const revision = buffer.read().revision;

    await buffer.edit(revision, [
      { type: 'replace_text', blockId: 'b0', oldText: 'First', newText: '1st' },
      { type: 'replace_text', blockId: 'b1', oldText: 'Second', newText: '2nd' }
    ]);
    expect(editor.state.doc.textContent).toBe('1st value2nd value');

    editor.destroy();
    buffer.destroy();
  });

  it('keeps fallback block handles stable when an earlier block is deleted', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Third' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const initial = buffer.read();

    await buffer.edit(initial.revision, [
      { type: 'delete_block', blockId: initial.blocks[0].blockId }
    ]);
    const current = buffer.read();
    expect(current.blocks.map((block) => block.blockId)).toEqual(['b1', 'b2']);

    await buffer.edit(current.revision, [
      {
        type: 'replace_text',
        blockId: 'b2',
        oldText: 'Third',
        newText: 'Updated third'
      }
    ]);
    expect(editor.state.doc.textContent).toBe('SecondUpdated third');

    editor.destroy();
    buffer.destroy();
  });

  it('rejects a replacement that crosses inline formatting boundaries', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' plain' }
          ]
        }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const revision = buffer.read().revision;

    await expect(
      buffer.edit(revision, [
        {
          type: 'replace_text',
          blockId: 'b0',
          oldText: 'bold plain',
          newText: 'changed'
        }
      ])
    ).rejects.toThrowError(/formatting boundaries/);
    expect(editor.state.doc.textContent).toBe('bold plain');

    editor.destroy();
    buffer.destroy();
  });

  it('rebases undo across a disjoint user edit', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const change = await buffer.edit(buffer.read().revision, [
      { type: 'replace_text', blockId: 'b0', oldText: 'First', newText: '1st' }
    ]);

    const secondTextPosition = editor.state.doc.child(0).nodeSize + 1;
    editor.view.dispatch(
      editor.state.tr.insertText('User ', secondTextPosition)
    );

    buffer.undo(change.changeId);
    expect(editor.state.doc.textContent).toBe('FirstUser Second');

    editor.destroy();
    buffer.destroy();
  });

  it('rejects undo when a user edit overlaps the AI change', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const change = await buffer.edit(buffer.read().revision, [
      { type: 'replace_text', blockId: 'b0', oldText: 'First', newText: '1st' }
    ]);

    editor.view.dispatch(editor.state.tr.insertText('!', 2));

    expect(() => buffer.undo(change.changeId)).toThrowError(
      /cannot be undone safely/
    );
    expect(editor.state.doc.textContent).toBe('1!st');

    editor.destroy();
    buffer.destroy();
  });

  it('rejects undo when an overlapping user mark change affects the AI range', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const change = await buffer.edit(buffer.read().revision, [
      { type: 'replace_text', blockId: 'b0', oldText: 'First', newText: '1st' }
    ]);
    const bold = editor.schema.marks.bold.create();
    editor.view.dispatch(editor.state.tr.addMark(1, 4, bold));

    expect(() => buffer.undo(change.changeId)).toThrowError(
      /cannot be undone safely/
    );

    editor.destroy();
    buffer.destroy();
  });

  it('supports paginated reads and repeated undo for sequential AI changes', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Third' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const firstPage = await buffer.executeTool('read_buffer', { limit: 2 });
    expect(firstPage.blocks?.map((block) => block.text)).toEqual([
      'First',
      'Second'
    ]);
    expect(firstPage.complete).toBe(false);
    expect(firstPage.nextOffset).toBe(2);

    const secondPage = await buffer.executeTool('read_buffer', {
      offset: firstPage.nextOffset,
      limit: 2
    });
    expect(secondPage.blocks?.map((block) => block.text)).toEqual(['Third']);
    expect(secondPage.complete).toBe(true);

    const firstChange = await buffer.edit(buffer.read().revision, [
      { type: 'replace_text', blockId: 'b0', oldText: 'First', newText: '1st' }
    ]);
    const secondChange = await buffer.edit(buffer.read().revision, [
      { type: 'replace_text', blockId: 'b0', oldText: '1st', newText: 'One' }
    ]);
    buffer.undo(secondChange.changeId);
    buffer.undo(firstChange.changeId);
    expect(editor.state.doc.textContent).toBe('FirstSecondThird');

    editor.destroy();
    buffer.destroy();
  });

  it('keeps the document valid when deleting its final block', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Only block' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');

    const change = await buffer.edit(buffer.read().revision, [
      { type: 'delete_block', blockId: 'b0' }
    ]);

    expect(change.status).toBe('applied');
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe('');

    editor.destroy();
    buffer.destroy();
  });

  it('deletes a final formula or code block while preserving a valid document', async () => {
    for (const content of [
      [{ type: 'mathBlock', attrs: { text: 'x^2' } }],
      [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const value = 1;' }]
        }
      ]
    ]) {
      const editor = createRichEditor({ type: 'doc', content });
      const buffer = new DocumentBuffer(editor, 'page-1');
      const block = buffer.read().blocks[0];

      const change = await buffer.edit(buffer.read().revision, [
        { type: 'delete_block', blockId: block.blockId }
      ]);

      expect(change.status).toBe('applied');
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
      expect(editor.state.doc.textContent).toBe('');
      editor.destroy();
      buffer.destroy();
    }
  });

  it('replaces the empty page placeholder when inserting the first content', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph' }]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');

    const insertion = await buffer.insert({
      expectedRevision: buffer.read().revision,
      target: { kind: 'document_end' },
      markdown: 'First content'
    });

    expect(insertion.status).toBe('applied');
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe('First content');
    buffer.undo(insertion.changeId);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe('');

    editor.destroy();
    buffer.destroy();
  });

  it('rejects raw HTML insertion without changing the document', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');

    await expect(
      buffer.insert({
        expectedRevision: buffer.read().revision,
        target: { kind: 'document_end' },
        markdown: '<div>Unsupported</div>'
      })
    ).rejects.toThrowError(/valid revision/);
    expect(editor.state.doc.textContent).toBe('Keep');

    editor.destroy();
    buffer.destroy();
  });

  it('does not treat unmatched literal delimiters as protected source', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');

    await expect(
      buffer.insert({
        expectedRevision: buffer.read().revision,
        target: { kind: 'document_end' },
        markdown: 'Price $5 <b>unsupported</b>'
      })
    ).rejects.toThrowError(/valid revision/);
    expect(editor.state.doc.textContent).toBe('Keep');

    editor.destroy();
    buffer.destroy();
  });

  it('does not start a cancelled tool operation', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const controller = new AbortController();
    controller.abort();

    await expect(
      buffer.executeTool(
        'edit_buffer',
        {
          expectedRevision: buffer.read().revision,
          operations: [
            {
              type: 'replace_text',
              blockId: 'b0',
              oldText: 'Keep',
              newText: 'Changed'
            }
          ]
        },
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(editor.state.doc.textContent).toBe('Keep');

    editor.destroy();
    buffer.destroy();
  });

  it('exposes list item paragraphs for text replacement while protecting the list container', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'List item' }]
                }
              ]
            }
          ]
        }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const initial = buffer.read();
    const item = initial.blocks.find((block) => block.type === 'paragraph');

    expect(item).toMatchObject({ editable: true, parentBlockId: 'b0' });
    expect(
      initial.blocks.find((block) => block.blockId === 'b0')
    ).toMatchObject({ editable: false });

    const change = await buffer.edit(initial.revision, [
      {
        type: 'replace_text',
        blockId: item!.blockId,
        oldText: 'List item',
        newText: 'Updated item'
      }
    ]);
    expect(change.status).toBe('applied');
    expect(editor.state.doc.textContent).toBe('Updated item');

    await expect(
      buffer.edit(change.revision, [
        { type: 'delete_block', blockId: item!.blockId }
      ])
    ).rejects.toThrowError(/nested and cannot be deleted/);

    editor.destroy();
    buffer.destroy();
  });
});
