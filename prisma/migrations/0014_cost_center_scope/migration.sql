-- Centro de custo: destino do lançamento ("payable" | "receivable" | "both").
--
-- O default é "both" DE PROPÓSITO: os centros já cadastrados não têm destino
-- definido, e assumir "payable" os faria sumir de Contas a Receber sem ninguém
-- ter pedido. "both" preserva exatamente o comportamento atual.
--
-- NOT NULL com default é seguro aqui: o Postgres preenche as linhas existentes.
ALTER TABLE "CostCenter" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'both';
