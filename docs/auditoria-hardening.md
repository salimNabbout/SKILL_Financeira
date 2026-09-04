# Endurecimento da trilha de auditoria

A trilha (`AuditRecord`) é encadeada por hash: cada registro carrega o hash do
anterior, e `verifyChain` recomputa a cadeia inteira. Isso detecta **adulteração
de conteúdo** e **truncamento do início ou do meio**.

Duas coisas ela NÃO resolve sozinha, e é do que este documento trata:

1. **Truncamento do FIM.** Apagar os últimos registros deixa um prefixo
   perfeitamente válido. Por isso existe a âncora `AuditHead` (seq + hash do
   último registro) — e por isso a âncora precisa de uma cópia **fora do banco**.
2. **Quem tem acesso ao banco.** O contrato append-only vivia só no código
   (`AuditRepo` não expõe `update` nem `delete`). Qualquer `psql`, migration ou
   ORM mal usado passava por cima.

## Onde isto roda

Produção é `deploy/docker-compose.prod.yml` numa VPS: serviços `db` (Postgres
16), `app`, `migrate` e `scheduler`. O Postgres **não expõe porta** — só é
alcançável pela rede interna do compose, via `docker compose exec db`. As
credenciais vêm de `deploy/.env.prod`, que não é versionado.

Os blocos abaixo assumem este preâmbulo, na VPS:

```bash
cd /opt/financeira/deploy
set -a; . ./.env.prod; set +a
DC="docker compose -f docker-compose.prod.yml"
```

---

## 1. Gatilhos no banco (migration `0018_audit_append_only`)

Aplicados pelo container `migrate` (`prisma migrate deploy`) a cada publicação:

| Tabela | Operação | Resultado |
|---|---|---|
| `AuditRecord` | `UPDATE` | `RAISE EXCEPTION 'AuditRecord é append-only'` |
| `AuditRecord` | `DELETE` | idem |
| `AuditHead` | `DELETE` | `RAISE EXCEPTION 'AuditHead não pode ser apagado'` |
| `AuditHead` | `UPDATE` com `seq <= seq atual` | `RAISE EXCEPTION 'AuditHead.seq só avança'` |

`UPDATE` em `AuditHead` continua permitido **para frente**: o upsert da âncora
depende dele. Baixar o `seq` desfaria justamente a proteção contra truncamento
do fim.

Gatilho dispara para qualquer usuário, **superusuário incluído** — é por isso
que ele é a tranca que de fato funciona hoje (ver §2).

### Conferir que estão instalados

```bash
$DC exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
SELECT tgname, tgrelid::regclass AS tabela FROM pg_trigger
WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('"AuditRecord"', '"AuditHead"')
ORDER BY 2, 1;
SELECT count(*) AS registros FROM "AuditRecord";
SQL
```

Devem aparecer três: `audit_record_append_only`, `audit_head_no_delete` e
`audit_head_seq_forward`.

### Conferir que eles BARRAM — sem gravar nada

A transação é abortada pela própria exceção; o `ROLLBACK` apenas a encerra.
Nada é escrito no banco de produção.

```bash
$DC exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
BEGIN;
UPDATE "AuditRecord" SET action = 'tentativa' WHERE id = (SELECT id FROM "AuditRecord" LIMIT 1);
ROLLBACK;
SQL
```

Esperado: `ERROR: AuditRecord é append-only: UPDATE não é permitido`. Repita
trocando a linha do meio por `DELETE FROM "AuditRecord" WHERE id = (SELECT id
FROM "AuditRecord" LIMIT 1);` e por `DELETE FROM "AuditHead";`.

⚠️ **Se `registros` for 0, este teste não prova nada:** o gatilho é de linha e
não dispara quando o `UPDATE` não casa com ninguém. Confira a contagem antes de
acreditar no resultado.

### O que NÃO usar para isto

`scripts/smoke-prisma.ts` também cobre os gatilhos, mas **não pode rodar contra
produção**: ele percorre o caminho completo — cria título por quatro skills,
aprova, executa pagamento e grava na trilha. Em produção, injetaria um título e
registros de auditoria falsos na empresa real; e, com estes gatilhos ativos,
esses registros não sairiam mais de lá.

Ele precisa de um banco descartável, migrado e semeado:

```bash
$DC exec -T db createdb -U "$POSTGRES_USER" smoke_tmp
$DC run --rm \
  -e DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/smoke_tmp?schema=public" \
  migrate sh -c "npx prisma migrate deploy && npm run db:seed && npx tsx scripts/smoke-prisma.ts"
$DC exec -T db dropdb -U "$POSTGRES_USER" smoke_tmp
```

---

## 2. Role restrita para o app, e o REVOKE que a acompanha

Os gatilhos barram a operação, mas quem consegue `ALTER TABLE ... DISABLE
TRIGGER` os desliga. A segunda tranca é tirar o privilégio de quem não precisa
dele.

Isso não funcionava enquanto `app`, `scheduler` e `migrate` usavam o mesmo
`POSTGRES_USER`: a imagem oficial do Postgres cria esse usuário como
**superusuário**, e superusuário ignora `GRANT`/`REVOKE`. Hoje são duas
credenciais:

