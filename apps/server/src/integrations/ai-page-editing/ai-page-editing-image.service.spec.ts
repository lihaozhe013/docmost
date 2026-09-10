import {
  AiPageEditingImageService,
  MAX_AI_IMAGE_BYTES
} from './ai-page-editing-image.service';

const scope = { userId: 'user-1', workspaceId: 'ws-1', pageId: 'page-1' };

function attachmentBase() {
  return {
    id: 'att-1',
    creatorId: 'user-1',
    workspaceId: 'ws-1',
    pageId: 'page-1',
    deletedAt: null,
    fileExt: '.png',
    fileSize: '10',
    mimeType: 'image/png',
    filePath: 'ws-1/files/att-1.png'
  };
}

function serviceFor(
  attachments: Record<string, any>,
  content = Buffer.from('img')
) {
  const attachmentRepo = {
    findById: async (id: string) => attachments[id] ?? null
  } as any;
  const storageService = {
    read: async () => content
  } as any;
  return new AiPageEditingImageService(attachmentRepo, storageService);
}

describe('AiPageEditingImageService', () => {
  it('returns a data URL for a valid own image', async () => {
    const service = serviceFor({ 'att-1': attachmentBase() });

    await expect(service.resolveImages(['att-1'], scope)).resolves.toEqual([
      `data:image/png;base64,${Buffer.from('img').toString('base64')}`
    ]);
  });

  it('deduplicates repeated attachment ids', async () => {
    const service = serviceFor({ 'att-1': attachmentBase() });

    await expect(
      service.resolveImages(['att-1', 'att-1'], scope)
    ).resolves.toHaveLength(1);
  });

  it('returns no images for an empty request', async () => {
    const service = serviceFor({});

    await expect(service.resolveImages([], scope)).resolves.toEqual([]);
  });

  it('rejects a missing attachment', async () => {
    const service = serviceFor({});

    await expect(service.resolveImages(['att-x'], scope)).rejects.toMatchObject(
      { code: 'INVALID_ATTACHMENT' }
    );
  });

  it('rejects an attachment uploaded by another user', async () => {
    const service = serviceFor({
      'att-1': { ...attachmentBase(), creatorId: 'user-2' }
    });

    await expect(service.resolveImages(['att-1'], scope)).rejects.toMatchObject(
      { code: 'INVALID_ATTACHMENT' }
    );
  });

  it('rejects an attachment belonging to another page', async () => {
    const service = serviceFor({
      'att-1': { ...attachmentBase(), pageId: 'page-2' }
    });

    await expect(service.resolveImages(['att-1'], scope)).rejects.toMatchObject(
      { code: 'INVALID_ATTACHMENT' }
    );
  });

  it('rejects a soft-deleted attachment', async () => {
    const service = serviceFor({
      'att-1': { ...attachmentBase(), deletedAt: new Date() }
    });

    await expect(service.resolveImages(['att-1'], scope)).rejects.toMatchObject(
      { code: 'INVALID_ATTACHMENT' }
    );
  });

  it('rejects a non-image extension', async () => {
    const service = serviceFor({
      'att-1': { ...attachmentBase(), fileExt: '.pdf' }
    });

    await expect(service.resolveImages(['att-1'], scope)).rejects.toMatchObject(
      { code: 'UNSUPPORTED_IMAGE_TYPE' }
    );
  });

  it('rejects an oversized image', async () => {
    const service = serviceFor({
      'att-1': {
        ...attachmentBase(),
        fileSize: String(MAX_AI_IMAGE_BYTES + 1)
      }
    });

    await expect(service.resolveImages(['att-1'], scope)).rejects.toMatchObject(
      { code: 'ATTACHMENT_TOO_LARGE' }
    );
  });

  it('rejects more images than the per-message limit', async () => {
    const service = serviceFor({});
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];

    await expect(service.resolveImages(ids, scope)).rejects.toMatchObject({
      code: 'INVALID_ATTACHMENT'
    });
  });

  it('fails when the stored file cannot be read', async () => {
    const attachmentRepo = {
      findById: async () => attachmentBase()
    } as any;
    const storageService = {
      read: async () => {
        throw new Error('disk gone');
      }
    } as any;
    const service = new AiPageEditingImageService(
      attachmentRepo,
      storageService
    );

    await expect(service.resolveImages(['att-1'], scope)).rejects.toMatchObject(
      { code: 'INVALID_ATTACHMENT' }
    );
  });
});
