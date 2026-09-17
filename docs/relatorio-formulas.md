# Relatório de auditoria de fórmulas — Financeira PME

Data da auditoria: 17/09/2026. Branch `feat/dashboard-painel-periodo`.
Base de dados real usada nas conferências: cópia do backup diário de produção de 17/09/2026 03:00 UTC (empresa CETEM Tecnologia), restaurada num container Postgres descartável na VPS e acessada por túnel SSH. O app foi executado localmente sobre essa cópia para ler o "valor na tela"; as consultas SQL independentes foram executadas na mesma cópia. O banco de produção só recebeu SELECTs.

Convenções: valores em centavos nas consultas, em R$ na coluna "tela"; "hoje" = 17/09/2026 (America/Sao_Paulo); mês fechado de referência = agosto/2026.

## 1. Resumo executivo

| Métrica | Quantidade |
|---|---|
| Linhas de fórmula/indicador auditadas (12 módulos; algumas linhas agrupam faixas, ex. COB-07..11) | 190 |
| OK (fórmula conferida no código e, quando há dado, valor da tela = recalculado por SQL) | 160 |
| Corrigidos nesta branch (bug claro, com teste e commit próprio) | 18 linhas em 7 commits de correção |
| Divergências (bug) registradas e NÃO corrigidas nas tabelas (dependem de decisão de regra ou de mudança de interface) | 9 |
| Divergências de tela/exportação listadas ao fim da seção 14 (fora do escopo de fórmula) | 9 |
| Decisões pendentes de regra de negócio (seção 14) | 17 |

Testes: 86 arquivos (11 novos), 921 casos verdes (72 novos), 3 pulados por dependerem de Redis (`npm test`). `npm run typecheck` limpo.

### 1.1 Correções feitas (commit → linhas do relatório)

| Commit | O que mudou | IDs |
|---|---|---|
| `fix(money)` | Juros pró-rata em aritmética inteira: `round(principal × pct × dias / 3000)`. Antes, `pct/100` em ponto flutuante arredondava meio centavo para baixo (R$ 66,60 × 1% × 25 dias = 55,5 c → 55). | COB-14, COB-16..19, CAP-12, CAR-11, CAR-12 |
| `fix(saldo-conciliado)` | Débito do extrato casado com título a pagar (`targetType = payable`) volta a contar como saída: a baixa por conciliação não cria `Payment`, então o dinheiro sumia do Saldo conciliado e do saldo calculado da auditoria. | CON-04, CON-06, CON-28..31 |
| `fix(orcamento)` (fuso) | Mês do realizado de despesas usa `executedAt` no fuso da empresa (era UTC). | ORC-02, ORC-07, ORC-11 |
| `fix(export)` | Rodapé da impressão e linha TOTAL do PDF de Contas a pagar/receber deixam títulos cancelados fora da soma e dizem quantos ficaram de fora. | CAP-09, CAR-07 |
| `fix(orcamento)` (dimensões) | `check_impact` soma o comprometido nas mesmas dimensões da linha orçada casada (categoria e/ou centro de custo). | ORC-09, ORC-10 |
| `fix(dre)` | Linhas subtrativas zeradas exibiam "-R$ 0,00" (−0). | DRE-02, DRE-04, DRE-06 |
| `fix(conciliacao)` | Contador "Conciliados (N)" mostrava o tamanho da lista já cortada em 30 (produção: 292). | CON-09 |
| `test(dashboard)`, `test(agenda)` | Cálculos feitos nas páginas extraídos para módulos puros (`_lib/dashboard-metrics.ts`, `agenda/_lib/agenda-month.ts`) sem mudar comportamento, para receberem testes. | DSH-03..06, AGD-01..10 |
| `test(auditoria)` | Casos de borda por módulo (seção 1.3). | vários |

### 1.2 Achados sobre os DADOS de produção (não são fórmulas, mas mudam a leitura dos números)

1. **As 34 transações bancárias que compõem o "Saldo disponível" são sintéticas** (`source = api_mock`, lotes `StatementImport.format = mock`, 1 por dia às 06:00 pelo agendador `bank_sync`). Abertura R$ 117.747,35 + R$ 36.716,17 de movimento mock = R$ 154.463,52 exibidos. Nenhuma transação real foi importada (OFX/CSV/Pluggy). Tudo que deriva do extrato (Fluxo de caixa realizado, tendência da visão executiva, Entradas/Saídas do mês, previsão estatística) está lendo dados fictícios.
2. **Nenhum título tem `categoryId`** (0 de 338 a pagar, 0 de 98 a receber; só 1 categoria cadastrada). A DRE por competência e os indicadores derivados (margens, ponto de equilíbrio, custos fixos/variáveis %) ficam inteiramente em "Outras" (agosto: R$ 459.763,41). Os títulos usam `supplierCategory` (texto, "Categoria de Fornecedores") e `costClassification`, que a DRE não lê. Ver decisão pendente D1.
3. **"Transferencia Entre Contas", "Antecipação De Dividendos", "Aporte", "Pro-labore" e "Empréstimo - Pronampe" são títulos a pagar** com essas categorias de fornecedor. Entram como pagamento em: fechamento mensal (DRE de caixa), PMP ("compras"), novos títulos, fluxo de caixa previsto, e entrarão no Total Pago do Painel por Período. Só em agosto: transferências R$ 47.000,00 e dividendos R$ 37.205,39 (= 37% dos R$ 230.280,24 pagos). Ver decisão D2.
4. **735 alertas abertos** (307 críticos, quase todos "segregação de funções: solicitante e aprovador são o mesmo usuário"). O dashboard mostra 5.
5. Em produção **todos os 292 pagamentos executados** têm `executedAt` ao meio-dia UTC e `scheduledDate` no mesmo mês do `executedAt`; 0 títulos foram baixados pela conciliação sem `Payment`; 0 títulos com pago/recebido acima do valor; 0 vencidos hoje. Vários caminhos de borda existem no código mas não têm ocorrência na base.

### 1.3 Testes novos por caso de borda

| Caso | Onde foi testado |
|---|---|
| Título cancelado | dashboard-metrics/auditoria-dashboard (tesouraria), import-export (pagar/receber), agenda-month, controladoria/auditoria-formulas, contas-a-pagar/auditoria-formulas, cobranca/auditoria-formulas, orcamento (existente) |
| Pagamento parcial | tesouraria/auditoria-dashboard, agenda-month, controladoria (valor cheio em competência), contas-a-pagar (encargos sobre o saldo), cobranca, faturamento (33,33%) |
| Título vencido | tesouraria/auditoria-dashboard (vencido entra em hoje), agenda-month (fica no vencimento), contas-a-pagar (list_due e forecast), cobranca (fronteiras 7/8/30/31/60/61) |
| Conta bancária inativa | tesouraria/auditoria-dashboard, relatorios/auditoria-dashboard, tesouraria/auditoria-fluxo |
| Virada de mês/ano | dashboard-metrics, tesouraria/auditoria-dashboard, relatorios/auditoria-dashboard (limites de mês), controladoria (31/12 vs 01/01), relatorios/auditoria-fechamento, contas-a-pagar (forecast), agenda-month (fev/bissexto) |
| Fuso (lançamento às 23h) | tesouraria/auditoria-dashboard (02h30 UTC = 23h30 em SP), orcamento (executedAt 01h30 UTC = 22h30 do dia anterior) |
| Arredondamento de centavos | money (55,5 c → 56), dashboard-metrics, tesouraria (333 + 667), relatorios (−10,05% → "queda" com −10 exibido), controladoria (33,33), cobranca (ticket 1,5 → 2), faturamento |
| Base vazia | dashboard-metrics, tesouraria (cash_position/projection/cashflow), relatorios (executive/monthly), agenda-month, contas-a-pagar, cobranca, dre-rows, import-export |

## 2. Dashboard (DSH)

Arquivos: `src/app/(app)/page.tsx`, `src/app/(app)/_lib/dashboard-metrics.ts`, `src/skills/tesouraria/index.ts`, `src/skills/relatorios/index.ts`.

