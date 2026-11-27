import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ClubVerificationController } from './club-verification.controller';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ClubVerificationController],
})
export class ClubsModule {}
