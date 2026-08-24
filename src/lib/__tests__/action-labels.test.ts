import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_LABELS } from "@/lib/format";

/**
 * Guarda contra regressão: toda ação de auditoria registrada no código de
 * PRODUÇÃO precisa ter um rótulo em ACTION_LABELS. Uma ação nova sem rótulo
 * quebra este teste — e o CI — antes de chegar à tela.
 *
 * Varre src/ (exceto __tests__) e, em cada LINHA que contém `action:`, extrai
 * TODOS os literais "x.y". Assim pega também ações em ternários, como
 *   action: cond ? "user.reactivated" : "user.deactivated"
 * (o padrão simples "action: \"...\"" perderia o 2º ramo).
 */
const SRC = join(process.cwd(), "src");
const LITERAL_RE = /"([a-z_]+\.[a-z_]+)"/g;

function collectActions(dir: string, acc = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue; // ignora ações fictícias de teste
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectActions(full, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      for (const line of readFileSync(full, "utf8").split("\n")) {
        if (!line.includes("action:")) continue;
        for (const m of line.matchAll(LITERAL_RE)) acc.add(m[1]);
      }
    }
  }
  return acc;
}

describe("ACTION_LABELS cobre todas as ações de auditoria em produção", () => {
  const actions = [...collectActions(SRC)].sort();

  it("encontra ações no código-fonte (sanidade do varredor)", () => {
    expect(actions.length).toBeGreaterThan(20);
    expect(actions).toContain("payable.settled_via_reconciliation");
    // Ações em ternário também são capturadas (antes escapavam do varredor).
    expect(actions).toContain("user.deactivated");
    expect(actions).toContain("user.reactivated");
  });

  it("toda ação de produção tem rótulo em ACTION_LABELS", () => {
    const semRotulo = actions.filter((a) => !(a in ACTION_LABELS));
    expect(semRotulo).toEqual([]);
  });
});
