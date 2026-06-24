-- Rename the read-only role "user" -> "viewer" for clarity (the name "user"
-- was ambiguous next to the AppUser table). Update the column default for new
-- accounts and migrate any existing rows still on the old value.
ALTER TABLE "app_user" ALTER COLUMN "role" SET DEFAULT 'viewer';
UPDATE "app_user" SET "role" = 'viewer' WHERE "role" = 'user';
