/**
 * API v1 — Fluxo de Caixa: exportação .xlsx e importação da aba Lançamentos
 * (tudo-ou-nada, relatório linha a linha, sem dupla contagem, auditada).
 */
import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { PermissionError, ValidationError } from "@/core/errors";
import { buildRegistry } from "@/skills";
import { buildXlsxWorkbook, columnLetter, excelDateSerial, type XlsxCell } from "@/lib/exporters/xlsx";
import { readXlsx } from "@/lib/importers/xlsx-reader";
import type { ApiDeps, ApiSession } from "../_lib/handlers";
import {
  applyCashflowImport,
  createCashflowManualEntry,
  exportCashflowWorkbook,
  getCashflowMonthly,
  importCashflowWorkbook,
  parseCashflowImport,
} from "../_lib/cashflow";

function buildDeps(env: TestEnv): ApiDeps {
  const registry = buildRegistry();
  return {
    repos: env.repos,
    events: env.events,
    audit: env.audit,
    clock: env.clock,
    ids: env.ids,
    ai: env.ai,
    integrations: env.integrations,
    registry,
    orchestrator: env.orchestrator(registry),
  };
}

async function sessionFor(env: TestEnv, key: "admin" | "manager" | "analyst" | "viewer"): Promise<ApiSession> {
  const user = env.users[key];
  const membership = await env.repos.memberships.findByUserAndCompany(user.id, env.company.id);
  if (!membership) throw new Error(`membership ausente para ${key}`);
  return { user, membership, company: env.company, config: env.config, actor: { type: "user", id: user.id, role: membership.role } };
}

const R = (reais: number) => Math.round(reais * 100);
const YEAR = 2026;

/** Um título pago no app (origem contas_pagar) + dois ajustes manuais. */
async function seed(env: TestEnv, deps: ApiDeps) {
  const now = env.clock.now().toISOString();
  const co = env.company.id;
  await env.repos.suppliers.create({ id: "sup_1", companyId: co, name: "Light", document: "1", active: true, createdAt: now, updatedAt: now });
  await env.repos.bankAccounts.create({ id: "ba_1", companyId: co, name: "Itaú", bankCode: "341", agency: "1", accountNumberMasked: "****", type: "checking", currency: "BRL", openingBalanceCents: 0, openingBalanceDate: "2026-01-01", active: true, createdAt: now, updatedAt: now });
  await env.repos.payables.create({ id: "pv_pago", companyId: co, supplierId: "sup_1", description: "Energia sala 1227", issueDate: "2026-07-01", dueDate: "2026-07-20", amountCents: R(1_500), paidCents: R(1_500), currency: "BRL", status: "paid", installmentNumber: 1, installmentCount: 1, originKey: "k1", supplierCategory: "Concessionaria - Energia", createdBy: "u", createdAt: now, updatedAt: now });
  await env.repos.payments.create({ id: "pay_1", companyId: co, payableId: "pv_pago", bankAccountId: "ba_1", amountCents: R(1_500), scheduledDate: "2026-07-20", executedAt: "2026-07-20T12:00:00.000Z", status: "executed", requestedBy: "u", createdAt: now, updatedAt: now });
  const manager = await sessionFor(env, "manager");
  await createCashflowManualEntry(deps, manager, { competenceDate: "2026-07-05", kind: "entrada", categoryId: "prestacao_servicos", description: "Contrato SCADA cliente A", status: "realizado", amountCents: R(92_000) });
  await createCashflowManualEntry(deps, manager, { competenceDate: "2026-08-10", kind: "saida", categoryId: "aluguel", description: "Aluguel agosto", status: "previsto", amountCents: R(6_000) });
}

const HEADERS = ["Data", "Tipo", "Categoria", "Descrição", "Centro de Custo", "Status", "Valor", "Grupo", "Mês", "Ano", "Origem", "Referência"];

/** Planilha com só a aba Lançamentos, como um usuário montaria a partir da exportação. */
function lancamentosXlsx(rows: Array<Record<string, string | number | undefined>>, sheetName = "Lançamentos"): Uint8Array {
  const cells: Record<string, XlsxCell> = {};
  HEADERS.forEach((h, i) => (cells[`${columnLetter(i)}1`] = { v: h }));
  rows.forEach((row, r) =>
    HEADERS.forEach((h, i) => {
      const v = row[h];
      if (v !== undefined && v !== "") cells[`${columnLetter(i)}${r + 2}`] = { v };
    })
  );
  return buildXlsxWorkbook({ sheets: [{ name: sheetName, cells }] });
}

