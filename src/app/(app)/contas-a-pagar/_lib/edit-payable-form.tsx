import Link from "next/link";
import { Button, Field, inputClass } from "@/components/ui";
import { MoneyInput } from "@/components/money-input";
import { updatePayableAction } from "../actions";
import type { CostCenterOption } from "./new-payable-form";

// Espelha os rótulos de frequência do select de NewPayableForm (mesma ordem).
const FREQUENCIA_LABEL: Record<string, string> = {
  weekly: "Semanal",
  monthly: "Mensal",
  quarterly: "Trimestral",
  yearly: "Anual",
};

/**
 * Título carregado do banco, já no formato que o formulário consome.
 * `amount` vem como "1234,56" — o mesmo formato que o MoneyInput aceita.
 */
export interface EditPayableValues {
  id: string;
  supplierName: string;
  description: string;
  amount: string;
  documentNumber?: string;
  issueDate: string;
  dueDate: string;
  supplierCategory: string;
  costClassification: string;
  costCenterId: string;
  notes: string;
  installmentNumber: number;
  installmentCount: number;
  /** Preenchido só quando o título nasceu de recorrência (marcador da originKey). */
  recurrenceFrequency?: string;
  /** Pagamento agendado: o valor fica travado até o agendamento ser cancelado. */
  scheduled: boolean;
}

/** Reidratação após falha de validação (searchParams f_* → defaultValue). */
export interface EditPayablePrefill {
  description?: string;
  amount?: string;
  issueDate?: string;
  dueDate?: string;
  supplierCategory?: string;
  costClassification?: string;
  costCenterId?: string;
  notes?: string;
}

/**
 * Formulário de EDIÇÃO de título a pagar — espelho do "Novo título": os mesmos
 * campos, na mesma ordem e com os mesmos rótulos, mais a caixa "Observação".
 *
 * Nem tudo que o Novo título coleta pode mudar depois. Fornecedor, Nº do Doc. e
 * o Tipo de lançamento (parcelado × recorrente) formam a identidade do título
 * (`originKey` na skill contas_a_pagar): alterá-los seria outra obrigação, e por
 * isso a skill os deixa de fora do `update_payable`. Aqui eles aparecem como
 * campos DESABILITADOS — a informação fica toda na tela, sem oferecer uma caixa
 * editável que o servidor recusaria. Para trocá-los, cancele o título e recrie.
 *
 * Editáveis: Descrição, Valor, Emissão, Vencimento, Categoria, Classificação do
 * CUSTO, Centro de Custo e Observação.
 */
