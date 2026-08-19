-- Anti-replay do TOTP: guarda o último counter consumido por usuário, para
-- bloquear o reuso do mesmo código dentro da janela de validade.
ALTER TABLE "User" ADD COLUMN "totpLastCounter" INTEGER;
