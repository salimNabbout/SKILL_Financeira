/**
 * Fluxos integrados — o orquestrador executa passos em ordem, resolvendo
 * dependências entre skills e repassando contexto (resultados anteriores).
 *
 * Contratos de payload de cada fluxo estão documentados junto à definição.
 */

import type { Permission } from "../auth";
import type { CompanyConfig } from "../config";
import type { ISODate } from "../dates";
import type { SkillName } from "../skill";
import type { SkillAlert, SkillResult } from "../types";

export interface FlowStepContext {
  /** Payload original da requisição ao orquestrador. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  /** Resultados dos passos anteriores, por id do passo. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  results: Record<string, SkillResult<any>>;
  today: ISODate;
  config: CompanyConfig;
}

export interface FlowStep {
  id: string;
  skill: SkillName;
  description: string;
  buildInput(f: FlowStepContext): unknown;
  /** Passo condicional: se retorna false, é pulado (registrado como suposição). */
  when?(f: FlowStepContext): boolean;
  /** Se true, uma falha neste passo não interrompe o fluxo (default: interrompe). */
  continueOnError?: boolean;
}

export interface FlowDefinition {
  name: string;
  description: string;
  requiredPermission: Permission;
  steps: FlowStep[];
  /** Validação de consistência entre resultados das skills (executada ao final). */
  validate?(f: FlowStepContext): SkillAlert[];
  /**
   * Fluxos periódicos (resumos/relatórios/régua) cuja saída depende do DIA em
   * que rodam: a chave de idempotência default inclui a data corrente, para que
   * rodar de novo no dia seguinte reprocesse em vez de devolver o replay eterno
   * do primeiro dia. Continua protegendo o duplo clique dentro do mesmo dia.
   */
  periodicDefault?: boolean;
}

// ---------------------------------------------------------------------------
// Fluxos padrão
// ---------------------------------------------------------------------------

/**
 * Entrada de nota de fornecedor.
 * payload: { supplierId, description, issueDate, dueDate, amountCents,
 *            categoryId?, costCenterId?, installmentCount?,
 *            document?: { type, number, series?, issuedAt, totalCents } }
 */
const supplierInvoiceIntake: FlowDefinition = {
  name: "supplier_invoice_intake",
  description:
    "Nota de fornecedor: cria título em Contas a Pagar, valida controles internos, atualiza projeção de caixa e verifica impacto orçamentário.",
  requiredPermission: "payable.create",
  steps: [
    {
      id: "ap_create",
      skill: "contas_a_pagar",
      description: "Criar título (idempotente por fornecedor+documento+parcela)",
      buildInput: (f) => ({ action: "create_payable", ...f.payload }),
    },
    {
      id: "controls_validate",
      skill: "controles_internos_auditoria",
      description: "Validar duplicidade, alçada e segregação",
      buildInput: (f) => ({
        action: "validate_payables",
        payableIds: (f.results.ap_create?.data?.payables ?? []).map((p: { id: string }) => p.id),
      }),
    },
    {
      id: "treasury_refresh",
      skill: "tesouraria_fluxo_caixa",
      description: "Atualizar projeção de desembolsos",
      buildInput: () => ({ action: "refresh_projection", horizonDays: 90 }),
      continueOnError: true,
    },
    {
      id: "budget_check",
      skill: "orcamento_planejamento",
      description: "Verificar impacto no orçamento",
      buildInput: (f) => ({
        action: "check_impact",
        payableIds: (f.results.ap_create?.data?.payables ?? []).map((p: { id: string }) => p.id),
      }),
      continueOnError: true,
    },
  ],
  validate: (f) => {
    const alerts: SkillAlert[] = [];
    const payables: Array<{ amountCents: number; dueDate: string }> =
      f.results.ap_create?.data?.payables ?? [];
    const summary = f.results.treasury_refresh?.data?.summary;
    if (payables.length > 0 && summary) {
      const withinHorizon = payables.filter(
        (p) => p.dueDate <= f.results.treasury_refresh!.data.summary.horizonEnd
      );
      const totalNew = withinHorizon.reduce((acc, p) => acc + p.amountCents, 0);
      if (totalNew > 0 && summary.totalOutCents < totalNew) {
        alerts.push({
          severity: "warning",
          code: "consistency_projection",
          message:
            "Inconsistência: a projeção de desembolsos da tesouraria não reflete o novo título dentro do horizonte.",
        });
      }
    }
    return alerts;
  },
};