export function EditPayableForm({
  payable,
  categories,
  costCenters,
  prefill,
  cancelHref,
}: {
  payable: EditPayableValues;
  categories: string[];
  costCenters: CostCenterOption[];
  prefill?: EditPayablePrefill;
  cancelHref: string;
}) {
  // Campo só de leitura: a mesma caixa do formulário de criação, apagada.
  // `disabled` (e não `readOnly`) para o navegador não submeter o valor — a
  // action ignora estes nomes de qualquer forma.
  const readOnlyClass = `${inputClass} cursor-not-allowed text-[var(--ink-muted)] opacity-70`;
  const isRecorrente = Boolean(payable.recurrenceFrequency);
  const posicaoLabel = isRecorrente ? "Ocorrência" : "Parcela";
  const cardBase = "flex items-start gap-2 rounded-lg border p-3 text-sm";
  const cardOn = `${cardBase} border-[var(--brand)] bg-slate-50`;
  const cardOff = `${cardBase} border-[var(--line)] opacity-60`;

  return (
    <form
      action={updatePayableAction}
      className="grid gap-4 rounded-lg border border-[var(--line)] bg-slate-50 p-3 md:grid-cols-4"
    >
      <input type="hidden" name="payableId" value={payable.id} />

      <Field label="Fornecedor">
        <input value={payable.supplierName} disabled className={readOnlyClass} />
        <span className="mt-1 block text-xs text-[var(--ink-muted)]">
          Não editável: trocar o fornecedor é outro título. Cancele e recrie.
        </span>
      </Field>
      <Field label="Descrição">
        <input
          name="description"
          required
          defaultValue={prefill?.description ?? payable.description}
          className={inputClass}
          placeholder="Ex.: NF 1234 — insumos"
        />
      </Field>
      <Field label="Valor (R$)">
        <MoneyInput
          name="amount"
          required
          defaultValue={prefill?.amount ?? payable.amount}
          className={inputClass}
          placeholder="1.234,56"
        />
      </Field>
      <Field label="Nº do Doc. (opcional)">
        <input value={payable.documentNumber ?? "—"} disabled className={readOnlyClass} />
        <span className="mt-1 block text-xs text-[var(--ink-muted)]">
          Não editável: o documento é a chave que evita lançamento duplicado.
        </span>
      </Field>
      <Field label="Emissão">
        <input
          type="date"
          name="issueDate"
          required
          defaultValue={prefill?.issueDate ?? payable.issueDate}
          className={inputClass}
        />
      </Field>
      <Field label="Vencimento">
        <input
          type="date"
          name="dueDate"
          required
          defaultValue={prefill?.dueDate ?? payable.dueDate}
          className={inputClass}
        />
      </Field>
      <Field label="Categoria">
        <select
          name="supplierCategory"
          defaultValue={prefill?.supplierCategory ?? payable.supplierCategory}
          className={inputClass}
        >
          <option value="">— selecione —</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Classificação do CUSTO">
        <select
          name="costClassification"
          defaultValue={prefill?.costClassification ?? payable.costClassification}
          className={inputClass}
        >
          <option value="">— selecione —</option>
          <option value="fixed">Custo Fixo</option>
          <option value="variable">Custo Variável</option>
        </select>
      </Field>
      {/* A lista recebida já inclui o centro de custo atual do título, mesmo
          inativo ou de outro destino, para a edição não trocar em silêncio o
          que foi lançado. */}
      <Field label="Centro de Custo">
        <select
          name="costCenterId"
          defaultValue={prefill?.costCenterId ?? payable.costCenterId}
          className={inputClass}
        >
          <option value="">— selecione —</option>
          {costCenters.map((cc) => (
            <option key={cc.id} value={cc.id}>
              {cc.label}
            </option>
          ))}
        </select>
      </Field>

      {/* TIPO DE LANÇAMENTO — espelha o bloco do Novo título, em leitura. O tipo
          é decidido na criação (define quantos títulos existem e a originKey de
          cada um); aqui ele é mostrado com a posição desta linha na série. */}
      <fieldset className="md:col-span-4 rounded-lg border border-[var(--line)] p-3">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
          Tipo de lançamento
        </legend>
        <div className="grid gap-3 md:grid-cols-2">
          <div className={isRecorrente ? cardOff : cardOn}>
            <span>
              <span className="font-medium">Parcelado</span>
              <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
                O valor informado é o TOTAL, dividido entre as parcelas.
              </span>
            </span>
          </div>
          <div className={isRecorrente ? cardOn : cardOff}>
            <span>
              <span className="font-medium">Recorrente</span>
              <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
                O valor informado se repete INTEGRALMENTE a cada período.
              </span>
            </span>
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {isRecorrente ? (
            <Field label="Frequência">
              <input
                value={
                  FREQUENCIA_LABEL[payable.recurrenceFrequency ?? ""] ??
                  payable.recurrenceFrequency ??
                  "—"
                }
                disabled
                className={readOnlyClass}
              />
            </Field>
          ) : (
            <Field label="Número de parcelas">
              <input value={payable.installmentCount} disabled className={readOnlyClass} />
            </Field>
          )}
          <Field label={`${posicaoLabel} deste título`}>
            <input
              value={`${payable.installmentNumber} de ${payable.installmentCount}`}
              disabled
              className={readOnlyClass}
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-[var(--ink-muted)]">
          O tipo de lançamento é definido na criação e vale para a série inteira.
          Salvar aqui altera apenas este título; os demais da série continuam como
          estão.
        </p>
      </fieldset>

      {/* Observação: texto livre do título (campo `notes` da entidade). Em bloco
          próprio, ocupando a linha, por ser mais longo que os demais campos. */}
      <div className="md:col-span-4">
        <Field label="Observação">
          <textarea
            name="notes"
            rows={3}
            defaultValue={prefill?.notes ?? payable.notes}
            className={inputClass}
            placeholder="Anotações sobre este título (opcional)."
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-2 md:col-span-4">
        <Button variant="warn" type="submit">
          Salvar alterações
        </Button>
        <Link
          href={cancelHref}
          className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Cancelar
        </Link>
        {payable.scheduled ? (
          <span className="text-xs text-amber-700">
            Este título tem pagamento agendado: o valor não pode ser alterado até o
            agendamento ser cancelado.
          </span>
        ) : null}
      </div>
    </form>
  );
}