const NOVAS = [
  { Data: excelDateSerial("2026-09-03"), Tipo: "Entrada", Categoria: "Prestação de Serviços", Descrição: "Contrato novo", Status: "Realizado", Valor: 1234.56 },
  { Data: "10/09/2026", Tipo: "Saída", Categoria: "aluguel", Descrição: "Aluguel setembro", Status: "Previsto", Valor: "6.000,00" },
];

describe("GET /fluxo-caixa/exportar", () => {
  it("devolve a pasta .xlsx (7 abas) com nome carimbado pelo ano e pela data; formato desconhecido → 400", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await seed(env, deps);
    const file = await exportCashflowWorkbook(deps, await sessionFor(env, "viewer"), { ano: String(YEAR) });
    expect(file.filename).toBe("fluxo-caixa-cetem_2026_2026-08-18.xlsx");
    expect(file.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect([file.bytes[0], file.bytes[1]]).toEqual([0x50, 0x4b]);
    const wb = readXlsx(file.bytes);
    expect(wb.sheetNames).toEqual(["Instruções", "Parâmetros", "Lançamentos", "Fluxo Mensal", "Previsto x Realizado", "Projeção", "Dashboard"]);
    const lanc = wb.readSheet("Lançamentos")!;
    const origens = [...lanc.cells.entries()].filter(([ref]) => /^K\d+$/.test(ref) && ref !== "K1").map(([, c]) => c.value);
    expect(origens.sort()).toEqual(["Ajuste manual", "Ajuste manual", "Contas a pagar"]);
    await expect(exportCashflowWorkbook(deps, await sessionFor(env, "admin"), { formato: "csv" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("POST /fluxo-caixa/importar", () => {
  it("exportar e reimportar preserva os totais: nada é criado (origem do app e ajustes existentes são ignorados)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await seed(env, deps);
    const manager = await sessionFor(env, "manager");
    const antes = await getCashflowMonthly(deps, manager, { ano: String(YEAR) });
    const file = await exportCashflowWorkbook(deps, manager, { ano: String(YEAR) });

    const report = await importCashflowWorkbook(deps, manager, { fileName: file.filename, bytes: file.bytes });
    expect(report.resultado).toBe("aplicado");
    expect(report.criadas).toBe(0);
    expect(report.erros).toEqual([]);
    expect(report.linhasLidas).toBe(3);
    expect(report.ignoradas.map((s) => s.motivo).sort()).toEqual(["ja_existente", "ja_existente", "origem_app"]);

    const depois = await getCashflowMonthly(deps, manager, { ano: String(YEAR) });
    expect(depois.monthly.entradasAnoCents).toBe(antes.monthly.entradasAnoCents);
    expect(depois.monthly.saidasAnoCents).toBe(antes.monthly.saidasAnoCents);
    expect(depois.monthly.saldoFinal).toEqual(antes.monthly.saldoFinal);
    expect(await env.repos.cashflowManualEntries.listAll(env.company.id)).toHaveLength(2);
    expect(env.db.auditRecords.filter((a) => a.action === "cashflow.imported")).toHaveLength(0);
  });

  it("linhas novas viram ajustes manuais com a observação 'importação planilha <arquivo>', numa transação auditada; reimportar o mesmo arquivo não duplica", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await seed(env, deps);
    const manager = await sessionFor(env, "manager");
    const bytes = lancamentosXlsx(NOVAS);

    const simulado = await importCashflowWorkbook(deps, manager, { fileName: "novos.xlsx", bytes, simulate: true });
    expect(simulado.resultado).toBe("simulado");
    expect(simulado.validas.map((v) => [v.linha, v.kind, v.categoryId, v.status, v.amountCents])).toEqual([
      [2, "entrada", "prestacao_servicos", "realizado", 123_456],
      [3, "saida", "aluguel", "previsto", 600_000],
    ]);
    expect(await env.repos.cashflowManualEntries.listAll(env.company.id)).toHaveLength(2);

    const aplicado = await importCashflowWorkbook(deps, manager, { fileName: "novos.xlsx", bytes });
    expect(aplicado.resultado).toBe("aplicado");
    expect(aplicado.criadas).toBe(2);
    expect(aplicado.ids).toHaveLength(2);
    expect(aplicado.totais).toEqual({ entradasCents: 123_456, saidasCents: 600_000 });
    const todos = await env.repos.cashflowManualEntries.listAll(env.company.id);
    expect(todos).toHaveLength(4);
    const novos = todos.filter((e) => aplicado.ids.includes(e.id));
    expect(novos.map((e) => e.sourceNote)).toEqual(["importação planilha novos.xlsx", "importação planilha novos.xlsx"]);
    expect(novos.map((e) => e.competenceDate).sort()).toEqual(["2026-09-03", "2026-09-10"]);
    const criados = env.db.auditRecords.filter((a) => a.action === "cashflow.manual_entry_created");
    expect(criados).toHaveLength(4); // 2 do seed + 2 da importação
    const resumo = env.db.auditRecords.filter((a) => a.action === "cashflow.imported");
    expect(resumo).toHaveLength(1);
    expect(resumo[0].after).toMatchObject({ arquivo: "novos.xlsx", criadas: 2, ignoradas: 0, entradasCents: 123_456, saidasCents: 600_000 });
    // Os novos ajustes entram no fluxo do ano.
    const mensal = await getCashflowMonthly(deps, manager, { ano: String(YEAR) });
    expect(mensal.monthly.entradasTotal[8]).toBe(123_456);

    const denovo = await importCashflowWorkbook(deps, manager, { fileName: "novos.xlsx", bytes });
    expect(denovo.resultado).toBe("aplicado");
    expect(denovo.criadas).toBe(0);
    expect(denovo.ignoradas.map((s) => s.motivo)).toEqual(["duplicado", "duplicado"]);
    expect(await env.repos.cashflowManualEntries.listAll(env.company.id)).toHaveLength(4);
  });

  it("tudo-ou-nada: uma linha inválida rejeita o arquivo inteiro, com o relatório linha a linha, e nada é gravado", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await seed(env, deps);
    const manager = await sessionFor(env, "manager");
    const bytes = lancamentosXlsx([
      ...NOVAS,
      { Data: "31/02/2026", Tipo: "Entrada", Categoria: "Aluguel", Descrição: "Errada", Status: "Realizado", Valor: -5 },
      { Data: excelDateSerial("2026-09-20"), Tipo: "Saída", Categoria: "Aluguel", Descrição: "Já no app", Status: "Previsto", Valor: 10, Origem: "Contas a pagar", Referência: "pv_x" },
    ]);
    const report = await importCashflowWorkbook(deps, manager, { fileName: "com-erro.xlsx", bytes });
    expect(report.resultado).toBe("rejeitado");
    expect(report.criadas).toBe(0);
    expect(report.validas).toHaveLength(2);
    expect(report.erros).toHaveLength(1);
    expect(report.erros[0].linha).toBe(4);
    expect(report.erros[0].motivo).toContain("Data inválida");
    expect(report.erros[0].motivo).toContain('Categoria "Aluguel" é de saída');
    expect(report.erros[0].motivo).toContain("positivo");
    expect(report.ignoradas).toEqual([{ linha: 5, motivo: "origem_app", detalhe: 'origem "Contas a pagar" (pv_x)' }]);
    expect(await env.repos.cashflowManualEntries.listAll(env.company.id)).toHaveLength(2);
    expect(env.db.auditRecords.filter((a) => a.action === "cashflow.imported")).toHaveLength(0);
  });

  it("recusa sem permissão de escrita, sem a aba Lançamentos e com bytes que não são .xlsx", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const bytes = lancamentosXlsx(NOVAS);
    await expect(importCashflowWorkbook(deps, await sessionFor(env, "viewer"), { fileName: "novos.xlsx", bytes })).rejects.toBeInstanceOf(PermissionError);
    const manager = await sessionFor(env, "manager");
    await expect(parseCashflowImport(deps, manager, { fileName: "outra.xlsx", bytes: lancamentosXlsx(NOVAS, "Dados") })).rejects.toThrow(/aba "Lançamentos"/);
    await expect(parseCashflowImport(deps, manager, { fileName: "x.xlsx", bytes: new TextEncoder().encode("isto não é um pacote xlsx de verdade") })).rejects.toBeInstanceOf(ValidationError);
    expect(await env.repos.cashflowManualEntries.listAll(env.company.id)).toHaveLength(0);
  });

  it("confirmação (etapa 2) revalida categoria/tipo e centro de custo antes de gravar", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");
    const rejeitado = await applyCashflowImport(deps, manager, {
      fileName: "previa.xlsx",
      rows: [
        { linha: 2, competenceDate: "2026-09-03", kind: "entrada", categoryId: "aluguel", description: "tipo errado", status: "realizado", amountCents: 100 },
        { linha: 3, competenceDate: "2026-09-03", kind: "saida", categoryId: "aluguel", description: "centro inexistente", costCenterId: "cc_nao_existe", status: "realizado", amountCents: 100 },
      ],
    });
    expect(rejeitado.resultado).toBe("rejeitado");
    expect(rejeitado.erros.map((e) => e.linha)).toEqual([2, 3]);
    expect(await env.repos.cashflowManualEntries.listAll(env.company.id)).toHaveLength(0);
    await expect(applyCashflowImport(deps, manager, { fileName: "previa.xlsx", rows: [{ linha: 2, competenceDate: "hoje", kind: "entrada", categoryId: "x", description: "d", status: "realizado", amountCents: 1 }] })).rejects.toBeInstanceOf(ValidationError);
  });
});
