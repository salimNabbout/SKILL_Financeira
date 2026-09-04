/**
 * Criação de alertas — um único caminho, que SEMPRE audita.
 *
 * Antes, dez pontos do sistema chamavam `repos.alerts.create` direto: oito
 * repetiam o mesmo `persistAlertDeduped` copiado, e só dois (tesouraria e
 * relatórios) registravam `alert.created` na trilha. Resultado: a maior parte
 * dos alertas nascia sem rastro, e quem olhasse a auditoria não conseguia
 * explicar por que o painel de pendências mudou.
 *
 * Aqui o dedupe e o registro andam juntos, e é impossível criar um sem o outro.
 */

import type { AuditTrail } from "./audit";
import type { Clock } from "./clock";
import type { Actor, Alert, ID } from "./entities";
import type { IdGenerator } from "./ids";
import type { Repositories } from "./repositories";
import type { SkillAlert } from "./types";

/** O mínimo que o helper precisa — atendido por SkillContext e pelo container. */
export interface AlertDeps {
  companyId: ID;
  actor: Actor;
  repos: Repositories;
  audit: AuditTrail;
  clock: Clock;
  ids: IdGenerator;
  correlationId?: string;
}

/**
 * Persiste um alerta e registra `alert.created` na trilha.
 *
 * DEDUPE (comportamento preservado do `persistAlertDeduped` original): não cria
 * se já houver alerta ABERTO com o mesmo `code` + `entityId` — sem isso, cada
 * reexecução da skill inflaria o painel de pendências. Quando o alerta é
 * suprimido pelo dedupe, nada é escrito e nada é auditado.
 *
 * @returns o alerta criado, ou `undefined` quando o dedupe o suprimiu.
 */
export async function persistAlert(
  deps: AlertDeps,
  alert: SkillAlert,
  source: string
): Promise<Alert | undefined> {
  const open = await deps.repos.alerts.listOpen(deps.companyId);
  if (open.some((a) => a.code === alert.code && a.entityId === alert.entityId)) {
    return undefined;
  }

  const registro: Alert = {
    id: deps.ids.next("alr"),
    companyId: deps.companyId,
    severity: alert.severity,
    code: alert.code,
    message: alert.message,
    entityType: alert.entityType,
    entityId: alert.entityId,
    source,
    status: "open",
    createdAt: deps.clock.now().toISOString(),
  };
  await deps.repos.alerts.create(registro);
  await deps.audit.record(deps.companyId, {
    actor: deps.actor,
    action: "alert.created",
    entityType: "alert",
    entityId: registro.id,
    after: registro,
    correlationId: deps.correlationId,
  });
  return registro;
}