/**
 * Agendamento e execução de pagamento (SEMPRE com aprovação humana).
 * payload: { payableId, bankAccountId, scheduledDate, method, amountCents? }
 */
const schedulePayment: FlowDefinition = {
  name: "schedule_payment",
  description:
    "Agenda pagamento de título e exige aprovação por alçada. A aprovação NÃO baixa o título: o pagamento fica aprovado aguardando a conciliação, que é quem executa (mock) e quita.",
  requiredPermission: "payment.request",
  steps: [
    {
      id: "ap_schedule",
      skill: "contas_a_pagar",
      description: "Agendar pagamento (pendente de aprovação) / executar após aprovação",
      buildInput: (f) => ({ action: "schedule_payment", ...f.payload }),
    },
    {
      id: "controls_post",
      skill: "controles_internos_auditoria",
      description: "Verificação pós-pagamento",
      buildInput: (f) => ({
        action: "post_payment_check",
        paymentId: f.results.ap_schedule?.data?.payment?.id,
      }),
      when: (f) => f.results.ap_schedule?.data?.payment?.status === "executed",
      continueOnError: true,
    },
    {
      id: "treasury_refresh",
      skill: "tesouraria_fluxo_caixa",
      description: "Atualizar posição e projeção de caixa",
      buildInput: () => ({ action: "refresh_projection", horizonDays: 90 }),
      continueOnError: true,
    },
    {
      id: "accounting_prepare",
      skill: "integracao_contabil_fiscal",
      description: "Preparar lançamento contábil do pagamento",
      buildInput: (f) => ({
        action: "prepare_entries",
        sourceType: "payment",
        sourceId: f.results.ap_schedule?.data?.payment?.id,
      }),
      when: (f) => f.results.ap_schedule?.data?.payment?.status === "executed",
      continueOnError: true,
    },
  ],
};

/**
 * Importação de extrato bancário e conciliação.
 * payload: { bankAccountId, format: "ofx" | "csv", content: string }
 */
const bankStatementImport: FlowDefinition = {
  name: "bank_statement_import",
  description:
    "Importa extrato (OFX/CSV), deduplica, concilia automaticamente com grau de confiança, atualiza caixa e varre anomalias.",
  requiredPermission: "reconciliation.manage",
  steps: [
    {
      id: "import",
      skill: "conciliacao_bancaria",
      description: "Importar e deduplicar transações",
      buildInput: (f) => ({ action: "import_statement", ...f.payload }),
    },
    {
      id: "match",
      skill: "conciliacao_bancaria",
      description: "Conciliação automática com grau de confiança",
      buildInput: (f) => ({ action: "auto_match", bankAccountId: f.payload.bankAccountId }),
    },
    {
      id: "treasury_refresh",
      skill: "tesouraria_fluxo_caixa",
      description: "Atualizar posição de caixa",
      buildInput: () => ({ action: "refresh_projection", horizonDays: 90 }),
      continueOnError: true,
    },
    {
      id: "controls_scan",
      skill: "controles_internos_auditoria",
      description: "Varredura de anomalias nas transações",
      buildInput: () => ({ action: "scan_anomalies" }),
      continueOnError: true,
    },
  ],
};

/**
 * Sincronização de extrato via provedor de dados bancários (porta BankDataProvider).
 * No MVP o provedor é MOCK (claramente identificado): gera um extrato sintético
 * determinístico — nenhum banco real é consultado.
 * payload: { bankAccountId, sinceDays? }
 */
const bankSync: FlowDefinition = {
  name: "bank_sync",
  description:
    "Sincroniza transações da conta via provedor de dados bancários (mock no MVP), deduplica, concilia automaticamente, atualiza caixa e varre anomalias.",
  requiredPermission: "reconciliation.manage",
  steps: [
    {
      id: "sync",
      skill: "conciliacao_bancaria",
      description: "Buscar transações no provedor e deduplicar",
      buildInput: (f) => ({
        action: "sync_bank",
        bankAccountId: f.payload.bankAccountId,
        sinceDays: f.payload.sinceDays,
      }),
    },
    {
      id: "match",
      skill: "conciliacao_bancaria",
      description: "Conciliação automática com grau de confiança",
      buildInput: (f) => ({ action: "auto_match", bankAccountId: f.payload.bankAccountId }),
    },
    {
      id: "treasury_refresh",
      skill: "tesouraria_fluxo_caixa",
      description: "Atualizar posição de caixa",
      buildInput: () => ({ action: "refresh_projection", horizonDays: 90 }),
      continueOnError: true,
    },
    {
      id: "controls_scan",
      skill: "controles_internos_auditoria",
      description: "Varredura de anomalias nas transações",
      buildInput: () => ({ action: "scan_anomalies" }),
      continueOnError: true,
    },
  ],
};

