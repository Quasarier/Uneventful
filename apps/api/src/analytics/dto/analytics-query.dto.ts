import { IsDateString, IsIn, IsOptional, Matches } from 'class-validator';

export class AnalyticsQueryDto {
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;

  @IsOptional()
  @IsIn(['day', 'week'])
  bucket?: 'day' | 'week';
}
