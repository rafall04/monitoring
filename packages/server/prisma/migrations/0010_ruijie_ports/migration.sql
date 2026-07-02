-- Ruijie port monitoring: per-port link state + learned baseline speed so the
-- worker can catch a link silently renegotiating down (e.g. 1G uplink -> 100M on
-- a bad cable), plus an append-only event timeline. Also captures free extras
-- (channel utilization, firmware-outdated flag) already present in the fleet
-- payload — 0 extra API calls.

-- New free-signal columns on the existing router mirror.
ALTER TABLE "ruijie_router"
  ADD COLUMN "radio1Util"          INTEGER,
  ADD COLUMN "radio2Util"          INTEGER,
  ADD COLUMN "firmwareOutdated"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recommendedFirmware" TEXT;

CREATE TABLE "ruijie_port" (
  "id"               TEXT NOT NULL,
  "routerId"         TEXT NOT NULL,
  "portName"         TEXT NOT NULL,
  "portIndex"        INTEGER NOT NULL,
  "medium"           TEXT,
  "up"               BOOLEAN NOT NULL DEFAULT false,
  "speedMbit"        INTEGER NOT NULL DEFAULT 0,
  "enabled"          BOOLEAN NOT NULL DEFAULT true,
  "baselineMbit"     INTEGER NOT NULL DEFAULT 0,
  "baselinePinned"   BOOLEAN NOT NULL DEFAULT false,
  "degraded"         BOOLEAN NOT NULL DEFAULT false,
  "degradedSince"    TIMESTAMP(3),
  "pendingSlow"      INTEGER NOT NULL DEFAULT 0,
  "lastLinkChangeAt" TIMESTAMP(3),
  "linkDowns"        INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ruijie_port_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ruijie_port_routerId_idx" ON "ruijie_port"("routerId");
CREATE UNIQUE INDEX "ruijie_port_routerId_portName_key" ON "ruijie_port"("routerId", "portName");

ALTER TABLE "ruijie_port"
  ADD CONSTRAINT "ruijie_port_routerId_fkey"
  FOREIGN KEY ("routerId") REFERENCES "ruijie_router"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ruijie_port_event" (
  "id"       TEXT NOT NULL,
  "routerId" TEXT NOT NULL,
  "portName" TEXT NOT NULL,
  "kind"     TEXT NOT NULL,
  "fromMbit" INTEGER,
  "toMbit"   INTEGER,
  "note"     TEXT,
  "at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ruijie_port_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ruijie_port_event_routerId_at_idx" ON "ruijie_port_event"("routerId", "at");
CREATE INDEX "ruijie_port_event_at_idx" ON "ruijie_port_event"("at");
