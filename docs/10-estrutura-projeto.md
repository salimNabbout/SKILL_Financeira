# 11. Estrutura de diretórios do projeto

```
SKILL_Financeira/
├── docker-compose.yml          # PostgreSQL 16 (+ Redis reservado p/ evolução do bus)
├── package.json                # scripts: dev, demo, test, typecheck, db:*, test:e2e
├── playwright.config.ts        # E2E sobe o app em modo demo na porta 3100
├── vitest.config.ts
├── prisma/
│   ├── schema.prisma           # modelo de dados (fonte oficial)
│   ├── migrations/0001_init/   # SQL gerado do schema
│   └── seed.ts                 # seed do Postgres com os dados de demonstração
├── docs/                       # entregáveis 1–12 + openapi.yaml
├── e2e/                        # teste E2E Playwright (smoke em modo demo)
└── src/
    ├── core/                   # DOMÍNIO PURO — sem Next, sem Prisma
    │   ├── types.ts            # envelope padrão SkillResult
    │   ├── entities.ts         # entidades (centavos, ISODate)
    │   ├── repositories.ts     # interfaces de persistência
    │   ├── skill.ts            # SkillDefinition, SkillContext, runSkill
    │   ├── events.ts           # EventBus + outbox in-process
    │   ├── audit.ts            # trilha hash-chain + verifyChain
    │   ├── auth.ts             # RBAC, alçadas, segregação de funções
    │   ├── config.ts           # CompanyConfig (políticas como dados)
    │   ├── money.ts / dates.ts / ids.ts / clock.ts / errors.ts / ai.ts
    │   ├── integrations.ts     # portas: banco, cobrança, fiscal, mensageria
    │   ├── stats.ts            # estatística robusta (mediana/MAD/Theil–Sen)
    │   ├── password-policy.ts  # política de senha configurável (validador)
    │   ├── orchestrator/
    │   │   ├── orchestrator.ts # motor: idempotência, aprovações, consolidação
    │   │   ├── flows.ts        # fluxos integrados declarativos
    │   │   └── registry.ts
    │   └── __tests__/          # testes do núcleo + integração ponta-a-ponta
    ├── skills/                 # AS 11 SKILLS (uma pasta cada, com __tests__/)
    │   ├── index.ts            # buildRegistry()
    │   ├── contabil/layouts.ts # layouts declarativos de exportação contábil
    │   ├── contas-a-pagar/  contas-a-receber/  faturamento/
    │   ├── tesouraria/  conciliacao/  cobranca/  orcamento/
    │   ├── controladoria/  contabil/  controles-internos/  relatorios/
    ├── adapters/
    │   ├── memory/             # repositórios em memória + test-env + demo-seed
    │   └── prisma/             # repositórios PostgreSQL (produção)
    ├── integrations/           # adaptadores das portas de integração
    │   ├── mock.ts             # mocks determinísticos (identificados)
    │   └── registry.ts         # seleção por env INTEGRATION_* (falha alto)
    ├── lib/
    │   ├── container.ts        # composição (demo × prisma) — singleton
    │   ├── session.ts / password.ts / totp.ts   # autenticação + 2FA (RFC 6238)
    │   ├── format.ts           # formatação pt-BR
    │   ├── importers/          # OFX, CSV (reais) e CNAB (stub declarado)
    │   └── exporters/          # CSV (BOM/; BR) e PDF (pdf-lib)
    ├── components/ui.tsx       # primitivas de UI compartilhadas
    └── app/
        ├── login/              # autenticação
        ├── (app)/              # telas autenticadas (dashboard, títulos, caixa,
        │                       #  conciliação, cobrança, orçamento, DRE,
        │                       #  indicadores, aprovações, alertas, relatórios,
        │                       #  cadastros, auditoria)
        └── api/v1/             # API REST (OpenAPI em docs/openapi.yaml)
```

Regras de dependência (de cima para baixo, nunca o contrário):

```
app / api  →  lib  →  skills  →  core  ←  adapters
```

- `core` não importa nada de fora do próprio domínio (testável isolado).
- `skills` dependem apenas de `core` (repositórios via interface).
- `adapters` implementam as interfaces de `core` (memória e Prisma são intercambiáveis).
- `app`/`api` só tocam o domínio através do `container` (orquestrador/repos) e da sessão.