/**
 * Faturamento de venda: gera cobrança e títulos a receber.
 * payload: { customerId, description, totalCents, saleRef?,
 *            installments?: [{ dueDate, amountCents }], method? }
 */
const customerInvoiceIntake: FlowDefinition = {
  name: "customer_invoice_intake",
  description:
    "Venda faturada: emite cobrança (NF-e mock), cria títulos em Contas a Receber e atualiza projeção de entradas.",
  requiredPermission: "invoice.manage",
  steps: [
    {
      id: "invoice_create",
      skill: "faturamento",
      description: "Criar e emitir fatura (NF-e/NFS-e mock)",
      buildInput: (f) => ({ action: "create_invoice", issue: true, ...f.payload }),
    },
    {
      id: "ar_create",
      skill: "contas_a_receber",
      description: "Criar títulos a receber a partir da fatura",
      buildInput: (f) => ({
        action: "create_from_invoice",
        invoiceId: f.results.invoice_create?.data?.invoice?.id,
        installments: f.payload.installments,
        method: f.payload.method,
      }),
    },
    {
      id: "treasury_refresh",
      skill: "tesouraria_fluxo_caixa",
      description: "Atualizar projeção de entradas",
      buildInput: () => ({ action: "refresh_projection", horizonDays: 90 }),
      continueOnError: true,
    },
  ],
};

/**
 * Régua de cobrança de inadimplentes (mensagens exigem aprovação humana).
 * payload: {}
 */
const dunningRun: FlowDefinition = {
  name: "dunning_run",
  description:
    "Identifica títulos vencidos, segmenta clientes, prepara mensagens de cobrança respeitosas e solicita aprovação humana antes de qualquer envio (envio é mock).",
  requiredPermission: "collection.manage",
  periodicDefault: true,
  steps: [
    {
      id: "overdue",
      skill: "contas_a_receber",
      description: "Listar títulos vencidos",
      buildInput: () => ({ action: "list_overdue" }),
    },
    {
      id: "dunning",
      skill: "cobranca_inadimplencia",
      description: "Rodar régua de cobrança (rascunhos → aprovação → envio mock)",
      buildInput: () => ({ action: "run_dunning" }),
    },
    {
      id: "indicators",
      skill: "cobranca_inadimplencia",
      description: "Indicadores de inadimplência",
      buildInput: () => ({ action: "delinquency_indicators" }),
      continueOnError: true,
    },
  ],
};

/** Resumo diário consolidado. payload: {} */
const dailySummary: FlowDefinition = {
  name: "daily_summary",
  description: "Resumo diário: posição de caixa, vencidos e visão executiva consolidada.",
  requiredPermission: "report.view",
  periodicDefault: true,
  steps: [
    {
      id: "cash",
      skill: "tesouraria_fluxo_caixa",
      description: "Posição de caixa",
      buildInput: () => ({ action: "cash_position" }),
    },
    {
      id: "overdue",
      skill: "contas_a_receber",
      description: "Títulos vencidos",
      buildInput: () => ({ action: "list_overdue" }),
      continueOnError: true,
    },
    {
      id: "report",
      skill: "relatorios_gerenciais",
      description: "Resumo diário consolidado",
      buildInput: () => ({ action: "daily_summary" }),
    },
  ],
};

