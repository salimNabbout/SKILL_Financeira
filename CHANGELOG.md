# Changelog

Registro das mudanças relevantes. Datas em ISO (AAAA-MM-DD).

---

## 2026-09-04 — Auditoria de conciliação: extrato × baixas

A conciliação só olhava numa direção — do extrato para os títulos. Quatro perguntas ficavam sem
resposta, e a mais séria era: **quais baixas do app não têm lastro no extrato?** É o caso de
alguém marcar um título como pago sem que o dinheiro tenha saído.

A ação nova `reconciliation_audit` responde as quatro: extrato do período ainda sem explicação,
baixas sem contrapartida bancária, conciliações com valor fora da tolerância e saldo do app
contra o saldo que o banco declara. É **100% leitura**: aponta e alerta, não corrige nada.

**O `<LEDGERBAL>` do OFX deixou de ser descartado.** Ele é a única referência externa para
conferir o saldo calculado, e agora fica guardado no lote de importação (tabela `StatementImport`,
migração `0019`). Sem backfill: lotes anteriores não têm registro, e a auditoria trata a ausência
como "sem saldo de referência".

Duas decisões que evitam alarme falso, e que são o miolo do trabalho:

- **A diferença de saldo é decomposta.** O saldo calculado exclui transações não conciliadas por
  construção; o do banco inclui tudo. Comparar cru daria alerta crítico permanente para qualquer
  empresa com extrato pendente. Só o **resíduo** — a diferença menos o que o extrato pendente e as
  baixas sem lastro explicam — gera alerta.
- **Cobertura do extrato.** Baixa feita depois do último extrato importado não é divergência: é o
  estado normal de quem paga hoje e importa amanhã. Ela conta em `pendingCoverageCount` e aparece
  como linha informativa na tela, nunca como problema.

Também: seção "Divergências do período" na tela de Conciliação, relatório
`GET /api/v1/reports/reconciliation_audit` em csv/xlsx/pdf com uma linha por divergência, e
execução automática dentro de `bank_sync` e do `daily_summary` — sem agenda nova.

> **No deploy:** rodar `npm run db:migrate` e **reiniciar o processo do agendador**, que carrega
> a definição dos fluxos na memória ao iniciar. Ver `docs/DEPLOY.md`.

