-- Incident workflow on the device row: who acknowledged & when, and whether
-- alerts are silenced until a given moment. All nullable -> safe additive change.
ALTER TABLE "device" ADD COLUMN "ackBy"         TEXT;
ALTER TABLE "device" ADD COLUMN "ackAt"         TIMESTAMP(3);
ALTER TABLE "device" ADD COLUMN "silencedUntil" TIMESTAMP(3);
