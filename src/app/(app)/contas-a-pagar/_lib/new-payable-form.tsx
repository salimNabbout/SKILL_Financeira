"use client";

import { Button, Field, inputClass } from "@/components/ui";
import { createPayableAction } from "../actions";

/** Fornecedor exibido no select de novo título. */
export interface SupplierOption {
  id: string;
  name: string;
}

/**
 * Formulário de novo título a pagar. As caixas "Categoria" (Categorias de
 * Fornecedores) e "Classificação do CUSTO" (Custo Fixo/Variável) são
 * selecionáveis — nenhuma deriva do cadastro do fornecedor.
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
  return (
    <form action={createPayableAction} className="grid gap-4 md:grid-cols-3">
      <Field label="Fornecedor">
        <select name="supplierId" required className={inputClass} defaultValue="">
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
          required
          className={inputClass}
        />
      </Field>
      <Field label="Categoria">
        <select name="supplierCategory" required className={inputClass} defaultValue="">
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
        <select name="costClassification" required className={inputClass} defaultValue="">
          <option value="">— selecione —</option>
          <option value="fixed">Custo Fixo</option>
          <option value="variable">Custo Variável</option>
        </select>
      </Field>
      <div className="flex items-end">
        <Button>Criar título</Button>
      </div>
    </form>
  );
}
