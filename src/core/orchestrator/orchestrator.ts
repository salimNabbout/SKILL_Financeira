/**
 * Orquestrador central.
 *
 * Responsabilidades:
 *  - receber solicitações, identificar o fluxo e as skills necessárias;
 *  - executar passos em ordem, repassando contexto (resultados anteriores);
 *  - garantir idempotência (mesma requisição não gera lançamentos duplicados);
 *  - controlar permissões, alçadas e aprovações humanas (com segregação de funções);
 *  - validar consistência entre resultados;
 *  - registrar tudo em trilha de auditoria imutável;
 *  - tratar falhas e dados incompletos sem interromper o que puder prosseguir;
 *  - consolidar respostas em uma visão única, explicitando fontes e suposições.
 */

import { assertPermission, assertSegregation, canApproveAmount } from "../auth";
import { HashChainAuditTrail, type AuditTrail } from "../audit";
import type { Clock } from "../clock";
import {
  requiredApprovalsForAmount,
  requiredRoleForAmount,
  resolveCompanyConfig,
  type CompanyConfig,
} from "../config";
import { todayInTz } from "../dates";
import type { Actor, Approval, FlowRun, FlowRunStatus, ID } from "../entities";
import { DomainError, NotFoundError, PermissionError, ValidationError } from "../errors";
import type { EventBus } from "../events";
import { hashPayload, type IdGenerator } from "../ids";
import type { Repositories } from "../repositories";
import { runSkill, type ApprovalDecision, type SkillContext } from "../skill";
import type { AiClassifier } from "../ai";
import type { Integrations } from "../integrations";
import type { ApprovalRequestData, PendingItem, SkillAlert, SkillResult } from "../types";
import { buildFlowMap, type FlowDefinition, type FlowStepContext } from "./flows";
import type { SkillRegistry } from "./registry";

export interface OrchestratorRequest {
  flow: string;
  companyId: ID;
  actor: Actor;
  payload: unknown;
  /** Chave de idempotência explícita; se ausente, derivada do hash de flow+payload. */
  idempotencyKey?: string;
}

export interface ConsolidatedView {
  summary: string;
  alerts: SkillAlert[];
  pending_items: PendingItem[];
  assumptions: string[];
  data_sources: string[];
}

export interface OrchestratorResponse {
  flowRunId: ID;
  flow: string;
  status: FlowRunStatus;
  results: Array<{ stepId: string; result: SkillResult }>;
  consolidated: ConsolidatedView;
  approval?: Approval;
  /** true quando a resposta veio do cache de idempotência (nada foi reprocessado). */
  idempotent_replay?: boolean;
}

export interface OrchestratorEnv {
  repos: Repositories;
  events: EventBus;
  clock: Clock;
  ids: IdGenerator;
  ai: AiClassifier;
  integrations: Integrations;
  registry: SkillRegistry;
  flows?: Map<string, FlowDefinition>;
}

interface StoredStepResult {
  stepId: string;
  result: SkillResult;
}

export class Orchestrator {
  private readonly flows: Map<string, FlowDefinition>;
  private readonly audit: AuditTrail;

  constructor(private readonly env: OrchestratorEnv) {
    this.flows = env.flows ?? buildFlowMap();
    this.audit = new HashChainAuditTrail(env.repos.audit, env.clock, env.ids);
  }

  listFlows(): FlowDefinition[] {
    return [...this.flows.values()];
  }

  // -------------------------------------------------------------------------
  // Execução de fluxo
  // -------------------------------------------------------------------------

