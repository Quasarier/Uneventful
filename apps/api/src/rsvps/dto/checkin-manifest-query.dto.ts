import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const MAX_CHECKIN_MANIFEST_PAGE_SIZE = 500;

export class CheckinManifestQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(parsed, MAX_CHECKIN_MANIFEST_PAGE_SIZE) : value;
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CHECKIN_MANIFEST_PAGE_SIZE)
  limit = MAX_CHECKIN_MANIFEST_PAGE_SIZE;
}
