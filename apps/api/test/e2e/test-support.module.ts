import { Module } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { AuthModule } from '../../src/auth/auth.module';
import { DatabaseModule } from '../../src/database/database.module';
import { E2eTestSupportController } from './test-support.controller';

@Module({
  imports: [AppModule, AuthModule, DatabaseModule],
  controllers: [E2eTestSupportController],
})
export class E2eTestSupportModule {}
