import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

export const MAX_REALTIME_MESSAGE_BYTES = 4_096;

export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly webOrigin: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: {
        origin: [this.webOrigin],
        credentials: true,
        methods: ['GET', 'POST'],
      },
      transports: ['websocket'],
      maxHttpBufferSize: MAX_REALTIME_MESSAGE_BYTES,
    });
  }
}
