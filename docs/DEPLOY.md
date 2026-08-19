# Deploy em produção — Financeira PME

Checklist e comandos para publicar o app com PostgreSQL real. Complementa o
`README.md` (que cobre demo e produção local). **Requisito: Node.js 22+.**

> **Antes de tudo — natureza do MVP:** todas as integrações externas (banco,
> Pix/boleto, NF-e, mensageria) são **mock**. O app organiza a operação
> financeira (títulos, aprovações, trilha de auditoria, relatórios), mas **não
> movimenta dinheiro nem emite nota fiscal reais**. Publicar é adequado para uso
> interno operacional; um sistema transacional real exige implementar os
> adaptadores reais antes (`INTEGRATION_*`).

---

## 1. Variáveis de ambiente

Copie `.env.example` para `.env` (ou configure no painel do provedor) e ajuste:

### Obrigatórias

| Variável | Valor | Observação |
|---|---|---|
| `NODE_ENV` | `production` | Ativa os endurecimentos (ex.: cookie `secure`, exigência de `SESSION_SECRET`). |
| `DATABASE_URL` | `postgresql://USER:SENHA@HOST:5432/DB?schema=public` | Fonte oficial dos dados. Use credenciais fortes, **não** as de exemplo. |
| `SESSION_SECRET` | segredo forte e aleatório | **O app se recusa a iniciar em produção** sem ele ou com o placeholder. Gere com `openssl rand -base64 48`. |

### Deixe assim (NÃO em produção)

| Variável | Valor em produção | Por quê |
|---|---|---|
| `DEMO_MODE` | **vazio ou ausente** | `DEMO_MODE=1` roda tudo em memória e perde os dados a cada restart. |

### Opcionais

| Variável | Default | Quando mudar |
|---|---|---|
| `DEFAULT_TIMEZONE` | `America/Sao_Paulo` | Fuso padrão (empresas podem sobrescrever na config). |
| `AI_PROVIDER` | `mock` | `anthropic` ativa a IA real (exige `ANTHROPIC_API_KEY`; sem chave, o boot falha). |
| `ANTHROPIC_API_KEY` | — | Necessária se `AI_PROVIDER=anthropic`. |
| `INTEGRATION_BANK` / `_CHARGES` / `_FISCAL` / `_MESSAGING` | `mock` | Só mude quando houver adaptador real implementado (senão o boot falha — mock nunca é fallback silencioso). |
| `EVENT_BUS` | in-process | `bullmq` + `REDIS_URL` ativam a fila real (worker separado — ver §5). |
| `REDIS_URL` | — | Necessária se `EVENT_BUS=bullmq`. |
| `SCHEDULER_INTERVAL_MS` | `60000` | Intervalo do agendador (processo separado — ver §5). |

**Gerar o `SESSION_SECRET`:**
```bash
openssl rand -base64 48
```

---

## 2. Migrações do banco

O schema é versionado em `prisma/migrations/` (0001 → 0007). Rode **antes** de
subir a aplicação nova, no banco apontado por `DATABASE_URL`:

```bash
npm ci                 # instala deps (postinstall gera o Prisma Client)
npm run db:migrate     # = prisma migrate deploy (aplica migrações pendentes)
```

`prisma migrate deploy` é **idempotente**: aplica só o que falta e não repete o
que já foi aplicado. As migrações 0005–0007 (adicionadas nesta série) são todas
**aditivas** (colunas opcionais, tabela `AuditHead`, índices) — não destroem dados.

> **Primeira publicação (banco vazio):** para popular a carga de demonstração
> (empresa fictícia Café Aurora), rode `npm run db:seed` **uma vez**. Em um banco
> de produção real com dados próprios, **não** rode o seed.

---

## 3. Build e start

```bash
npm run build          # next build
npm run start          # next start (porta 3000; use PORT=... para mudar)
```

Sirva atrás de um proxy reverso com **HTTPS** (o cookie de sessão é `secure` em
produção — sem TLS o login não persiste). Garanta que o proxy repasse o IP real
em `X-Forwarded-For` (o rate limiting do login usa esse header).

---

## 4. Verificação pós-deploy (smoke)

- [ ] O app **iniciou** (se `SESSION_SECRET` faltar, ele falha no boot — isso é esperado).
- [ ] `GET /login` responde 200.
- [ ] Login com um usuário real funciona e a sessão persiste (cookie `secure` sob HTTPS).
- [ ] Uma página protegida (ex.: `/`) carrega os dados do PostgreSQL (não dados demo).
- [ ] A página `/auditoria` mostra a cadeia de hash **íntegra**.
- [ ] Uma mutação cross-site em `/api/v1/...` (com `Origin` de outro host) recebe **403** (CSRF).

Opcional, contra o banco de produção (cuidado — cria dados de teste):
```bash
npx tsx scripts/smoke-prisma.ts   # exercita orquestrador + skills sobre Prisma real
```

---

## 5. Processos auxiliares (opcionais, terminais/serviços separados)

Só valem no modo produção (PostgreSQL). Rode como serviços gerenciados
(systemd/PM2/container próprio), não no mesmo processo do web:

```bash
# Agendador: bank_sync 6h, daily_summary 7h, dunning_run 8h (horas locais da empresa).
# Também recupera flowRuns presos (reaper). Disparos são idempotentes por balde de tempo.
npx tsx scripts/scheduler.ts

# Worker da fila (apenas se EVENT_BUS=bullmq):
EVENT_BUS=bullmq REDIS_URL=redis://HOST:6379 npx tsx scripts/event-worker.ts
```

---

## 6. Rollback

- **App:** faça deploy da versão anterior (imagem/commit).
- **Migrações:** as 0005–0007 são aditivas — reverter o app **não** exige reverter
  o schema (colunas/índices extras são inofensivos para a versão anterior). Só
  crie uma migração de reversão se precisar remover o schema por outro motivo.

---

## 7. Endurecimentos recomendados (não bloqueiam, mas faça)

- **`docker-compose.yml`** (se usado em produção): o Postgres usa senha fraca
  (`financeira`) e publica portas em todas as interfaces. Para produção, use
  senha via variável e faça bind em `127.0.0.1` (ex.: `127.0.0.1:5432:5432`).
- **Rate limiting** do login é **por processo**. Em várias réplicas, cada uma
  conta em separado; para um limite global, evolua para um limitador em Redis.
- **Backups** do PostgreSQL: a trilha de auditoria e a âncora de head garantem
  integridade *lógica*, não durabilidade — configure backups automáticos.