| Container | Role | Para quê |
|---|---|---|
| `migrate` | `POSTGRES_USER` — dono do banco, superusuário | criar e alterar tabelas |
| `app`, `scheduler` | `APP_DB_USER` — restrita, sem superpoderes | ler e escrever dados |

### Instalar (uma vez por ambiente)

1. Preencha `APP_DB_USER` e `APP_DB_PASSWORD` em `deploy/.env.prod`
   (`openssl rand -base64 24` para a senha).
2. Rode `deploy/criar-role-app.sh` — cria a role, aplica os privilégios e
   **verifica**, conectando como ela, que um `UPDATE` na trilha é recusado.
3. Publique (`deploy/publicar.sh`), para o app e o scheduler passarem a usar a
   credencial nova.

Enquanto os dois valores não existirem, `publicar.sh` cai no usuário dono e
avisa em voz alta: o deploy funciona, mas sem esta proteção.

### O que a role recebe

`deploy/sql/grants-app.sql` (versionado, sem segredos, idempotente):

| Objeto | Privilégio |
|---|---|
| banco / schema `public` | `CONNECT`, `USAGE` — sem `CREATE` |
| tabelas em geral | `SELECT, INSERT, UPDATE, DELETE` |
| `AuditRecord` | só `SELECT, INSERT` — `UPDATE`, `DELETE` e `TRUNCATE` revogados |
| `AuditHead` | `SELECT, INSERT, UPDATE` — `DELETE` e `TRUNCATE` revogados |

`AuditHead` mantém `UPDATE` porque a âncora é gravada por upsert; quem impede o
retrocesso é o gatilho `audit_head_seq_forward`. `DELETE` continua no geral
porque a aplicação apaga de verdade em dois lugares (`SupplierRepo.delete` e
`IdempotencyRepo.remove`).

### Manutenção: tabela nova não quebra o app

O script inclui `ALTER DEFAULT PRIVILEGES`, então tabelas criadas por migrations
futuras já nascem acessíveis à role. Além disso, `publicar.sh` reaplica o script
a cada publicação (passo 4/6) — idempotente, e no-op silencioso onde a role
ainda não existe.

⚠️ Se uma migration futura **recriar** `AuditRecord` ou `AuditHead`, a tabela
nova nasce com os privilégios padrão e o REVOKE se perde. O passo 4/6 do
`publicar.sh` reaplica logo em seguida, mas vale conferir.

### Conferir

```bash
$DC exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
WHERE table_name IN ('AuditRecord', 'AuditHead') ORDER BY grantee, table_name, privilege_type;
SELECT rolname, rolsuper FROM pg_roles WHERE rolname <> 'postgres' AND rolcanlogin;
SQL
```

`rolsuper = t` na role do app significa que o REVOKE não vale nada — a role foi
criada errada, refaça pelo `criar-role-app.sh`.

---

## 3. Âncora externa do head

`scripts/audit-anchor.ts` imprime uma linha JSON por empresa no **stdout**:

```json
{"companyId":"co_x","seq":128,"hash":"9f2c…","verifiedAt":"2026-09-04T03:00:00.000Z","ok":true}
```

O `scheduler` a executa **1x/dia** (primeiro tique de cada dia UTC), prefixada
com `audit-anchor `. O log do container passa a guardar uma cópia da âncora que
ninguém com acesso ao Postgres consegue reescrever. `ok: false` faz o script
sair com código 1 — a cadeia não fecha e precisa de investigação imediata.

Ler as âncoras já registradas, e rodar sob demanda:

```bash
$DC logs scheduler | grep audit-anchor
$DC exec -T scheduler npx tsx scripts/audit-anchor.ts
```

### Como comparar a âncora do log com o banco

Diante de suspeita de adulteração:

1. **Pegue a última âncora do log** (o `grep` acima), no período de interesse.

2. **Leia a âncora atual do banco**:

   ```bash
   $DC exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -c 'SELECT "companyId", seq, hash FROM "AuditHead";'
   ```

3. **Compare**:

   | Situação | Leitura |
   |---|---|
   | `seq` do banco **≥** o do log e a cadeia fecha | normal — a trilha só cresceu |
   | `seq` do banco **<** o do log | **truncamento do fim**: registros que existiam sumiram |
   | mesmo `seq`, `hash` **diferente** | **adulteração**: o conteúdo daquele ponto mudou |
   | cadeia não fecha (`ok:false` no script) | adulteração de conteúdo ou remoção no meio |

4. **Localize o ponto**: rodando o script, `brokenAtSeq` diz o primeiro `seq` em
   que a verificação falhou. Os registros a partir dali são os suspeitos.

5. **Reconstrua o histórico** com a cópia do log: as linhas diárias dão a
   sequência de `seq`/`hash` ao longo do tempo, e mostram entre quais dias a
   divergência apareceu.

⚠️ O log do Docker é rotacionado e vive no mesmo servidor que o banco — quem tem
root na VPS alcança os dois. Se a trilha for exigência regulatória, mande as
linhas `audit-anchor` para fora da máquina (o `deploy/pull-offsite.sh` já leva o
backup para fora; a âncora pode pegar carona).