| ID | Tela/Componente | Indicador | Fórmula | Origem dos dados | Filtros e regras | Arquivo:função | Teste (arquivo::caso) | Valor na tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| DSH-01 | Card "Saldo disponível" | Saldo disponível | Σ contas ativas (openingBalanceCents + Σ TODAS BankTransaction.amountCents da conta). SQL: `SUM(a.openingBalanceCents + COALESCE(t.sum,0)) FROM BankAccount a LEFT JOIN (SELECT bankAccountId, SUM(amountCents) FROM BankTransaction GROUP BY 1) t ... WHERE a.active` | BankAccount.openingBalanceCents, .active; BankTransaction.amountCents | Só contas ativas; toda transação importada (conciliada ou não, qualquer data); ignora Payment/Receipt e openingBalanceDate | tesouraria/index.ts:loadCashBase (275-292); FORMULA_AVAILABLE (254) | tesouraria.test.ts::"calcula disponível por conta, comprometido e projetado 30 dias com valores exatos"; auditoria-dashboard.test.ts::"conta inativa fica fora do disponível, da lista de contas e da projeção"; ::"valores ímpares somam exatos" | R$ 154.463,52 × 15446352 (1 conta) | OK (fórmula mantida por decisão do usuário; documentada) | Difere do "Saldo conciliado" (core/bank-balance.ts: pagamentos + recibos + extrato conciliado). Movimento inteiro é mock (achado 1.2.1). openingBalanceDate ignorada (S-08). |
| DSH-02 | Card "Comprometido" | Comprometido | Σ Payment.amountCents com status ∈ {pending_approval, approved} + Σ (amountCents − paidCents) dos Payable status = scheduled SEM payment pendente | Payment.amountCents/.status; Payable.amountCents/.paidCents/.status | Sem dupla contagem (payable com payment pendente conta só o payment); cancelados/rejeitados/executados fora | tesouraria/index.ts:committedCents (322-328) | tesouraria.test.ts::"calcula disponível…"; auditoria-dashboard.test.ts::"payable/receivable cancelados e payment cancelado/rejeitado não entram em nada" | R$ 0,00 × 0 (0 pagamentos pendentes, 0 agendados) | OK | |
| DSH-03 | Card "A pagar (7 dias)" | Saídas previstas até hoje+7 | Σ outCents dos pontos diários da projeção com date ≤ hoje+7. Cada ponto = Σ saldo restante dos payables abertos (open/scheduled/partially_paid) cuja data de referência (min scheduledDate de payment pendente, senão dueDate; se < hoje → hoje) cai no dia | Payable.*, Payment.scheduledDate/.status | Janela inclusiva hoje..hoje+7 (8 dias corridos); vencidos entram em hoje; parciais pelo saldo | _lib/dashboard-metrics.ts:sumFlowsThrough; tesouraria:buildOutflows (348-368), projectDaily (405-456) | dashboard-metrics.test.ts::"janela inclusiva nas duas pontas…"; ::"virada de mês e de ano…"; tesouraria/auditoria-dashboard.test.ts::"vencidos … entram em HOJE"; ::"títulos parcialmente liquidados entram pelo saldo restante" | R$ 0,00 × 0 (nenhum aberto vence até 24/09) | OK | Rodapé mostra "até 24/09/2026". Observação: a janela tem 8 dias corridos (hoje incluído), enquanto o gráfico usa semanas de 7. |
| DSH-04 | Card "A receber (7 dias)" | Entradas previstas até hoje+7 | Idem com inCents: saldo restante dos receivables open/partially_received por dueDate (vencidos em hoje) | Receivable.amountCents/.receivedCents/.dueDate/.status | idem | _lib/dashboard-metrics.ts:sumFlowsThrough; tesouraria:buildInflows (371-390) | idem | R$ 0,00 × 0 (AR aberto = 0) | OK | |
| DSH-05 | Gráfico "Entradas × saídas — próximas 4 semanas" | 4 barras duplas | Semana k (0..3) = Σ inCents / Σ outCents dos pontos com date ∈ [hoje+7k, hoje+7k+6] | idem DSH-03/04 | Cobre hoje..hoje+27; vencidos na semana 1 | _lib/dashboard-metrics.ts:buildWeekGroups; _lib/charts.tsx:InOutBarChart | dashboard-metrics.test.ts::"semanas de 7 dias contíguas…"; ::"vencidos: … caem na semana 1"; ::"virada de ano…"; render.test.ts::"InOutBarChart" | Sem 3 (01/10 a 07/10) saídas R$ 520,13 × 52013; demais 0 × 0 | OK | |
| DSH-06 | Tom do card Saldo disponível | crit/warn/ok | < 0 → crítico; < config.minimumCashCents → atenção; senão ok; sem valor → neutro | CompanyConfig.minimumCashCents (produção: R$ 10.000,00) | | _lib/dashboard-metrics.ts:availableTone | dashboard-metrics.test.ts::"negativo = crítico; abaixo do caixa mínimo = atenção…" | ok (154 mil > 10 mil) | OK | |
| DSH-07 | Card "Alertas abertos" | Lista (top 5) | alerts.listOpen ordenados por severidade (critical > warning > info) e createdAt desc; 5 primeiros | Alert.status = open, .severity, .createdAt | Sem cálculo | page.tsx (topAlerts) | — (ordenação simples) | 5 exibidos × 735 abertos (307 críticos) | OK | Não há contador do total na tela; ver achado 1.2.4. |
| DSH-08 | Card "Aprovações pendentes" | Lista + valor | approvals.listByStatus(["pending"]); valor = Approval.amountCents | Approval.status/.amountCents | Sem cálculo | page.tsx | — | 0 × 0 | OK | |
| DSH-09 | Cards Riscos/Oportunidades/Recomendações | Regras da visão executiva | Tendência: entradas = Σ créditos bancários (amount ≥ 0) de contas ativas por mês; último mês (corrente, parcial) vs média dos 2 anteriores; alta se último×20 > soma_anteriores×11 (> +10%), queda se último×20 < soma×9 (< −10%), senão estável; variação% = (último − média)/média×100 arredondado a 1 casa; null se média = 0. Riscos: queda, caixa < mínimo, vencidos, alertas críticos, aprovações. Oportunidades: alta, caixa ≥ 2× mínimo, vencidos recuperáveis | BankTransaction.date/.amountCents; BankAccount.active; payables/receivables abertos; approvals; alerts | Mês corrente parcial (assumption declarada); comparação inteira exata | relatorios/index.ts:computeExecutiveOverview (660-872); FORMULA_TREND (257) | relatorios.test.ts::"tendência de ALTA…", ::"QUEDA…", ::"ESTÁVEL no limiar exato de +10%"; relatorios/auditoria-dashboard.test.ts::"conta inativa…", ::"limites de mês…", ::"meses anteriores zerados…", ::"limiar exato de −10%…", ::"base vazia…" | Tela: "+20.2% vs média" (alta), excedente de caixa, 307 críticos × SQL: jul 1.146.336, ago 2.703.929, set 2.313.923 → média 1.925.132,5 → +20,2% | OK | Percentual exibido com ponto decimal ("20.2%") em texto pt-BR. Com −10,05% a tela mostra "−10%" junto de "queda" (arredondamento de apresentação). Base = transações mock. |
| DSH-10 | Rodapé "Confiança do cálculo" | Confiança | Constante por ação: tesouraria cash_position/refresh_projection = 1,0 (não exibida); relatorios executive_overview = 0,9 → "Confiança do cálculo: 90% (estimativa/heurística)"; forecast_cash = 0,7/0,5; scenarios 0,6. Não é calculada a partir dos dados | SkillResult.confidence | Exibida só quando < 1 | _lib/result-meta.tsx:SkillResultMeta; skills (makeResult) | relatorios/auditoria-dashboard.test.ts::"mês corrente parcial é declarado como suposição e a confiança é 0,9"; render.test.ts::"SkillResultMeta" | "90%" × 0,9 | OK | É um rótulo fixo de método, não uma medida estatística. |

## 3. Contas a pagar (CAP)

Arquivos: `src/skills/contas-a-pagar/index.ts`, `src/app/(app)/contas-a-pagar/page.tsx`, `_lib/{filters,export-rows,load-filtered}.ts`, `imprimir/page.tsx`, `export/route.ts`, `src/lib/{situation,payable-situation}.ts`, `src/core/money.ts`.

