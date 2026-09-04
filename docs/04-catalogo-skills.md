# 5. Catálogo detalhado das skills

Todas as skills implementam o contrato `SkillDefinition` (`src/core/skill.ts`): nome,
responsabilidade delimitada, objetivo, schema de entrada (Zod, discriminado por `action`),
eventos consumidos/publicados, fontes de dados e `execute` devolvendo o envelope padrão.
Nenhuma skill chama outra skill — o orquestrador coordena.

Convenções comuns: dinheiro em centavos; datas `YYYY-MM-DD` no fuso da empresa; escritas
idempotentes por chave natural; ações sensíveis exigem aprovação humana via orquestrador;
alertas relevantes são persistidos na central de pendências; mutações são auditadas.

---

## 1. `contas_a_pagar` — Contas a Pagar
**Pasta:** `src/skills/contas-a-pagar` · **Fontes:** payables, suppliers, documents, payments, bank_accounts

Cadastro e classificação de obrigações; vencimentos, parcelas, juros e multas; agendamento de
pagamento com aprovação por alçada; alertas de vencimento; previsão de desembolsos; detecção de
duplicidade. **Nunca efetua pagamento sem aprovação humana explícita** — e a "execução" é mock.

| Ação | O que faz |
|---|---|
| `create_payable` | Cria título (com parcelas via `splitInstallments`), idempotente por `originKey` (fornecedor+documento+parcela); deduplica documento por hash de conteúdo; sugere categoria via IA (mock) quando ausente |
| `schedule_payment` | Sem aprovação: cria `Payment pending_approval` e devolve `awaiting_approval`; aprovado: executa (mock), baixa o título, publica `payment.executed`; rejeitado: cancela |
| `list_due` | Títulos a vencer/vencidos com multa e juros calculados (`computeLateFee`, fórmula exposta); gera alertas `payable_due_soon`/`payable_overdue` |
| `forecast_disbursements` | Previsão de desembolsos por semana no horizonte |
| `detect_duplicates` | Pares suspeitos (mesmo fornecedor+valor+vencimento ou mesmo documento) |
| `cancel_payable` | Cancela título sem pagamento executado (permissão `payable.cancel`) |

**Publica:** `payable.created/updated/canceled`, `payment.scheduled/executed`.

## 2. `contas_a_receber` — Contas a Receber
**Pasta:** `src/skills/contas-a-receber` · **Fontes:** receivables, customers, invoices, receipts

Clientes, títulos e parcelas; vencimentos e recebimentos; atrasos; projeção de entradas; baixa
manual (usuário) e automática (conciliação, `registeredBy: "system"`); método conceitual
Pix/boleto/cartão (sem integração real).

| Ação | O que faz |
|---|---|
| `create_receivable` | Título manual, parcelado, idempotente por `originKey` |
| `create_from_invoice` | Títulos a partir de fatura emitida; valida soma das parcelas = total; idempotente (`inv:<id>:<n>`) |
| `list_overdue` | Vencidos com dias de atraso e encargos; alertas `receivable_overdue`; evento `receivable.overdue_detected` |
| `register_receipt` | Baixa manual parcial/total com `Receipt` |
| `projection` | Entradas previstas por semana |

**Publica:** `receivable.created/received/overdue_detected`.

## 3. `faturamento` — Faturamento
**Pasta:** `src/skills/faturamento` · **Fontes:** invoices, customers, receivables, receipts

Geração e acompanhamento de cobranças; ciclo venda → faturamento → recebimento; NF-e/NFS-e
**mock declarado** (número + chave de acesso fictícia); vendas ainda não faturadas.

| Ação | O que faz |
|---|---|
| `create_invoice` | Cria fatura (idempotente por `saleRef`); com `issue: true` emite com NF-e mock |
| `issue_invoice` | Emite uma fatura em rascunho |
| `cancel_invoice` | Cancela fatura sem recebimentos (cancela títulos abertos ligados) |
| `billing_status` | Ciclo completo: rascunhos (vendas não faturadas), emitidas sem título (inconsistência) e % recebido por fatura |

**Publica:** `invoice.created/issued/canceled`.

## 4. `tesouraria_fluxo_caixa` — Tesouraria e Fluxo de Caixa
**Pasta:** `src/skills/tesouraria` · **Fontes:** bank_accounts, bank_transactions, payments, payables, receivables

