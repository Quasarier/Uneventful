import { IsString, MaxLength, MinLength } from 'class-validator';

export class UnsubscribeTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  token!: string;
}
