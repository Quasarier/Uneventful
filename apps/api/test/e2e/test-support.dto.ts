import { IsBase64, IsIn, MaxLength } from 'class-validator';

export class E2eSessionDto {
  @IsIn(['first', 'second', 'organizer', 'admin'])
  user!: 'first' | 'second' | 'organizer' | 'admin';
}

export class E2eImageUploadDto {
  @IsBase64()
  @MaxLength(512)
  imageBase64!: string;
}