| ID | Tela/Componente | Indicador | Fórmula | Origem dos dados | Filtros e regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| CAP-01 | Listagem, coluna Status | Situação derivada: A Vencer / Hoje / Atrasado / Pago / Pago no Vencimento / Pago Atrasado / Cancelado | canceled → Cancelado; paid → compara paidAt (max todayInTz(Payment.executedAt) dos executed) com dueDate; senão dueDate < hoje → Atrasado, = hoje → Hoje, senão A Vencer; "(parcial)" só em Atrasado com paidCents > 0 | Payable.status/.dueDate/.paidCents; Payment.executedAt/.status | Só Payment executed; comparação ISO | page.tsx:569 derivePayableSituation; payable-situation.ts:53-71; situation.ts:51-67 | situation.test.ts (6 casos); payable-situation.test.ts (10); contas-a-pagar.test.ts::"conciliação após o vencimento sinaliza a quitação em atraso"; ::"corrige a data e reclassifica…" | A Vencer 23 / Pago 292 / Cancelado 23 × SQL idem | OK | Título baixado pela conciliação sem Payment ficaria "Pago" verde mesmo após o vencimento (0 casos na base) — D9. "(parcial)" não aparece em Hoje/A Vencer. |
| CAP-02 | Vencimento em vermelho | Vencido | dueDate < hoje AND status ∉ {paid, canceled} | idem | | page.tsx:566 | — (inline) | 0 vencidos × 0 | OK | |
| CAP-03 | Chips de situação | Recorte | a_vencer: abertos AND dueDate ≥ hoje+1; hoje: = hoje; atrasado: ≤ hoje−1; pago; cancelado; todos | Payable.status/.dueDate | Interseção com período; no banco (listPage) | page.tsx:166-203; filters.ts:112-148; repos.ts:1516-1541 | import-export.test.ts (pagar)::"Atrasado recorta…", ::"Hoje recorta…", ::"situação e período se combinam…", ::"situação inválida cai para todos" | n/a | OK | |
| CAP-04 | Filtros Ano/Mês/De/Até | Intervalo de vencimento | de/até > ano+mês > ano; de > até = erro | Payable.dueDate | | page.tsx:136-162; filters.ts:88-110 | import-export.test.ts::"período explícito vence Ano/Mês"; ::"ano sem mês…"; ::"acusa período invertido" | n/a | OK | Filtros incidem sobre o VENCIMENTO (confirmado). |
| CAP-05 | Select Ano | Anos | DISTINCT year(dueDate) de todos | | inclui cancelados | page.tsx:269-271 | — | 2026, 2027 | OK | |
| CAP-06 | Colunas Valor / Pago | amountCents / paidCents | brutos | | | page.tsx:597-598 | remaining-cents.test.ts | 0 títulos com pago > valor | OK | Conciliação com tolerância pode gerar pago > valor (sem clamp) — D10. |
| CAP-07 | Coluna Parc. | n/m | installmentNumber/installmentCount | | | page.tsx:591 | contas-a-pagar.test.ts::"cria título parcelado com soma exata e vencimentos mensais" | n/a | OK | |
| CAP-08 | Form Pagar: data padrão | dueDate ≥ hoje ? dueDate : hoje | | | só open/partially_paid; contas ativas | page.tsx:634 | — | n/a | OK | |
| CAP-09 | Impressão (rodapé) e PDF (linha TOTAL) | N títulos, Σ Valor, Σ Pago | Antes: Σ de TODOS os listados. Agora: Σ dos não cancelados; cancelados contados à parte no rótulo | Payable.amountCents/.paidCents/.status | Mesmos filtros da tela; teto de 5000 linhas | _lib/export-rows.ts:totalsOf, totalsLabel; imprimir/page.tsx; export/route.ts | import-export.test.ts (pagar)::"título cancelado fica fora de Σ Valor e Σ Pago…"; ::"base vazia: totais zerados" | Antes: "TOTAL — 338 título(s) R$ 1.059.623,62 R$ 980.499,80" (inclui 23 cancelados = R$ 73.027,82). Depois: "TOTAL — 315 título(s) (23 cancelado(s) fora da soma) R$ 986.595,80 R$ 980.499,80" × SQL 98659580 / 98049980 | Corrigido (`fix(export)`) | Ainda pendente (não corrigido): acima de 5000 títulos o CSV/PDF sai truncado sem aviso e o aviso da impressão tem classe `nao-imprimir` — Divergência (bug) de exportação. |
| CAP-10 | CSV/PDF/Impressão, coluna Status | statusLabel(status) | Status persistido ("Em aberto", "Pago") | Payable.status | | export-rows.ts:79; pdf.ts:70-75 | import-export.test.ts::"todas as colunas pedidas estão presentes" | n/a | Divergência (bug) | Arquivo não mostra Atrasado/Hoje/Pago Atrasado (tela mostra); PDF pinta vencido de azul. Não corrigido: decisão de layout (quais rótulos no arquivo). |
| CAP-11 | Export, coluna Conta de Pagamento | executado ?? primeiro não cancelado | Payment.bankAccountId | inclui rejeitado; mais antigo | load-filtered.ts:55-59 | — | n/a | Divergência (bug) menor | Título só com pagamento rejeitado mostra conta. |
| CAP-12 | Skill list_due (API/fluxos) | Vencimentos até hoje+7 com encargos | abertos com dueDate ≤ hoje+7 (vencidos sem limite inferior); remaining = max(0, amount − paid); multa = round(remaining × 2%); juros = round(remaining × 1% × dias / 3000 × 100)… (ver money) | Payable.*; config.lateFeeDefaults | Sobre o saldo restante | contas-a-pagar/index.ts:listDue (916-987); money.ts:computeLateFee | contas-a-pagar.test.ts::"calcula juros e multa exatos…"; auditoria-formulas.test.ts::"parcial vencido: encargos sobre o SALDO…"; ::"base vazia…"; money.test.ts::"juros pró-rata arredondam em aritmética inteira" | n/a (não há vencidos) | Corrigido (`fix(money)`, arredondamento) | Encargos sobre o saldo restante (não sobre o valor original) — consistente com list_overdue; regra a confirmar (D11). |
| CAP-13 | Skill forecast_disbursements | Desembolso semanal | abertos com dueDate ≤ hoje+30; data efetiva = max(hoje, dueDate); semana = min(floor(diff/7), n−1); Σ remaining | Payable.* | vencidos na semana atual | index.ts:989-1043 | contas-a-pagar.test.ts::"agrupa saldos por semana…"; auditoria-formulas.test.ts::"virada de ano…" | n/a | OK | Confiança 0,9. |
| CAP-14 | create_payable (parcelamento) | Parcelas | splitInstallments: base = floor(total/n), resto nas primeiras; dueDate_i = addMonths(dueDate, i) | | 1..120 | money.ts:74-81; index.ts:491-539 | money.test.ts::"divide parcelas somando exatamente o total"; contas-a-pagar.test.ts::"cria título parcelado…"; dates.test.ts | n/a | OK | |
| CAP-15 | create_payable (recorrência) | Valor cheio × ocorrências | | | 2..60 | index.ts:371-382 | contas-a-pagar.test.ts::"12 ocorrências mensais…"; ::"recorrência mensal a partir de 31/01…" | n/a | OK | |
| CAP-16 | schedule_payment | Saldo agendável | max(0, amount − paid) − Σ payments pending/approved | | | index.ts:640-656 | contas-a-pagar.test.ts::"recusa segundo agendamento…"; ::"permite dois agendamentos parciais…" | n/a | OK | |
| CAP-17 | reconcile_payment | Baixa | paidCents += amount; status paid/partially_paid; executedAt = meio-dia UTC da data informada | | só approved; data ≤ hoje e ≥ emissão | index.ts:1501-1532 | contas-a-pagar.test.ts::"conciliação executa (mock), quita o título"; ::"pagamento parcial conciliado…"; ::"recusa conciliação… de data futura" | 292 executados, todos ao meio-dia UTC | OK | |
| CAP-18 | reverse_payment | Estorno | paidCents = max(0, paid − amount) | | | index.ts:1664-1680 | 3 casos em contas-a-pagar.test.ts | n/a | OK | |
| CAP-19 | adjust_payment_date | Reclassificação | executedAt.slice(0,10) → nova data ao meio-dia UTC | | | index.ts:1379-1444 | 4 casos | n/a | OK | Depende de todo executedAt estar ao meio-dia UTC (hoje verdadeiro). |
| CAP-20 | detect_duplicates | Pares suspeitos | mesmo fornecedor+valor+vencimento; mesmo documento+parcela | | exclui canceled | index.ts:1045-1131 | 2 casos | n/a | OK | Confiança 0,8. |
| CAP-21 | Botões editar/cancelar | Regras | editável: status ∉ {paid, canceled} e paidCents = 0; cancelável: open/scheduled | | | page.tsx:289-295 | contas-a-pagar.test.ts::"bloqueia edição…"; ::"bloqueia cancelamento…" | n/a | OK | |
| CAP-22 | Pager / vazio | COUNT com o mesmo where | | | | page.tsx:552-559 | — | 338 | OK | |

## 4. Contas a receber (CAR)

