# 9. Principais APIs e eventos

Especificação completa: `docs/openapi.yaml` (OpenAPI 3.1). Autenticação por cookie de sessão
assinado (`financeira_session`); respostas padronizadas `{ data }` / `{ error: { code, message } }`.

## Rotas principais (`/api/v1`)

| Método/Rota | Descrição |
|---|---|
| `POST /auth/login` · `POST /auth/logout` | Sessão (e-mail + senha; scrypt + cookie HMAC) |
| `GET /me` | Usuário, empresa e papel atuais |
| `GET /companies` · `GET /companies/current` | Empresas do usuário (multiempresa) |
| `GET|POST /suppliers`, `/customers`, `/categories`, `/cost-centers`, `/bank-accounts` | Cadastros (POST exige `master_data.manage` / `bank_account.manage`) |
| `GET /users` | Usuários da empresa (sem hash de senha) |
| `GET /payables[/:id]` · `GET /receivables[/:id]` | Títulos com liquidações |
| `POST /receivables/:id/charge` | Gera código de cobrança Pix/boleto do saldo em aberto via porta `ChargeProvider` (mock: código fake, nada em PSP/banco) |
| `GET /bank-transactions` | Extrato importado (filtros conta/conciliada) |
| `GET /flows` | Fluxos disponíveis do orquestrador (passos e permissões) |
| `POST /flows/:flow/execute` | **Porta de entrada do orquestrador** — `{ payload, idempotencyKey? }` → `OrchestratorResponse` |
| `GET /approvals` · `POST /approvals/:id/decide` | Central de aprovações; decidir retoma o fluxo suspenso |
| `GET /alerts` · `POST /alerts/:id/ack` | Central de pendências |
| `GET /audit` | Trilha de auditoria (filtros por entidade) |
| `GET /skills` | Catálogo público das skills registradas (contrato) |
| `GET /events` | Outbox de eventos de domínio |
| `GET /reports/:report?format=json\|csv\|pdf&period=` | `daily_summary` · `monthly_close` · `executive_overview` com exportação |
| `POST /import/statement` | Atalho para o fluxo `bank_statement_import` (OFX/CSV como texto) |
| `POST /accounting/export` | Gera e baixa o lote contábil no layout escolhido (`padrao`/`dominio`/`omie`/`contmatic` — layouts de referência; requer `accounting.export`) |

### Exemplo — executar fluxo com idempotência

```http
POST /api/v1/flows/supplier_invoice_intake/execute
Content-Type: application/json
Cookie: financeira_session=...

{
  "idempotencyKey": "nf-8841-fornecedor-torra",
  "payload": {
    "supplierId": "sup_torrefacao",
    "description": "NF 8841 — café verde lote 42",
    "issueDate": "2026-08-10",
    "dueDate": "2026-09-10",
    "amountCents": 1250000,
    "categoryId": "cat_insumos",
    "installmentCount": 2,
    "document": { "type": "nfe", "number": "8841", "issuedAt": "2026-08-10", "totalCents": 1250000 }
  }
}
```

Resposta: `OrchestratorResponse` com `results` por passo (envelopes das skills), `consolidated`
(resumo, alertas, pendências, suposições, fontes) e `status`. Reenviar a mesma requisição
retorna `idempotent_replay: true` sem criar nada.

## Catálogo de eventos de domínio

Persistidos como outbox (`EventRecord`) e despachados in-process; `correlationId` amarra o fluxo.

| Grupo | Eventos |
|---|---|
| Contas a pagar | `payable.created` · `payable.updated` · `payable.canceled` · `payment.scheduled` · `payment.approved` · `payment.rejected` · `payment.executed` |
| Contas a receber | `receivable.created` · `receivable.updated` · `receivable.received` · `receivable.overdue_detected` |
| Faturamento | `invoice.created` · `invoice.issued` · `invoice.canceled` |
| Conciliação | `statement.imported` · `reconciliation.auto_matched` · `reconciliation.suggested` · `reconciliation.confirmed` · `reconciliation.rejected` · `reconciliation.audited` |
| Cobrança | `collection.message_drafted` · `collection.message_sent` |
| Tesouraria | `cashflow.updated` · `cashflow.shortfall_detected` |
| Orçamento | `budget.deviation_detected` |
| Contábil | `accounting.entry_prepared` · `accounting.batch_exported` |
| Controles | `controls.anomaly_detected` |
| Governança | `alert.raised` · `approval.requested` · `approval.decided` · `flow.completed` · `report.generated` |

Evolução planejada: o mesmo contrato `EventBus` sobre Redis/BullMQ (workers assíncronos,
retries, DLQ), mantendo o outbox como garantia de entrega.