/** Fechamento mensal. payload: { period: "YYYY-MM" } */
const monthlyClose: FlowDefinition = {
  name: "monthly_close",
  description:
    "Fechamento mensal: DRE gerencial, orçado vs. realizado, indicadores, lançamentos contábeis e relatório de fechamento.",
  requiredPermission: "report.view",
  steps: [
    {
      id: "dre",
      skill: "controladoria_indicadores",
      description: "DRE gerencial do período",
      buildInput: (f) => ({ action: "dre", period: f.payload.period }),
    },
    {
      id: "variance",
      skill: "orcamento_planejamento",
      description: "Orçado vs. realizado",
      buildInput: (f) => ({ action: "variance_report", period: f.payload.period }),
      continueOnError: true,
    },
    {
      id: "indicators",
      skill: "controladoria_indicadores",
      description: "Indicadores financeiros",
      buildInput: (f) => ({ action: "indicators", period: f.payload.period }),
      continueOnError: true,
    },
    {
      id: "accounting",
      skill: "integracao_contabil_fiscal",
      description: "Preparar lançamentos do período",
      buildInput: (f) => ({ action: "prepare_entries", period: f.payload.period }),
      continueOnError: true,
    },
    {
      id: "report",
      skill: "relatorios_gerenciais",
      description: "Relatório de fechamento mensal",
      buildInput: (f) => ({ action: "monthly_close", period: f.payload.period }),
    },
  ],
};

/** Exportação contábil. payload: { period: "YYYY-MM", format?: "csv", layout?: "padrao"|"dominio"|"omie"|"contmatic" } */
const accountingExport: FlowDefinition = {
  name: "accounting_export",
  description:
    "Classifica lançamentos do período e prepara lote de exportação para a contabilidade no layout escolhido (padrão ou layouts de referência Domínio/Omie/Contmatic — validação final é do contador).",
  requiredPermission: "accounting.export",
  steps: [
    {
      id: "prepare",
      skill: "integracao_contabil_fiscal",
      description: "Preparar lançamentos do período",
      buildInput: (f) => ({ action: "prepare_entries", period: f.payload.period }),
    },
    {
      id: "export",
      skill: "integracao_contabil_fiscal",
      description: "Gerar lote de exportação no layout escolhido",
      buildInput: (f) => ({
        action: "export_batch",
        period: f.payload.period,
        format: f.payload.format ?? "csv",
        layout: f.payload.layout,
      }),
    },
  ],
};

/**
 * Geração de títulos recorrentes. Roda diariamente pelo scheduler; cria os
 * títulos a pagar dos templates de recorrência devidos no mês (idempotente).
 */
const recurringTitlesGenerate: FlowDefinition = {
  name: "recurring_titles_generate",
  description:
    "Gera os títulos recorrentes (a pagar e a receber) devidos no mês corrente a partir dos modelos de recorrência cadastrados. Idempotente: não duplica títulos já gerados.",
  requiredPermission: "payable.create",
  periodicDefault: true,
  steps: [
    {
      id: "generate_payables",
      skill: "contas_a_pagar",
      description: "Gerar títulos a pagar recorrentes do mês",
      buildInput: () => ({ action: "generate_recurring" }),
    },
    {
      id: "generate_receivables",
      skill: "contas_a_receber",
      description: "Gerar títulos a receber recorrentes do mês",
      buildInput: () => ({ action: "generate_recurring" }),
      continueOnError: true,
    },
  ],
};

/**
 * Edição de título a pagar. Fluxo de um único passo — a skill valida a regra de
 * edição (bloqueios por status/pagamento) e registra a trilha. Não dispara as
 * revalidações a jusante do intake: editar campos que não afetam alçada não
 * muda projeção/orçamento; o valor só muda quando não há pagamento reservado.
 * payload: { payableId, description, issueDate, dueDate, amountCents,
 *            categoryId?, costCenterId?, supplierCategory?, costClassification?, notes? }
 */
const updatePayable: FlowDefinition = {
  name: "update_payable",
  description:
    "Edita um título a pagar (campos que não afetam idempotência nem alçada), com bloqueio de valor quando há pagamento pendente/realizado, e registra a alteração na auditoria.",
  requiredPermission: "payable.create",
  steps: [
    {
      id: "ap_update",
      skill: "contas_a_pagar",
      description: "Editar título a pagar (com bloqueios de segurança)",
      buildInput: (f) => ({ action: "update_payable", ...f.payload }),
    },
  ],
};

