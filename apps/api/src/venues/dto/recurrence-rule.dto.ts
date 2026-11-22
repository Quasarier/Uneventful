import { IsIn, IsInt, Matches, Max, Min, ValidateIf } from 'class-validator';

export class RecurrenceRuleDto {
  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY'])
  frequency!: 'DAILY' | 'WEEKLY' | 'MONTHLY';

  @IsInt()
  @Min(1)
  @Max(12)
  interval!: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(52)
  count?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  untilDate?: string;
}
