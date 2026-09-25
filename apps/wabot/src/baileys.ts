// =============================================================================
// Baileys-backed WhatsAppSender. Owns the WA socket lifecycle: pairing QR,
// reconnect-with-backoff, session snapshots to Redis (for the backend/UI), and
// inbound message normalization → the command router.
// =============================================================================

import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import {
  REDIS_KEYS,
  isGroupJid,
  jidToPhone,
  phoneToJid,
  type WaInboundMessage,
  type WaSessionState,
  type WhatsAppSender,
} from '@noc/shared';
import { publishWaGroups, publishWaSession, type Redis } from '@noc/server';
import { clearDbAuthState, useDbAuthState } from './session';

interface BaileysDeps {
  redis: Redis;
  logger: Logger;
  onMessage: (msg: WaInboundMessage) => Promise<void>;
}

export class BaileysSender implements WhatsAppSender {
  private sock: WASocket | null = null;
  private closed = false;
  private retries = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private groupsTimer: NodeJS.Timeout | null = null;
  private state: WaSessionState = {
    status: 'offline',
    qr: null,
    phone: null,
    name: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };

  constructor(private deps: BaileysDeps) {}

  session(): WaSessionState {
    return this.state;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async sendText(to: string, text: string): Promise<void> {
    if (this.state.status !== 'connected' || !this.sock) {
      throw new Error('whatsapp not connected');
    }
    const jid = to.includes('@') ? to : phoneToJid(to);
    await this.sock.sendMessage(jid, { text });
  }

  /**
   * Soft restart — keeps the paired session keys. Ending a live socket lets the
   * close handler drive the reconnect (avoids racing a second socket); with no
   * live socket we connect right away.
   */
  async reconnect(): Promise<void> {
    if (this.closed) return;
    this.retries = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock && this.state.status !== 'offline') {
      try {
        this.sock.end(undefined);
      } catch {
        /* socket already gone */
      }
    } else {
      await this.connect();
    }
  }

  /**
   * Refresh the participating-group cache (REDIS_KEYS.waGroups) — the admin UI
   * renders it as a pick-list for kind='group' recipients. A bot can only send
   * to groups it belongs to, so this list is also the validity boundary.
   */
  async refreshGroups(): Promise<void> {
    if (this.state.status !== 'connected' || !this.sock) return;
    const all = await this.sock.groupFetchAllParticipating();
    const groups = Object.values(all)
      .map((g) => ({
        jid: g.id,
        name: g.subject ?? g.id,
        size: g.size ?? g.participants?.length ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    await publishWaGroups(this.deps.redis, groups);
    this.deps.logger.info({ groups: groups.length }, 'wa groups refreshed');
  }

  /** Debounced re-fetch — join/subject events arrive in bursts. */
  private queueGroupsRefresh(): void {
    if (this.groupsTimer) clearTimeout(this.groupsTimer);
    this.groupsTimer = setTimeout(() => {
      void this.refreshGroups().catch((err) =>
        this.deps.logger.warn({ err }, 'wa groups refresh failed'),
      );
    }, 2000);
    this.groupsTimer.unref();
  }

  /**
   * Full session reset — "new session / different number". Connected: unlink
   * the device on WhatsApp's side; the close handler (DisconnectReason.
   * loggedOut) then wipes keys and re-pairs. Otherwise wipe keys locally and
   * restart so the next socket emits a fresh QR either way.
   */
  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.sock && this.state.status === 'connected') {
        await this.sock.logout();
        return; // close handler finishes the wipe + re-pair
      }
    } catch (err) {
      this.deps.logger.warn({ err }, 'wa logout failed — wiping keys anyway');
    }
    await clearDbAuthState().catch((err) =>
      this.deps.logger.warn({ err }, 'wa auth wipe failed'),
    );
    // A different number pairs next — its group list is unrelated, so don't
    // let the old account's groups linger in the pick-list.
    await publishWaGroups(this.deps.redis, []).catch(() => undefined);
    this.retries = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        /* socket already gone */
      }
      // close handler schedules the reconnect (keys already wiped → fresh QR)
    } else {
      await this.connect();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end(undefined);
    } catch {
      /* socket already gone */
    }
    await this.setState({ status: 'offline', qr: null });
  }

  private async setState(patch: Partial<WaSessionState>): Promise<void> {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    await publishWaSession(this.deps.redis, this.state).catch((err) =>
      this.deps.logger.warn({ err }, 'wa session publish failed'),
    );
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(3000 * 2 ** this.retries, 60_000);
    this.retries += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref();
    this.deps.logger.info({ delayMs: delay, retries: this.retries }, 'wa reconnect scheduled');
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    await this.setState({ status: 'connecting', qr: null });

    const { state, saveCreds } = await useDbAuthState();
    // Pin the WA-web protocol version — a stale default is a common cause of
    // mysterious 405/connection failures. Fall back to the bundled default if
    // the version lookup itself is unreachable.
    const version = await fetchLatestBaileysVersion()
      .then((r) => r.version)
      .catch(() => undefined);

    // Baileys is chatty at info/debug — cap its logger at warn.
    const waLogger = this.deps.logger.child({ module: 'baileys' });
    waLogger.level = 'warn';

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      browser: Browsers.ubuntu('Chrome'),
      logger: waLogger,
      printQRInTerminal: false, // QR goes to the admin UI instead
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) => jid === 'status@broadcast' || jid.endsWith('@newsletter'),
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => void saveCreds());

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) void this.setState({ status: 'qr', qr, error: null });
      if (connection === 'open') {
        this.retries = 0;
        void this.setState({
          status: 'connected',
          qr: null,
          phone: sock.user?.id ? jidToPhone(sock.user.id) : null,
          name: sock.user?.name ?? null,
          error: null,
        });
        this.deps.logger.info({ phone: this.state.phone }, 'whatsapp connected');
        this.queueGroupsRefresh();
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const reason = String(code ?? lastDisconnect?.error?.message ?? 'closed');
        void this.setState({ status: 'offline', qr: null, error: reason });
        this.deps.logger.warn({ code, reason }, 'whatsapp connection closed');
        if (this.closed) return;
        if (code === DisconnectReason.loggedOut) {
          // Paired session revoked — wipe keys so the next socket emits a
          // fresh QR instead of retrying dead credentials forever. The group
          // list belongs to the revoked account — drop it too.
          void publishWaGroups(this.deps.redis, []).catch(() => undefined);
          void clearDbAuthState()
            .catch((err) => this.deps.logger.warn({ err }, 'wa auth wipe failed'))
            .finally(() => this.scheduleReconnect());
        } else {
          this.scheduleReconnect();
        }
      }
    });

    // Group membership/subject changes → keep the pick-list fresh.
    sock.ev.on('groups.upsert', () => this.queueGroupsRefresh());
    sock.ev.on('groups.update', () => this.queueGroupsRefresh());

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (m.key.fromMe || !m.key.remoteJid) continue;
        const text =
          m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? '';
        if (!text.trim()) continue;
        const remoteJid = m.key.remoteJid;
        const inbound: WaInboundMessage = {
          from: isGroupJid(remoteJid) ? remoteJid : jidToPhone(remoteJid),
          text: text.trim(),
          isGroup: isGroupJid(remoteJid),
          messageId: m.key.id ?? '',
        };
        void this.deps.onMessage(inbound).catch((err) =>
          this.deps.logger.warn({ err }, 'wa inbound handler failed'),
        );
      }
    });
  }
}