Consolida entradas/saídas; saldo **disponível** (extrato), **comprometido** (pagamentos
aprovados/pendentes) e **projetado**; fluxo diário/semanal/mensal; cenários; alertas de
insuficiência. **Recomenda ações; nunca movimenta dinheiro.**

| Ação | O que faz |
|---|---|
| `cash_position` | Posição por conta + totais (disponível/comprometido/projetado 30d), fórmulas expostas |
| `refresh_projection` | Série diária de entradas/saídas/saldo no horizonte; menor saldo e data; alertas `cash_shortfall_projected` (crítico) / `cash_below_minimum`; recomendações textuais |
| `cashflow_statement` | Realizado (extrato) + projetado por dia/semana/mês |
| `scenarios` | Otimista/base/pessimista com parâmetros explícitos (% realização e atraso das entradas) |
| `forecast_cash` | Previsão estatística semanal (mediana + tendência Theil–Sen + sazonalidade com ≥ 52 semanas) com banda de incerteza; comprometido é piso — estimativa, não fato |

**Publica:** `cashflow.updated`, `cashflow.shortfall_detected`.

## 5. `conciliacao_bancaria` — Conciliação Bancária
**Pasta:** `src/skills/conciliacao` (+ `src/lib/importers`) · **Fontes:** bank_transactions, payables, receivables, payments, receipts

Importa OFX/CSV reais (API bancária/Open Finance são mocks; CNAB tem stub honesto); compara
extrato com AP/AR; concilia automaticamente com **grau de confiança**; divergências vão para
revisão humana; histórico completo de correspondências.

| Ação | O que faz |
|---|---|
| `import_statement` | Parse OFX/CSV, deduplicação por FITID/hash (reimportar não duplica), lote auditado |
| `auto_match` | Pontua candidatos (valor, data, similaridade de nome); ≥ limiar → conciliação automática com baixa; abaixo → sugestão para revisão |
| `confirm_match` / `reject_match` | Decisão humana sobre sugestões |
| `reconciliation_status` | Visão geral: não conciliadas, sugestões pendentes, conciliadas no mês |
| `reconciliation_audit` | Auditoria do período: extrato sem explicação, **baixas sem lastro no extrato**, conciliações com valor divergente e saldo do app × saldo do banco. 100% leitura — não corrige nada |

A auditoria olha na direção contrária das demais ações: elas vão do extrato para
os títulos; ela pergunta o que foi baixado no app **sem** contrapartida bancária.
Baixa recente demais para o extrato importado não é divergência: entra em
`pendingCoverageCount` e aguarda a importação.

**Publica:** `statement.imported`, `reconciliation.auto_matched/suggested/confirmed/rejected`,
`reconciliation.audited`.

## 6. `cobranca_inadimplencia` — Cobrança e Inadimplência
**Pasta:** `src/skills/cobranca` · **Fontes:** receivables, customers, receipts, collection_messages

Segmenta clientes por atraso e risco; régua de cobrança configurável; mensagens respeitosas;
sugestões de renegociação; indicadores. **Aprovação humana obrigatória antes de qualquer envio
(envio é mock) ou alteração de condição.**

| Ação | O que faz |
|---|---|
| `segment_customers` | Buckets de atraso (1-7/8-30/31-60/60+) × risco (baixo/médio/alto) |
| `run_dunning` | Rascunha mensagens pela régua (templates com placeholders) → `awaiting_approval`; aprovado → marca enviadas (mock); rejeitado → cancela |
| `suggest_renegotiation` | Opções determinísticas (à vista com desconto de juros, 2x, 3x) com valores exatos — apenas recomendação |
| `delinquency_indicators` | % inadimplência, aging, ticket médio, DSO aproximado — com fórmulas |

**Publica:** `collection.message_drafted/message_sent`.

## 7. `orcamento_planejamento` — Orçamento e Planejamento Financeiro
**Pasta:** `src/skills/orcamento` · **Fontes:** budgets, budget_lines, payables, payments, receivables, receipts, categories, cost_centers

Orçamento por categoria/centro de custo/período; realizado vs. orçado; variações absolutas e
percentuais; forecast; detecção de desvios relevantes (limiar configurável).

