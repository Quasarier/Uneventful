import { Transform, Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, MaxLength, MinLength } from 'class-validator';

export const MAX_MANUAL_CHECKIN_PAGE_SIZE = 100;

export class ManualCheckinLookupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @Transform(({ value }) => {
    if (value === undefined) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(parsed, MAX_MANUAL_CHECKIN_PAGE_SIZE) : value;
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MANUAL_CHECKIN_PAGE_SIZE)
  limit = 20;
}
