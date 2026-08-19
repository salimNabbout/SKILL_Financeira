# Changelog

Registro das mudanças relevantes. Datas em ISO (AAAA-MM-DD).

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