/**
 * Cancelamento (lógico) de título a pagar. Fluxo de um único passo — a skill
 * exige permissão payable.cancel, valida o status (open/scheduled), bloqueia
 * títulos com pagamento executado, cancela pagamentos pendentes vinculados e
 * registra a trilha. NÃO há exclusão física (a auditoria é preservada).
 * payload: { payableId, reason }
 */
const cancelPayableFlow: FlowDefinition = {
  name: "cancel_payable",
  description:
    "Cancela (logicamente) um título a pagar em aberto/agendado, cancelando junto os pagamentos pendentes vinculados, e mantém o registro no histórico para auditoria.",
  requiredPermission: "payable.cancel",
  steps: [
    {
      id: "ap_cancel",
      skill: "contas_a_pagar",
      description: "Cancelar título a pagar (com bloqueios de segurança)",
      buildInput: (f) => ({ action: "cancel_payable", ...f.payload }),
    },
  ],
};

/**
 * Cancelamento (lógico) de título a receber. Fluxo de um único passo — a skill
 * exige permissão receivable.cancel, valida o status (só open, sem recebimento),
 * bloqueia títulos de nota fiscal (cancele pela fatura), cancela as mensagens de
 * cobrança pendentes vinculadas e registra a trilha. NÃO há exclusão física.
 * payload: { receivableId, reason }
 */
const cancelReceivableFlow: FlowDefinition = {
  name: "cancel_receivable",
  description:
    "Cancela (logicamente) um título a receber em aberto e sem recebimento, cancelando junto as mensagens de cobrança pendentes, e mantém o registro no histórico para auditoria.",
  requiredPermission: "receivable.cancel",
  steps: [
    {
      id: "ar_cancel",
      skill: "contas_a_receber",
      description: "Cancelar título a receber (com bloqueios de segurança)",
      buildInput: (f) => ({ action: "cancel_receivable", ...f.payload }),
    },
  ],
};

/**
 * Ajuste do vencimento de título já baixado. Fluxo de um único passo — a skill
 * exige payable.create, aceita só título com baixa registrada (o sem baixa é
 * caso do update_payable) e altera exclusivamente o vencimento.
 * payload: { payableId, dueDate }
 */
const adjustDueDateFlow: FlowDefinition = {
  name: "adjust_due_date",
  description:
    "Corrige o vencimento de um título já baixado, sem tocar em valor, baixa ou contabilidade. A situação (Pago / Pago no Vencimento / Pago Atrasado) é reclassificada pela nova data.",
  requiredPermission: "payable.create",
  steps: [
    {
      id: "ap_adjust_due_date",
      skill: "contas_a_pagar",
      description: "Ajustar vencimento de título baixado",
      buildInput: (f) => ({ action: "adjust_due_date", ...f.payload }),
    },
  ],
};

/**
 * Conciliação de pagamento aprovado. Fluxo de um único passo — a skill exige
 * payment.execute, aceita só pagamento aprovado, grava a data real do pagamento
 * como executedAt e baixa o título, que volta para Contas a pagar como pago
 * (em dia ou em atraso, conforme a data informada).
 * payload: { paymentId, paymentDate }
 */
const reconcilePaymentFlow: FlowDefinition = {
  name: "reconcile_payment",
  description:
    "Concilia um pagamento aprovado: registra a data real da saída do dinheiro, baixa o título e o devolve para Contas a pagar como pago (em dia ou em atraso, conforme a data).",
  requiredPermission: "payment.execute",
  steps: [
    {
      id: "ap_reconcile",
      skill: "contas_a_pagar",
      description: "Conciliar pagamento aprovado (com bloqueios de segurança)",
      buildInput: (f) => ({ action: "reconcile_payment", ...f.payload }),
    },
    // Os três passos abaixo eram do schedule_payment, disparados quando a
    // aprovação executava o pagamento. Como quem executa agora é a conciliação,
    // eles vieram junto — sem isso, nenhum pagamento geraria verificação de
    // controles nem lançamento contábil.
    {
      id: "controls_post",
      skill: "controles_internos_auditoria",
      description: "Verificação pós-pagamento",
      buildInput: (f) => ({
        action: "post_payment_check",
        paymentId: f.results.ap_reconcile?.data?.payment?.id,
      }),
      when: (f) => f.results.ap_reconcile?.data?.payment?.status === "executed",
      continueOnError: true,
    },
    {
      id: "treasury_refresh",
      skill: "tesouraria_fluxo_caixa",
      description: "Atualizar posição e projeção de caixa",
      buildInput: () => ({ action: "refresh_projection", horizonDays: 90 }),
      continueOnError: true,
    },
    {
      id: "accounting_prepare",
      skill: "integracao_contabil_fiscal",
      description: "Preparar lançamento contábil do pagamento",
      buildInput: (f) => ({
        action: "prepare_entries",
        sourceType: "payment",
        sourceId: f.results.ap_reconcile?.data?.payment?.id,
      }),
      when: (f) => f.results.ap_reconcile?.data?.payment?.status === "executed",
      continueOnError: true,
    },
  ],
};

