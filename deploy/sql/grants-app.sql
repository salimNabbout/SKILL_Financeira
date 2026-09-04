-- Privilégios da role restrita da aplicação. IDEMPOTENTE e SEM SEGREDOS:
-- é versionado e roda a cada publicação (ver deploy/publicar.sh).
--
-- Se a role ainda não existir, o arquivo é um NO-OP silencioso — ambientes que
-- ainda não separaram as credenciais continuam publicando normalmente. Para
-- criar a role, use deploy/criar-role-app.sh (uma vez por ambiente).
--
-- Rodar à mão:
--   docker compose -f docker-compose.prod.yml --env-file .env.prod \
--     exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     < sql/grants-app.sql
--
-- Nome da role: financeira_app por padrão, trocável com -v role_app=outra.

\if :{?role_app}
\else
\set role_app 'financeira_app'
\endif

\echo 'Aplicando privilégios para a role:' :role_app

-- Aviso quando não há o que fazer (o WHERE abaixo já cuida do no-op, mas em
-- silêncio parece que rodou).
SELECT CASE
         WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_app')
           THEN 'role encontrada — aplicando'
         ELSE 'role AUSENTE — nada aplicado (rode deploy/criar-role-app.sh)'
       END AS situacao;

-- As instruções são geradas e executadas com \gexec: a lista some inteira
-- quando a role não existe, então o script nunca falha por causa disso.
SELECT stmt FROM (
  VALUES
    -- Acesso básico ao banco e ao schema. A role NÃO recebe CREATE: quem cria
    -- tabela é o dono do banco, pelo container `migrate`.
    (1, format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'role_app')),
    (2, format('GRANT USAGE ON SCHEMA public TO %I', :'role_app')),

    -- Dados de negócio: a aplicação lê, insere, atualiza e apaga. DELETE é
    -- necessário de verdade (SupplierRepo.delete e IdempotencyRepo.remove).
    (3, format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'role_app')),
    (4, format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'role_app')),

    -- Trilha de auditoria: append-only também por PRIVILÉGIO, não só pelo
    -- gatilho. O gatilho barra a operação; isto tira a permissão de quem
    -- poderia desligar o gatilho. AuditHead mantém UPDATE porque a âncora é
    -- gravada por upsert — e o gatilho audit_head_seq_forward garante que o
    -- seq só avança.
    (5, format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditRecord" FROM %I', :'role_app')),
    (6, format('REVOKE DELETE, TRUNCATE ON TABLE "AuditHead" FROM %I', :'role_app')),

    -- Tabelas criadas por migrations FUTURAS já nascem acessíveis. Sem isto, a
    -- próxima migration que criar tabela derrubaria o app em runtime — e o erro
    -- apareceria só quando alguém usasse a tela nova.
    (7, format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      current_user, :'role_app')),
    (8, format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
      current_user, :'role_app'))
) AS t(ordem, stmt)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_app')
ORDER BY ordem
\gexec

-- Conferência: o que a role tem hoje nas duas tabelas da trilha.
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = :'role_app' AND table_name IN ('AuditRecord', 'AuditHead')
ORDER BY table_name, privilege_type;

-- Se vier `t`, o REVOKE não vale nada: superusuário ignora privilégios.
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = :'role_app';
