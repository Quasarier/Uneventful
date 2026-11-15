import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EventsModule } from './events/events.module';
import { DatabaseModule } from './database/database.module';
import { HealthService } from './health.service';

@Module({
  imports: [AppConfigModule, AuthModule, EventsModule, DatabaseModule],
  controllers: [AppController],
  providers: [AppService, HealthService],
})
export class AppModule {}
