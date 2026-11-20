import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class GoogleCallbackDto {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{40,64}$/)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  error?: string;
}