Dívida conhecida registrada em [#108](https://github.com/salimNabbout/SKILL_Financeira/issues/108):
2 erros de `tsc` em fixtures de teste e a corrida entre specs E2E que compartilham o servidor demo.
Ambos anteriores a este trabalho.

---

## 2026-09-04 — Conciliação: fim dos falsos positivos em série

O card **"2 — Sugestões pendentes de revisão"** vinha propondo baixas parciais absurdas: bastava um
token genérico da razão social aparecer na descrição do extrato. Uma tarifa de R$ 36,51 com a
descrição `TARIFA PACOTE SERVICOS` era sugerida como baixa parcial de um título da
`LIGHT SERVICOS DE ELETRICIDADE S A` de R$ 215,20 vencido 20 dias antes — 65% de confiança, só
porque `"servicos"` casava dos dois lados.

**Baixa parcial (Fase 4) desligada por padrão.** Nova configuração
`reconciliationEnablePartial` (default `false`), no mesmo padrão das demais chaves
`reconciliation*`. A fase continua no código e volta a rodar quando a flag é ligada — só não é
mais o comportamento padrão. As Fases 1, 2 e 3 (casamento exato, transferência entre contas e
rateio com soma exata) **não mudaram**: nem lógica, nem limiares, nem ordenação.

**Novo tipo de alvo `bank_fee` — despesa bancária.** Débitos cuja descrição casa com
tarifa/IOF/juros/encargo/cesta/pacote de serviços/anuidade passam a virar sugestão própria
(confiança fixa 0,80, **nunca automática**), avaliada **antes** dos demais fallbacks. Antes,
esses débitos ou viravam falso positivo na Fase 4 ou ficavam órfãos em "não conciliadas".

Confirmar uma despesa bancária concilia a transação e **lança a despesa** — o app não tinha rota
para despesa sem título, então foi criada a mínima: um `AccountingEntry` de ajuste (débito em
despesa operacional, crédito em caixa) usando as **mesmas contas** da skill contábil, agora
exportadas para não duplicar código mágico. O lançamento é idempotente pela origem (`fee:<txId>`),
e a classificação da tarifa é sinalizada como pendente de validação do contador. Rejeitar mantém a
transação não conciliada, como nos demais tipos.

**Fase 4 endurecida, para quando a flag estiver ligada.** Passou a exigir que o vencimento esteja
**dentro da tolerância de dias** configurada (antes, um vencimento 77 dias distante pontuava 0,00
em data e a sugestão nascia mesmo assim) e que **dois tokens** do nome da contraparte apareçam na
descrição — ou um único com 6 letras ou mais. A `NAME_STOPWORDS` deixou de conter só sufixos
societários e agora inclui termos genéricos de razão social: serviços, comércio, indústria,
Brasil, engenharia, manutenção, distribuidora, consultoria, tecnologia, participações,
empreendimentos, soluções, sistemas, construtora, transportes e logística.

---

## 2026-08-19 — QR Code no cadastro do 2FA

A tela **Segurança** passa a exibir um **QR Code** da URI otpauth, em vez de apenas a chave base32
e a URI em texto. O código é gerado **no servidor** e desenhado como SVG em JSX — sem
`dangerouslySetInnerHTML`, sem script no cliente e sem nenhuma API externa de QR: o segredo TOTP é
o segundo fator e não pode sair para terceiros. A chave base32 continua visível para digitação
manual (com o rótulo "Não consegue ler o QR Code?"), e a URI completa fica atrás de um
`<details>`. Dependência nova: `qrcode`.

---

## 2026-08-19 — Revisão, correções e publicação em produção

Sessão de revisão de código (multi-agente), correção dos achados, endurecimento
para produção e **publicação** do app em `https://financeira.cetemrj.com.br`
(Next.js + PostgreSQL em Docker, atrás de nginx com HTTPS).

Cada item abaixo foi entregue via Pull Request com CI verde (typecheck, testes
unitários/integração, Postgres+Redis reais e E2E). A suíte cresceu de ~430 para
**498 testes**.

### Correções de bugs — severidade Crítica e Alta (PR #16)
- **S1 (Crítico):** `SESSION_SECRET` com fallback público — o app agora recusa
  iniciar em produção sem um segredo forte.
- **W1:** `upsert_budget` sem checagem de permissão (`budget.manage`).
- **W3:** contas a pagar sem teto de parcelas (limite 120, simétrico a receber).
- **I1:** injeção de fórmula CSV no exportador.
- **E1/E2:** `resolveCompanyConfig` sem validação (NaN em juros); alçada
  escalável por ordem dos tiers.
- **D7:** ponto de equilíbrio descontava deduções duas vezes.
- **D1 (Crítico):** dupla baixa via dois agendamentos do mesmo título.
- **D2/D5:** chave natural sem datas (recorrência descartada); alçada burlável
  fracionando o pagamento.
- **D3/D4/D6:** refaturamento duplicando títulos; transação conciliada duas
  vezes; encargos sem caminho de registro.
- **A1/A2 (Crítico):** idempotência check-then-act (duplo clique) e
  `decideApproval` sem trava — ambos agora atômicos.
- **A3:** replay eterno de relatórios diários (data na chave de idempotência).
- **C1/C2:** cadeia de auditoria bifurcava sob concorrência e não detectava
  truncamento do fim.
- **B1 (parcial):** recuperação de aprovação com vínculo `flowRun.approvalId`
  perdido.

### Segurança — severidade Média (PR #17)
- Login com **rate limiting** por IP+e-mail e **scrypt assíncrono**.
- **CSRF**: bloqueio de mutações cross-site em `/api/v1` (middleware).
- **RBAC** nas rotas de leitura da API (espelha os papéis da UI).
- **TOTP anti-replay** (migração `0005`): mesmo código não é reutilizável.

### Residuais estruturais (PR #18)
- **`withTransaction`**: atomicidade de negócio na execução de pagamento.
- **Four-eyes** sem lost-update (trava otimista por versão — migração `0006`).
- **Âncora de auditoria** persistida (detecta truncamento do fim; migração `0006`).
- **Reaper** de `flowRuns` presos, ligado ao scheduler.

### Robustez — severidade Média/Baixa (PR #19)
- Parsers monetários rejeitam grupos de milhar malformados (bug de 100×).
- XLSX remove caracteres de controle inválidos em XML 1.0.
- Importadores: limite no texto colado; aceita sinal ao final e parênteses
  contábeis; OFX decodifica entidades SGML.
- Contas a receber valida `dueDate ≥ issueDate`; controles internos deixa de
  acusar parcelas legítimas como duplicidade.
- Índices Postgres para as consultas por FK (migração `0007`).

### Deploy e documentação
- **Guia + script de deploy** (`docs/DEPLOY.md`, `scripts/deploy.sh`) — PR #21.
- **docker-compose endurecido** (bind local, senha via env) — PR #22.
- **Molde de adaptador de integração real** (`example-charge-provider.ts`) e guia
  de adoção pós-publicação (`docs/DEPLOY.md §8`) — PR #23.
- **Empacotamento Docker para a VPS** (Dockerfile standalone, compose de
  produção, vhost nginx, runbook `deploy/README.md`) — PR #24.

### Correções descobertas no deploy real (PRs #25–#27)
- Migração no container falhava por causa da CLI do Prisma / `.wasm` e deps
  faltando (`effect`). Solução: rodar migrações num **serviço `migrate`** com
  `node_modules` completo (PRs #25, #26).
- Login falhava com `Invalid Server Actions request` atrás do proxy (Host×Origin
  com ponto final). Solução: nginx envia Host limpo + `allowedOrigins` (PR #27).

### Primeiro acesso e docs finais
- **`scripts/create-admin.ts`**: cria empresa + admin reais no primeiro acesso,
  sem dados fictícios (PR #28).
- **README** com seção de publicação e **lições do primeiro deploy** no
  `deploy/README.md` (PR #29).

### Marco
- **App publicado e operante** em `https://financeira.cetemrj.com.br`, com HTTPS,
  PostgreSQL (7 migrações aplicadas), containers isolados dos demais sites da VPS
  e usuário admin real criado.
- Integrações externas (banco, Pix/boleto, NF-e, mensageria) seguem **mock** — o
  app serve para uso interno operacional; ligar provedores reais é aditivo
  (`docs/DEPLOY.md §8`).

---

## 2026-08-18 a 2026-08-19 — Desenvolvimento inicial (MVP → v1.2)

Construção original da plataforma, anterior à sessão de revisão acima
(PRs #1 a #14):

- **MVP (PR #1):** 11 skills especializadas + orquestrador central com
  idempotência, aprovações por alçada, segregação de funções e trilha de
  auditoria imutável.
- **v1.1 (PRs #2–#6):** upload real OFX/CSV na conciliação; gestão de usuários e
  troca de empresa; baixas parciais/rateio/transferências; exportação Excel;
  paginação, fila BullMQ/Redis e CNAB240.
- **v1.2 (PRs #7–#13):** camada de integrações (portas + mocks); previsão
  estatística de fluxo de caixa e anomalias; 2FA TOTP + política de senha +
  dupla aprovação; exportação contábil declarativa; agendador de rotinas; IA
  real (Anthropic) opcional atrás da interface; resumo narrativo por IA.
- **DX (PR #14):** correções de ambiente no Windows.
