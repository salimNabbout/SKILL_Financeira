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

## 2. REVOKE na role da aplicação — hoje é um NO-OP

Os gatilhos barram a operação, mas quem pode `ALTER TABLE ... DISABLE TRIGGER`
os desliga. Revogar o privilégio fecharia essa porta.

**Só que hoje não fecha.** No `docker-compose.prod.yml`, `app`, `scheduler` e
`migrate` usam o mesmo `POSTGRES_USER`, e a imagem oficial do Postgres cria esse
usuário como **superusuário**. Superusuário ignora `GRANT`/`REVOKE` por
completo: o SQL abaixo rodaria sem erro e não protegeria nada.

### Pré-requisito: uma role dedicada, sem superpoderes

Antes do REVOKE fazer sentido é preciso separar quem lê e escreve de quem migra:

- criar uma role para o app e o scheduler, **sem** `SUPERUSER` e sem ser dona
  das tabelas;
- manter o dono do banco apenas para o container `migrate`;
- passar uma segunda `DATABASE_URL` no `.env.prod` e no compose, para que `app`
  e `scheduler` conectem com a role restrita.

Enquanto isso não existir, a proteção real é o gatilho — que vale para todo
mundo. Este documento registra a lacuna em vez de fingir que ela está fechada.

### O REVOKE, depois que a role existir

Não está na migration de propósito: o nome da role varia por ambiente, e uma
migration que cita role inexistente derruba o deploy inteiro. Rode uma vez por
ambiente, conectado como o dono do banco:

```sql
-- Troque financeira_app pelo nome real da role restrita.
REVOKE DELETE, TRUNCATE ON TABLE "AuditRecord" FROM financeira_app;
REVOKE UPDATE           ON TABLE "AuditRecord" FROM financeira_app;
REVOKE DELETE, TRUNCATE ON TABLE "AuditHead"   FROM financeira_app;

-- A aplicação precisa continuar podendo INSERIR e LER:
GRANT INSERT, SELECT         ON TABLE "AuditRecord" TO financeira_app;
GRANT INSERT, SELECT, UPDATE ON TABLE "AuditHead"   TO financeira_app;
```

Conferir:

```bash
$DC exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_name IN ('AuditRecord', 'AuditHead') ORDER BY grantee, privilege_type;
SELECT rolname, rolsuper FROM pg_roles WHERE rolname = 'financeira_app';
SQL
```

`rolsuper = t` significa que o REVOKE não vale nada — volte ao pré-requisito.

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
