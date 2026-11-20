import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import sharp from 'sharp';
import type { Environment } from '../config/environment';
import {
  EVENT_IMAGE_UPLOAD_TTL_SECONDS,
  MAX_EVENT_IMAGE_SIZE,
  type EventImageContentType,
  isEventImageContentType,
} from './event-image.constants';

export const MAX_EVENT_IMAGE_PIXELS = 40_000_000;
export const EVENT_IMAGE_PROCESSING_TIMEOUT_SECONDS = 10;

const decoderOptions = {
  failOn: 'error' as const,
  limitInputPixels: MAX_EVENT_IMAGE_PIXELS,
  animated: false,
  pages: 1,
};

export async function reencodeEventImage(
  input: Uint8Array,
  contentType: EventImageContentType,
): Promise<Buffer> {
  if (input.length < 1 || input.length > MAX_EVENT_IMAGE_SIZE) {
    throw new BadRequestException('The uploaded image is invalid.');
  }

  const expectedFormat =
    contentType === 'image/jpeg' ? 'jpeg' : contentType === 'image/png' ? 'png' : 'webp';

  try {
    const metadata = await sharp(input, {
      failOn: 'error',
      animated: false,
      pages: 1,
    })
      .timeout({ seconds: EVENT_IMAGE_PROCESSING_TIMEOUT_SECONDS })
      .metadata();
    if (metadata.format !== expectedFormat) {
      throw new BadRequestException('The uploaded image content does not match its file type.');
    }
    if (
      typeof metadata.width !== 'number' ||
      typeof metadata.height !== 'number' ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width > Math.floor(MAX_EVENT_IMAGE_PIXELS / metadata.height)
    ) {
      throw new BadRequestException('The uploaded image exceeds the pixel limit.');
    }

    let pipeline = sharp(input, decoderOptions)
      .timeout({ seconds: EVENT_IMAGE_PROCESSING_TIMEOUT_SECONDS })
      .rotate();
    if (contentType === 'image/jpeg') {
      pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
    } else if (contentType === 'image/png') {
      pipeline = pipeline.png({ compressionLevel: 9 });
    } else {
      pipeline = pipeline.webp({ quality: 85 });
    }
    const normalized = await pipeline.toBuffer();
    if (normalized.length < 1 || normalized.length > MAX_EVENT_IMAGE_SIZE) {
      throw new BadRequestException('The normalized image exceeds the allowed size.');
    }
    return normalized;
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new BadRequestException('The uploaded image could not be decoded.');
  }
}

function isObjectNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'NotFound' || error.$metadata.httpStatusCode === 404)
  );
}

@Injectable()
export class EventImageStorageService implements OnModuleDestroy {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: ConfigService<Environment, true>) {
    this.bucket = config.get('OBJECT_STORAGE_BUCKET', { infer: true });
    const endpoint = config.get('OBJECT_STORAGE_ENDPOINT', { infer: true });
    this.client = new S3Client({
      region: config.get('OBJECT_STORAGE_REGION', { infer: true }),
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  createUploadForm(key: string, contentType: EventImageContentType) {
    return createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Fields: { 'Content-Type': contentType },
      Conditions: [
        ['content-length-range', 1, MAX_EVENT_IMAGE_SIZE],
        ['eq', '$Content-Type', contentType],
      ],
      Expires: EVENT_IMAGE_UPLOAD_TTL_SECONDS,
    });
  }

  async sanitizeAndStoreUploadedObject(
    uploadKey: string,
    finalKey: string,
    contentType: EventImageContentType,
  ): Promise<void> {
    try {
      let head;
      try {
        head = await this.client.send(
          new HeadObjectCommand({
            Bucket: this.bucket,
            Key: uploadKey,
          }),
        );
      } catch (error) {
        if (isObjectNotFound(error)) {
          throw new BadRequestException('The image upload was not found.');
        }
        throw error;
      }

      if (
        head.ContentType !== contentType ||
        typeof head.ContentLength !== 'number' ||
        head.ContentLength < 1 ||
        head.ContentLength > MAX_EVENT_IMAGE_SIZE
      ) {
        throw new BadRequestException('The uploaded image does not meet the file requirements.');
      }

      let bytes: Uint8Array;
      try {
        const object = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: uploadKey,
          }),
        );
        if (!object.Body) {
          throw new BadRequestException('The uploaded image is invalid.');
        }
        bytes = await object.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        if (isObjectNotFound(error)) {
          throw new BadRequestException('The image upload was not found.');
        }
        throw error;
      }

      if (bytes.length !== head.ContentLength) {
        throw new BadRequestException('The uploaded image could not be verified.');
      }
      const normalized = await reencodeEventImage(bytes, contentType);
      const extension = finalKey.slice(finalKey.lastIndexOf('.') + 1);
      const safeExtensionByType =
        contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/png' ? 'png' : 'webp';
      if (extension !== safeExtensionByType) {
        throw new BadRequestException('The server-generated image key is invalid.');
      }
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: finalKey,
          Body: normalized,
          ContentLength: normalized.length,
          ContentType: contentType,
          ContentDisposition: `attachment; filename="event-image.${extension}"`,
          CacheControl: 'private, no-store',
        }),
      );
    } finally {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: uploadKey,
        }),
      );
    }
  }

  async getFinalImage(key: string): Promise<{
    body: Buffer;
    contentType: EventImageContentType;
    extension: string;
  }> {
    const extension = key.slice(key.lastIndexOf('.') + 1);
    const contentType = this.imageContentTypeForKey(key);
    let head;
    try {
      head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isObjectNotFound(error)) {
        throw new BadRequestException('The event image is no longer available.');
      }
      throw error;
    }
    if (
      head.ContentType !== contentType ||
      typeof head.ContentLength !== 'number' ||
      head.ContentLength < 1 ||
      head.ContentLength > MAX_EVENT_IMAGE_SIZE
    ) {
      throw new BadRequestException('The stored event image is invalid.');
    }
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!object.Body) {
      throw new BadRequestException('The stored event image is invalid.');
    }
    const body = Buffer.from(await object.Body.transformToByteArray());
    if (body.length !== head.ContentLength) {
      throw new BadRequestException('The stored event image is invalid.');
    }
    return { body, contentType, extension };
  }

  private imageContentTypeForKey(key: string): EventImageContentType {
    const extension = key.slice(key.lastIndexOf('.') + 1);
    const contentType =
      extension === 'jpg'
        ? 'image/jpeg'
        : extension === 'png'
          ? 'image/png'
          : extension === 'webp'
            ? 'image/webp'
            : undefined;
    if (!contentType || !isEventImageContentType(contentType)) {
      throw new BadRequestException('The stored event image key is invalid.');
    }
    return contentType;
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
