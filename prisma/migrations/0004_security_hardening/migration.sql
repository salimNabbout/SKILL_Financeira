-- Endurecimento de acesso: 2FA TOTP por usuário e dupla aprovação por faixa.

ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Approval" ADD COLUMN "approvalsRequired" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Approval" ADD COLUMN "approverIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