| ID | Tela/Componente | Indicador | Fórmula | Origem | Filtros e regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| CAR-01 | Coluna Status | Situação derivada | Como CAP-01 com settled = received; receivedAt = max(Receipt.receivedDate ativos); rótulo "Recebido" (cor distingue em dia × atraso) | Receivable.*; Receipt.receivedDate/.status | Estornados fora | page.tsx:633; receivable-situation.ts:49-77 | receivable-situation.test.ts (9); situation.test.ts; contas-a-receber.test.ts::"corrige a data e reclassifica…" | n/a | OK | |
| CAR-02 | Vencimento vermelho | dueDate < hoje AND aberto | | | | page.tsx:629 | — | 0 | OK | |
| CAR-03 | Form Receber: valor padrão | max(0, amount − received) | | | | page.tsx:630 | remaining-cents.test.ts | n/a | OK | `register_receipt` não valida conta ATIVA (só existência) — D12. |
| CAR-04 | Chips/filtros | Recorte | como CAP-03/04 | | | filters.ts:87-164 | import-export.test.ts (receber) 6 casos | n/a | OK | |
| CAR-05 | Colunas Valor/Recebido | amountCents / receivedCents (principal) | | | | page.tsx:679-680 | contas-a-receber.test.ts::"baixa parcial e depois total…" | 0 com recebido > valor | OK | D10. |
| CAR-06 | Select Ano | | | | | page.tsx:332-334 | — | | OK | |
| CAR-07 | Impressão/PDF TOTAL | N, Σ Valor, Σ Recebido | Σ dos não cancelados (corrigido) | | | export-rows.ts:totalsOf/totalsLabel | import-export.test.ts (receber)::"título cancelado fica fora…"; ::"base vazia" | Antes 98 × R$ 919.345,81 / R$ 893.237,39 (3 cancelados = R$ 26.108,42); depois 95 × 89323739 / 89323739 | Corrigido (`fix(export)`) | Truncamento 5000 silencioso — mesma pendência de CAP-09. |
| CAR-08 | Export, coluna Status | statusLabel | | | | export-rows.ts:72 | ::"todas as colunas…" | | Divergência (bug) | Idem CAP-10; comentário em page.tsx:66 afirma o contrário. |
| CAR-09 | Export, Conta de Recebimento | primeiro Receipt ativo com conta | | | | load-filtered.ts:57-61 | — | | OK | |
| CAR-10 | Painel Recebimentos (💰) | Lista de recibos ativos | exibe amountCents (com encargos) | | | page.tsx:847-858 | — | | OK | Mostra o total recebido, não o principal. |
| CAR-11 | Skill list_overdue | Vencidos + encargos | abertos com dueDate < hoje; diasAtraso = diffDays; multa/juros sobre o saldo (money) | | | contas-a-receber/index.ts:574-658 | contas-a-receber.test.ts::"calcula dias de atraso, saldo e encargos exatos…"; ::"sem vencidos: lista vazia…"; money.test.ts | 0 vencidos | Corrigido (`fix(money)`) | |
| CAR-12 | register_receipt | Principal × encargos | excesso aceito só se ≈ multa+juros (±2 c); receivedCents += principal | | recusa canceled/received | index.ts:675-755 | 6 casos [D6] | n/a | Corrigido (`fix(money)`) | |
| CAR-13 | Skill projection | Entradas por semana | abertos com hoje ≤ dueDate ≤ hoje+30; VENCIDOS FORA (assunção declarada) | | | index.ts:816-864 | ::"agrupa entradas previstas por semana…" | n/a | OK | Assimetria com CAP-13 (que inclui vencidos) — documentada. |
| CAR-14 | create_receivable | Parcelas | split + addMonths | | | index.ts:422-436 | ::"divide parcelas…" | | OK | |
| CAR-15 | create_from_invoice | Plano | 1 parcela hoje+30 ou Σ = total | | | index.ts:503-555 | 5 casos [D3] | | OK | |
| CAR-16 | reverse_receipt | Estorno | principal = principalCents ?? min(amount, received) | | | index.ts:1183-1193 | 4 casos | | OK | |
| CAR-17 | adjust_receipt_date | Reclassificação | | | | index.ts:1269-1323 | 2 casos | | OK | |
| CAR-18 | issue_charge | Valor | max(0, amount − received) | | | index.ts:965-982 | 2 casos | | OK | |
| CAR-19 | Botões | Regras | | | | page.tsx:269-271 | 3 casos | | OK | |
| CAR-20 | Pager | COUNT | | | | page.tsx:611-618 | — | 98 | OK | |

## 5. Faturamento (FAT)

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| FAT-01 | /faturamento tabela | Total/Emissão/Status | listAll desc | Invoice.* | nenhum filtro | faturamento/page.tsx:20-60 | — | 0 faturas na base | OK | A tela não exibe nenhum total ou percentual. |
| FAT-02 | Form Nova fatura | Σ parcelas = total | parseBRLToCents (string) | | | actions.ts:40-55 | contas-a-receber.test.ts (2); form-utils.test.ts | n/a | OK | |
| FAT-03 | Skill billing_status | % recebido | Σ receivedCents dos títulos ativos ÷ totalCents × 100 (2 casas) | Receivable.*; Invoice.totalCents | issued com ≥ 1 título ativo | faturamento/index.ts:484-501 | faturamento.test.ts::"…ciclo com percentual recebido exato"; ::"reconhece fatura quitada"; ::"títulos cancelados não contam no ciclo"; auditoria-formulas.test.ts::"30.000 de 90.000 … 33,33%" | n/a | OK | Sem clamp em 100% se recebido > total (D10). Não exibido em tela. |
| FAT-04 | billing_status contadores | drafts / emitidas sem títulos | | | | index.ts:428-482 | 3 casos | | OK | |
| FAT-05 | issue_invoice | issueDate = hoje; NF-e mock sequencial | | | | index.ts:130-164 | 3 casos | | OK | |
| FAT-06 | create_invoice | Idempotência por saleRef não cancelada | | | | index.ts:228-230 | 2 casos | | OK | |
| FAT-07 | cancel_invoice | Bloqueio por recebimento; cancela títulos abertos | | | | index.ts:342-395 | 3 casos | | OK | |

## 6. Fluxo de caixa (FLX)

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| FLX-01 | Demonstrativo, coluna Período | Buckets | pastCount = floor(periods/2); diário 30, semanal 8 (segunda), mensal 12; limites inclusivos | calendário | | tesouraria:buildBucketRanges (485-506) | tesouraria.test.ts::"mensal: realizado…"; ::"usa defaults…"; auditoria-fluxo.test.ts::"base vazia: 12 meses…" | 2026-03..2027-02 | OK | EmptyState "Sem movimentos" é inalcançável (sempre há buckets). |
| FLX-02 | Entradas realizadas | Σ tx ≥ 0 de contas ativas com date ∈ [start, min(end, hoje)] | BankTransaction.*; BankAccount.active | conciliadas ou não; Payment/Receipt NÃO entram | tesouraria:733-741 | tesouraria.test.ts::"mensal…"; auditoria-fluxo.test.ts::"conta inativa fica fora…" | jul R$ 11.463,36 / ago 27.039,29 / set 23.139,23 × 1146336 / 2703929 / 2313923 | OK | Transferência entre contas ativas infla entradas E saídas (líquido 0). Dados mock (1.2.1). |
| FLX-03 | Saídas realizadas | idem < 0 | | | tesouraria:736-741 | idem | 7.639,42 / 14.225,78 / 3.060,51 × 763942 / 1422578 / 306051 | OK | Pagamento executado sem extrato não aparece no realizado. |
| FLX-04 | Entradas previstas | buildInflows 100%/0/0 no bucket (saldo restante; vencido → hoje) | Receivable.* | open/partially_received | tesouraria:371-390, 744-750 | tesouraria.test.ts | 0 × 0 | OK | Dupla contagem transitória no bucket corrente (tx importada + título ainda aberto) — assumida. |
| FLX-05 | Saídas previstas | buildOutflows (scheduledDate pendente ou dueDate; vencido → hoje) | Payable.*; Payment.* | open/scheduled/partially_paid | tesouraria:348-368 | tesouraria.test.ts | out R$ 1.032,53; nov–fev 520,13 × 103253; 52013… | OK | |
| FLX-06 | Líquido | realIn − realOut + projIn − projOut | | | tesouraria:751 | tesouraria.test.ts | jul 3.823,94; ago 12.813,51 | OK | |
| FLX-07 | Saldo acumulado | Σ aberturas ativas + Σ tx date < periodStart; + líquido acumulado | | openingBalanceDate ignorada | tesouraria:723-752 | tesouraria.test.ts; auditoria-fluxo.test.ts::"…extrato anterior ao 1º período entra no saldo de partida…" | 117.747,35 → 121.571,29 → 134.384,80 → 154.463,52 × idem | OK | Diverge do Saldo conciliado por desenho (BB:35-38). |
| FLX-08 | (insumo) availableCents | abertura + Σ todas tx (ativas) | | | tesouraria:277-292 | tesouraria.test.ts | 154.463,52 | OK | = DSH-01 |
| FLX-09 | Cenários — parâmetros | otimista {100%,0,7}; base {95%,7,21}; pessimista {80%,21,45}; round por título | Receivable.* | | tesouraria:248-252 | tesouraria.test.ts::"calcula os três cenários…" | AR aberto 0 → 3 cenários iguais | OK | Arredondamento por título, não sobre o total. |
| FLX-10 | Cenários — saldo final | available + Σ in − Σ out (≤ hoje+90) | | | tesouraria:784-827 | idem | R$ 152.390,73 (3×) × 15446352 − 103253 − 52013×2 = 15239073 | OK | Confiança 0,6. |
| FLX-11 | Cenários — menor saldo | mínimo do acumulado, empate data mais antiga | | | tesouraria:414-440 | idem | 152.390,73 em 04/12 | OK | |
| FLX-12 | Previsão — histórico semanal | semanas completas anteriores; historyWeeks 26 | BankTransaction.* | | tesouraria:857-888 | tesouraria.test.ts::"história estável…"; ::"histórico insuficiente…" | 8 semanas (mock) | OK | |
| FLX-13 | Previsão — comprometido | itens determinísticos por semana | | | tesouraria:936-956 | ::"o comprometido … é piso" | n/a | OK | |
| FLX-14 | Previsão — estatístico | max(0, round(theilSen × sazonal × proration)); zero se < 8 semanas | | | tesouraria:958-968 | ::"tendência de crescimento…" | n/a | OK | Confiança 0,7 / 0,5. |
| FLX-15 | Previsão — previsto/saldo | max(comprometido, estatístico); acumulado | | | tesouraria:970-985 | idem | n/a | OK | |
| FLX-16 | Previsão — banda | MAD × 1,4826 × √(k+1) | | | tesouraria:925-987 | idem | n/a | OK | |

## 7. Agenda (AGD)

