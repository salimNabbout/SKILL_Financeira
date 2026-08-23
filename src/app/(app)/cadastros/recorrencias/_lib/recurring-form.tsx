"use client";

import { useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { createRecurringAction } from "../actions";

export interface PartyOption {
  id: string;
  name: string;
}

/**
 * Formulário de nova recorrência. O tipo (a pagar / a receber) alterna entre
 * fornecedor e cliente; categoria e classificação de custo só aparecem para
 * "a pagar". A geração dos títulos é automática todo mês.
 */
export function RecurringForm({
  suppliers,
  customers,
  categories,
  today,
}: {
  suppliers: PartyOption[];
  customers: PartyOption[];
  categories: string[];
  today: string;
}) {
  const [kind, setKind] = useState<"payable" | "receivable">("payable");
  const isPayable = kind === "payable";
  const parties = isPayable ? suppliers : customers;

  return (
    <form action={createRecurringAction} className="grid gap-4 md:grid-cols-3">
      <Field label="Tipo">
        <select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as "payable" | "receivable")}
          className={inputClass}
        >
          <option value="payable">A pagar (fornecedor)</option>
          <option value="receivable">A receber (cliente)</option>
        </select>
      </Field>
      <Field label={isPayable ? "Fornecedor" : "Cliente"}>
        {/* key força recriar o select ao trocar o tipo, limpando a seleção. */}
        <select key={kind} name="counterpartyId" required className={inputClass} defaultValue="">
          <option value="">Selecione…</option>
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Descrição">
        <input
          name="description"
          required
          className={inputClass}
          placeholder={isPayable ? "Ex.: Aluguel da sede" : "Ex.: Mensalidade do plano"}
        />
      </Field>
      <Field label="Valor mensal (R$)">
        <input name="amount" required className={inputClass} placeholder="2.000,00" inputMode="decimal" />
      </Field>
      <Field label="Dia do vencimento">
        <input type="number" name="dueDay" min={1} max={31} required className={inputClass} placeholder="5" />
      </Field>
      {isPayable ? (
        <>
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
        </>
      ) : null}
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
