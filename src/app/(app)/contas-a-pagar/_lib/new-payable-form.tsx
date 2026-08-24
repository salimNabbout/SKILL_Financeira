"use client";

import { Button, Field, inputClass } from "@/components/ui";
import { createPayableAction } from "../actions";
import { MoneyInput } from "@/components/money-input";
import type { CostCenterOption } from "@/app/(app)/cadastros/_lib/cost-centers";

/** Fornecedor exibido no select de novo título. */
export interface SupplierOption {
  id: string;
  name: string;
}

/**
 * Valores devolvidos pela server action quando a criação falha, para o usuário
 * não perder o que digitou. Chegam pela URL (searchParams), não por estado no
 * cliente — a página segue Server Component.
 */
export interface NewPayableDefaults {
  supplierId?: string;
  description?: string;
  amount?: string;
  issueDate?: string;
  dueDate?: string;
  installmentCount?: string;
  supplierCategory?: string;
  costClassification?: string;
  costCenterId?: string;
}

/**
 * Formulário de novo título a pagar. As caixas "Categoria" (Categorias de
 * Fornecedores) e "Classificação do CUSTO" (Custo Fixo/Variável) são
 * selecionáveis — nenhuma deriva do cadastro do fornecedor.
 */
export function NewPayableForm({
  suppliers,
  categories,
  costCenters,
  today,
  defaults,
}: {
  suppliers: SupplierOption[];
  categories: string[];
  costCenters: CostCenterOption[];
  today: string;
  defaults?: NewPayableDefaults;
}) {
  const d = defaults ?? {};
  return (
    <form action={createPayableAction} className="grid gap-4 md:grid-cols-3">
      <Field label="Fornecedor">
        <select name="supplierId" required className={inputClass} defaultValue={d.supplierId ?? ""}>
          <option value="">Selecione…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Descrição">
        <input
          name="description"
          required
          defaultValue={d.description}
          className={inputClass}
          placeholder="Ex.: NF 1234 — insumos"
        />
      </Field>
      <Field label="Valor total (R$)">
        <MoneyInput
          name="amount"
          required
          defaultValue={d.amount}
          className={inputClass}
          placeholder="1.234,56"
        />
      </Field>
      <Field label="Emissão">
        <input
          type="date"
          name="issueDate"
          required
          defaultValue={d.issueDate ?? today}
          className={inputClass}
        />
      </Field>
      <Field label="Vencimento">
        <input
          type="date"
          name="dueDate"
          required
          defaultValue={d.dueDate}
          className={inputClass}
        />
      </Field>
      <Field label="Parcelas">
        <input
          type="number"
          name="installmentCount"
          min={1}
          max={120}
          defaultValue={d.installmentCount ?? 1}
          required
          className={inputClass}
        />
      </Field>
      <Field label="Categoria">
        <select name="supplierCategory" required className={inputClass} defaultValue={d.supplierCategory ?? ""}>
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
        <select name="costClassification" required className={inputClass} defaultValue={d.costClassification ?? ""}>
          <option value="">— selecione —</option>
          <option value="fixed">Custo Fixo</option>
          <option value="variable">Custo Variável</option>
        </select>
      </Field>
      <Field label="Centro de custo (opcional)">
        <select name="costCenterId" className={inputClass} defaultValue={d.costCenterId ?? ""}>
          <option value="">Sem centro de custo</option>
          {costCenters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-end">
        <Button>Criar título</Button>
      </div>
    </form>
  );
}
