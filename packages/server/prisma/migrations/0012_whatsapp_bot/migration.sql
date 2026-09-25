-- WhatsApp bot (docs/whatsapp-bot-plan.md): per-site WA mode, member phone
-- linking, complaint tickets, bot session keys, and the outbound message log.

-- AlterTable
ALTER TABLE "site"
  ADD COLUMN "whatsappMode"     TEXT NOT NULL DEFAULT 'off',
  ADD COLUMN "whatsappGroupJid" TEXT;

-- AlterTable
ALTER TABLE "app_user"
  ADD COLUMN "phone"           TEXT,
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "setting"
  ADD COLUMN "waDownTemplate"      TEXT    NOT NULL DEFAULT E'🔴 *DOWN* — {device} ({ip})\n🏭 {site}\n🕐 {when}',
  ADD COLUMN "waUpTemplate"        TEXT    NOT NULL DEFAULT E'🟢 *RECOVERED* — {device} ({ip})\n🏭 {site}\n🕐 {when}',
  ADD COLUMN "waBotName"           TEXT    NOT NULL DEFAULT 'NOC Bot',
  ADD COLUMN "waComplaintEnabled"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "waTicketEscalateMin" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "site_contact" (
    "id"        TEXT    NOT NULL,
    "siteId"    TEXT    NOT NULL,
    "name"      TEXT    NOT NULL,
    "phone"     TEXT    NOT NULL,
    "role"      TEXT    NOT NULL DEFAULT 'technician',
    "alerts"    BOOLEAN NOT NULL DEFAULT true,
    "tickets"   BOOLEAN NOT NULL DEFAULT true,
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket" (
    "id"            TEXT         NOT NULL,
    "siteId"        TEXT         NOT NULL,
    "memberId"      TEXT,
    "reporterPhone" TEXT         NOT NULL,
    "reporterName"  TEXT,
    "category"      TEXT         NOT NULL DEFAULT 'gangguan',
    "message"       TEXT         NOT NULL,
    "status"        TEXT         NOT NULL DEFAULT 'open',
    "handledBy"     TEXT,
    "escalatedAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"    TIMESTAMP(3),

    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_auth_key" (
    "key"       TEXT         NOT NULL,
    "valueEnc"  TEXT         NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_auth_key_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "wa_message" (
    "id"        TEXT         NOT NULL,
    "to"        TEXT         NOT NULL,
    "kind"      TEXT         NOT NULL,
    "body"      TEXT         NOT NULL,
    "status"    TEXT         NOT NULL DEFAULT 'queued',
    "siteId"    TEXT,
    "attempts"  INTEGER      NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_contact_siteId_idx" ON "site_contact"("siteId");

-- CreateIndex
CREATE INDEX "ticket_siteId_status_idx" ON "ticket"("siteId", "status");

-- CreateIndex
CREATE INDEX "ticket_createdAt_idx" ON "ticket"("createdAt");

-- CreateIndex
CREATE INDEX "wa_message_createdAt_idx" ON "wa_message"("createdAt");

-- CreateIndex
CREATE INDEX "wa_message_status_idx" ON "wa_message"("status");

-- AddForeignKey
ALTER TABLE "site_contact" ADD CONSTRAINT "site_contact_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
