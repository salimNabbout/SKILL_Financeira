# Recorrência Mensal de Títulos — Design

Data: 2026-08-23
App: Financeira PME (Next.js 15 + Prisma/PostgreSQL, repo SKILL_Financeira)

## Problema

O app não tem recorrência: para uma despesa/receita que se repete todo mês
(aluguel, salário, mensalidade), hoje o usuário precisa recadastrar o título
manualmente a cada mês. Existe apenas **parcelamento** (installmentCount), que
divide um valor finito de uma vez — não é recorrência.

## Escopo aprovado

- Vale para **Contas a Pagar E Contas a Receber**.
- Frequência **mensal** (dia fixo do mês).
- Geração **automática** pelo scheduler diário que já roda na VPS.
- Início definido; **data-fim opcional** (sem = indefinido); pausar/encerrar.
- Título gerado **no início do mês** (dia 1º ou startDate), com vencimento no dueDay.
- Dia inexistente no mês (31 em fev) → último dia do mês.

## Modelo de dados — `RecurringTemplate` (tabela nova)

- `id`, `companyId`, `createdAt`, `updatedAt`, `active` (padrão do app)
- `kind`: `"payable" | "receivable"`
- `counterpartyId`: fornecedor (payable) ou cliente (receivable)
- `description`: string
- `amountCents`: int
- `dueDay`: 1–31
- `category?`: string (categoria de fornecedor, para payable)
- `costClassification?`: `"fixed" | "variable"` (para payable)
- `startDate`: ISODate
- `endDate?`: ISODate (opcional)
- `status`: `"active" | "paused" | "ended"`

Migração segue o molde do 0009 (tabela nova: PK id TEXT, companyId + FK Company,
índices, `@@unique([companyId, ...])`). Nome: `0011_recurring_template`.

## Geração automática

- Flow novo `recurring_titles_generate`, agendado **diário** (~6h) no scheduler
  (ScheduleDefinition em DEFAULT_SCHEDULES / config.schedules).
- Cadência: roda `daily` e o próprio flow decide se hoje é dia de gerar (não há
  cadência "monthly" nativa; o daily + idempotência do balde já protege).
- A cada execução: para cada template `active` da empresa, se hoje ≥ dia de
  geração do mês corrente (dia 1º/startDate) e dentro de [startDate, endDate],
  cria o título do mês (vencimento = dueDay ajustado ao último dia se preciso)
  chamando `create_payable` / `create_receivable`.
- **Idempotência**: criação já é idempotente por `originKey` (inclui a data). O
  título do mês nunca é criado 2x. O originKey da recorrência deve variar por
  mês (inclui o período), garantindo 1 título/mês/template.
- Título gerado leva marca de origem (em notes/descrição): "gerado por recorrência".

## Tela — Cadastros → Recorrências

- Formulário "Nova recorrência": tipo (a pagar/a receber, reativo →
  fornecedor/cliente), descrição, valor mensal, dia do vencimento, categoria +
  classificação de custo (payable), data início, data-fim (opcional).
- Lista das recorrências: descrição, tipo, valor, dia, status; ações Pausar /
  Encerrar / Editar.
- **Editar/pausar/encerrar afeta só os títulos FUTUROS**; os já gerados são
  títulos normais e não mudam.

## Arquitetura (padrões existentes)

1. Domínio: `RecurringTemplate` (entities.ts) + `RecurringTemplateRepo`
   (repositories.ts, com `listActive`, `findByOriginKey`).
2. Persistência: schema.prisma + migração 0011 + mapeadores Prisma + coleção
   memory (testes).
3. Skill `recorrencia`: criar/pausar/encerrar templates + gerar títulos devidos
   (chama create_payable/create_receivable).
4. Flow `recurring_titles_generate` + agenda diária no scheduler.
5. UI: `cadastros/recorrencias` (client component para o form reativo).

## Testes (TDD)

- Gera título certo no mês certo (dueDay, startDate, endDate).
- Idempotência: gerar 2x no mesmo mês não duplica.
- Dia inexistente (31 em fev) → último dia do mês.
- Pausado/encerrado não gera.
- Mapeamento Prisma ida/volta do template.
- CI real (Postgres) valida a migração.

## Entrega — 2 PRs sequenciais

- **PR 1 — Fundação + Contas a Pagar**: modelo, migração, skill, flow,
  scheduler, tela (só "a pagar" no form). Utilizável e testável ponta a ponta.
- **PR 2 — Contas a Receber**: adiciona o tipo "a receber" (cliente) ao mesmo
  cadastro e à geração.

Cada PR: TDD → CI verde → merge → publicar via `deploy/publicar.sh`.