  /**
   * @param staleRejectRetry uso INTERNO: marca a única reexecução permitida
   * depois de descartar um cache de idempotência de fluxo rejeitado (registro
   * legado). Evita recursão infinita se algo regravar a chave no meio.
   */
  async execute(
    request: OrchestratorRequest,
    staleRejectRetry = false
  ): Promise<OrchestratorResponse> {
    const flowDef = this.flows.get(request.flow);
    if (!flowDef) throw new ValidationError(`Fluxo desconhecido: ${request.flow}`);

    assertPermission(request.actor, flowDef.requiredPermission);

    const company = await this.env.repos.companies.getById(request.companyId);
    if (!company) throw new NotFoundError("Empresa", request.companyId);
    const config = resolveCompanyConfig(company.config);

    // Idempotência da requisição inteira. Para fluxos periódicos (resumos/régua),
    // a chave default inclui a data corrente (no fuso da empresa) para não
    // congelar o resultado do primeiro dia — o duplo clique do mesmo dia segue
    // protegido pela mesma chave.
    const requestHash = hashPayload(request.payload ?? null);
    const defaultKeyBase: Record<string, unknown> = {
      flow: request.flow,
      payload: request.payload ?? null,
    };
    if (flowDef.periodicDefault) {
      defaultKeyBase.day = todayInTz(this.env.clock.now(), config.timezone);
    }
    const idempotencyKey = request.idempotencyKey ?? hashPayload(defaultKeyBase);

    const now = this.env.clock.now().toISOString();
    const flowRun: FlowRun = {
      id: this.env.ids.next("flow"),
      companyId: request.companyId,
      flow: request.flow,
      status: "running",
      cursor: 0,
      payload: request.payload ?? {},
      results: [],
      idempotencyKey,
      correlationId: this.env.ids.next("corr"),
      requestedBy: request.actor.id,
      createdAt: now,
      updatedAt: now,
    };

    // Reserva ATÔMICA da chave ANTES de executar. Duas requisições concorrentes
    // com a mesma chave: só uma vence a reserva; a outra recai no ramo "existing"
    // e nunca reexecuta o fluxo. O resultado in-progress marca o flowRun vencedor.
    const reservation = await this.env.repos.idempotency.reserve({
      id: this.env.ids.next("idem"),
      companyId: request.companyId,
      key: idempotencyKey,
      requestHash,
      result: { __inProgressFlowRunId: flowRun.id },
      createdAt: now,
    });

    if (!reservation.reserved) {
      const existing = reservation.existing;
      if (existing && existing.requestHash !== requestHash) {
        throw new ValidationError(
          `Chave de idempotência "${idempotencyKey}" já usada com payload diferente.`
        );
      }
      const cached = existing?.result as OrchestratorResponse | { __inProgressFlowRunId: ID } | undefined;

      // O registro guarda uma FOTO do que aconteceu; o que vale é o estado ATUAL
      // do fluxo por trás dele. A chave só deve bloquear enquanto existir um
      // fluxo VIVO (em execução ou aguardando aprovação) ou CONCLUÍDO — nesses
      // casos reexecutar duplicaria algo real. Rejeitado, falho ou inexistente
      // não tem nada a preservar: descarta o registro e executa de verdade.
      //
      // Sem isto, um título REJEITADO nunca mais volta para a aprovação: a
      // requisição idêntica (mesmo título, conta e data) baterá para sempre no
      // registro velho, sem criar pagamento nem aprovação, enquanto a tela diz
      // que enviou. Vale tanto para os registros que versões anteriores
      // gravavam na rejeição quanto para fluxos que morreram no meio.
      const previousRunId =
        cached && typeof cached === "object" && "__inProgressFlowRunId" in cached
          ? cached.__inProgressFlowRunId
          : (cached as OrchestratorResponse | undefined)?.flowRunId;
      const previousRun = previousRunId
        ? await this.env.repos.flowRuns.getById(request.companyId, previousRunId)
        : null;
      const staleKey =
        !previousRun || previousRun.status === "rejected" || previousRun.status === "failed";
      if (staleKey && !staleRejectRetry) {
        await this.env.repos.idempotency.remove(request.companyId, idempotencyKey);
        return this.execute(request, true);
      }

      // Execução concorrente ainda em andamento: devolve uma resposta "running"
      // sem reprocessar (o cliente pode consultar o flowRun depois).
      if (cached && typeof cached === "object" && "__inProgressFlowRunId" in cached) {
        return {
          flowRunId: cached.__inProgressFlowRunId,
          flow: request.flow,
          status: "running",
          results: [],
          consolidated: {
            summary: "Execução em andamento para esta chave de idempotência.",
            alerts: [],
            pending_items: [],
            assumptions: [],
            data_sources: [],
          },
          idempotent_replay: true,
        };
      }

      return { ...(cached as OrchestratorResponse), idempotent_replay: true };
    }

    await this.env.repos.flowRuns.create(flowRun);

    await this.audit.record(request.companyId, {
      actor: request.actor,
      action: "flow.started",
      entityType: "FlowRun",
      entityId: flowRun.id,
      after: { flow: request.flow, payload: request.payload },
      correlationId: flowRun.correlationId,
    });

    try {
      const response = await this.runSteps(flowDef, flowRun, request.actor, config);
      // Fluxo que terminou em falha NÃO grava idempotência de conclusão (para
      // permitir reexecução): a reserva in-progress precisa ser liberada, senão
      // a chave ficaria presa e toda retentativa cairia em "em andamento".
      if (response.status === "failed") {
        await this.env.repos.idempotency.remove(request.companyId, idempotencyKey);
      }
      return response;
    } catch (error) {
      // Erro lançado antes de concluir: libera a reserva para que uma nova
      // tentativa possa reexecutar (a reserva não deve prender a chave para sempre).
      await this.env.repos.idempotency.remove(request.companyId, idempotencyKey);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Aprovação humana: decidir e retomar fluxo
  // -------------------------------------------------------------------------

  async decideApproval(params: {
    companyId: ID;
    approvalId: ID;
    decision: "approved" | "rejected";
    actor: Actor;
    justification?: string;
  }): Promise<OrchestratorResponse | { approval: Approval }> {
    const { companyId, approvalId, decision, actor, justification } = params;
    let approval = await this.env.repos.approvals.getById(companyId, approvalId);
    if (!approval) throw new NotFoundError("Aprovação", approvalId);
    if (approval.status !== "pending") {
      throw new ValidationError(`Aprovação ${approvalId} já decidida (${approval.status}).`);
    }

    // Alçada + segregação de funções: regras determinísticas, sempre auditadas.
    // O e-mail do aprovador entra na checagem por causa da exceção nominal
    // (SELF_APPROVAL_EXEMPT_EMAILS): a dispensa é de pessoas identificadas, não
    // de um papel. Só é buscado quando aprovador e solicitante são o mesmo — no
    // caminho normal não há consulta extra.
    const approverEmail =
      approval.requestedBy === actor.id
        ? (await this.env.repos.users.getById(actor.id))?.email
        : undefined;
    assertSegregation(approval.requestedBy, actor.id, approverEmail);
    if (actor.type !== "user") {
      throw new PermissionError("Apenas usuários humanos podem decidir aprovações.");
    }
    const membership = await this.env.repos.memberships.findByUserAndCompany(actor.id, companyId);
    if (!membership) throw new PermissionError("Usuário não pertence à empresa.");
    const check = canApproveAmount(membership, approval.requiredRole, approval.amountCents);
    if (!check.allowed) throw new PermissionError(check.reason ?? "Sem alçada para aprovar.");

    // Dupla aprovação (four-eyes): cada aprovador conta uma vez; a decisão só
    // é final quando o total exigido pela faixa de alçada for atingido. Uma
    // única rejeição encerra a solicitação (não há "voto vencido" em rejeição).
    const approvalsRequired = Math.max(1, approval.approvalsRequired ?? 1);
    const priorApprovers = approval.approverIds ?? [];
    if (priorApprovers.includes(actor.id)) {
      throw new ValidationError(
        "Você já registrou aprovação nesta solicitação — as demais aprovações devem vir de OUTRAS pessoas (dupla aprovação)."
      );
    }

    // Aprovação PARCIAL (ainda não atinge o total exigido): registra o voto com
    // trava otimista por versão, para que dois votos concorrentes não se percam.
    // A perdedora do compare-and-set relê a versão nova e reaplica seu voto.
    // approverIds finais (com o voto deste ator, se aprovação). Pode ser
    // recalculado pelo laço parcial abaixo ao relê após conflito de versão.
    let finalApprovers = decision === "approved" ? [...priorApprovers, actor.id] : priorApprovers;

    if (decision === "approved" && finalApprovers.length < approvalsRequired) {
      // Aprovação PARCIAL: registra o voto com trava otimista por versão, para
      // que dois votos concorrentes não se percam. A perdedora do compare-and-set
      // relê a versão nova e reaplica seu voto.
      let current = approval;
      for (let attempt = 0; attempt < 8; attempt++) {
        const before = current.approverIds ?? [];
        if (before.includes(actor.id)) {
          throw new ValidationError(
            "Você já registrou aprovação nesta solicitação — as demais aprovações devem vir de OUTRAS pessoas (dupla aprovação)."
          );
        }
        finalApprovers = [...before, actor.id];
        // Se, com o voto reaplicado, o total foi atingido, sai para o terminal.
        if (finalApprovers.length >= approvalsRequired) {
          approval = current;
          break;
        }
        const partial: Approval = {
          ...current,
          approverIds: finalApprovers,
          justification: justification ?? current.justification,
          version: (current.version ?? 0) + 1,
        };
        const claimed = await this.env.repos.approvals.updateIfVersion(partial, current.version ?? 0);
        if (!claimed) {
          const reread = await this.env.repos.approvals.getById(companyId, approvalId);
          if (!reread) throw new NotFoundError("Aprovação", approvalId);
          if (reread.status !== "pending") {
            throw new ValidationError(`Aprovação ${approvalId} já decidida (${reread.status}).`);
          }
          current = reread;
          continue;
        }
        await this.audit.record(companyId, {
          actor,
          action: "approval.partially_approved",
          entityType: "Approval",
          entityId: approval.id,
          before: { approvals: before.length, required: approvalsRequired },
          after: { approvals: finalApprovers.length, required: approvalsRequired, justification },
        });
        await this.env.events.publish({
          companyId,
          type: "approval.partially_approved",
          payload: {
            approvalId: approval.id,
            approvedBy: actor.id,
            approvals: finalApprovers.length,
            approvalsRequired,
          },
          source: "orchestrator",
          correlationId: approval.flowRunId ?? approval.id,
        });
        // Fluxo continua suspenso aguardando a(s) próxima(s) aprovação(ões).
        return { approval: partial };
      }
    }

    const approverIds = finalApprovers;
    const decided: Approval = {
      ...approval,
      approverIds,
      status: decision,
      decidedBy: actor.id,
      decidedAt: this.env.clock.now().toISOString(),
      justification,
    };
    // Trava a decisão de forma ATÔMICA: só grava se o status ainda for "pending".
    // Duas decisões concorrentes: só uma vence; a perdedora recebe false e é
    // rejeitada, impedindo que o passo sensível (pagamento) rode duas vezes.
    const claimed = await this.env.repos.approvals.updateIfStatus(decided, "pending");
    if (!claimed) {
      throw new ValidationError(`Aprovação ${approvalId} já decidida (decisão concorrente).`);
    }

    await this.audit.record(companyId, {
      actor,
      action: `approval.${decision}`,
      entityType: "Approval",
      entityId: approval.id,
      before: { status: approval.status },
      after: { status: decision, justification },
    });
    await this.env.events.publish({
      companyId,
      type: "approval.decided",
      payload: { approvalId: approval.id, decision, decidedBy: actor.id },
      source: "orchestrator",
      correlationId: approval.flowRunId ?? approval.id,
    });

    // Recuperação (B1): se o vínculo flowRun.approvalId se perdeu (crash entre o
    // create da aprovação e o update do flowRun), reencontra o fluxo pelo
    // flowRunId que a própria aprovação carrega — evita o flowRun preso em
    // "running" para sempre.
    let flowRun = await this.env.repos.flowRuns.findByApprovalId(companyId, approval.id);
    if (!flowRun && approval.flowRunId) {
      flowRun = await this.env.repos.flowRuns.getById(companyId, approval.flowRunId);
    }
    if (!flowRun) return { approval: decided };

    const flowDef = this.flows.get(flowRun.flow);
    if (!flowDef) throw new ValidationError(`Fluxo desconhecido: ${flowRun.flow}`);
    const company = await this.env.repos.companies.getById(companyId);
    const config = resolveCompanyConfig(company?.config);

    // Retoma o passo que pediu aprovação, repassando a decisão à skill.
    const requester: Actor = { type: "user", id: flowRun.requestedBy };
    const decisionCtx: ApprovalDecision = {
      id: decided.id,
      status: decision,
      decidedBy: actor.id,
      justification,
    };
    return this.runSteps(flowDef, flowRun, requester, config, decisionCtx);
  }

  // -------------------------------------------------------------------------
  // Motor de passos
  // -------------------------------------------------------------------------

  private async runSteps(
    flowDef: FlowDefinition,
    flowRun: FlowRun,
    actor: Actor,
    config: CompanyConfig,
    approvalForCurrentStep?: ApprovalDecision
  ): Promise<OrchestratorResponse> {
    const stored = flowRun.results as StoredStepResult[];
    const assumptions: string[] = [];
    let approvalDecision = approvalForCurrentStep;
    const resumedRejected = approvalForCurrentStep?.status === "rejected";

    for (let i = flowRun.cursor; i < flowDef.steps.length; i++) {
      const step = flowDef.steps[i];
      const fctx = this.buildStepContext(flowRun, stored, config);

      if (step.when && !step.when(fctx)) {
        assumptions.push(`Passo "${step.id}" pulado: condição não atendida.`);
        flowRun.cursor = i + 1;
        continue;
      }

      const skillDef = this.env.registry.get(step.skill);
      const ctx = this.buildSkillContext(flowRun, actor, config, approvalDecision);
      approvalDecision = undefined; // a decisão vale apenas para o passo retomado
      const input = step.buildInput(fctx);
      const result = await runSkill(skillDef, ctx, input);

      // Substitui resultado anterior do mesmo passo (caso de retomada pós-aprovação).
      const existingIdx = stored.findIndex((r) => r.stepId === step.id);
      if (existingIdx >= 0) stored[existingIdx] = { stepId: step.id, result };
      else stored.push({ stepId: step.id, result });

      if (result.status === "awaiting_approval") {
        return this.suspendForApproval(flowDef, flowRun, actor, config, step.id, i, stored, result);
      }

      if (result.status === "error" && !step.continueOnError) {
        flowRun.status = "failed";
        flowRun.cursor = i;
        flowRun.results = stored;
        flowRun.updatedAt = this.env.clock.now().toISOString();
        await this.env.repos.flowRuns.update(flowRun);
        await this.audit.record(flowRun.companyId, {
          actor,
          action: "flow.failed",
          entityType: "FlowRun",
          entityId: flowRun.id,
          after: { failedStep: step.id, alerts: result.alerts },
          correlationId: flowRun.correlationId,
        });
        // Falha não grava idempotência: a nova tentativa reexecuta com segurança
        // (ações de escrita das skills são idempotentes por chave natural). A
        // RESERVA in-progress também precisa cair — numa falha durante a
        // RETOMADA (decideApproval) não há ninguém em execute() para liberá-la,
        // e a chave presa faria toda retentativa responder "em andamento".
        await this.env.repos.idempotency.remove(flowRun.companyId, flowRun.idempotencyKey);
        return this.buildResponse(flowDef, flowRun, stored, assumptions);
      }

      flowRun.cursor = i + 1;
      flowRun.updatedAt = this.env.clock.now().toISOString();
      flowRun.results = stored;
      await this.env.repos.flowRuns.update(flowRun);

      // Rejeição: a skill retomada cancelou a ação pendente; não há o que prosseguir.
      if (resumedRejected) break;
    }

    flowRun.status = resumedRejected ? "rejected" : "completed";
    flowRun.updatedAt = this.env.clock.now().toISOString();
    flowRun.results = stored;
    await this.env.repos.flowRuns.update(flowRun);

    const response = this.buildResponse(flowDef, flowRun, stored, assumptions);

    if (flowRun.status === "rejected") {
      // REJEIÇÃO não grava idempotência — libera a chave, como já se fazia na
      // falha. Gravá-la congelava a requisição: reenviar o MESMO pagamento
      // (mesmo título, conta e data) devolvia a resposta velha em cache, sem
      // criar pagamento nem aprovação. A tela dizia "enviado para aprovação" e
      // Aprovações continuava vazia — o título rejeitado nunca mais voltava ao
      // fluxo. Rejeitar é justamente o desfecho que pede nova tentativa.
      await this.env.repos.idempotency.remove(flowRun.companyId, flowRun.idempotencyKey);
    } else {
      await this.env.repos.idempotency.save({
        id: this.env.ids.next("idem"),
        companyId: flowRun.companyId,
        key: flowRun.idempotencyKey,
        requestHash: hashPayload(flowRun.payload ?? null),
        result: response,
        createdAt: this.env.clock.now().toISOString(),
      });
    }

    await this.audit.record(flowRun.companyId, {
      actor,
      action: "flow.completed",
      entityType: "FlowRun",
      entityId: flowRun.id,
      after: { status: flowRun.status, steps: stored.map((s) => s.stepId) },
      correlationId: flowRun.correlationId,
    });
    await this.env.events.publish({
      companyId: flowRun.companyId,
      type: "flow.completed",
      payload: { flowRunId: flowRun.id, flow: flowRun.flow, status: flowRun.status },
      source: "orchestrator",
      correlationId: flowRun.correlationId,
    });

    return response;
  }

  private async suspendForApproval(
    flowDef: FlowDefinition,
    flowRun: FlowRun,
    actor: Actor,
    config: CompanyConfig,
    stepId: string,
    stepIndex: number,
    stored: StoredStepResult[],
    result: SkillResult
  ): Promise<OrchestratorResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: ApprovalRequestData | undefined = (result.data as any)?.approvalRequest;
    if (!req) {
      throw new DomainError(
        "missing_approval_request",
        `Skill retornou awaiting_approval sem data.approvalRequest (passo ${stepId}).`
      );
    }
    const approval: Approval = {
      id: this.env.ids.next("apr"),
      companyId: flowRun.companyId,
      targetType: req.targetType,
      targetId: req.targetId,
      flowRunId: flowRun.id,
      summary: req.summary,
      amountCents: req.amountCents,
      requestedBy: flowRun.requestedBy,
      // A alçada usa tierAmountCents quando informado (ex.: valor do título
      // inteiro), evitando que um pagamento fracionado rebaixe o papel exigido.
      requiredRole: requiredRoleForAmount(config, req.tierAmountCents ?? req.amountCents ?? 0),
      approvalsRequired: requiredApprovalsForAmount(config, req.tierAmountCents ?? req.amountCents ?? 0),
      approverIds: [],
      status: "pending",
      createdAt: this.env.clock.now().toISOString(),
    };
    await this.env.repos.approvals.create(approval);

    flowRun.status = "awaiting_approval";
    flowRun.cursor = stepIndex; // o mesmo passo será reexecutado com a decisão
    flowRun.approvalId = approval.id;
    flowRun.results = stored;
    flowRun.updatedAt = this.env.clock.now().toISOString();
    await this.env.repos.flowRuns.update(flowRun);

    await this.env.repos.alerts.create({
      id: this.env.ids.next("alr"),
      companyId: flowRun.companyId,
      severity: "warning",
      code: "approval_pending",
      message: `Aprovação pendente: ${req.summary}`,
      entityType: "Approval",
      entityId: approval.id,
      source: "orchestrator",
      status: "open",
      createdAt: this.env.clock.now().toISOString(),
    });
    await this.audit.record(flowRun.companyId, {
      actor,
      action: "approval.requested",
      entityType: "Approval",
      entityId: approval.id,
      after: { summary: req.summary, amountCents: req.amountCents, requiredRole: approval.requiredRole },
      correlationId: flowRun.correlationId,
    });
    await this.env.events.publish({
      companyId: flowRun.companyId,
      type: "approval.requested",
      payload: { approvalId: approval.id, flowRunId: flowRun.id, summary: req.summary },
      source: "orchestrator",
      correlationId: flowRun.correlationId,
    });

    const response = this.buildResponse(flowDef, flowRun, stored, [], approval);

    await this.env.repos.idempotency.save({
      id: this.env.ids.next("idem"),
      companyId: flowRun.companyId,
      key: flowRun.idempotencyKey,
      requestHash: hashPayload(flowRun.payload ?? null),
      result: response,
      createdAt: this.env.clock.now().toISOString(),
    });

    return response;
  }

  // -------------------------------------------------------------------------
  // Contextos e consolidação
  // -------------------------------------------------------------------------

  private buildStepContext(
    flowRun: FlowRun,
    stored: StoredStepResult[],
    config: CompanyConfig
  ): FlowStepContext {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: Record<string, SkillResult<any>> = {};
    for (const { stepId, result } of stored) results[stepId] = result;
    return {
      payload: flowRun.payload,
      results,
      today: todayInTz(this.env.clock.now(), config.timezone),
      config,
    };
  }

  private buildSkillContext(
    flowRun: FlowRun,
    actor: Actor,
    config: CompanyConfig,
    approval?: ApprovalDecision
  ): SkillContext {
    const { repos, events, clock, ids, ai, integrations } = this.env;
    return {
      companyId: flowRun.companyId,
      actor,
      repos,
      events,
      audit: this.audit,
      clock,
      ids,
      config,
      ai,
      integrations,
      correlationId: flowRun.correlationId,
      flowRunId: flowRun.id,
      approval,
      today: () => todayInTz(clock.now(), config.timezone),
    };
  }

  private buildResponse(
    flowDef: FlowDefinition,
    flowRun: FlowRun,
    stored: StoredStepResult[],
    extraAssumptions: string[],
    approval?: Approval
  ): OrchestratorResponse {
    const alerts: SkillAlert[] = [];
    const pending: PendingItem[] = [];
    const assumptions: string[] = [...extraAssumptions];
    const dataSources = new Set<string>();

    for (const { result } of stored) {
      alerts.push(...result.alerts);
      pending.push(...result.pending_items);
      assumptions.push(...result.assumptions);
      for (const s of result.audit.data_sources) dataSources.add(s);
    }

    // Validação de consistência entre skills (regras do próprio fluxo).
    if (flowRun.status === "completed" && flowDef.validate) {
      const fctx = this.buildStepContext(flowRun, stored, resolveCompanyConfig(undefined));
      alerts.push(...flowDef.validate(fctx));
    }

    const statusLabel: Record<FlowRunStatus, string> = {
      running: "em execução",
      awaiting_approval: "aguardando aprovação humana",
      completed: "concluído",
      failed: "falhou",
      rejected: "rejeitado na aprovação",
    };

    const summary =
      `Fluxo "${flowDef.name}" ${statusLabel[flowRun.status]}: ` +
      `${stored.length} passo(s) executado(s)` +
      (alerts.length > 0 ? `, ${alerts.length} alerta(s)` : "") +
      (pending.length > 0 ? `, ${pending.length} pendência(s)` : "") +
      ".";

    return {
      flowRunId: flowRun.id,
      flow: flowRun.flow,
      status: flowRun.status,
      results: stored,
      consolidated: {
        summary,
        alerts,
        pending_items: pending,
        assumptions,
        data_sources: [...dataSources],
      },
      approval,
    };
  }
}
