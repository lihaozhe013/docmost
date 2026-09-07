import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { BufferError, DocumentBuffer } from './document-buffer';

function createEditor(content: any): Editor {
  return new Editor({
    extensions: [StarterKit],
    content
  });
}

describe('DocumentBuffer', () => {
  it('reads blocks and applies an exact replacement with a revision', () => {
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

    const change = buffer.edit(initial.revision, [
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

  it('rejects stale and ambiguous edits without mutating the document', () => {
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

    expect(() =>
      buffer.edit('old-revision', [
        {
          type: 'replace_text',
          blockId: 'b0',
          oldText: 'repeat',
          newText: 'once'
        }
      ])
    ).toThrowError(BufferError);
    expect(() =>
      buffer.edit(revision, [
        {
          type: 'replace_text',
          blockId: 'b0',
          oldText: 'repeat',
          newText: 'once'
        }
      ])
    ).toThrowError(/more than once/);
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
    const edited = buffer.edit(insertion.revision, [
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

  it('applies disjoint replacements against one original revision atomically', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First value' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second value' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const revision = buffer.read().revision;

    buffer.edit(revision, [
      { type: 'replace_text', blockId: 'b0', oldText: 'First', newText: '1st' },
      { type: 'replace_text', blockId: 'b1', oldText: 'Second', newText: '2nd' }
    ]);
    expect(editor.state.doc.textContent).toBe('1st value2nd value');

    editor.destroy();
    buffer.destroy();
  });

  it('keeps fallback block handles stable when an earlier block is deleted', () => {
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

    buffer.edit(initial.revision, [
      { type: 'delete_block', blockId: initial.blocks[0].blockId }
    ]);
    const current = buffer.read();
    expect(current.blocks.map((block) => block.blockId)).toEqual(['b1', 'b2']);

    buffer.edit(current.revision, [
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

  it('rejects a replacement that crosses inline formatting boundaries', () => {
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

    expect(() =>
      buffer.edit(revision, [
        {
          type: 'replace_text',
          blockId: 'b0',
          oldText: 'bold plain',
          newText: 'changed'
        }
      ])
    ).toThrowError(/formatting boundaries/);
    expect(editor.state.doc.textContent).toBe('bold plain');

    editor.destroy();
    buffer.destroy();
  });

  it('rebases undo across a disjoint user edit', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const change = buffer.edit(buffer.read().revision, [
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

  it('rejects undo when a user edit overlaps the AI change', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const change = buffer.edit(buffer.read().revision, [
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

  it('rejects undo when an overlapping user mark change affects the AI range', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');
    const change = buffer.edit(buffer.read().revision, [
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

    const firstChange = buffer.edit(buffer.read().revision, [
      { type: 'replace_text', blockId: 'b0', oldText: 'First', newText: '1st' }
    ]);
    const secondChange = buffer.edit(buffer.read().revision, [
      { type: 'replace_text', blockId: 'b0', oldText: '1st', newText: 'One' }
    ]);
    buffer.undo(secondChange.changeId);
    buffer.undo(firstChange.changeId);
    expect(editor.state.doc.textContent).toBe('FirstSecondThird');

    editor.destroy();
    buffer.destroy();
  });

  it('keeps the document valid when deleting its final block', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Only block' }] }
      ]
    });
    const buffer = new DocumentBuffer(editor, 'page-1');

    const change = buffer.edit(buffer.read().revision, [
      { type: 'delete_block', blockId: 'b0' }
    ]);

    expect(change.status).toBe('applied');
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe('');

    editor.destroy();
    buffer.destroy();
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

  it('exposes list item paragraphs for text replacement while protecting the list container', () => {
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

    const change = buffer.edit(initial.revision, [
      {
        type: 'replace_text',
        blockId: item!.blockId,
        oldText: 'List item',
        newText: 'Updated item'
      }
    ]);
    expect(change.status).toBe('applied');
    expect(editor.state.doc.textContent).toBe('Updated item');

    expect(() =>
      buffer.edit(change.revision, [
        { type: 'delete_block', blockId: item!.blockId }
      ])
    ).toThrowError(/nested and cannot be deleted/);

    editor.destroy();
    buffer.destroy();
  });
});
