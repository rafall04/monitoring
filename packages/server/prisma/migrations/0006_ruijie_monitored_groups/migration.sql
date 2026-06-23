-- Per-account monitor allowlist: which Ruijie project/group ids the NOC tracks.
-- Empty by default; the worker stores devices only in these groups, so the
-- owner's non-NOC sites (factory/home) never reach our DB or UI.
ALTER TABLE "ruijie_account" ADD COLUMN "monitoredGroupIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
