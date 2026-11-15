import sharp from 'sharp';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  EventImageStorageService,
  EVENT_IMAGE_PROCESSING_TIMEOUT_SECONDS,
  MAX_EVENT_IMAGE_PIXELS,
  reencodeEventImage,
} from './event-image-storage.service';
import { MAX_EVENT_IMAGE_SIZE } from './event-image.constants';

describe('event image normalization', () => {
  it('decodes and re-encodes images, removing metadata and trailing polyglot data', async () => {
    const source = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: { r: 30, g: 90, b: 160 },
      },
    })
      .jpeg()
      .withMetadata({ density: 300 })
      .toBuffer();
    const polyglot = Buffer.concat([source, Buffer.from('<script>alert(1)</script>')]);

    const normalized = await reencodeEventImage(polyglot, 'image/jpeg');
    const normalizedMetadata = await sharp(normalized).metadata();

    expect(normalized.includes(Buffer.from('<script>alert(1)</script>'))).toBe(false);
    expect(normalizedMetadata.format).toBe('jpeg');
    expect(normalizedMetadata.width).toBe(3);
    expect(normalizedMetadata.height).toBe(2);
    expect(normalizedMetadata.exif).toBeUndefined();
    expect(normalizedMetadata.density).not.toBe(300);
  });

  it('rejects undecodable bytes and a content type that does not match the decoded format', async () => {
    await expect(reencodeEventImage(Buffer.from('not an image'), 'image/png')).rejects.toThrow(
      'The uploaded image could not be decoded.',
    );

    const png = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    await expect(reencodeEventImage(png, 'image/jpeg')).rejects.toThrow(
      'The uploaded image content does not match its file type.',
    );
  });

  it('rejects inputs over the size cap before decoding', async () => {
    await expect(
      reencodeEventImage(Buffer.alloc(MAX_EVENT_IMAGE_SIZE + 1), 'image/jpeg'),
    ).rejects.toThrow('The uploaded image is invalid.');
  });

  it('applies the configured timeout to metadata inspection and image decoding', async () => {
    const source = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 12, g: 34, b: 56 },
      },
    })
      .png()
      .toBuffer();
    const timeout = vi.spyOn(sharp.prototype, 'timeout');

    try {
      await reencodeEventImage(source, 'image/png');
      expect(timeout).toHaveBeenCalledTimes(2);
      expect(timeout).toHaveBeenNthCalledWith(1, {
        seconds: EVENT_IMAGE_PROCESSING_TIMEOUT_SECONDS,
      });
      expect(timeout).toHaveBeenNthCalledWith(2, {
        seconds: EVENT_IMAGE_PROCESSING_TIMEOUT_SECONDS,
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it('rejects a compressed image whose dimensions exceed the decompression-bomb pixel cap', async () => {
    const side = Math.ceil(Math.sqrt(MAX_EVENT_IMAGE_PIXELS + 1));
    const bomb = await sharp({
      create: {
        width: side,
        height: side,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    expect(bomb.length).toBeLessThan(MAX_EVENT_IMAGE_SIZE);
    await expect(reencodeEventImage(bomb, 'image/png')).rejects.toThrow(
      'The uploaded image exceeds the pixel limit.',
    );
  });

  it('applies EXIF orientation before stripping the metadata', async () => {
    const source = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: { r: 30, g: 50, b: 70 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(source).metadata()).orientation).toBe(6);

    const normalized = await reencodeEventImage(source, 'image/jpeg');
    const metadata = await sharp(normalized).metadata();

    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(3);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });

  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
  ] as const)(
    'normalizes supported %s images into their declared format',
    async (format, contentType) => {
      const source = await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 3,
          background: { r: 12, g: 34, b: 56 },
        },
      })
        .toFormat(format)
        .toBuffer();

      const normalized = await reencodeEventImage(source, contentType);
      await expect(sharp(normalized).metadata()).resolves.toMatchObject({
        format,
        width: 2,
        height: 2,
      });
    },
  );

  it('reduces animated WebP to its first frame', async () => {
    const makeFrame = (background: { r: number; g: number; b: number }) =>
      sharp({ create: { width: 2, height: 2, channels: 3, background } })
        .png()
        .toBuffer();
    const [first, second] = await Promise.all([
      makeFrame({ r: 255, g: 0, b: 0 }),
      makeFrame({ r: 0, g: 0, b: 255 }),
    ]);
    const animated = await sharp([first, second], { join: { animated: true } })
      .webp({ delay: [100, 200], loop: 0 })
      .toBuffer();
    const animatedMetadata = await sharp(animated, { animated: true }).metadata();
    expect(animatedMetadata.pages).toBe(2);

    const normalized = await reencodeEventImage(animated, 'image/webp');
    const normalizedMetadata = await sharp(normalized, { animated: true }).metadata();
    const firstPixel = await sharp(normalized)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();

    expect(normalizedMetadata.format).toBe('webp');
    expect(normalizedMetadata.pages).toBeUndefined();
    expect(firstPixel[0]).toBeGreaterThan(200);
    expect(firstPixel[2]).toBeLessThan(50);
  });

  it('deletes the staging object after normalization succeeds', async () => {
    const source = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
    const { storage, commands } = makeStorage(source);

    await storage.sanitizeAndStoreUploadedObject(
      'event-uploads/staging/event/source.png',
      'events/event/normalized.png',
      'image/png',
    );

    expect(
      commands.map((command) =>
        command instanceof HeadObjectCommand
          ? 'HeadObjectCommand'
          : command instanceof GetObjectCommand
            ? 'GetObjectCommand'
            : command instanceof PutObjectCommand
              ? 'PutObjectCommand'
              : command instanceof DeleteObjectCommand
                ? 'DeleteObjectCommand'
                : 'UnexpectedCommand',
      ),
    ).toEqual(['HeadObjectCommand', 'GetObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand']);
    const deletion = commands.at(-1);
    expect(deletion).toBeInstanceOf(DeleteObjectCommand);
    expect(deletion).toMatchObject({
      input: {
        Bucket: 'event-image-test-bucket',
        Key: 'event-uploads/staging/event/source.png',
      },
    });
  });

  it('deletes the staging object when decoding fails', async () => {
    const { storage, commands } = makeStorage(Buffer.from('corrupt'));

    await expect(
      storage.sanitizeAndStoreUploadedObject(
        'event-uploads/staging/event/corrupt.png',
        'events/event/normalized.png',
        'image/png',
      ),
    ).rejects.toThrow('The uploaded image could not be decoded.');

    const deletion = commands.at(-1);
    expect(deletion).toBeInstanceOf(DeleteObjectCommand);
    expect(deletion).toMatchObject({
      input: {
        Bucket: 'event-image-test-bucket',
        Key: 'event-uploads/staging/event/corrupt.png',
      },
    });
    expect(commands.some((command) => command instanceof PutObjectCommand)).toBe(false);
  });
});

function makeStorage(input: Buffer): {
  storage: EventImageStorageService;
  commands: unknown[];
} {
  const commands: unknown[] = [];
  const client = {
    send: vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof HeadObjectCommand) {
        return { ContentType: 'image/png', ContentLength: input.length };
      }
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => input } };
      }
      return {};
    }),
  };
  const storage = Object.create(EventImageStorageService.prototype) as EventImageStorageService;
  Object.defineProperty(storage, 'client', { value: client });
  Object.defineProperty(storage, 'bucket', { value: 'event-image-test-bucket' });
  return { storage, commands };
}
