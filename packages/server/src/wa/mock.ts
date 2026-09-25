// =============================================================================
// Mock WhatsApp driver (WA_DRIVER=mock). Lets the whole stack — pairing UI,
// outbox, test sends — run on a dev box with no WhatsApp number. "Sends" go to
// the log; the session reports as connected so the UI shows the happy path.
// =============================================================================

import type { Logger } from 'pino';
import type { WaSessionState, WhatsAppSender } from '@noc/shared';

export class MockWaSender implements WhatsAppSender {
  constructor(private logger: Logger) {}

  async sendText(to: string, text: string): Promise<void> {
    this.logger.info({ to, text }, 'WA MOCK >> send');
  }

  session(): WaSessionState {
    return {
      status: 'connected',
      qr: null,
      phone: '620000000000',
      name: 'Mock Driver',
      error: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async reconnect(): Promise<void> {
    this.logger.info('WA MOCK >> reconnect (noop)');
  }

  async logout(): Promise<void> {
    this.logger.info('WA MOCK >> logout (noop)');
  }

  async refreshGroups(): Promise<void> {
    this.logger.info('WA MOCK >> refreshGroups (noop)');
  }

  async close(): Promise<void> {}
}
