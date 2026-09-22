-- Member self-service: link an AppUser (role=member) to the hotspot account it
-- owns on a router, so staff can see their quota/sessions and rotate their own
-- hotspot password from the NOC without an operator.

ALTER TABLE "app_user"
  ADD COLUMN "hotspotRouterId" TEXT,
  ADD COLUMN "hotspotUsername" TEXT;

CREATE INDEX "app_user_hotspotRouterId_hotspotUsername_idx"
  ON "app_user"("hotspotRouterId", "hotspotUsername");

ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_hotspotRouterId_fkey"
  FOREIGN KEY ("hotspotRouterId") REFERENCES "router_mikrotik"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