Cálculo extraído para `src/app/(app)/agenda/_lib/agenda-month.ts` (antes inline na página, sem nenhum teste).

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| AGD-01 | Universo do mês | Títulos considerados | listDueBetween(1º, último dia) filtrado por status aberto | Payable/Receivable.dueDate/.status | cancelados/pagos/recebidos fora | agenda-month.ts:buildAgendaMonth | agenda-month.test.ts::"cancelado, pago e recebido ficam fora…"; ::"título com vencimento fora do mês é ignorado" | set/2026: 0 a pagar, 0 a receber × SQL 0 / 0 | OK | |
| AGD-02 | Célula do dia (−R$) | Saídas | Σ max(0, amount − paid) por dia do dueDate | | | idem | idem | | OK | Scheduled com payment aprovado conta o valor cheio (diverge de FLX-05, que usa scheduledDate) — documentado. |
| AGD-03 | Célula do dia (+R$) | Entradas | Σ max(0, amount − received) | | | idem | idem | | OK | |
| AGD-04 | Líquido do dia | in − out | (não renderizado) | | | idem | idem | | OK | |
| AGD-05 | StatCard "A receber no mês" | Σ inCents | | | | idem | ::"…identidade totais = Σ dias" | R$ 0,00 × 0 | OK | |
| AGD-06 | StatCard "A pagar no mês" | Σ outCents | | | | idem | idem | R$ 0,00 × 0 (outubro: 1.032,53 × 103253) | OK | |
| AGD-07 | StatCard "Líquido do mês" | in − out | | | | idem | idem | R$ 0,00 | OK | |
| AGD-08 | Marcação vencido/hoje | date < hoje com títulos; = hoje | hoje no fuso | | page.tsx:isOverdue | ::"vencido … fica no DIA DO VENCIMENTO" | n/a | OK | |
| AGD-09 | Detalhamento | remaining por título, ordem dueDate/id | | | agenda-month.ts | ::"detalhamento ordena por vencimento e desempata por id" | n/a | OK | |
| AGD-10 | Base vazia | EmptyState; cards R$ 0,00 | | | page.tsx | ::"sem títulos: 30 células zeradas…" | "Nenhum vencimento em aberto em Setembro de 2026." | OK | fev/bissexto testados. |

## 8. Conciliação (CON)

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| CON-01 | Filtros conta/período | Conta e período efetivos | 1ª conta ativa; startOfMonth(hoje)..hoje; de > até sinalizado | BankAccount.active | só ativas | filters.ts:resolveFilters | filters.test.ts (7 casos) | Itaú, 01/09..17/09 | OK | Auditoria recebe `sp.conta` cru (conta inválida na URL → erro no card de divergências). |
| CON-02 | Linhas "Pagamento" | Saídas | Payment executed da conta, date = todayInTz(executedAt), no período, −amount | Payment.* | só executed | bank-balance.ts:124-130 | bank-balance.test.ts (4 casos) | 13 lançamentos × 13 (R$ 85.224,72 × 8522472) | OK | |
| CON-03 | Linhas "Recebimento" | Entradas | Receipt ativo com conta, receivedDate no período, +amount (com encargos) | Receipt.* | cancelados fora; sem conta fora | bank-balance.ts:135-145 | bank-balance.test.ts (4) | 8 × 8 (R$ 118.789,80 × 11878980) | OK | |
| CON-04 | Linhas "Extrato" | Extrato conciliado não casado com registro | tx reconciled no período, exceto casada (confirmed/auto) com payment/receipt/receivable. **payable removido do conjunto** | BankTransaction.*; ReconciliationMatch.* | | bank-balance.ts:ALVOS_JA_CONTADOS (107) | bank-balance.test.ts::"transação casada com TÍTULO a pagar continua contando…"; ::"…RECEBER não conta duas vezes…"; + 5 casos existentes | 0 × 0 (nenhuma tx conciliada) | Corrigido (`fix(saldo-conciliado)`) | Antes: débito casado com payable sumia (não há Payment). |
| CON-05 | "Entradas: R$ (n)" / "Saídas: R$ (n)" | Totais | módulo; zero não conta | | | bank-balance.ts:190-200 | ::"a lista SEMPRE soma o total da caixa…" | 118.789,80 (8) / 85.224,72 (13) | OK | |
| CON-06 | StatCard "Saldo" | abertura inteira + entradas − saídas do período | | movimentos antes de `de` não entram | bank-balance.ts:209 | ::"sem movimentação, o saldo é o saldo inicial" | 117.747,35 + 118.789,80 − 85.224,72 = R$ 151.312,43 | OK (por especificação) | Semântica: não é o saldo da conta na data final quando há movimentos antes do período (S2). |
| CON-07 | "Total de lançamentos conciliados no período" | inflowCount + outflowCount | | ≠ nº de BankTransaction.reconciled | bank-balance.ts:210 | idem | 21 × 21 | OK | Rótulo pode induzir a leitura errada. |
| CON-08 | "Pagamentos aprovados aguardando conciliação (N)" | payments approved | | todas as contas | page.tsx:326-332 | — | 0 × 0 | OK | |
| CON-09 | "Conciliados (N)" | executados | Antes: tamanho da lista após slice(0,30). Agora: total, com "30 mais recentes exibidos" | Payment.status/.executedAt | | page.tsx:315-324 | — (página; verificado na cópia) | Antes "Conciliados (30)"; depois "Conciliados (292 · 30 mais recentes exibidos)" × 292 | Corrigido (`fix(conciliacao)`) | |
| CON-10 | "Sugestões pendentes (N)", "Confiança X%" | matches suggested; round(conf × 100) | | 1 card por perna/parcela | page.tsx:82, 1028-1081 | conciliacao.test.ts (indireto) | 9 × 9 (todas bank_fee 80%) | OK | |
| CON-11 | "Transações não conciliadas (N)" + "Localizar no extrato" | listPage total; filtro sobre a PÁGINA | | inativas entram | page.tsx:85-89, 265-278 | — | 34 × 34 | Divergência (bug) | "Localizar" filtra só a página corrente (50) — transações compatíveis em outras páginas não aparecem. Não corrigido (UI). |
| CON-12 | Histórico recente | confirmed/auto desc 15 | | | page.tsx:259-261 | — | n/a | OK | Alvo payment mostra scheduledDate. |
| CON-13 | Score fase 1 | valor = 0 → 0,55; ≤ tol → 0,40; data = 0 +0,25, ≤ tol +0,15; nome +0,20; candidato > 0,50; auto ≥ 0,90 | BankTransaction.*; títulos; Payment.scheduledDate | | conciliacao:scoreCandidate (296-327) | conciliacao.test.ts (6 casos) | n/a | OK | Valor exato sozinho (0,55) vira sugestão com qualquer distância de data; candidato payment usa scheduledDate, não executedAt — observações. |
| CON-14 | Desempate | score, prioridade payment, dateDiff, id | | | conciliacao:893-910 | idem | | OK | |
| CON-15 | Reserva de saldo no lote | remaining em memória | | | conciliacao:969-990 | ::"um título não é casado por duas transações além do saldo" | | OK | |
| CON-16 | Transferência (fase 2) | par oposto em outra conta ≤ tolDias; 0,55 + data + regex 0,20; nenhuma receita/despesa | | | conciliacao:1085-1168 | partials.test.ts (4) | | OK | |
| CON-17 | Rateio (fase 3) | subconjunto 2..4 com soma exata | | | conciliacao:1171-1285 | partials.test.ts (3) | | OK | |
| CON-18 | Parcial (fase 4) | flag; nome obrigatório; nunca auto | | | conciliacao:1293-1368 | partials.test.ts (7) | | OK | |
| CON-19 | Tarifa bancária | regex; 0,80; sempre sugestão; AccountingEntry idempotente | | | conciliacao:362-413, 1377-1401 | conciliacao.test.ts (5) | 9 sugestões pendentes | OK | |
| CON-20 | Flash da rodada | autoConfirmed/suggested/unmatched | | | conciliacao:1403-1449 | conciliacao/partials tests | | OK | |
| CON-21 | API reconciliation_status | contagens | | inativas entram | conciliacao:2383-2428 | ::"consolida não conciliadas…" | | OK | |
| CON-22 | Cobertura do extrato | max(maior tx, ledgerBalanceDate) − tolDias | StatementImport.* | todas as contas | conciliacao:1929-1967 | auditoria.test.ts (6); conciliacao.test.ts (3) | | OK | Fronteira exclusiva não testada. |
| CON-23 | "Extrato sem explicação" | tx !reconciled no período; Σ módulo | | | conciliacao:1971-2008 | auditoria.test.ts (2) | ago: 34 transações mock não conciliadas | OK | |
| CON-24 | Baixas sem lastro — pagamento | executed sem match aplicado; fora da cobertura → pendente | | | conciliacao:2039-2065 | auditoria.test.ts (6) | | OK | |
| CON-25 | Baixas sem lastro — recebimento | Receipt ativo com conta sem match | | | conciliacao:2067-2107 | auditoria.test.ts (2) | | OK | auto_match nunca cria match `receipt`: recibo manual nunca é "explicado" (obs.). |
| CON-26 | Baixas sem lastro — baixa manual | listPaidBetween (updatedAt em UTC) sem Payment executed | Payable.updatedAt | | conciliacao:2110-2137; prisma/repos.ts:1493-1508 | auditoria.test.ts (4) | 0 casos | Divergência (bug) | Data da baixa fatiada/comparada em UTC (21h+ em SP cai no dia seguinte) e `updatedAt` muda com qualquer edição. Correção exige passar o fuso ao repositório (assinatura de `listPaidBetween`) — não feita. |
| CON-27 | "Valores divergentes" | aplicado vs esperado; payable/receivable: saldo restante ATUAL | | | conciliacao:2182-2221 | auditoria.test.ts (2, só payment) | 0 matches de título aplicados | Divergência (bug) — decisão D8 | Para payable/receivable o "esperado" já foi reduzido pela própria baixa: toda conciliação exata de título vira "divergência" igual ao valor aplicado. Correção depende de definir o esperado com baixas parciais. |
| CON-28 | Saldo do app na data-base | computeBankPeriodBalance 0001-01-01..asOf | | | conciliacao:2231-2252 | auditoria.test.ts (2); ledger-balance.test.ts | sem lote com saldo (mock não traz LEDGERBAL) | Corrigido (herda CON-04) | |
| CON-29 | Banco / Diferença | ledger; calculado − ledger | | | conciliacao:2237-2254 | auditoria.test.ts (2) | n/a | OK | |
| CON-30 | Diferença explicada | semLastro + pendentes − naoConciliadas (até asOf) | | | conciliacao:2269-2288 | auditoria.test.ts (5) | n/a | Divergência (bug) | Janelas assimétricas: calculado/não conciliadas cobrem toda a história, mas baixas sem lastro só o período auditado → resíduo sem linha correspondente. Não corrigido (mudança de regra). |
| CON-31 | Resíduo/alerta | diff − explicado; > tol warning; > 100×tol critical | | | conciliacao:2289-2321 | auditoria.test.ts (4) | n/a | OK (herda CON-04/30) | |
| CON-32 | "Baixas sem lastro" (R$) | Σ sem sinal | | | conciliacao:2339-2340 | auditoria.test.ts | | OK | Volume, não líquido. |
| CON-33 | "N baixa(s) aguardam a importação do extrato" | count | | | conciliacao:2343 | auditoria.test.ts (3) | | OK | |

