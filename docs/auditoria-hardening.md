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

---

## 1. Gatilhos no banco (migration `0018_audit_append_only`)

Aplicados automaticamente pelo `prisma migrate deploy`:

| Tabela | Operação | Resultado |
|---|---|---|
| `AuditRecord` | `UPDATE` | `RAISE EXCEPTION 'AuditRecord é append-only'` |
| `AuditRecord` | `DELETE` | idem |
| `AuditHead` | `DELETE` | `RAISE EXCEPTION 'AuditHead não pode ser apagado'` |
| `AuditHead` | `UPDATE` com `seq <= seq atual` | `RAISE EXCEPTION 'AuditHead.seq só avança'` |

`UPDATE` em `AuditHead` continua permitido **para frente**: o upsert da âncora
depende dele. Baixar o `seq` desfaria justamente a proteção contra truncamento
do fim.

Conferir se os gatilhos estão instalados:

```sql
SELECT tgname, tgrelid::regclass AS tabela
FROM pg_trigger
WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('"AuditRecord"', '"AuditHead"');
```

Devem aparecer três: `audit_record_append_only`, `audit_head_no_delete` e
`audit_head_seq_forward`.

---

## 2. REVOKE de DELETE na role da aplicação (rodar À MÃO)

Os gatilhos barram a operação, mas a role da aplicação continua **tendo** a
permissão — e um `ALTER TABLE ... DISABLE TRIGGER` a devolve. Revogar o
privilégio fecha essa porta.

**Isto não está na migration de propósito:** o nome da role varia por ambiente
(Render, local, CI), e uma migration que referencia uma role inexistente falha o
deploy inteiro. Rode uma vez por ambiente, com um usuário administrador:

```sql
-- Troque financeira_app pelo nome real da role da aplicação.
-- Descobrir: SELECT current_user;  (conectado com a URL da aplicação)

REVOKE DELETE, TRUNCATE ON TABLE "AuditRecord" FROM financeira_app;
REVOKE UPDATE          ON TABLE "AuditRecord" FROM financeira_app;
REVOKE DELETE, TRUNCATE ON TABLE "AuditHead"   FROM financeira_app;

-- A aplicação precisa continuar podendo INSERIR e LER:
GRANT INSERT, SELECT ON TABLE "AuditRecord" TO financeira_app;
GRANT INSERT, SELECT, UPDATE ON TABLE "AuditHead" TO financeira_app;
```

Conferir o resultado:

```sql
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name IN ('AuditRecord', 'AuditHead')
ORDER BY grantee, privilege_type;
```

⚠️ Se a aplicação e as **migrations** usam a mesma role, o `REVOKE UPDATE` em
`AuditRecord` pode barrar uma migration futura que precise reescrever a tabela
(por exemplo, um backfill de coluna nova). Nesse caso, conceda temporariamente,
rode a migration e revogue de novo — e registre o porquê.
