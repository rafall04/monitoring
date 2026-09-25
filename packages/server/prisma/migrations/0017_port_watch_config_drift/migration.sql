-- Device.watchPort: TCP-probe status source ("host up, service dead" — e.g.
-- a dst-nat forward disabled at the router leaves ping green while the real
-- service is unreachable; the probe sees the truth).
ALTER TABLE "device" ADD COLUMN "watchPort" INTEGER;

-- RouterMikrotik.watchConfig: per-router opt-out for the worker's firewall
-- drift watch (nat/filter/mangle snapshot+diff → alert + audit on change).
ALTER TABLE "router_mikrotik" ADD COLUMN "watchConfig" BOOLEAN NOT NULL DEFAULT true;
