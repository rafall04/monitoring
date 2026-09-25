-- Department on complaint tickets + member accounts. The bot asks an
-- anonymous reporter (or a member with an empty profile) for their department
-- once; members/admins can also set it directly. Ticket keeps a snapshot so
-- later profile edits never rewrite history.

ALTER TABLE "app_user" ADD COLUMN "department" TEXT;
ALTER TABLE "ticket" ADD COLUMN "reporterDept" TEXT;
-- Web-created complaints may have no reachable phone — allow NULL reporter.
ALTER TABLE "ticket" ALTER COLUMN "reporterPhone" DROP NOT NULL;
