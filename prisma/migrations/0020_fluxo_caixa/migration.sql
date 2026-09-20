-- Fluxo de Caixa (disciplina "Fluxo de Caixa CETEM") — tabelas fc_*.
--
-- Motivo: o módulo reproduz a planilha de referência dentro do app e se
-- alimenta SÓ por leitura dos módulos existentes (títulos, pagamentos,
-- recebimentos, conciliação). Escreve apenas nestas tabelas:
--   fc_categoria     plano de 37 categorias da planilha (+ transferencia_interna,
--                    neutra) — referência global, id = slug estável;
--   fc_mapeamento    de-para entre chaves do app (plano contábil, categoria de
--                    fornecedor, categoria a receber, regra por texto) e o plano;
--   fc_parametro     saldo inicial, reserva mínima e override de meses realizados
--                    por exercício (nunca constantes no código);
--   fc_cenario       premissas dos cenários em pontos-base inteiros (1% = 100);
--   fc_ajuste_manual lançamentos que não existem em nenhum módulo.
--
-- Dinheiro em BIGINT de centavos (convenção do app: nunca float). Toda tabela
-- de escrita carrega createdBy/updatedBy/timestamps e `version` (trava
-- otimista). A unificação (vw_fc_lancamento da especificação) é função de
-- domínio (src/core/cashflow/unify.ts), não view SQL: serve o adaptador em
-- memória e o Prisma da mesma forma. Nada nas tabelas existentes é alterado.
--
-- DDL gerado com:
--   npx prisma migrate diff --from-schema-datamodel <schema anterior> \
--     --to-schema-datamodel prisma/schema.prisma --script
-- Seeds (abaixo do DDL) gerados a partir de src/core/cashflow/plan.ts.

