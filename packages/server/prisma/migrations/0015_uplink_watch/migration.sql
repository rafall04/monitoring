-- Interface-watch ("uplink") devices: a Device whose status is driven by a
-- RouterOS interface's running flag instead of Netwatch — e.g. "ether2 =
-- jalur uplink ke 001". Alerts for these devices are gated by a work-hours
-- window: global default on Setting, optional per-device JSON override.

ALTER TABLE "device"
  ADD COLUMN "watchInterface"   TEXT,
  ADD COLUMN "watchAlertWindow" JSONB;

-- Global default window: 06:00-18:00 every day. Minutes after midnight;
-- days are ISO weekday numbers (1=Mon..7=Sun).
ALTER TABLE "setting"
  ADD COLUMN "uplinkAlertStartMin" INTEGER   NOT NULL DEFAULT 360,
  ADD COLUMN "uplinkAlertEndMin"   INTEGER   NOT NULL DEFAULT 1080,
  ADD COLUMN "uplinkAlertDays"     INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7];
