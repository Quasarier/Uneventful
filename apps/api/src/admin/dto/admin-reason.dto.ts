import { IsString, Length, Matches } from 'class-validator';

export class AdminReasonDto {
  @IsString()
  @Length(1, 1000)
  @Matches(/\S/)
  reason!: string;
}
