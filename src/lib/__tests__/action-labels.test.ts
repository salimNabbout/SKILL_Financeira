import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_LABELS } from "@/lib/format";

/**
 * Guarda contra regressão: toda ação de auditoria registrada no código de
 * PRODUÇÃO (action: "x.y") precisa ter um rótulo em ACTION_LABELS. Uma ação
 * nova sem rótulo quebra este teste — e o CI — antes de chegar à tela.
 *
 * Varre src/ (exceto __tests__), replicando o grep documentado no prompt:
 *   grep -rhn 'action: "[a-z_]*\.[a-z_]*"' --include=*.ts src
 */
const SRC = join(process.cwd(), "src");
const ACTION_RE = /action:\s*"([a-z_]+\.[a-z_]+)"/g;

function collectActions(dir: string, acc = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue; // ignora ações fictícias de teste
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectActions(full, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(ACTION_RE)) acc.add(m[1]);
    }
  }
  return acc;
}

describe("ACTION_LABELS cobre todas as ações de auditoria em produção", () => {
  const actions = [...collectActions(SRC)].sort();

  it("encontra ações no código-fonte (sanidade do varredor)", () => {
    expect(actions.length).toBeGreaterThan(20);
    expect(actions).toContain("payable.settled_via_reconciliation");
  });

  it("toda ação de produção tem rótulo em ACTION_LABELS", () => {
    const semRotulo = actions.filter((a) => !(a in ACTION_LABELS));
    expect(semRotulo).toEqual([]);
  });
});