## 9. Cobrança (COB)

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| COB-01 | StatCard "Taxa de inadimplência" | % | round(Σ saldo_vencido ÷ Σ saldo_aberto × 10000)/100; null se aberto = 0 | Receivable.* | abertos com saldo > 0; vencido = dueDate < hoje | cobranca:delinquencyIndicators (685-698) | cobranca.test.ts::"calcula os indicadores com valores exatos…"; auditoria-formulas.test.ts::"7 dias → 1-7…" (10%); ::"cancelado vencido fica fora…" (100%) | "—" × null (AR aberto 0) | OK | Limite 10% duplicado na UI (page.tsx:89). |
| COB-02 | "Aging da carteira vencida" | 1-7 / 8-30 / 31-60 / 60+ | diffDays(dueDate, hoje) → faixa; Σ saldo | | 60+ = ≥ 61 | cobranca:703-704, 171-178 | auditoria-formulas.test.ts::"7 dias → 1-7; 8 → 8-30; 30 → 8-30; 31 → 31-60; 60 → 31-60; 61 → 60+" | R$ 0,00 ×4 × 0 | OK (fórmula); rótulo | Título com exatamente 60 dias cai em "31-60" — rótulo "60+" enganoso (D13). |
| COB-03 | "Ticket médio vencido" | round(Σ vencido ÷ qtd) | | | cobranca:706-707 | ::"…ticket médio é half-up" | "—" | OK | |
| COB-04 | "Clientes inadimplentes" | COUNT DISTINCT customerId | | | cobranca:712 | auditoria-formulas.test.ts | 0 × 0 | OK | |
| COB-05 | "DSO (dias)" | round((Σ aberto ÷ Σ recibos ativos [hoje−90, hoje]) × 90 × 10)/10 | Receipt.amountCents/.receivedDate/.status | estornados fora; janela inclusiva (91 dias) | cobranca:714-730 | ::"janela de recebimentos vai de hoje−90 a hoje…" | 0 × 0 (aberto 0; recibos 90d R$ 648.458,81) | OK (fórmula) | Janela de 91 dias × 90 e recibos com encargos no denominador — D14. Confiança 0,9. |
| COB-06 | Alerta high_delinquency | rate > 10 | | | cobranca:732-742 | cobranca.test.ts | | OK | |
| COB-07..11 | Segmentação de clientes | saldo/qtd/maior atraso/bucket/risco por cliente | Σ (amount − received) vencidos; risco: alto ≥ 3 títulos ou > R$ 10.000; baixo ≤ 1 e < R$ 1.000 | | | cobranca:segmentCustomers (234-263) | cobranca.test.ts::"segmenta clientes por bucket de atraso e risco…"; ::"retorna lista vazia sem títulos vencidos" | vazio × 0 | OK | Total vencido calculado mas não exibido. |
| COB-12 | Dias em atraso | diffDays no fuso | | | cobranca:203-204; dates.ts:66-69 | dates.test.ts | | OK | |
| COB-13 | Régua (run_dunning) | step = último com daysOverdue ≤ dias; idempotente por (título, step) | config.dunningSteps | | cobranca:289-329 | cobranca.test.ts (3); flows.integration | n/a | OK (fórmula) | dunningSteps não validado; recebimento não cancela mensagens pendentes; retomada envia sem revalidar — D15. |
| COB-14 | Mensagem {{valor}} | multa + juros pró-rata sobre o saldo | money.ts:computeLateFee | | money.ts:119-137 | money.test.ts::"juros pró-rata arredondam em aritmética inteira…" | n/a | Corrigido (`fix(money)`) | |
| COB-15 | Valor da aprovação da régua | Σ totais rascunhados | | | cobranca:319-412 | cobranca.test.ts | | OK | |
| COB-16..19 | Renegociação (sem UI) | à vista (saldo + multa); 2x; 3x com juros mensal×3 | splitInstallments | | cobranca:583-643 | cobranca.test.ts::"calcula as três opções com valores exatos…"; money.test.ts | | Corrigido (`fix(money)`) | Juros de parcelamento sobre total que já tem multa+juros, por 3 meses cheios — política (D16). |
| COB-20 | "Mensagens de cobrança (N)" | COUNT incl. canceladas | | | page.tsx:42-49 | — | 0 | OK | |

## 10. Orçamento (ORC)

Base de produção sem orçamento cadastrado (0 Budget, 0 BudgetLine): a tela mostra "Nenhuma linha de orçamento para o período"; conferência com dados reais não aplicável.

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| ORC-01 | Coluna Orçado | BudgetLine.amountCents do Budget ativo do ano (mais recente), period = mês | Budget/BudgetLine | só active; órfãs = 0 | orcamento:398-420 | orcamento.test.ts (5 casos); run-skill.test.ts | n/a | OK | 2 orçamentos ativos → mais novo em silêncio (obs.). |
| ORC-02 | Coluna Realizado | despesa: Σ Payment.amountCents executed com mês(executedAt no fuso) = period e categoria/centro do payable; receita: Σ Receipt.amountCents ativos por receivedDate | Payment/Payable/Receipt/Receivable/Category.kind | baixas via conciliação sem Payment não entram (declarado) | orcamento:loadRealizedItems (172-205) | orcamento.test.ts::"pagamento executado às 22h30 de 31/07 … é realizado de JULHO" | n/a | Corrigido (`fix(orcamento)` fuso) | Receipt.amountCents inclui encargos; linha curinga + por categoria duplica — D17. |
| ORC-03 | Variação | realizado − orçado | | | orcamento:439 | orcamento.test.ts | | OK | |
| ORC-04 | Variação % | round(var ÷ orçado × 10000)/100; null se orçado 0 | | | orcamento:440-447 | orcamento.test.ts | | OK | |
| ORC-05 | Linha Total | Σ orçado/realizado/variação | | soma receitas e despesas no mesmo sinal | orcamento:522-529 | orcamento.test.ts | | Decisão pendente D17 | |
| ORC-06 | Alerta budget_deviation | |var%| > 10 e |var| ≥ R$ 100 | | ignora kind | orcamento:460-491 | orcamento.test.ts (2) | | Decisão pendente D17 | Orçado 0 nunca alerta. |
| ORC-07 | Pendência nao_orcado | Σ por categoria sem linha | | | orcamento:494-520 | orcamento.test.ts | | Corrigido (herda ORC-02) | |
| ORC-08 | Pendência sem_orcamento | sem Budget ativo | | | orcamento:399-417 | ::"sem orçamento para o ano…" | tela vazia | OK | |
| ORC-09 | check_impact — comprometido | Σ saldo restante dos abertos do mês + executados, nas dimensões da linha casada | | | orcamento:checkImpact (560-668) | orcamento.test.ts::"linha orçada por categoria + centro…"; ::"linha orçada só por centro…"; + 4 existentes | n/a | Corrigido (`fix(orcamento)` dimensões) | |
| ORC-10 | check_impact — restante/estouro | orçado − comprometido; < 0 | | | orcamento:621-659 | idem | | Corrigido (herda) | |
| ORC-11 | forecast (sem UI) | média dos 3 meses fechados por categoria | | | orcamento:676-745 | orcamento.test.ts (2) | | Corrigido (herda ORC-02) | Confiança 0,5. |
| ORC-12 | Form CSV | reais → centavos; duplicatas somadas | | | orcamento/csv.ts | csv.test.ts | | OK | |
| ORC-13 | MonthNav | mês corrente no fuso | | | page.tsx:65-66 | dates.test.ts | | OK | |