-- CreateTable
CREATE TABLE "fc_categoria" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "fc_categoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fc_mapeamento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "fc_mapeamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fc_parametro" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "baseYear" INTEGER NOT NULL,
    "openingBalanceCents" BIGINT NOT NULL DEFAULT 0,
    "minimumReserveCents" BIGINT NOT NULL DEFAULT 0,
    "realizedMonthsOverride" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "fc_parametro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fc_cenario" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revenueAdjustmentBp" INTEGER NOT NULL,
    "expenseAdjustmentBp" INTEGER NOT NULL,
    "monthlyGrowthBp" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "fc_cenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fc_ajuste_manual" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "competenceDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "costCenterId" TEXT,
    "status" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "sourceNote" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "fc_ajuste_manual_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fc_mapeamento_companyId_active_idx" ON "fc_mapeamento"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "fc_mapeamento_companyId_source_sourceKey_key" ON "fc_mapeamento"("companyId", "source", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "fc_parametro_companyId_baseYear_key" ON "fc_parametro"("companyId", "baseYear");

-- CreateIndex
CREATE UNIQUE INDEX "fc_cenario_companyId_code_key" ON "fc_cenario"("companyId", "code");

-- CreateIndex
CREATE INDEX "fc_ajuste_manual_companyId_competenceDate_idx" ON "fc_ajuste_manual"("companyId", "competenceDate");

-- CreateIndex
CREATE INDEX "fc_ajuste_manual_companyId_categoryId_idx" ON "fc_ajuste_manual"("companyId", "categoryId");

-- CreateIndex
CREATE INDEX "fc_ajuste_manual_companyId_status_idx" ON "fc_ajuste_manual"("companyId", "status");

-- AddForeignKey
ALTER TABLE "fc_mapeamento" ADD CONSTRAINT "fc_mapeamento_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fc_mapeamento" ADD CONSTRAINT "fc_mapeamento_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "fc_categoria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fc_parametro" ADD CONSTRAINT "fc_parametro_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fc_cenario" ADD CONSTRAINT "fc_cenario_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fc_ajuste_manual" ADD CONSTRAINT "fc_ajuste_manual_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fc_ajuste_manual" ADD CONSTRAINT "fc_ajuste_manual_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "fc_categoria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fc_ajuste_manual" ADD CONSTRAINT "fc_ajuste_manual_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Seed do plano de categorias (37 da planilha + transferencia_interna, neutra).
-- Idempotente: reexecutar não duplica nem sobrescreve edições de `active`.
INSERT INTO "fc_categoria" ("id", "name", "kind", "groupKey", "classification", "sortOrder", "active") VALUES
  ('vendas_produtos', 'Vendas de Produtos', 'entrada', 'receita_operacional', 'variavel', 1, true),
  ('prestacao_servicos', 'Prestação de Serviços', 'entrada', 'receita_operacional', 'variavel', 2, true),
  ('receita_financeira', 'Receita Financeira', 'entrada', 'receita_nao_operacional', 'variavel', 3, true),
  ('outras_receitas', 'Outras Receitas', 'entrada', 'receita_nao_operacional', 'variavel', 4, true),
  ('folha_salarios', 'Folha e Salários', 'saida', 'pessoal', 'fixo', 5, true),
  ('pro_labore', 'Pró-labore', 'saida', 'pessoal', 'fixo', 6, true),
  ('encargos_inss', 'Encargos INSS', 'saida', 'pessoal', 'fixo', 7, true),
  ('encargos_fgts', 'Encargos FGTS', 'saida', 'pessoal', 'fixo', 8, true),
  ('beneficios', 'Benefícios (VR/VT/Saúde)', 'saida', 'pessoal', 'fixo', 9, true),
  ('aluguel', 'Aluguel', 'saida', 'operacional', 'fixo', 10, true),
  ('condominio', 'Condomínio', 'saida', 'operacional', 'fixo', 11, true),
  ('energia_eletrica', 'Energia Elétrica', 'saida', 'operacional', 'variavel', 12, true),
  ('agua_esgoto', 'Água e Esgoto', 'saida', 'operacional', 'variavel', 13, true),
  ('internet_telefonia', 'Internet e Telefonia', 'saida', 'operacional', 'fixo', 14, true),
  ('fornecedores', 'Fornecedores', 'saida', 'operacional', 'variavel', 15, true),
  ('materiais_equipamentos', 'Materiais e Equipamentos', 'saida', 'operacional', 'variavel', 16, true),
  ('frete_logistica', 'Frete e Logística', 'saida', 'operacional', 'variavel', 17, true),
  ('simples_nacional_das', 'Simples Nacional / DAS', 'saida', 'tributos', 'variavel', 18, true),
  ('irpj', 'IRPJ', 'saida', 'tributos', 'variavel', 19, true),
  ('csll', 'CSLL', 'saida', 'tributos', 'variavel', 20, true),
  ('pis_cofins', 'PIS / COFINS', 'saida', 'tributos', 'variavel', 21, true),
  ('iss', 'ISS', 'saida', 'tributos', 'variavel', 22, true),
  ('icms', 'ICMS', 'saida', 'tributos', 'variavel', 23, true),
  ('tributos_municipais', 'Tributos Municipais', 'saida', 'tributos', 'fixo', 24, true),
  ('tarifas_bancarias', 'Tarifas Bancárias', 'saida', 'financeiro', 'fixo', 25, true),
  ('juros_multas', 'Juros e Multas', 'saida', 'financeiro', 'variavel', 26, true),
  ('emprestimos_financiamentos', 'Empréstimos e Financiamentos', 'saida', 'financeiro', 'fixo', 27, true),
  ('cartao_credito', 'Cartão de Crédito', 'saida', 'financeiro', 'variavel', 28, true),
  ('marketing_publicidade', 'Marketing e Publicidade', 'saida', 'crescimento', 'variavel', 29, true),
  ('software_assinaturas', 'Software e Assinaturas', 'saida', 'crescimento', 'fixo', 30, true),
  ('consultorias_contabilidade', 'Consultorias e Contabilidade', 'saida', 'crescimento', 'fixo', 31, true),
  ('treinamento_certificacoes', 'Treinamento e Certificações', 'saida', 'crescimento', 'variavel', 32, true),
  ('manutencao', 'Manutenção', 'saida', 'outras', 'variavel', 33, true),
  ('seguros', 'Seguros', 'saida', 'outras', 'fixo', 34, true),
  ('combustivel_deslocamento', 'Combustível e Deslocamento', 'saida', 'outras', 'variavel', 35, true),
  ('viagens_hospedagem', 'Viagens e Hospedagem', 'saida', 'outras', 'variavel', 36, true),
  ('a_classificar', 'A Classificar', 'saida', 'outras', 'variavel', 37, true),
  ('transferencia_interna', 'Transferência entre contas próprias', 'neutro', 'outras', 'variavel', 38, true)
ON CONFLICT ("id") DO NOTHING;

-- Seed dos três cenários para cada empresa já cadastrada (empresas novas
-- recebem os mesmos padrões na primeira leitura, pela skill). Ids
-- determinísticos para a migration ser idempotente.
INSERT INTO "fc_cenario" ("id", "companyId", "code", "name", "revenueAdjustmentBp", "expenseAdjustmentBp", "monthlyGrowthBp", "active", "createdBy", "createdAt", "updatedAt", "version")
SELECT 'fcs_' || c."id" || '_otimista', c."id", 'otimista', 'Otimista', 1500, 0, 0, true, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
FROM "Company" c
ON CONFLICT ("companyId", "code") DO NOTHING;
INSERT INTO "fc_cenario" ("id", "companyId", "code", "name", "revenueAdjustmentBp", "expenseAdjustmentBp", "monthlyGrowthBp", "active", "createdBy", "createdAt", "updatedAt", "version")
SELECT 'fcs_' || c."id" || '_realista', c."id", 'realista', 'Realista', 0, 0, 0, true, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
FROM "Company" c
ON CONFLICT ("companyId", "code") DO NOTHING;
INSERT INTO "fc_cenario" ("id", "companyId", "code", "name", "revenueAdjustmentBp", "expenseAdjustmentBp", "monthlyGrowthBp", "active", "createdBy", "createdAt", "updatedAt", "version")
SELECT 'fcs_' || c."id" || '_pessimista', c."id", 'pessimista', 'Pessimista', -2000, 500, 0, true, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
FROM "Company" c
ON CONFLICT ("companyId", "code") DO NOTHING;
