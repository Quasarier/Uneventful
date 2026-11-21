import { IsIn } from 'class-validator';

export class E2eSessionDto {
  @IsIn(['first', 'second'])
  user!: 'first' | 'second';
}
