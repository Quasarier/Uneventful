import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, Matches, ValidateNested } from 'class-validator';
import { CreateEventDto } from '../../events/dto/create-event.dto';
import { RecurrenceRuleDto } from './recurrence-rule.dto';

export class CreateEventSeriesDto extends CreateEventDto {
  @ValidateNested()
  @Type(() => RecurrenceRuleDto)
  recurrence!: RecurrenceRuleDto;

  @IsArray()
  @ArrayMaxSize(52)
  @ArrayUnique()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true })
  exceptionDates!: string[];
}
