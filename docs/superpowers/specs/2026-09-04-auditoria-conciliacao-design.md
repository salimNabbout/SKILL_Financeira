# Auditoria de Conciliação (extrato × baixas) — Design

**Status:** proposta, aguardando aprovação
**Skill:** `conciliacao_bancaria` — ação nova `reconciliation_audit`

## Problema

A conciliação só olha numa direção: extrato → títulos. Quatro perguntas ficam sem resposta:

1. Que lançamentos do extrato do período continuam sem explicação?
2. Que **baixas do app não têm lastro no extrato** — `Payment` executado, `Receipt` registrado ou `Payable` pago sem transação bancária casada? É o caso "alguém marcou como pago, mas o dinheiro não saiu".
3. O saldo do app fecha com o saldo que o banco informa no OFX (`<LEDGERBAL>`)? O parser hoje descarta esse campo.
4. Há conciliações confirmadas com valor divergente do título, além da tolerância?

## Três decisões que preciso da sua aprovação

O restante da spec é execução direta. Estes três pontos mudam o desenho e vêm de premissas do pedido que não batem com o código.

### D1 — O que "saldo calculado" significa no `balanceChecks` (o mais importante)

`computeBankPeriodBalance` calcula: `saldo inicial + pagamentos executados + recebimentos + transações conciliadas que não foram casadas com nenhum deles`. **Transações não conciliadas ficam de fora por construção.**

O `<LEDGERBAL>` do banco é outra coisa: `saldo inicial + TODAS as transações`, conciliadas ou não.

Comparar os dois diretamente, como o pedido descreve, produz uma diferença que é **quase toda explicável**. Na sua produção hoje: 24 transações importadas, **zero conciliadas**, 6 pagamentos executados. A diferença seria a soma das 24 transações mais os R$ 13.317,25 dos pagamentos — e dispararia alerta **crítico** (a regra proposta é crítico acima de 100× a tolerância, ou seja R$ 100). Alerta crítico permanente é alerta ignorado.

**Recomendo:** manter a comparação contra `bank-balance.ts` (é o número que a tela mostra, e é ele que precisa fechar), mas **decompor a diferença** e alertar só sobre o resíduo:

```
diff            = saldoApp − ledgerBanco
explicadoPor    = − Σ(transações não conciliadas até a data)
                  + Σ(baixas sem lastro no período)
residuoCents    = diff − explicadoPor
```

`residuoCents ≠ 0` é o que não tem explicação e merece alerta. `diff` continua no relatório, com a decomposição ao lado. Sem isso, o bloco 4 vira um espelho ruidoso dos blocos 1 e 2.

**Alternativa,** se você preferir simplicidade: comparar o `LEDGERBAL` apenas contra `saldo inicial + Σ todas as transações do extrato`. Responde "minha importação está completa?", não responde "o app fecha com o banco". Não usa `bank-balance.ts`.

### D2 — `reports.ts` só sabe rodar a skill de relatórios

`src/app/api/_lib/reports.ts:120` chama `runSkill` com a skill `relatorios_gerenciais`, e o `report` é validado contra um enum dentro dela. Acrescentar `"reconciliation_audit"` a `REPORT_NAMES` sem mais nada faz a requisição morrer na validação da skill errada.

**Recomendo:** um mapa de despacho em `reports.ts` — `report → { skill, action }` — com `reconciliation_audit` apontando para `conciliacao_bancaria`. Os três relatórios atuais seguem apontando para `relatorios_gerenciais`. É a mudança menor e não duplica lógica.

### D3 — Nenhuma skill chama outra neste repo

O pedido diz que o `daily_summary` deve incluir o bloco de conciliação "chamando a skill via orquestrador/contexto como os outros blocos fazem". Os outros blocos **não** fazem isso: `grep` por `runSkill` dentro de `src/skills/*/index.ts` não devolve nada — cada skill lê repositórios direto, e a composição entre skills é papel do fluxo.

**Recomendo:** compor no fluxo. `FlowStepContext.results` já entrega o resultado dos passos anteriores por id, então o passo `report` monta a entrada com `f.results.reconciliation_audit?.data.totals`. Isso exige um campo opcional novo na entrada de `daily_summary` (`reconciliationTotals?`), que é uma mudança de contrato pequena e explícita — em vez de a skill de relatórios reimplementar a auditoria.

---

## Fase 1 — Saldo do banco na importação

- `ParsedStatement` ganha `ledgerBalance?: { amountCents: number; date: ISODate }`.
- `ofx.ts` extrai `<LEDGERBAL><BALAMT>`/`<DTASOF>` com o mesmo `tagValue` tolerante a SGML, via `parseDecimalToCents` e `parseOfxDate`. Ausente → campo ausente, sem warning. CSV e CNAB240 não têm saldo.
- Tabela **`StatementImport`** (migração `0019_statement_import`): `id` (= o `importBatchId` já gravado em `BankTransaction`), `companyId`, `bankAccountId`, `format`, `source` (`ofx|csv|cnab240|sync`), `imported`, `duplicates`, `warnings`, `ledgerBalanceCents BigInt?`, `ledgerBalanceDate Date?`, `createdBy`, `createdAt`. Índice `(companyId, bankAccountId, createdAt)`.
- Entidade em `entities.ts`; `StatementImportRepo` com `listByAccount` e `latestWithBalanceBefore`, nos **dois** adaptadores.
- `importStatement` e `syncBank` passam a gravar o lote. A auditoria `statement.imported` não muda.

