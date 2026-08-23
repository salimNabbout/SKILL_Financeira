"use client";

import { Button, Field, inputClass } from "@/components/ui";
import { createRecurringAction } from "../actions";

export interface SupplierOption {
  id: string;
  name: string;
}

/**
 * Formulário de nova recorrência (a pagar). A geração dos títulos é automática:
 * o app cria o título do mês no vencimento, sem recadastro.
 */
export function RecurringForm({
  suppliers,
  categories,
  today,
}: {
  suppliers: SupplierOption[];
  categories: string[];
  today: string;
}) {
  return (
    <form action={createRecurringAction} className="grid gap-4 md:grid-cols-3">
      <Field label="Fornecedor">
        <select name="counterpartyId" required className={inputClass} defaultValue="">
          <option value="">Selecione…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Descrição">
        <input name="description" required className={inputClass} placeholder="Ex.: Aluguel da sede" />
      </Field>
      <Field label="Valor mensal (R$)">
        <input name="amount" required className={inputClass} placeholder="2.000,00" inputMode="decimal" />
      </Field>
      <Field label="Dia do vencimento">
        <input
          type="number"
          name="dueDay"
          min={1}
          max={31}
          required
          className={inputClass}
          placeholder="5"
        />
      </Field>
      <Field label="Categoria">
        <select name="category" className={inputClass} defaultValue="">
          <option value="">— selecione —</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Classificação do CUSTO">
        <select name="costClassification" className={inputClass} defaultValue="">
          <option value="">— selecione —</option>
          <option value="fixed">Custo Fixo</option>
          <option value="variable">Custo Variável</option>
        </select>
      </Field>
      <Field label="Início">
        <input type="date" name="startDate" required defaultValue={today} className={inputClass} />
      </Field>
      <Field label="Fim (opcional)">
        <input type="date" name="endDate" className={inputClass} />
      </Field>
      <div className="flex items-end">
        <Button>Cadastrar recorrência</Button>
      </div>
    </form>
  );
}