/**
 * DESFAZER a conciliação de um pagamento (botão Excluir do card "Conciliados").
 * Estorna o pagamento — o título volta para Contas a pagar com o status da
 * regra existente —, estorna o lançamento contábil gerado na conciliação e
 * atualiza o caixa. A aprovação que originou a conciliação é marcada como
 * estornada pela própria skill (sai do histórico, sem ser apagada).
 * payload: { paymentId, reason }
 */
const undoReconciliationFlow: FlowDefinition = {
  name: "undo_reconciliation",
  description:
    "Desfaz a conciliação de um pagamento: estorna o pagamento (o título volta para Contas a pagar), lança o estorno contábil e atualiza o caixa. Nada é apagado — tudo fica registrado na auditoria.",
  requiredPermission: "payment.execute",
  steps: [
    {
      id: "ap_reverse",
      skill: "contas_a_pagar",
      description: "Estornar o pagamento e devolver o título",
      buildInput: (f) => ({ action: "reverse_payment", ...f.payload }),
    },
    // Espelha o accounting_prepare do reconcile_payment: o que a conciliação
    // lançou, o desfazer estorna. Sem este passo sobraria despesa estornada
    // dentro do DRE. continueOnError: uma falha contábil não deve impedir a
    // devolução do título, que é o efeito principal e já commitou.
    {
      id: "accounting_reverse",
      skill: "integracao_contabil_fiscal",
      description: "Estornar o lançamento contábil do pagamento",
      buildInput: (f) => ({
        action: "reverse_entries",
        sourceType: "payment",
        sourceId: (f.payload as { paymentId?: string }).paymentId,
        reason: (f.payload as { reason?: string }).reason,
      }),
      continueOnError: true,
    },
    {
      id: "treasury_refresh",
      skill: "tesouraria_fluxo_caixa",
      description: "Atualizar posição e projeção de caixa",
      buildInput: () => ({ action: "refresh_projection", horizonDays: 90 }),
      continueOnError: true,
    },
  ],
};

/**
 * Estorno de pagamento executado. Fluxo de um único passo — a skill exige
 * payment.execute, valida que o pagamento está executado, devolve o valor ao
 * saldo do título (que volta para Contas a pagar) e registra a trilha. O
 * pagamento NÃO é apagado: fica cancelado, com o motivo na auditoria.
 * payload: { paymentId, reason }
 */
const reversePaymentFlow: FlowDefinition = {
  name: "reverse_payment",
  description:
    "Estorna um pagamento já executado: desfaz a baixa, devolve o título para Contas a pagar e mantém o pagamento no histórico como cancelado, com o motivo registrado na auditoria.",
  requiredPermission: "payment.execute",
  steps: [
    {
      id: "ap_reverse",
      skill: "contas_a_pagar",
      description: "Estornar pagamento executado (com bloqueios de segurança)",
      buildInput: (f) => ({ action: "reverse_payment", ...f.payload }),
    },
  ],
};

export const BUILTIN_FLOWS: FlowDefinition[] = [
  supplierInvoiceIntake,
  schedulePayment,
  updatePayable,
  cancelPayableFlow,
  cancelReceivableFlow,
  adjustDueDateFlow,
  reconcilePaymentFlow,
  reversePaymentFlow,
  undoReconciliationFlow,
  bankStatementImport,
  bankSync,
  customerInvoiceIntake,
  dunningRun,
  dailySummary,
  monthlyClose,
  accountingExport,
  recurringTitlesGenerate,
];

export function buildFlowMap(flows: FlowDefinition[] = BUILTIN_FLOWS): Map<string, FlowDefinition> {
  return new Map(flows.map((f) => [f.name, f]));
}
