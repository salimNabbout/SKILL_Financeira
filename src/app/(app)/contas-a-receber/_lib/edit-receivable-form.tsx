import Link from "next/link";
import { Button, Field, inputClass } from "@/components/ui";
import { MoneyInput } from "@/components/money-input";
import { updateReceivableAction } from "../actions";

/** Categoria de receita para o select ("Nome"); value é o id. */
export interface CategoriaOption {
  id: string;
  name: string;
}

/** Centro de custo para o select ("CÓDIGO — Nome"); value é o id. */
export interface CentroOption {
  id: string;
  label: string;
}

/** Título carregado do banco, no formato que o formulário consome. */
export interface EditReceivableValues {
  id: string;
  customerName: string;
  description: string;
  /** "1234,56" — o formato que o MoneyInput aceita. */
  amount: string;
  issueDate: string;
  dueDate: string;
  categoryId: string;
  costCenterId: string;
  notes: string;
  installmentNumber: number;
  installmentCount: number;
  /** Título nascido de nota fiscal: cancelar/alterar passa pela fatura. */
  fromInvoice: boolean;
}

/** Reidratação após falha de validação (searchParams f_* → defaultValue). */
export interface EditReceivablePrefill {
  description?: string;
  amount?: string;
  issueDate?: string;
  dueDate?: string;
  categoryId?: string;
  costCenterId?: string;
  notes?: string;
}

/**
 * Formulário de EDIÇÃO de título a receber — espelho do lado Contas a pagar.
 *
 * Cliente, nota fiscal e parcela compõem a identidade do título (`originKey` na
 * skill): alterá-los seria outra obrigação, e por isso a skill os deixa fora do
 * `update_receivable`. Aparecem aqui DESABILITADOS — a informação fica na tela
 * sem oferecer uma caixa que o servidor recusaria.
 *
 * Editáveis: Descrição, Valor, Emissão, Vencimento, Categoria, Centro de Custo
 * e Observação. Só enquanto o título não tiver recebimento: com dinheiro
 * baixado, o caminho é estornar o recebimento primeiro.
 */
export function EditReceivableForm({
  receivable,
  categorias,
  centros,
  prefill,
  cancelHref,
}: {
  receivable: EditReceivableValues;
  categorias: CategoriaOption[];
  centros: CentroOption[];
  prefill?: EditReceivablePrefill;
  cancelHref: string;
}) {
  const readOnlyClass = `${inputClass} cursor-not-allowed text-[var(--ink-muted)] opacity-70`;

  return (
    // Moldura em degradê, como no lado pagar: cores literais (não tokens do
    // tema) para o vermelho ficar igual no claro e no escuro; raio interno 2px
    // menor que o externo, a espessura exata da moldura.
    <div
      className="rounded-lg p-[2px]"
      style={{
        backgroundImage:
          "linear-gradient(135deg, #dc2626 0%, #f87171 30%, #7f1d1d 65%, #ef4444 100%)",
      }}
    >
      <form
        action={updateReceivableAction}
        className="grid gap-4 rounded-md bg-slate-50 p-3 md:grid-cols-4"
      >
        <input type="hidden" name="receivableId" value={receivable.id} />

        <Field label="Cliente">
          <input value={receivable.customerName} disabled className={readOnlyClass} />
          <span className="mt-1 block text-xs text-[var(--ink-muted)]">
            Não editável: trocar o cliente é outro título. Cancele e recrie.
          </span>
        </Field>
        <Field label="Descrição">
          <input
            name="description"
            required
            defaultValue={prefill?.description ?? receivable.description}
            className={inputClass}
            placeholder="Ex.: NF 1234 — serviços"
          />
        </Field>
        <Field label="Valor (R$)">
          <MoneyInput
            name="amount"
            required
            defaultValue={prefill?.amount ?? receivable.amount}
            className={inputClass}
            placeholder="1.234,56"
          />
        </Field>
        <Field label="Parcela deste título">
          <input
            value={`${receivable.installmentNumber} de ${receivable.installmentCount}`}
            disabled
            className={readOnlyClass}
          />
          <span className="mt-1 block text-xs text-[var(--ink-muted)]">
            O parcelamento é definido na criação e vale para a série inteira.
          </span>
        </Field>
        <Field label="Emissão">
          <input
            type="date"
            name="issueDate"
            required
            defaultValue={prefill?.issueDate ?? receivable.issueDate}
            className={inputClass}
          />
        </Field>
        <Field label="Vencimento">
          <input
            type="date"
            name="dueDate"
            required
            defaultValue={prefill?.dueDate ?? receivable.dueDate}
            className={inputClass}
          />
        </Field>
        <Field label="Categoria">
          <select
            name="categoryId"
            defaultValue={prefill?.categoryId ?? receivable.categoryId}
            className={inputClass}
          >
            <option value="">— sem categoria —</option>
            {categorias.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {/* A lista recebida já inclui o centro atual do título, mesmo inativo,
            para a edição não trocar em silêncio o que foi lançado. */}
        <Field label="Centro de Custo">
          <select
            name="costCenterId"
            defaultValue={prefill?.costCenterId ?? receivable.costCenterId}
            className={inputClass}
          >
            <option value="">— sem centro de custo —</option>
            {centros.map((cc) => (
              <option key={cc.id} value={cc.id}>
                {cc.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="md:col-span-4">
          <Field label="Observação">
            <textarea
              name="notes"
              rows={3}
              defaultValue={prefill?.notes ?? receivable.notes}
              className={inputClass}
              placeholder="Anotações sobre este título (opcional)."
            />
          </Field>
        </div>

        {receivable.fromInvoice ? (
          <p className="md:col-span-4 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            Título gerado por nota fiscal: alterar valor ou vencimento aqui não altera a
            fatura. Para mudanças que afetem a nota, use Faturamento.
          </p>
        ) : null}

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
        </div>
      </form>
    </div>
  );
}
