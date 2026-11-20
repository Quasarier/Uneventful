import { IsString, Length, Matches } from 'class-validator';

export class RejectEventDto {
  @IsString()
  @Length(1, 1000)
  @Matches(/\S/)
  reason!: string;
}
