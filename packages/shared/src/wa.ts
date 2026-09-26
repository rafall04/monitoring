// =============================================================================
// WhatsApp bot contracts (docs/whatsapp-bot-plan.md).
//
// The Baileys socket lives ONLY in apps/wabot. Every other process talks to it
// through two Redis artifacts defined here:
//   - outbox list  (REDIS_KEYS.waOutbox)  : outbound messages, LPUSH → BLPOP
//   - session key  (REDIS_KEYS.waSession) : latest connection snapshot for the UI
// This file is isomorphic — no node-only imports.
// =============================================================================

import { z } from 'zod';
import type { WhatsAppMode } from './types';

// ---- Outbound outbox ---------------------------------------------------------

export const WA_MESSAGE_KINDS = [
  'alert',          // device down/recovery alert to site contacts
  'ticket-forward', // complaint forwarded to technicians
  'reply',          // a command/intake reply to the sender
  'broadcast',      // admin-initiated announcement
  'test',           // "send test message" from the settings UI
] as const;
export type WaMessageKind = (typeof WA_MESSAGE_KINDS)[number];

export const WA_MESSAGE_STATUSES = ['queued', 'sent', 'failed', 'dead'] as const;
export type WaMessageStatus = (typeof WA_MESSAGE_STATUSES)[number];

/**
 * One outbound message. `id` is the WaMessage row id — the wabot consumer marks
 * it sent/failed/dead so every send is auditable in the wa_message table.
 */
export interface WaOutboxPayload {
  id: string;
  to: string; // phone digits (628…) or a group JID (…@g.us)
  text: string;
  kind: WaMessageKind;
  siteId?: string;
}

// ---- Session snapshot --------------------------------------------------------
// wabot writes this to REDIS_KEYS.waSession on every connection transition;
// the backend reads it to drive the Settings → WhatsApp pairing UI.

export const WA_SESSION_STATUSES = [
  'disabled',    // WA_ENABLED=false — process not running the socket
  'offline',     // socket down / not started
  'connecting',  // opening the WA websocket
  'qr',          // waiting for an admin to scan the QR (pairing)
  'connected',   // linked and ready
] as const;
export type WaSessionStatus = (typeof WA_SESSION_STATUSES)[number];

export interface WaSessionState {
  status: WaSessionStatus;
  /** Raw QR payload from Baileys — the UI renders it client-side. */
  qr: string | null;
  /** Connected account's number (E.164 digits) once linked. */
  phone: string | null;
  /** Connected account's pushname. */
  name: string | null;
  error: string | null;
  updatedAt: string; // ISO
}

/**
 * One WhatsApp group the bot account participates in — fetched via
 * groupFetchAllParticipating() and cached in REDIS_KEYS.waGroups so the admin
 * UI offers a pick-list instead of asking for a raw JID. The bot can only send
 * to groups it is a member of, so this list IS the set of valid targets.
 */
export interface WaGroupInfo {
  jid: string; // …@g.us
  name: string; // group subject
  size: number | null; // participant count when known
}

// ---- Phone numbers ------------------------------------------------------------

/**
 * Normalize to E.164 digits WITHOUT the leading '+' (Baileys JID style).
 * Indonesian local format is auto-upgraded: "0812-3456" → "628123456".
 */
export function normalizePhone(raw: string): string {
  let d = raw.replace(/\D+/g, '');
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  return d;
}

