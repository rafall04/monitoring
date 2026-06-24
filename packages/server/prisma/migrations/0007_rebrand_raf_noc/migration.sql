-- Rebrand: "MikroTik NOC" -> "RAF NOC".
-- The product is now multi-vendor (MikroTik + Ruijie + …), so the default
-- white-label org name is generalized.
--
-- 1) Change the column default for fresh installs.
-- 2) Migrate the existing single Setting row ONLY if it still carries the old
--    default, so a name an admin already customized is never clobbered.
ALTER TABLE "setting" ALTER COLUMN "orgName" SET DEFAULT 'RAF NOC';
UPDATE "setting" SET "orgName" = 'RAF NOC' WHERE "orgName" = 'MikroTik NOC';
