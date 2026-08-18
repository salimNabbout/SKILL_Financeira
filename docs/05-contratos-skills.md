# 6. Contratos de entrada e saída das skills

## Envelope padrão (todas as skills)

Toda execução devolve exatamente este envelope (`src/core/types.ts`), validado nos testes:

```json
{
  "skill": "nome_da_skill",
  "status": "success | warning | error | awaiting_approval",
  "confidence": 1.0,
  "data": {},
  "alerts": [{ "severity": "info|warning|critical", "code": "...", "message": "...", "entityType": "...", "entityId": "..." }],
  "pending_items": [{ "code": "...", "description": "...", "suggestedAction": "..." }],
  "assumptions": ["suposições explícitas em pt-BR"],
  "requires_human_approval": false,
  "audit": {
    "execution_id": "exec_...",
    "timestamp": "2026-08-18T15:00:00.000Z",
    "data_sources": ["payables", "suppliers"]
  }
}
```

Regras transversais:

- **Entrada**: união discriminada por `action` validada com Zod; entrada inválida ⇒ envelope
  `error` com código `invalid_input` (o processo nunca lança para o chamador).
- **`confidence`**: 1.0 para cálculo determinístico; < 1.0 para heurísticas (classificação IA,
  cenários, forecast) — o valor e o porquê ficam em `assumptions`.
- **Aprovação humana**: ação sensível sem decisão ⇒ `status: "awaiting_approval"`,
  `requires_human_approval: true` e `data.approvalRequest = { targetType, targetId, summary,
  amountCents }`. A retomada chega via `ctx.approval` (decisão verificada no repositório).
- **Idempotência**: repetir a mesma escrita devolve o registro existente com `assumption`
  explicando (nunca duplica).
- **Erros**: `DomainError` tipado ⇒ envelope `error` com o código do erro; inesperado ⇒
  `unexpected_error` sem vazar stack.
- **Execução registrada**: cada chamada gera `SkillExecution` (hash da entrada, status,
  confiança, resultado, tempos) — consultável na auditoria.

## Contratos por skill (entradas → data de saída)

Notação: campos `?` são opcionais; valores monetários em **centavos**; datas `YYYY-MM-DD`.

### contas_a_pagar
| Ação | Entrada | Saída (`data`) |
|---|---|---|
| `create_payable` | `supplierId, description, issueDate, dueDate, amountCents, categoryId?, costCenterId?, installmentCount?, notes?, document?{type, number, series?, issuedAt, totalCents}` | `{ payables: Payable[], document? }` |
| `schedule_payment` | `payableId, bankAccountId, scheduledDate, method: pix\|ted\|boleto\|debit, amountCents?` | `{ payment, approvalRequest? }` |
| `list_due` | `withinDays?=7` | `{ due: [{...payable, daysLate, fineCents, interestCents, totalDueCents, formula}], totalDueCents }` |
| `forecast_disbursements` | `horizonDays?=30` | `{ horizonDays, weekly: [{weekStart, weekEnd, totalCents, count}], totalCents, formula }` |
| `detect_duplicates` | — | `{ suspects: [{payableIds, reason}] }` |
| `cancel_payable` | `payableId, reason` | `{ payable }` |

### contas_a_receber
| Ação | Entrada | Saída |
|---|---|---|
| `create_receivable` | `customerId, description, issueDate, dueDate, amountCents, categoryId?, costCenterId?, installmentCount?, method?, notes?` | `{ receivables: Receivable[] }` |
| `create_from_invoice` | `invoiceId, installments?: [{dueDate, amountCents}], method?` | `{ receivables }` |
| `list_overdue` | — | `{ overdue: [{receivable, daysLate, remainingCents, lateFee}], totalOverdueCents, count }` |
| `register_receipt` | `receivableId, amountCents, receivedDate, method, bankAccountId?` | `{ receipt, receivable }` |
| `projection` | `horizonDays?=30` | `{ horizonDays, weekly, totalCents, formula }` |

### faturamento
| Ação | Entrada | Saída |
|---|---|---|
| `create_invoice` | `customerId, description, totalCents, saleRef?, issue?` | `{ invoice }` (com `nfeMock` quando emitida) |
| `issue_invoice` | `invoiceId` | `{ invoice }` |
| `cancel_invoice` | `invoiceId, reason` | `{ invoice }` |
| `billing_status` | — | `{ drafts, issuedUnbilled, cycle: [{invoiceId, totalCents, receivedCents, receivablesCount, status}] }` |

### tesouraria_fluxo_caixa
| Ação | Entrada | Saída |
|---|---|---|
| `cash_position` | — | `{ accounts: [{id, name, availableCents}], totals: {availableCents, committedCents, projected30Cents}, formulas }` |
| `refresh_projection` | `horizonDays?=90` | `{ summary: {horizonStart, horizonEnd, openingBalanceCents, totalInCents, totalOutCents, endingBalanceCents, minBalanceCents, minBalanceDate}, daily: [{date, inCents, outCents, balanceCents}], recommendations }` |
| `cashflow_statement` | `granularity: daily\|weekly\|monthly, periods?` | `{ granularity, buckets: [{label, start, end, realizedInCents, realizedOutCents, projectedInCents, projectedOutCents, netCents, cumulativeBalanceCents}], formula }` |
| `scenarios` | `horizonDays?=90` | `{ scenarios: [{name, endingBalanceCents, minBalanceCents, minBalanceDate, params}], horizonDays }` |

