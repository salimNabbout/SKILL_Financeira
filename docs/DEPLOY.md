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

O schema é versionado em `prisma/migrations/` (0001 → 0019). Rode **antes** de
subir a aplicação nova, no banco apontado por `DATABASE_URL`:

```bash
npm ci                 # instala deps (postinstall gera o Prisma Client)
npm run db:migrate     # = prisma migrate deploy (aplica migrações pendentes)
```

`prisma migrate deploy` é **idempotente**: aplica só o que falta e não repete o
que já foi aplicado. As migrações desta série são todas **aditivas** (colunas
opcionais, tabelas `AuditHead` e `StatementImport`, gatilhos append-only da
trilha, índices) — não destroem dados.

> **`0019_statement_import`** cria a tabela do lote de importação de extrato.
> Não há backfill: lotes importados antes dela não têm registro, e a auditoria
> de conciliação trata a ausência como "sem saldo de referência". O primeiro OFX
> importado depois do deploy já traz a referência.

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

> ⚠️ **O agendador precisa ser REINICIADO a cada deploy.** Ele é um processo de
> vida longa que carrega a definição dos fluxos na memória ao iniciar: passos
> novos (como a auditoria de conciliação acrescentada a `bank_sync` e a
> `daily_summary`) só passam a rodar depois do restart. Sem isso, o código novo
> está no ar pela web e o agendador continua executando a versão antiga dos
> fluxos — silenciosamente, sem erro nenhum.
>
> No deploy padrão da VPS isso já acontece: `deploy/publicar.sh` faz
> `docker compose up -d --force-recreate app scheduler`. Em deploy manual, ou
> com o agendador sob systemd/PM2 fora do compose, reinicie-o à mão:
>
> ```bash
> docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod >   up -d --force-recreate scheduler
> # ou, fora do compose:
> systemctl restart financeira-scheduler   # pm2 restart scheduler
> ```
>
> Conferir que subiu com o código novo:
> ```bash
> docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod >   logs --tail 20 scheduler
> ```

```bash
# Agendador: bank_sync 6h, daily_summary 7h, dunning_run 8h (horas locais da empresa).
# Também recupera flowRuns presos (reaper) e imprime a âncora diária da trilha
# de auditoria. Disparos são idempotentes por balde de tempo.
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

- **`docker-compose.yml`**: já faz bind em `127.0.0.1` por padrão (banco/Redis
  não expostos na rede) e lê a senha de env. Em produção, defina
  `POSTGRES_PASSWORD` com um valor forte (e o mesmo em `DATABASE_URL`):
  ```bash
  POSTGRES_PASSWORD='<senha-forte>' docker compose up -d db
  ```
  `DB_BIND` / `REDIS_BIND` permitem abrir para outras interfaces só quando
  necessário (default `127.0.0.1`).
- **Rate limiting** do login é **por processo**. Em várias réplicas, cada uma
  conta em separado; para um limite global, evolua para um limitador em Redis.
- **Backups** do PostgreSQL: a trilha de auditoria e a âncora de head garantem
  integridade *lógica*, não durabilidade — configure backups automáticos.

---

## 8. Ligar integrações externas reais (pós-publicação)

No MVP, as quatro integrações são **mock** (nenhum efeito externo). Elas podem
ser ligadas **depois da publicação**, uma de cada vez, sem reescrever o app: a
camada de negócio fala com **portas** (`src/core/integrations.ts`), e trocar o
mock por um provedor real é implementar a interface e registrá-la em
`src/integrations/registry.ts`. Um provedor real declarado mas não implementado
**falha na inicialização** (mock nunca é fallback silencioso).

**Molde pronto:** `src/integrations/providers/example-charge-provider.ts` é um
esqueleto comentado do adaptador de cobrança (credenciais via env, chamada HTTP,
mapeamento request/response e o webhook). Use-o como referência para qualquer uma
das quatro.

### Passo a passo (para cada adaptador)

1. **Implementar** a interface da porta num arquivo em `src/integrations/providers/`
   (copie o molde). Ler credenciais de env; falhar alto se faltarem.
2. **Registrar** em `src/integrations/registry.ts`: trocar o `assertMockOnly(...)`
   correspondente por uma seleção que aceite o novo provedor
   (ex.: `INTEGRATION_CHARGES=meupsp → new MeuPspChargeProvider(...)`).
3. **Configurar** as variáveis de ambiente do provedor + a variável de seleção.
4. **Homologar** primeiro em ambiente de teste do provedor (§ crítico p/ fiscal).
5. **Deploy** com a variável de seleção apontando para o provedor real.

### O que cada uma exige

| Integração | Variável de seleção | Credenciais/config (exemplos) | Homolog. | Webhook |
|---|---|---|---|---|
| **Cobrança** (Pix/boleto) | `INTEGRATION_CHARGES` | chaves do PSP (API key/OAuth), `CHARGES_PSP_BASE_URL` | recomendada | **SIM** (confirmação de pagamento) |
| **Dados bancários** (extrato) | `INTEGRATION_BANK` | agregador Open Finance (ex.: client id/secret) + **consentimento** do cliente | recomendada | opcional (atualização) |
| **Fiscal** (NF-e/NFS-e) | `INTEGRATION_FISCAL` | **certificado digital**, inscrição na SEFAZ/prefeitura | **obrigatória** | opcional (status) |
| **Mensageria** (e-mail/WhatsApp) | `INTEGRATION_MESSAGING` | credenciais do provedor de envio + opt-in/descadastro | opcional | opcional (entrega) |

### Webhook de confirmação de pagamento (cobrança) — peça NOVA

O mock só **emite** o código de cobrança. Com um PSP real, a **baixa automática**
depende de o PSP notificar o pagamento via **webhook**. É preciso criar uma rota
(ex.: `src/app/api/v1/webhooks/charges/route.ts`) que:

1. **valide a assinatura** do PSP (HMAC/segredo) **antes** de confiar no corpo —
   sem isso, um "pago" poderia ser forjado;
2. extraia o `external_reference` (o `receivableId` enviado ao criar a cobrança)
   e o valor/data pagos;
3. dispare a baixa **idempotente** pela skill `contas_a_receber` /
   `register_receipt` (mesmo caminho da baixa manual) — PSPs reenviam webhooks;
4. responda 200 rapidamente.

A rota de webhook é **pública** (o PSP chama de fora): autentica-se pela
assinatura do PSP, **não** pelo cookie de sessão. Ao criá-la, avalie isentá-la do
middleware CSRF (o matcher cobre `/api/v1/**`) ou validar por assinatura.

### Ordem sugerida de adoção

Do menor ao maior risco: **mensageria → cobrança → fiscal** (o fiscal tem peso
regulatório maior — sempre homologue antes de produção).
