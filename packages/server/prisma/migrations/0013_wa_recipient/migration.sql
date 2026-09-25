-- Unified WhatsApp recipients: site_contact is renamed to wa_recipient and
-- generalized — a row can be a personal number (kind='number') OR a WhatsApp
-- group (kind='group'), each with its own alert/ticket flags. The site's
-- single whatsappGroupJid column is superseded by group recipient rows.

-- RenameTable + generalize columns
ALTER TABLE "site_contact" RENAME TO "wa_recipient";
ALTER TABLE "wa_recipient" RENAME COLUMN "phone" TO "target";
ALTER TABLE "wa_recipient" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'number';

-- Tidy constraint/index names to match the new table
ALTER TABLE "wa_recipient" RENAME CONSTRAINT "site_contact_pkey" TO "wa_recipient_pkey";
ALTER TABLE "wa_recipient" RENAME CONSTRAINT "site_contact_siteId_fkey" TO "wa_recipient_siteId_fkey";
ALTER INDEX "site_contact_siteId_idx" RENAME TO "wa_recipient_siteId_idx";

-- Carry any configured group JIDs over as group recipients (deterministic ids).
INSERT INTO "wa_recipient" ("id", "siteId", "name", "kind", "target", "role", "alerts", "tickets", "isActive", "createdAt")
SELECT 'mig_' || "id", "id", 'Grup WhatsApp site', 'group', "whatsappGroupJid", 'noc', true, true, true, CURRENT_TIMESTAMP
FROM "site"
WHERE "whatsappGroupJid" IS NOT NULL AND "whatsappGroupJid" <> '';

-- DropColumn
ALTER TABLE "site" DROP COLUMN "whatsappGroupJid";
