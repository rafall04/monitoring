-- Link Ruijie projects to NOC sites: a JSON map of groupName -> siteId on the
-- account, so each site page can surface its mapped project's WiFi counts.
ALTER TABLE "ruijie_account" ADD COLUMN "groupSiteMap" JSONB NOT NULL DEFAULT '{}';
