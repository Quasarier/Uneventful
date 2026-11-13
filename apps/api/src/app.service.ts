import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
