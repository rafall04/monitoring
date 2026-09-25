-- Device.watchNatDstPort + watchNatStaleMin: NAT-forward traffic watch.
-- Status follows the byte counter of the matching dst-nat rule — a disabled
-- rule or a counter that stops growing means "data is not flowing" even
-- though every ping is green.
ALTER TABLE "device" ADD COLUMN "watchNatDstPort" TEXT;
ALTER TABLE "device" ADD COLUMN "watchNatStaleMin" INTEGER;