**Testes:** OFX com e sem `LEDGERBAL` (vírgula e ponto decimal); importação grava o saldo; reimportar não duplica transações mas grava novo lote.

## Fase 2 — Ação `reconciliation_audit`

Entrada na `discriminatedUnion` existente; permissão `report.view`; saída conforme o contrato do pedido, mais os campos de decomposição da D1.

| Bloco | Regra |
|---|---|
| `unexplainedBankTransactions` | `reconciled=false` no período/conta. `hasSuggestion` via `listByBankTransaction` com status `suggested`. |
| `settlementsWithoutBank` | `Payment` executado sem match `payment` confirmado; `Receipt` ativo com `bankAccountId` sem match `receipt` confirmado; `Payable` pago sem `Payment` executado e sem match `payable`. Recebimento sem conta bancária vira `assumption`, não divergência. |
| `amountMismatches` | Matches confirmados com `|aplicado − esperado| > reconciliationAmountToleranceCents`. Ignora `bank_fee` e `transfer`. Para títulos o esperado é o **saldo atual**, não o histórico — dito na `formula`. |
| `balanceChecks` | Último `StatementImport` com saldo até `period.end`; saldo do app por `bank-balance.ts`; decomposição da D1. Sem importação com saldo → conta fora da lista e uma `assumption`. |

`PayableRepo` ganha `listPaidBetween(companyId, start, end)` nos dois adaptadores — o repositório não tem consulta adequada hoje e o projeto está migrando para consultas indexadas, não `listAll` filtrado em memória.

**Alertas** (só via `persistAlert`; o dedupe por `code + entityId` garante que reexecutar não infla o painel):

- `reconciliation_settlement_without_bank` — `warning`, `entityType` `payment|receipt|payable`.
- `reconciliation_balance_mismatch` — disparado pelo **resíduo** (D1), `critical` acima de 100× a tolerância, senão `warning`; `entityType="bank_account"`.

Sem alerta para extrato sem explicação nem para divergência de valor: esses já têm `pendingItems` e sugestões. Evento novo `reconciliation.audited` com os `totals`, em `publishes`.

**Testes:** cenário limpo zerado; pagamento sem match aparece e alerta uma vez em três execuções; recibo sem conta vira assumption; valor fora da tolerância; saldo divergente com resíduo e sem resíduo (severidades diferentes); filtro por conta; período `YYYY-MM` e `{start,end}`.

## Fase 3 — Automação e relatório

- `bank_sync`: passo `audit` depois de `match`, `continueOnError`.
- `daily_summary`: passo `reconciliation_audit` antes do `report`, `continueOnError`; o passo `report` repassa os totais (D3). Nenhuma agenda nova em `DEFAULT_SCHEDULES` — a auditoria pega carona, e a chave de idempotência por balde de tempo continua cobrindo.
- `reports.ts`: mapa de despacho (D2), `reconciliation_audit` exigindo `period`, exportação csv/xlsx (uma linha por divergência, coluna `tipo`) e pdf pelo gerador existente. `docs/openapi.yaml` atualizado.

## Fase 4 — Tela

Seção "Divergências do período" na Conciliação, abaixo das sugestões, com `month-nav` e filtro de conta: 4 cartões de total, 4 tabelas, "Localizar no extrato" pré-filtrando por valor ± tolerância e data ± `reconciliationDateToleranceDays`, botão Exportar, e estado vazio nomeando o mês e a data do último saldo conferido. Server actions no padrão `confirm_match`. E2E mínimo: a seção renderiza e o estado vazio aparece.

## Fase 5 — Documentação

`04-catalogo-skills`, `05-contratos-skills`, `07-modelo-de-dados`, `08-apis-e-eventos`, `11-roadmap`, `CHANGELOG.md` e o lembrete de `npm run db:migrate` em `DEPLOY.md`.

## Invariantes

A skill não movimenta dinheiro nem altera títulos: auditoria é leitura e alerta, sem correção automática. Centavos inteiros e `ISODate`. Tolerâncias sempre de `CompanyConfig`. Toda saída por `makeResult` com `formula` em texto. Alertas só por `persistAlert`.

## Fora de escopo

Provedor Open Finance real; correção automática de baixa; sugestão de pares por LLM; unificar as três somas de saldo duplicadas (dívida já registrada no cabeçalho de `bank-balance.ts`).

## Entrega

Uma fase por PR, `npm run typecheck && npm test` verdes em cada uma. Parada para revisão ao fim da Fase 1.
