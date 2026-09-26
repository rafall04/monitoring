-- CreateIndex
CREATE INDEX "app_user_phone_idx" ON "app_user"("phone");

-- CreateIndex
CREATE INDEX "wa_recipient_target_idx" ON "wa_recipient"("target");

-- CreateIndex
CREATE INDEX "ticket_status_escalatedAt_idx" ON "ticket"("status", "escalatedAt");
