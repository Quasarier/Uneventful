import { IsBoolean, IsOptional } from 'class-validator';

export class CreateRsvpDto {
  @IsOptional()
  @IsBoolean()
  checkConflicts?: boolean;
}
