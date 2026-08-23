"use client";

import { useMemo, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import type { CostClassification } from "@/core/entities";
import { createPayableAction } from "../actions";

/** Fornecedor com a classificação de custo, para o espelho reativo no form. */
export interface SupplierOption {
  id: string;
  name: string;
  costClassification?: CostClassification;
}

function costLabel(c?: CostClassification): string {
  if (c === "fixed") return "Custo Fixo";
  if (c === "variable") return "Custo Variável";
  return "—";
}

/**
 * Formulário de novo título a pagar. Client component para espelhar a
 * Classificação de CUSTO do fornecedor selecionado (somente leitura) — a caixa
 * "Categoria" lista Categorias de Fornecedores (texto), não o plano de contas.
 */
export function NewPayableForm({
  suppliers,
  categories,
  today,
}: {
  suppliers: SupplierOption[];
  categories: string[];
  today: string;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, SupplierOption>();
    for (const s of suppliers) m.set(s.id, s);
    return m;
  }, [suppliers]);

  const [supplierId, setSupplierId] = useState("");
  const cost = supplierId ? byId.get(supplierId)?.costClassification : undefined;

  return (
    <form action={createPayableAction} className="grid gap-4 md:grid-cols-3">
      <Field label="Fornecedor">
        <select
          name="supplierId"
          required
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className={inputClass}
        >
          <option value="">Selecione…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Descrição">
        <input name="description" required className={inputClass} placeholder="Ex.: NF 1234 — insumos" />
      </Field>
      <Field label="Valor total (R$)">
        <input name="amount" required className={inputClass} placeholder="1.234,56" inputMode="decimal" />
      </Field>
      <Field label="Emissão">
        <input type="date" name="issueDate" required defaultValue={today} className={inputClass} />
      </Field>
      <Field label="Vencimento">
        <input type="date" name="dueDate" required className={inputClass} />
      </Field>
      <Field label="Parcelas">
        <input
          type="number"
          name="installmentCount"
          min={1}
          max={120}
          defaultValue={1}
          className={inputClass}
        />
      </Field>
      <Field label="Categoria">
        <select name="supplierCategory" className={inputClass}>
          <option value="">— selecione —</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {categories.length === 0 ? (
          <span className="mt-1 block text-xs text-[var(--ink-muted)]">
            Cadastre categorias em “Categoria de Fornecedores”.
          </span>
        ) : null}
      </Field>
      <Field label="Classificação do CUSTO">
        {/* Espelho da classificação do fornecedor selecionado (somente leitura). */}
        <input value={costLabel(cost)} readOnly disabled className={inputClass} />
        <span className="mt-1 block text-xs text-[var(--ink-muted)]">
          Definida no cadastro do fornecedor.
        </span>
      </Field>
      <div className="flex items-end">
        <Button>Criar título</Button>
      </div>
    </form>
  );
}