## 11. DRE gerencial (DRE)

Regime: competência por `issueDate`, valor cheio do título; `Category.dreGroup` via `categoryId`. Em produção nenhum título tem `categoryId` → tudo em "Outras".

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado (ago/2026) | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| DRE-01 | Receita bruta | Σ amountCents de recebíveis E pagáveis com dreGroup = receita_bruta, mês(issueDate) = period, status ≠ canceled | Receivable/Payable.amountCents/.issueDate/.categoryId → Category.dreGroup | vencidos entram; parcial = valor cheio; kind ignorado; categoria inativa classifica | controladoria:computeDre (221-301) | controladoria.test.ts::"apura cada linha da DRE por competência…"; auditoria-formulas.test.ts::"virada de ano…", ::"categoria INATIVA…", ::"pagamento parcial … VALOR CHEIO", ::"cancelado fica fora…" | R$ 0,00 × 0 | OK (fórmula) | Sem sinal por tipo de título (S-02) — D3. |
| DRE-02 | (−) Deduções | Σ dreGroup = deducoes | | | controladoria:250 | idem; dre-rows.test.ts | Antes "-R$ 0,00"; agora "R$ 0,00" × 0 | Corrigido (`fix(dre)`) | |
| DRE-03 | (=) Receita líquida | bruta − deduções | | | :275 | controladoria.test.ts | 0 | OK | |
| DRE-04 | (−) Custos | Σ dreGroup = custos | | | :250 | idem | "R$ 0,00" | Corrigido (`fix(dre)`) | |
| DRE-05 | (=) Lucro bruto | líquida − custos | | | :276 | idem | 0 | OK | |
| DRE-06 | (−) Despesas operacionais | Σ dreGroup = despesas_operacionais | | | :250 | idem | "R$ 0,00" | Corrigido (`fix(dre)`) | |
| DRE-07 | (=) EBITDA | lucro bruto − despesas operacionais | | | :277 | idem | 0 | OK | |
| DRE-08 | (+/−) Resultado financeiro | Σ receitas_financeiras − Σ despesas_financeiras | | encargos de recibos não entram | :278 | idem | 0 | OK | |
| DRE-09 | (=) Resultado | ebitda + financeiro ("outras" fora) | | | :289 | ::"é determinística e idempotente…" | 0 | OK | Alerta persistido a cada visualização (dedupe). |
| DRE-10 | Outras (informativo) | Σ sem sinal de dreGroup = outras ou sem categoria | | | :250, 290 | ::"detalha o breakdown…" | R$ 459.763,41 × 45976341 | OK (fórmula) | Soma recebíveis + pagáveis sem sinal (S-03) — D3. Todo o movimento cai aqui (1.2.2). |
| DRE-11 | Detalhamento por categoria | por (dreGroup, categoryId) | | | :251-298 | idem | "Sem categoria" | OK | |
| DRE-12 | Pendências titulo_sem_categoria | sem categoryId ou inexistente | | | :260-269 | idem | 2 pendências exibidas (recebíveis) | OK | |

## 12. Indicadores (IND)

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| IND-01 | Margem bruta | lucro bruto ÷ receita líquida × 100 (2 casas); null se ≤ 0 | DRE | | controladoria:453-470 | controladoria.test.ts::"calcula todos os indicadores…"; ::"período sem receita…"; auditoria-formulas.test.ts::"custos acima da receita: margem bruta negativa"; ::"…1/3 → 33,33" | "—" × null | OK | Dupla arredondagem (2 casas + 1 na UI). |
| IND-02 | Margem operacional | ebitda ÷ receita líquida | | | :471-482 | idem | "—" | OK | |
| IND-03 | EBITDA gerencial | = DRE-07 | | | :483-492 | idem | R$ 0,00 × 0 | OK | |
| IND-04 | Ponto de equilíbrio | fixos ÷ MC; MC = (bruta − variáveis) ÷ bruta; null se bruta 0 ou MC ≤ 0 | | usa dreGroup, não costClassification | :498-528 | ::"ponto de equilíbrio não desconta deduções duas vezes" | "—" | OK | Dois critérios de fixo/variável no app (dreGroup × costClassification) — D1. |
| IND-05 | Capital de giro | Σ saldo AR aberto − Σ saldo AP aberto (HOJE) | | ignora o mês selecionado | :531-557 | ::"capital de giro negativo gera alerta…" | −R$ 6.096,00 × −609600 (AR 0; AP 609600) | OK (fórmula) | Rodapé diz "Período de apuração: {mês}" mas é posição de hoje (S-05) — Divergência de rótulo (tela). |
| IND-06 | PMR | round(AR aberto × 90 ÷ Σ recebíveis emitidos [hoje−89, hoje]) | | | :560-590 | controladoria.test.ts | 0 dias × 0 (receita90 62845842) | OK | Fórmula diz "receita bruta" mas soma todos os grupos. |
| IND-07 | PMP | round(AP aberto × 90 ÷ compras90) | | | :567-600 | idem | 1 dia × round(609600×90/63855317) = 1 | OK | "compras" = todos os pagáveis (inclui transferências, dividendos — D2). |
| IND-08 | Ciclo financeiro | PMR − PMP | | | :601-610 | idem | −1 × −1 | OK | |
| IND-09 | Custos fixos % | Σ pagáveis despesas_operacionais ÷ Σ pagáveis do mês | | | :613-631 | idem | 0,0% × 0 (tudo sem categoria) | OK | |
| IND-10 | Custos variáveis % | (custos + deduções) ÷ total | | | :632-644 | idem | 0,0% | OK | |
| IND-11 | cost_structure (sem UI) | pctOfTotal por categoria | | | :658-703 | ::"separa fixos, variáveis…" | n/a | OK | |

## 13. Relatórios (REL)