| Ação | O que faz |
|---|---|
| `upsert_budget` | Cria/atualiza orçamento do ano (idempotente por nome+ano) |
| `variance_report` | Orçado × realizado do mês, variações, alertas `budget_deviation`, itens não orçados |
| `check_impact` | Impacto de novos títulos no orçamento da categoria/mês (comprometido vs. restante) |
| `forecast` | Projeção por média móvel de 3 meses (premissas explícitas) |

**Publica:** `budget.deviation_detected`.

## 8. `controladoria_indicadores` — Controladoria e Indicadores
**Pasta:** `src/skills/controladoria` · **Fontes:** payables, receivables, categories, receipts, payments

DRE gerencial por competência; margens, EBITDA gerencial, ponto de equilíbrio, capital de giro,
ciclo financeiro (PMR − PMP); custos fixos × variáveis; **explicações em linguagem simples**
(dicionário determinístico — sem LLM).

| Ação | O que faz |
|---|---|
| `dre` | DRE gerencial completa do mês com breakdown por categoria |
| `indicators` | Indicadores com valor, fórmula, período, fontes e explicação |
| `cost_structure` | Fixos vs. variáveis por categoria |
| `explain_indicator` | Explicação didática de cada indicador |

## 9. `integracao_contabil_fiscal` — Integração Contábil e Fiscal
**Pasta:** `src/skills/contabil` · **Fontes:** payments, receipts, payables, receivables, categories, chart_accounts

Classifica lançamentos (partida dobrada) para exportação; plano de contas e centros de custo;
identifica inconsistências cadastrais. **Não substitui contador** (declarado em toda resposta);
regras tributárias são **dados configuráveis** (`taxRules`), nunca código.

| Ação | O que faz |
|---|---|
| `prepare_entries` | Lançamentos de pagamentos/recebimentos (idempotente por origem), mapeamento categoria→conta documentado |
| `export_batch` | Lote CSV para a contabilidade; marca exportado |
| `check_master_data` | Inconsistências: títulos sem categoria, cadastros sem documento, contas inexistentes |
| `tax_summary` | Resumo informativo por regime configurado — sem cálculo de imposto |

**Publica:** `accounting.entry_prepared`, `accounting.batch_exported`.

## 10. `controles_internos_auditoria` — Controles Internos, Riscos e Auditoria
**Pasta:** `src/skills/controles-internos` · **Fontes:** payables, payments, approvals, bank_transactions, audit_records, alerts, memberships

Segregação de funções; duplicidades e transações suspeitas; verificação da trilha imutável;
limites de aprovação; relatórios de exceção.

| Ação | O que faz |
|---|---|
| `validate_payables` | Duplicidade, papel exigido para pagar (alçada), cadastro do fornecedor |
| `post_payment_check` | Pós-pagamento: aprovação existe, aprovador ≠ solicitante, limite e papel respeitados |
| `scan_anomalies` | Transações duplicadas, valores fora do padrão (>3× média), pagamentos sem aprovação (crítico), pagamento acima do título |
| `verify_audit_chain` | Integridade da cadeia de hash da auditoria |
| `exception_report` | Consolidado de exceções (alertas, aprovações paradas, sugestões pendentes) |

**Publica:** `controls.anomaly_detected`.

## 11. `relatorios_gerenciais` — Relatórios Gerenciais
**Pasta:** `src/skills/relatorios` · **Fontes:** todas as tabelas de leitura

Consolida as demais disciplinas em resumo diário, fechamento mensal e visão executiva —
separando **fatos**, **cálculos** (com fórmula), **previsões** (com premissas) e
**recomendações**. Produz dados prontos para exportação CSV/PDF (`src/lib/exporters`).

| Ação | O que faz |
|---|---|
| `daily_summary` | Posição do dia: saldo, vencimentos, vencidos, alertas, aprovações, projeção 7d, riscos |
| `monthly_close` | Fechamento: entradas/saídas, fluxo líquido, DRE simplificada (caixa), destaques |
| `executive_overview` | KPIs, tendência (alta/estável/queda), riscos e oportunidades |
| `export_data` | Dados achatados (métrica/valor/unidade/fonte) para CSV/PDF |

**Publica:** `report.generated`.
