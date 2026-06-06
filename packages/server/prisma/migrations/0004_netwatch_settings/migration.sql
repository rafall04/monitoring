-- Netwatch tuning + custom RouterOS script tails + Telegram message templates,
-- all kept on the global Setting singleton so super_admin can change them
-- without touching device or per-site config.
ALTER TABLE "setting"
  ADD COLUMN "netwatchIntervalSec"   INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "netwatchTimeoutMs"     INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "netwatchExtraUp"       TEXT,
  ADD COLUMN "netwatchExtraDown"     TEXT,
  ADD COLUMN "telegramDownTemplate"  TEXT NOT NULL DEFAULT E'🔴 DOWN — {device} ({ip})\n🏭 {site}',
  ADD COLUMN "telegramUpTemplate"    TEXT NOT NULL DEFAULT E'🟢 RECOVERED — {device} ({ip})\n🏭 {site}';
