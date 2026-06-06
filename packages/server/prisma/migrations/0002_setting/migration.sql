-- Global NOC configuration / branding (singleton: id = 'global').
CREATE TABLE "setting" (
  "id"                  TEXT NOT NULL DEFAULT 'global',
  "orgName"             TEXT NOT NULL DEFAULT 'MikroTik NOC',
  "logoUrl"             TEXT,
  "accentRgb"           TEXT NOT NULL DEFAULT '59 130 246',
  "themeDefault"        TEXT NOT NULL DEFAULT 'dark',
  "defaultMapLat"       DOUBLE PRECISION NOT NULL DEFAULT -6.2,
  "defaultMapLng"       DOUBLE PRECISION NOT NULL DEFAULT 106.8,
  "defaultMapZoom"      INTEGER NOT NULL DEFAULT 13,
  "defaultPollSec"      INTEGER NOT NULL DEFAULT 20,
  "eventRetentionDays"  INTEGER NOT NULL DEFAULT 90,
  "auditRetentionDays"  INTEGER NOT NULL DEFAULT 180,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "setting_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row.
INSERT INTO "setting" ("id", "updatedAt") VALUES ('global', NOW())
  ON CONFLICT ("id") DO NOTHING;
