"use client";

import { Button, Field, inputClass } from "@/components/ui";
import { createPayableAction } from "../actions";
import { MoneyInput } from "@/components/money-input";

// Espelha MAX_RECURRENCE_OCCURRENCES da skill contas_a_pagar. Não importamos da
// skill aqui porque este é um Client Component e a skill puxa node:crypto para o
// bundle. A UI é só conveniência (o teto real é revalidado na skill).
const MAX_RECURRENCE_OCCURRENCES = 60;

/** Fornecedor exibido no select de novo título. */
export interface SupplierOption {
  id: string;
  name: string;
}

/**
 * Formulário de novo título a pagar. As caixas "Categoria" (Categorias de
 * Fornecedores) e "Classificação do CUSTO" (Custo Fixo/Variável) são
 * selecionáveis — nenhuma deriva do cadastro do fornecedor.
 *
 * O TIPO (Parcelado × Recorrente) é escolhido por radios; a alternância dos
 * blocos de campos é feita 100% por CSS (peer-checked), SEM useState nem estado
 * de React — o form permanece um Client Component apenas por causa do MoneyInput.
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
    <form action={createPayableAction} className="grid gap-4 md:grid-cols-4">
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
      <Field label="Valor (R$)">
        <MoneyInput name="amount" required className={inputClass} placeholder="1.234,56" />
      </Field>
      <Field label="Emissão">
        <input type="date" name="issueDate" required defaultValue={today} className={inputClass} />
      </Field>
      <Field label="Vencimento">
        <input type="date" name="dueDate" required className={inputClass} />
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

      {/* TIPO: Parcelado × Recorrente. Os DOIS radios são irmãos diretos dos
          blocos condicionais (mesmo nível), para que os seletores peer-checked
          (que dependem da relação de irmão ~) funcionem. Sem JS de estado —
          alternância 100% CSS. */}
      <fieldset className="md:col-span-4 rounded-lg border border-[var(--line)] p-3">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
          Tipo de lançamento
        </legend>

        {/* Radios "nus" (escondidos) no topo — irmãos dos blocos abaixo. */}
        <input
          type="radio"
          id="tipo-parcelado"
          name="tipoLancamento"
          value="parcelado"
          defaultChecked
          className="peer/parcelado sr-only"
        />
        <input
          type="radio"
          id="tipo-recorrente"
          name="tipoLancamento"
          value="recorrente"
          className="peer/recorrente sr-only"
        />

        {/* Rótulos clicáveis (for=id) com os textos de ajuda; destacam o
            selecionado via peer-checked. */}
        <div className="grid gap-3 md:grid-cols-2">
          <label
            htmlFor="tipo-parcelado"
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--line)] p-3 peer-checked/parcelado:border-[var(--brand)] peer-checked/parcelado:bg-slate-50"
          >
            <span className="text-sm">
              <span className="font-medium">Parcelado</span>
              <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
                O valor informado é o TOTAL, dividido entre as parcelas.
              </span>
            </span>
          </label>
          <label
            htmlFor="tipo-recorrente"
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--line)] p-3 peer-checked/recorrente:border-[var(--brand)] peer-checked/recorrente:bg-slate-50"
          >
            <span className="text-sm">
              <span className="font-medium">Recorrente</span>
              <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
                O valor informado se repete INTEGRALMENTE a cada período.
              </span>
            </span>
          </label>
        </div>

        {/* Campos de PARCELADO — visíveis quando "parcelado" está marcado. */}
        <div className="mt-3 hidden peer-checked/parcelado:block">
          <Field label="Número de parcelas">
            <input
              type="number"
              name="installmentCount"
              min={1}
              max={120}
              defaultValue={1}
              className={`${inputClass} md:w-48`}
            />
          </Field>
        </div>

        {/* Campos de RECORRENTE — visíveis quando "recorrente" está marcado. */}
        <div className="mt-3 hidden peer-checked/recorrente:block">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Frequência">
              <select name="recurrenceFrequency" className={inputClass} defaultValue="monthly">
                <option value="weekly">Semanal</option>
                <option value="monthly">Mensal</option>
                <option value="quarterly">Trimestral</option>
                <option value="yearly">Anual</option>
              </select>
            </Field>
            <Field label={`Número de ocorrências (2 a ${MAX_RECURRENCE_OCCURRENCES})`}>
              <input
                type="number"
                name="recurrenceOccurrences"
                min={2}
                max={MAX_RECURRENCE_OCCURRENCES}
                defaultValue={12}
                className={inputClass}
              />
            </Field>
          </div>
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            Serão criados vários títulos, um por período, cada um com o valor
            informado por INTEIRO (não dividido). O vencimento avança conforme a
            frequência a partir do vencimento informado; a emissão permanece a
            mesma. Os valores e datas exatos aparecem na listagem após salvar.
          </p>
        </div>
      </fieldset>

      <div className="flex items-end md:col-span-4">
        <Button>Criar título</Button>
      </div>
    </form>
  );
}
