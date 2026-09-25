-- Data-layer fixes: index the hot sweep/lookup paths and enforce one device
-- row per (router, ipAddress) — Netwatch resolves status by that pair, so
-- duplicates would race which row receives status updates.

-- Retention sweep: `statusEvent.deleteMany(occurredAt < cutoff)` seq-scanned.
CREATE INDEX "status_event_occurredAt_idx" ON "status_event"("occurredAt");

-- Refresh-token purge: `refreshToken.deleteMany(expiresAt < now)`.
CREATE INDEX "refresh_token_expiresAt_idx" ON "refresh_token"("expiresAt");

-- One device per watched host per router. Postgres treats NULLs as distinct,
-- so devices with no ipAddress are still allowed in any number.
--
-- NOTE: this fails if duplicate (routerId, ipAddress) rows already exist.
-- Clean them first, e.g. keep the oldest row per pair:
--   DELETE FROM "device" a USING "device" b
--   WHERE a."routerId" = b."routerId"
--     AND a."ipAddress" = b."ipAddress"
--     AND a."ipAddress" IS NOT NULL
--     AND a.id < b.id;
DROP INDEX "device_routerId_ipAddress_idx";
CREATE UNIQUE INDEX "device_routerId_ipAddress_key" ON "device"("routerId", "ipAddress");