/** WhatsApp JID for a personal chat. */
export function phoneToJid(phone: string): string {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

/** Sender JID → phone digits ('62812…' from '62812…:42@s.whatsapp.net'). */
export function jidToPhone(jid: string): string {
  return normalizePhone(jid.split('@')[0]?.split(':')[0] ?? '');
}

// ---- Inbound --------------------------------------------------------------------

/** One inbound message, normalized off the Baileys proto before dispatch. */
export interface WaInboundMessage {
  /** Sender phone digits (private chat) or the group JID. */
  from: string;
  /** Group messages only: the sender participant's phone digits — the real
   *  identity to authorize against (`from` stays the group JID for replies). */
  sender?: string;
  /** Text of the message this one quotes (replies-to), when present — lets
   *  `SELESAI` apply to a quoted ticket card without retyping the code. */
  quotedText?: string;
  text: string;
  isGroup: boolean;
  messageId: string;
}

// ---- Conversation state (anonymous complaint intake) ----------------------------
// Stored as JSON in REDIS_KEYS.waConv(phone) with a short TTL. The intake is a
// 3-step wizard: name → site pick → free-text message.

export const WA_CONV_TTL_SEC = 15 * 60;
/** LINK <code> pairing window (portal shows the code, user texts it to the bot). */
export const WA_LINK_TTL_SEC = 10 * 60;

export interface WaConvState {
  flow: 'complaint' | 'register';
  step: 'name' | 'dept' | 'site' | 'message';
  name?: string;
  /** Reporter's department — asked once, then saved to the member profile. */
  dept?: string;
  /** Inline `komplain <teks>` body stashed while we collect missing fields. */
  message?: string;
  siteId?: string;
  /** Candidate site ids shown as the numbered list at step 'site'. */
  siteIds?: string[];
  /** memberId present when a linked member (not anonymous) is complaining. */
  memberId?: string;
}

// ---- Sender interface ----------------------------------------------------------
// Implemented by the Baileys socket (apps/wabot) and by MockSender for dev.
// Producers do NOT hold a sender — they enqueue via the outbox so messages
// survive a bot restart.

export interface WhatsAppSender {
  sendText(to: string, text: string): Promise<void>;
  /**
   * Optional presence humanization — 'composing' before a send / 'paused'
   * after. Machine-perfect send timing is a WhatsApp ban signature; drivers
   * that can't do presence simply omit this (mock/offline).
   */
  sendPresence?(to: string, presence: 'composing' | 'paused'): Promise<void>;
  session(): WaSessionState;
  /** Soft restart of the WA socket — keeps the paired session keys. */
  reconnect(): Promise<void>;
  /** Unlink the device on WhatsApp's side + wipe keys → fresh QR (new number). */
  logout(): Promise<void>;
  /** Re-fetch the participating-group list into REDIS_KEYS.waGroups.
   *  `force` bypasses the event-driven throttle — for admin-triggered
   *  refreshes only. */
  refreshGroups(force?: boolean): Promise<void>;
  close(): Promise<void>;
}

// ---- Control channel ------------------------------------------------------------
// Admin actions the backend cannot perform itself (the socket lives in wabot).
// Producers LPUSH WaControlOp to REDIS_KEYS.waControl; wabot BLPOPs — the
// command survives a bot restart, same guarantee as the outbox.

export const WA_CONTROL_OPS = ['logout', 'reconnect', 'groups-refresh'] as const;
export type WaControlOp = (typeof WA_CONTROL_OPS)[number];
export interface WaControlMessage {
  op: WaControlOp;
  requestedBy?: string; // audit trail: admin email/id
}

// ---- Recipients + tickets (read models) ------------------------------------------

export const WA_RECIPIENT_KINDS = ['number', 'group'] as const;
export type WaRecipientKind = (typeof WA_RECIPIENT_KINDS)[number];

export const SITE_CONTACT_ROLES = ['technician', 'manager', 'noc'] as const;
export type SiteContactRole = (typeof SITE_CONTACT_ROLES)[number];

export interface WaRecipient {
  id: string;
  siteId: string;
  name: string;
  kind: WaRecipientKind;
  /** Phone digits (628xxx) for kind='number', group JID (xxx@g.us) for 'group'. */
  target: string;
  role: SiteContactRole;
  alerts: boolean;
  tickets: boolean;
  isActive: boolean;
  createdAt: string;
}

export const TICKET_STATUSES = ['open', 'ack', 'resolved'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_CATEGORIES = ['gangguan', 'lambat', 'voucher', 'lainnya'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export interface Ticket {
  id: string;
  siteId: string;
  siteName: string | null;
  memberId: string | null;
  memberName: string | null;
  /** Null when the complaint came from the web portal and the member has no linked WA. */
  reporterPhone: string | null;
  reporterName: string | null;
  /** Reporter's department snapshot (free text). */
  reporterDept: string | null;
  category: TicketCategory;
  message: string;
  status: TicketStatus;
  handledBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

// ---- zod schemas -----------------------------------------------------------------

const zEnum = <T extends string>(vals: readonly T[]) =>
  z.enum(vals as unknown as [T, ...T[]]);

const phoneSchema = z
  .string()
  .min(6)
  .max(20)
  .transform(normalizePhone)
  .refine((p) => /^[1-9]\d{8,15}$/.test(p), 'Nomor WhatsApp tidak valid (format: 08xxx / 628xxx)');

export const waRecipientUpsertSchema = z
  .object({
    id: z.string().min(1).optional(), // present = update
    name: z.string().min(1).max(120),
    kind: zEnum(WA_RECIPIENT_KINDS).default('number'),
    target: z.string().min(5).max(64),
    role: zEnum(SITE_CONTACT_ROLES).default('technician'),
    alerts: z.boolean().default(true),
    tickets: z.boolean().default(true),
    isActive: z.boolean().default(true),
  })
  .transform((r) => ({
    ...r,
    // Numbers are normalized to E.164 digits; group JIDs pass through verbatim.
    target: r.kind === 'group' ? r.target : normalizePhone(r.target),
  }))
  .refine(
    (r) =>
      r.kind === 'group'
        ? r.target.endsWith('@g.us')
        : /^[1-9]\d{8,15}$/.test(r.target),
    { path: ['target'], message: 'Target tidak valid (nomor 08xxx/628xxx atau JID @g.us)' },
  );
export type WaRecipientUpsertInput = z.infer<typeof waRecipientUpsertSchema>;

/** "Send test message" — verifies the whole outbox → socket path on demand. */
export const waTestMessageSchema = z.object({
  to: phoneSchema,
  text: z.string().min(1).max(2000),
});
export type WaTestMessageInput = z.infer<typeof waTestMessageSchema>;

export const updateTicketSchema = z.object({
  status: zEnum(TICKET_STATUSES).optional(),
  handledBy: z.string().max(120).nullable().optional(),
});
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

/** Admin broadcast: one announcement to a site's contacts + linked members. */
export const waBroadcastSchema = z.object({
  siteId: z.string().min(1),
  text: z.string().min(1).max(2000),
});
export type WaBroadcastInput = z.infer<typeof waBroadcastSchema>;

export const ticketQuerySchema = z.object({
  status: zEnum(TICKET_STATUSES).optional(),
  siteId: z.string().min(1).optional(),
});
export type TicketQueryInput = z.infer<typeof ticketQuerySchema>;

export type { WhatsAppMode };