### conciliacao_bancaria
| Ação | Entrada | Saída |
|---|---|---|
| `import_statement` | `bankAccountId, format: ofx\|csv, content` | `{ imported, duplicates, warnings, transactions }` |
| `auto_match` | `bankAccountId?` | `{ autoConfirmed, suggested, unmatched, matches: ReconciliationMatch[] }` |
| `confirm_match` | `matchId` | `{ match, settlement }` |
| `reject_match` | `matchId, notes?` | `{ match }` |
| `reconciliation_status` | — | `{ unreconciled, suggestedPending, confirmedThisMonth, ... }` |

### cobranca_inadimplencia
| Ação | Entrada | Saída |
|---|---|---|
| `segment_customers` | — | `{ segments: [{customerId, customerName, bucket, risk, overdueCount, overdueCents, maxDaysLate}] }` |
| `run_dunning` | — | `{ messages: CollectionMessage[], approvalRequest?, sent }` |
| `suggest_renegotiation` | `receivableId` | `{ options: [{label, installments, totalCents, ...}], charges }` |
| `delinquency_indicators` | — | `{ indicators: {delinquencyPercent, aging, avgOverdueTicketCents, dso, ...} }` (cada um com fórmula/período/fonte) |

### orcamento_planejamento
| Ação | Entrada | Saída |
|---|---|---|
| `upsert_budget` | `name, year, lines: [{period, categoryId?, costCenterId?, amountCents}]` | `{ budget, lines }` |
| `variance_report` | `period` | `{ period, lines: [{categoryId?, categoryName?, budgetedCents, actualCents, varianceCents, variancePercent}], totals, formula }` |
| `check_impact` | `payableIds: string[]` | `{ impacts: [{payableId, period, categoryId?, budgetedCents, committedCents, remainingCents, exceeded}] }` |
| `forecast` | `months?=3` | `{ months, byCategory: [{categoryId, categoryName, monthlyAvgCents, projected}], formula }` |

### controladoria_indicadores
| Ação | Entrada | Saída |
|---|---|---|
| `dre` | `period` | `{ period, dre: {receitaBrutaCents, deducoesCents, receitaLiquidaCents, custosCents, lucroBrutoCents, despesasOperacionaisCents, ebitdaCents, resultadoFinanceiroCents, resultadoCents, outrasCents}, breakdown, formula, regime: "competencia" }` |
| `indicators` | `period` | `{ indicators: [{key, label, value*, formula, period, sources, explanation}] }` |
| `cost_structure` | `period` | `{ fixed, variable, totals }` |
| `explain_indicator` | `indicator` | `{ indicator, explanation, example }` |

### integracao_contabil_fiscal
| Ação | Entrada | Saída |
|---|---|---|
| `prepare_entries` | `period?` ou `sourceType + sourceId` | `{ entries: AccountingEntry[], skipped }` |
| `export_batch` | `period, format: csv` | `{ batchId, csv, count }` |
| `check_master_data` | — | `{ issues: [...], count }` |
| `tax_summary` | `period` | `{ regime, taxableRevenueCents, notes }` (informativo; sem cálculo de imposto) |

### controles_internos_auditoria
| Ação | Entrada | Saída |
|---|---|---|
| `validate_payables` | `payableIds` | `{ checks: [{payableId, duplicates, requiredRoleForPayment, issues}] }` |
| `post_payment_check` | `paymentId` | `{ paymentId, checks: [{rule, passed, detail}] }` |
| `scan_anomalies` | — | `{ anomalies: [{type, severity, entityType, entityId, detail}] }` |
| `verify_audit_chain` | — | `{ valid, brokenAtSeq?, totalRecords }` |
| `exception_report` | — | `{ sections: [...] }` |

### relatorios_gerenciais
| Ação | Entrada | Saída |
|---|---|---|
| `daily_summary` | — | `{ date, facts, calculations, risks, recommendations, sources }` |
| `monthly_close` | `period` | `{ period, facts, calculations (inclui DRE simplificada por caixa), highlights, risks, recommendations }` |
| `executive_overview` | — | `{ asOf, kpis, trend, risks, opportunities, recommendations }` |
| `export_data` | `report, period?` | `{ report, title, subtitle, rows: [{metrica, valor, unidade, fonte}] }` |

## Eventos consumidos e publicados

| Skill | Consome (declarado) | Publica |
|---|---|---|
| contas_a_pagar | — | payable.created/updated/canceled, payment.scheduled/executed |
| contas_a_receber | — | receivable.created/received/overdue_detected |
| faturamento | — | invoice.created/issued/canceled |
| tesouraria | payable.created, payment.executed, receivable.created/received, statement.imported | cashflow.updated, cashflow.shortfall_detected |
| conciliacao | — | statement.imported, reconciliation.* |
| cobranca | receivable.overdue_detected | collection.message_drafted/message_sent |
| orcamento | — | budget.deviation_detected |
| controladoria | — | — |
| contabil | — | accounting.entry_prepared, accounting.batch_exported |
| controles_internos | — | controls.anomaly_detected |
| relatorios | — | report.generated |
| orquestrador | — | approval.requested/decided, flow.completed |

*(No MVP, as reações a eventos são materializadas pelos fluxos do orquestrador — o consumo
declarado documenta a dependência semântica e habilita a evolução para processamento assíncrono.)*
