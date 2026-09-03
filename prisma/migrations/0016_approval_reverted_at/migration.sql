-- Marca de ESTORNO da aprovação, para o Histórico de decisões deixar de exibir
-- a linha cuja conciliação foi desfeita — sem apagar o registro.
--
-- Apagar a linha de Approval seria destrutivo: Payment.approvalId e
-- FlowRun.approvalId ficariam órfãos (não há FK protegendo), Controles Internos
-- passaria a acusar "pagamento sem registro de aprovação" para sempre, e a
-- prova de quem aprovou (approverIds/decidedBy/justification) só existe aqui.
--
-- Aditiva e nula por padrão: nada muda para as aprovações existentes.
ALTER TABLE "Approval" ADD COLUMN "revertedAt" TIMESTAMP(3);
