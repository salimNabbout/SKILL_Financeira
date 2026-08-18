# Financeira PME — plataforma financeira multiagente para PMEs brasileiras

[![CI](https://github.com/salimNabbout/SKILL_Financeira/actions/workflows/ci.yml/badge.svg)](https://github.com/salimNabbout/SKILL_Financeira/actions/workflows/ci.yml)

Plataforma que centraliza a operação financeira de uma PME sobre uma arquitetura de **11 skills
especializadas** (Contas a Pagar, Contas a Receber, Faturamento, Tesouraria/Fluxo de Caixa,
Conciliação Bancária, Cobrança/Inadimplência, Orçamento, Controladoria/Indicadores, Integração
Contábil/Fiscal, Controles Internos/Auditoria e Relatórios Gerenciais) coordenadas por um
**orquestrador central** com idempotência, aprovações humanas por alçada, segregação de funções
e trilha de auditoria imutável.

- **Fonte oficial dos dados**: PostgreSQL (Prisma). Respostas de IA nunca são fonte de dados.
- **Regras financeiras determinísticas** em código, com fórmula/período/fonte declarados; IA
  (mock heurístico plugável) apenas sugere classificação e explica.
- **Nenhuma skill movimenta dinheiro sem aprovação humana** — e toda integração externa do MVP
  (banco, NF-e, envio de mensagens) é **mock identificado**.

Documentação completa (entregáveis): [`docs/`](docs/) — resumo e premissas, perguntas em aberto,
arquitetura (diagramas), catálogo e contratos das skills, orquestrador (regras + pseudocódigo),
modelo de dados, APIs e eventos (`docs/openapi.yaml`), wireframes, estrutura, roadmap e
critérios de aceite.

## Como executar

Pré-requisito: Node.js 22+.

### Modo demonstração (sem banco — recomendado para conhecer o produto)

```bash
npm install
npm run demo          # Next.js em http://localhost:3000 com dados fictícios em memória
```

Login (empresa fictícia **Café Aurora Ltda**, senha `demo1234` para todos):

| E-mail | Papel | Alçada |
|---|---|---|
| `ana@cafeaurora.com.br` | Administradora | ilimitada |
| `bruno@cafeaurora.com.br` | Gestor financeiro | até R$ 50.000 |
| `diego@cafeaurora.com.br` | Aprovador | até R$ 5.000 |
| `carla@cafeaurora.com.br` | Analista (cria, não aprova) | — |
| `elisa@cafeaurora.com.br` | Contadora | — |

Roteiro de demonstração sugerido:

1. **Dashboard** — posição de caixa, alertas e aprovações pendentes.
2. **Contas a pagar** — crie um título (fluxo integrado AP → Controles → Tesouraria → Orçamento)
   e depois **agende o pagamento** com a Carla: vira aprovação pendente.
3. **Aprovações** — entre com o Diego e aprove (a Carla não consegue aprovar o que solicitou —
   segregação de funções).
4. **Conciliação** — cole um OFX/CSV (há transações demo não conciliadas) e veja conciliação
   automática + sugestões para revisão.
5. **Cobrança** — rode a régua: mensagens ficam aguardando aprovação; o envio é mock.
6. **Fluxo de caixa, DRE, Indicadores, Orçamento, Relatórios** (com export CSV/PDF) e
   **Auditoria** (cadeia de hash verificada).

### Modo produção local (PostgreSQL)

```bash
cp .env.example .env            # ajuste SESSION_SECRET; deixe DEMO_MODE vazio/0
docker compose up -d db
npm run db:generate
npm run db:migrate
npm run db:seed                 # mesma carga de demonstração, agora persistida
npm run dev
```

### Testes e verificação

```bash
npm test              # unitários + integração (Vitest)
npm run typecheck     # TypeScript strict
npm run test:e2e      # smoke E2E (Playwright; sobe o app em modo demo na porta 3100)
```

Para o E2E, instale os navegadores com `npx playwright install chromium` — ou, se já houver um
Chromium no ambiente, aponte `PLAYWRIGHT_CHROMIUM_PATH=/caminho/do/chromium`.

## API

REST em `/api/v1` (mesma sessão por cookie da UI) — especificação em
[`docs/openapi.yaml`](docs/openapi.yaml). Porta de entrada do orquestrador:

```
POST /api/v1/flows/{flow}/execute   { "payload": {...}, "idempotencyKey": "opcional" }
```

Reenviar a mesma requisição **não** duplica lançamentos (`idempotent_replay: true`).

## Critérios de aceite e limitações

Ver [`docs/12-criterios-aceite-e-limitacoes.md`](docs/12-criterios-aceite-e-limitacoes.md) —
inclui o passo a passo de verificação de cada critério e as limitações conhecidas do MVP
(mocks identificados, escopo e recomendações para produção).
