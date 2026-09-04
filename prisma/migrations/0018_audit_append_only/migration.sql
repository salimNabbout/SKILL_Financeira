-- Trilha de auditoria: append-only NO BANCO, não só por convenção.
--
-- O contrato "append-only" existia apenas no código (AuditRepo não expõe update
-- nem delete). Qualquer acesso direto ao banco — psql, uma migration futura, um
-- ORM mal usado — apagava ou reescrevia registro sem nenhuma barreira, e a
-- cadeia de hash só denuncia adulteração de CONTEÚDO ou truncamento do meio.
-- Estes gatilhos fecham a porta na própria tabela.

-- AuditRecord: nem UPDATE nem DELETE, nunca.
CREATE OR REPLACE FUNCTION audit_record_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditRecord é append-only: % não é permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_record_append_only ON "AuditRecord";
CREATE TRIGGER audit_record_append_only
  BEFORE UPDATE OR DELETE ON "AuditRecord"
  FOR EACH ROW EXECUTE FUNCTION audit_record_append_only();

-- AuditHead: DELETE proibido. UPDATE continua permitido (o upsert da âncora
-- depende dele), mas só PARA FRENTE: baixar o seq desfaria a proteção contra
-- truncamento do fim, que é justamente o que a âncora existe para detectar.
CREATE OR REPLACE FUNCTION audit_head_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditHead não pode ser apagado (âncora da trilha)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_head_no_delete ON "AuditHead";
CREATE TRIGGER audit_head_no_delete
  BEFORE DELETE ON "AuditHead"
  FOR EACH ROW EXECUTE FUNCTION audit_head_no_delete();

CREATE OR REPLACE FUNCTION audit_head_seq_forward() RETURNS trigger AS $$
BEGIN
  IF NEW.seq <= OLD.seq THEN
    RAISE EXCEPTION 'AuditHead.seq só avança: tentativa de ir de % para %', OLD.seq, NEW.seq;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_head_seq_forward ON "AuditHead";
CREATE TRIGGER audit_head_seq_forward
  BEFORE UPDATE ON "AuditHead"
  FOR EACH ROW EXECUTE FUNCTION audit_head_seq_forward();
