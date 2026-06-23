-- Ruijie / Reyee Cloud integration: a cloud account (one app_id/secret) and the
-- devices it exposes. Polled read-only by the worker for per-router online
-- status + connected-client counts. Separate from the MikroTik spine.

CREATE TABLE "ruijie_account" (
  "id"                 TEXT NOT NULL,
  "label"              TEXT NOT NULL DEFAULT 'Ruijie Cloud',
  "appId"              TEXT NOT NULL,
  "appSecretEncrypted" TEXT NOT NULL,
  "baseUrl"            TEXT NOT NULL DEFAULT 'https://cloud-as.ruijienetworks.com',
  "pollIntervalSec"    INTEGER,
  "lastPolledAt"       TIMESTAMP(3),
  "lastError"          TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ruijie_account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ruijie_router" (
  "id"            TEXT NOT NULL,
  "accountId"     TEXT NOT NULL,
  "cloudSerial"   TEXT NOT NULL,
  "cloudGroupId"  TEXT NOT NULL,
  "groupName"     TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "model"         TEXT,
  "online"        BOOLEAN NOT NULL DEFAULT false,
  "clientCount"   INTEGER NOT NULL DEFAULT 0,
  "activeClients" INTEGER NOT NULL DEFAULT 0,
  "localIp"       TEXT,
  "wanIp"         TEXT,
  "mac"           TEXT,
  "firmware"      TEXT,
  "lastSeenAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ruijie_router_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ruijie_router_accountId_idx" ON "ruijie_router"("accountId");
CREATE UNIQUE INDEX "ruijie_router_accountId_cloudSerial_key" ON "ruijie_router"("accountId", "cloudSerial");

ALTER TABLE "ruijie_router"
  ADD CONSTRAINT "ruijie_router_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ruijie_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
