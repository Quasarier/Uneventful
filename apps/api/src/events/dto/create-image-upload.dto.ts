import { IsIn, IsInt, Max, Min } from 'class-validator';
import { MAX_EVENT_IMAGE_SIZE } from '../event-image.constants';
import { ALLOWED_EVENT_IMAGE_TYPES } from '../event-image.constants';

export class CreateImageUploadDto {
  @IsIn(Object.keys(ALLOWED_EVENT_IMAGE_TYPES))
  contentType!: keyof typeof ALLOWED_EVENT_IMAGE_TYPES;

  @IsInt()
  @Min(1)
  @Max(MAX_EVENT_IMAGE_SIZE)
  size!: number;
}
