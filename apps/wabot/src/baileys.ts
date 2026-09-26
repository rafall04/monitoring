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
  fetchLatestWaWebVersion,
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
  /** Single-flight: concurrent callers share the in-flight connect instead of
   *  spawning parallel sockets (which race creds + show an orphaned QR). */
  private connecting: Promise<void> | null = null;
  /** The in-flight creds flush — the post-pairing restart must wait for it or
   *  the next socket can come up without `creds.me` and re-register → 401. */
  private credsSave: Promise<void> | null = null;
  /** When the last 515 (restartRequired) arrived — a 401 shortly after it is
   *  usually WA cleaning up the old session slot, not a real logout. */
  private lastPairRestartAt = 0;
  private retriedPostPair401 = false;
  /** Sockets deliberately killed by logout()/reconnect(). Their close events
   *  must NOT schedule another reconnect — doing so races the caller's own
   *  explicit connect() and spawns a second live socket whose orphan QR gets
   *  scanned while the paired session commits on the other one. */
  private deadSocks = new WeakSet<WASocket>();
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
    // Tombstone the old socket so its close event can't double-drive the
    // reconnect, then always connect explicitly.
    if (this.sock) {
      this.deadSocks.add(this.sock);
      try {
        this.sock.end(undefined);
      } catch {
        /* socket already gone */
      }
      this.sock = null;
    }
    await this.connect();
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
    const sock = this.sock;
    this.sock = null;
    this.retries = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      if (sock && this.state.status === 'connected') {
        await sock.logout(); // close handler finishes the wipe + re-pair
        return;
      }
    } catch (err) {
      this.deps.logger.warn({ err }, 'wa logout failed — wiping keys anyway');
    }
    // Dead/stale socket: tombstone it so its close can't re-drive the loop,
    // end it, then wipe, then connect explicitly — never rely on a close
    // event that may have already fired.
    if (sock) {
      this.deadSocks.add(sock);
      try {
        sock.end(undefined);
      } catch {
        /* socket already gone */
      }
    }
    await clearDbAuthState().catch((err) =>
      this.deps.logger.warn({ err }, 'wa auth wipe failed'),
    );
    // A different number pairs next — its group list is unrelated, so don't
    // let the old account's groups linger in the pick-list.
    await publishWaGroups(this.deps.redis, []).catch(() => undefined);
    await this.connect();
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

  private scheduleReconnect(delayOverride?: number): void {
    if (this.closed) return;
    const delay = delayOverride ?? Math.min(3000 * 2 ** this.retries, 60_000);
    this.retries += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref();
    this.deps.logger.info({ delayMs: delay, retries: this.retries }, 'wa reconnect scheduled');
  }

  private connect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const p = this.doConnect()
      .catch((err) => {
        this.deps.logger.warn({ err }, 'wa connect failed — retrying');
        this.scheduleReconnect();
      })
      .finally(() => {
        if (this.connecting === p) this.connecting = null;
      });
    this.connecting = p;
    return p;
  }

  private async doConnect(): Promise<void> {
    if (this.closed) return;
    await this.setState({ status: 'connecting', qr: null });

    const { state, saveCreds } = await useDbAuthState();
    // Pin the WA-web protocol version — a stale default is a common cause of
    // mysterious 405/connection failures. `fetchLatestWaWebVersion` scrapes the
    // version WA's edge actually serves (fetchLatestBaileysVersion's GitHub
    // scrape can lag and has shipped stale-"latest" versions — issue #2679).
    // Bounded so a hung fetch can't stall the connect pipeline forever.
    const version = await Promise.race([
      fetchLatestWaWebVersion()
        .then((r) => r.version)
        .catch(() => fetchLatestBaileysVersion().then((r) => r.version).catch(() => undefined)),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 10_000)),
    ]);

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
      // Each QR ref stays valid 60s instead of the 20s default — the admin UI
      // polls the session snapshot, so longer-lived refs cut the stale-QR
      // window where a phone scans a ref WA already rotated away.
      qrTimeout: 60_000,
      shouldIgnoreJid: (jid) => jid === 'status@broadcast' || jid.endsWith('@newsletter'),
    });
    this.sock = sock;

    // Track the flush — a 515 restart must wait for pair creds to hit the DB
    // before the next socket reads them.
    sock.ev.on('creds.update', () => {
      this.credsSave = saveCreds().catch((err) =>
        this.deps.logger.warn({ err }, 'wa creds save failed'),
      );
    });

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        this.deps.logger.info('wa qr emitted');
        void this.setState({ status: 'qr', qr, error: null });
      }
      if (connection === 'open') {
        this.retries = 0;
        this.retriedPostPair401 = false;
        this.lastPairRestartAt = 0;
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
        if (this.sock === sock) this.sock = null;
        if (this.closed || this.deadSocks.has(sock)) return;
        if (code === DisconnectReason.restartRequired) {
          // 515 is EXPECTED, not an error: pair-success committed and WA asks
          // us to restart with the fresh credentials. Flush the pending creds
          // write FIRST — reconnecting without `creds.me` makes the login look
          // like a duplicate registration and WA answers 401. This is the
          // documented 515 → 401 pairing-death loop.
          this.lastPairRestartAt = Date.now();
          this.retriedPostPair401 = false;
          this.retries = 0;
          this.deps.logger.info('pair-success → restarting with fresh creds');
          void (this.credsSave ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => this.scheduleReconnect(1500));
          return;
        }
        if (code === DisconnectReason.loggedOut) {
          const postPair = Date.now() - this.lastPairRestartAt < 120_000;
          if (postPair && !this.retriedPostPair401) {
            // Known WA quirk: right after pair+restart the server 401s the OLD
            // session slot — wiping here destroys the just-paired session.
            this.retriedPostPair401 = true;
            this.deps.logger.warn('post-pair 401 — treating as slot cleanup, retrying with creds');
            this.scheduleReconnect(3000);
            return;
          }
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
        // LID-addressed chats carry the phone-form JID in remoteJidAlt —
        // replying to a bare LID builds a phantom `…@s.whatsapp.net` target.
        const rawJid = m.key.remoteJid;
        const remoteJid = rawJid.endsWith('@lid')
          ? (m.key.remoteJidAlt ?? rawJid)
          : rawJid;
        // Group sender identity lives in participant (same LID→alt fix).
        const rawPart = m.key.participant ?? undefined;
        const participant = rawPart?.endsWith('@lid')
          ? (m.key.participantAlt ?? rawPart)
          : rawPart;
        const inbound: WaInboundMessage = {
          from: isGroupJid(remoteJid) ? remoteJid : jidToPhone(remoteJid),
          ...(participant ? { sender: jidToPhone(participant) } : {}),
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