| ID | Tela/Componente | Indicador | Fórmula | Origem | Regras | Arquivo:função | Teste | Tela × recalculado | Resultado | Observações |
|---|---|---|---|---|---|---|---|---|---|---|
| REL-01 | Resumo diário — Saldo disponível | = DSH-01 | | | | relatorios:loadBankBase (275-299) | relatorios.test.ts::"consolida fatos, projeção 7d…" | R$ 154.463,52 × 15446352 | OK | S-08 openingBalanceDate. |
| REL-02/03 | A pagar hoje (R$, qtd) | Σ saldo restante abertos com dueDate = hoje | | | :335, 429-430 | idem | 0 / 0 × 0 | OK | |
| REL-04/05 | A receber hoje | idem | | | :336, 431-435 | idem | 0 / 0 | OK | |
| REL-06 | Pagáveis vencidos | Σ saldo restante abertos dueDate < hoje | | | :337-339 | idem | 0 × 0 | OK | |
| REL-07 | Recebíveis vencidos | idem | | | :340-342 | idem | 0 × 0 | OK | |
| REL-08 | Alertas abertos | count por severidade | | | :349-351 | idem | 307 · 370 · 59 × 307 / 369 / 59 | OK | 370 vs 369: 1 alerta warning criado pela própria navegação na cópia entre as duas leituras (alertas são persistidos a cada render). |
| REL-09 | Aprovações pendentes | count pending | | | :353 | idem | 0 | OK | |
| REL-10 | Saldo projetado 7d (só narrativa/export) | disponível + Σ AR aberto dueDate ≤ hoje+7 − Σ AP aberto dueDate ≤ hoje+7 (vencidos entram) | | não usa scheduledDate de pagamentos pendentes (tesouraria usa) | :324, 356-362 | idem; ::"com saldo projetado negativo…" | narrativa: R$ 154.463,52 | OK | Rótulo existe mas o número não aparece no card (obs.). |
| REL-11 | Riscos/recomendações diários | vencidos×100 > carteira×10 etc. | | | :368-423 | idem | "Nenhum risco" | OK | "%" com ponto decimal. |
| REL-12 | Fechamento — Recebimentos no mês | Σ Receipt.amountCents ativos com receivedDate no mês | Receipt.* | estornados fora; inclui encargos | :491-503 | relatorios.test.ts::"fecha julho…"; auditoria-fechamento.test.ts::"recibo ESTORNADO…", ::"limites inclusivos…", ::"virada de ano…", ::"base vazia…" | R$ 226.193,37 × 22619337 (23 recibos) | OK | |
| REL-13 | Pagamentos no mês | Σ Payment.amountCents executed com **scheduledDate** no mês | Payment.* | não usa executedAt | :494-504 | relatorios.test.ts::"fecha julho…" | R$ 230.280,24 × 23028024 (por scheduledDate) = 23028024 (por executedAt; 0 divergentes na base) | Decisão pendente D4 | Ajustar a data de pagamento não muda o fechamento; conciliação usa executedAt. |
| REL-14 | Novos títulos a pagar | Σ amountCents ≠ canceled com issueDate no mês | | | :505-507 | idem | R$ 233.570,04 × 23357004 | OK | Inclui transferências/dividendos (D2). |
| REL-15 | Novos títulos a receber | idem | | | :508-510 | idem | R$ 226.193,37 × 22619337 | OK | |
| REL-16 | Saldo ao fim do mês | Σ contas ativas hoje (abertura + Σ tx date ≤ fim do mês) | | conta inativada depois some; openingBalanceDate ignorada | :288-297, 511 | idem | R$ 134.384,80 × 13438480 (= FLX-07 ago) | OK | S-08. |
| REL-17 | Fluxo líquido | recebimentos − pagamentos | | | :512 | idem | −R$ 4.086,87 × −408687 | OK | |
| REL-18 | DRE simplificada (caixa) | receita = REL-12; despesas = REL-13 | | | :617-623 | idem; ::"mês com resultado negativo…" | 226.193,37 / 230.280,24 / −4.086,87 | OK (herda D4) | Três "resultados" no app (competência, caixa por títulos, líquido bancário) — só a assumption explica. |
| REL-19 | Destaques | maior pagamento/recibo; top 3 categorias (nome da categoria do pagável) | | | :515-562 | idem | top: Transferencia Entre Contas R$ 47.000,00; Antecipação De Dividendos R$ 37.205,39; Impostos E Taxas R$ 36.577,75 × SQL idem | OK (fórmula) | Evidência direta do achado 1.2.3. |
| REL-20 | Riscos/recomendações mensais | net < 0; fim de mês < mínimo; novos AP > novos AR | | | :567-602 | idem | 2 riscos exibidos | OK | Empresa sem contas geraria "caixa abaixo do mínimo" (S-09). |
| REL-21/22/23 | Export CSV/XLSX/PDF (linhas) | metrica/valor/unidade/fonte; valor em CENTAVOS | | | :1162-1242; reports.ts | relatorios.test.ts (4 casos export_data) | n/a | Divergência (usabilidade) | Valores saem como 1950000 (centavos) no CSV, XLSX (coluna sem type "money") e PDF (S-07). |
| REL-24 | CSV | BOM, ';', CRLF, anti-injeção | | | exporters/csv.ts | csv.test.ts (9) | | OK | |
| REL-25 | XLSX | money → /100; number bruto | | | exporters/xlsx.ts | xlsx.test.ts (7) | | OK | Tipo money suportado mas não usado pelos relatórios. |
| REL-26 | PDF | tabela 4 colunas iguais; célula truncada com "…" | | | exporters/pdf.ts:drawTable | pdf.test.ts (4) | | Divergência (bug) | Riscos/recomendações/destaques truncados no PDF (S-06). Não corrigido (layout). |
| REL-27 | Visão executiva (card) | = DSH-09 + KPIs | | | relatorios:660-872 | ver DSH-09 | Entradas 2026-09 R$ 23.139,23 × 2313923; Saídas R$ 3.060,51 × 306051 | OK | |

## 14. Decisões pendentes (regra de negócio — não decidi sozinho)

| # | Decisão | Onde impacta | Recomendação |
|---|---|---|---|
| D1 | **Categorias da DRE**: os títulos usam `supplierCategory` (texto) e `costClassification`; a DRE/indicadores só leem `Category.dreGroup` via `categoryId`, que está vazio em 100% dos títulos. Mapear "Categoria de Fornecedores" → `Category`, ou derivar a DRE de `costClassification`/`supplierCategory`? | DRE-01..12, IND-01..04, IND-09/10 | Criar vínculo `SupplierCategory → Category(dreGroup)` no cadastro e preencher `categoryId` no título a partir dele (migração de dados a partir do texto). |
| D2 | **Transferências entre contas, aportes, dividendos, pró-labore, empréstimos lançados como títulos a pagar**: devem contar como "pagamento/despesa"? Hoje entram em tudo (fechamento, PMP, novos títulos, e no Total Pago do painel novo). Não existe conceito/flag no modelo. | REL-13/14/18/19, IND-07, FLX-05, painel (PNL-02..05) | Marcar as categorias de fornecedor de natureza "movimentação de capital/transferência" (flag no cadastro) e excluí-las por padrão dos totais de despesa, exibindo-as em linha própria. O painel novo declara, no rodapé, que hoje as inclui. |
| D3 | **DRE sem sinal por tipo de título** (S-02/S-03): recebível numa categoria de despesa aumenta a despesa; "Outras" soma recebíveis + pagáveis. Usar o tipo do título (ou `Category.kind`) para dar sinal? | DRE-01..10 | Sim: pagável soma, recebível subtrai no grupo (ou bloquear categoria de kind incompatível na criação). |
| D4 | **Fechamento mensal por `scheduledDate`** (S-04): trocar para `executedAt` (data real do caixa, a mesma da conciliação e do orçamento)? Na base atual não há diferença (0 divergentes). | REL-13, REL-18, REL-19 | Sim, `executedAt` no fuso da empresa. |
| D5 | **Saldo disponível**: mantido por decisão sua (abertura + extrato importado). Registrado; nada a fazer além de documentar. Fica o alerta de que o extrato importado é 100% mock em produção. | DSH-01, REL-01/16, FLX-07/08 | Desligar o `bank_sync` mock em produção (`INTEGRATION_BANK=mock` gera transações fictícias diariamente) até o Pluggy entrar. |
| D6 | **Janela de "7 dias"**: hoje..hoje+7 são 8 dias corridos, enquanto o gráfico usa semanas de 7. Manter? | DSH-03/04 | Manter e deixar o limite no rodapé (já está), ou mudar para hoje..hoje+6. |
| D7 | **Baixas por conciliação sem `Payment`**: painel ignora e mostra aviso (sua decisão 1). Além disso: manter esse caminho na conciliação ou passar a criar um `Payment` executado (resolveria CAP-01/D9, ORC-02 e CON-26)? | CON-04, CAP-01, ORC-02, painel | Criar `Payment` executado na baixa por conciliação. |
| D8 | **"Valores divergentes" da auditoria de conciliação** (S6): definir o "esperado" para título — saldo restante ANTES da baixa (remaining + aplicado)? Com baixa parcial habilitada, aplicado < esperado é normal. | CON-27 | Esperado = saldo antes da baixa; divergência só quando aplicado > esperado + tolerância, ou quando o match não é parcial e |aplicado − esperado| > tolerância. |
| D9 | **Situação "Pago" de título baixado por conciliação** (sem Payment): mostrar "Pago" sem saber se foi em atraso é aceitável? | CAP-01 | Resolve-se com D7. |
| D10 | **Conciliação com tolerância soma sem clamp**: `paidCents`/`receivedCents` podem exceder o valor (0 casos hoje). Limitar ao saldo e lançar a diferença como despesa/receita financeira? | CAP-06, CAR-05, FAT-03 | Clamp no saldo + lançamento contábil da diferença. |
| D11 | **Encargos sobre o saldo restante** (list_due/list_overdue) em vez do valor original do título. Confirmar. | CAP-12, CAR-11, COB-14 | Manter (saldo restante). |
| D12 | **`register_receipt` aceita conta bancária inativa** (só via API). Bloquear como em contas a pagar? | CAR-03 | Bloquear. |
| D13 | **Rótulo "60+"** cobre ≥ 61 dias. Renomear para "61+" ou mudar a faixa para ≥ 60? | COB-02, COB-09 | Renomear rótulo. |
| D14 | **DSO**: janela de 91 dias inclusivos × 90 e recibos com encargos no denominador. Ajustar para hoje−89..hoje e `principalCents`? | COB-05 | Sim. |
| D15 | **Régua de cobrança**: recebimento não cancela mensagens pendentes de aprovação; retomada envia sem revalidar saldo. | COB-13 | Cancelar pendências no recebimento e revalidar na retomada. |
| D16 | **Renegociação 3x**: juros de parcelamento sobre total que já inclui multa + juros, por 3 meses cheios. Política jurídica. | COB-19 | Validar com jurídico. |
| D17 | **Orçamento**: total mistura receitas e despesas no mesmo sinal; orçado 0 nunca alerta; alerta ignora kind; realizado de receita usa `amountCents` (com encargos); linha curinga + por categoria duplica. | ORC-02/05/06 | Separar totais por kind; alertar orçado 0 com realizado > 0; realizado de receita por `principalCents`. |

Divergências de tela/exportação registradas e não corrigidas (fora do escopo de fórmula, para um PR de UI): CAP-09/CAR-07 truncamento 5000 silencioso; CAP-10/CAR-08 coluna Status do arquivo; CAP-11 conta de pagamento com rejeitado; CON-11 "Localizar no extrato" pós-paginação; IND-05..08 rodapé "Período de apuração"; REL-21..23 valores em centavos nos arquivos; REL-26 PDF trunca textos; DSH-09/REL-11 percentual com ponto decimal; COB-01 limite 10% duplicado na UI.

## 15. Painel por Período (PNL) — fórmulas novas

Preenchido na Fase 3/4 (mesmo formato).
