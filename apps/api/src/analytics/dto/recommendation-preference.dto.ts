import { IsBoolean } from 'class-validator';

export class RecommendationPreferenceDto {
  @IsBoolean()
  personalized!: boolean;
}
