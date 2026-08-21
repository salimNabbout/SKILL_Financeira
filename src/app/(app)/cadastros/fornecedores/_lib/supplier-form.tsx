"use client";

import { useMemo, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import {
  createSupplierAction,
  deleteSupplierAction,
  updateSupplierAction,
} from "../actions";

/** Dados mínimos de cada fornecedor já cadastrado, para o autopreenchimento. */
export interface KnownSupplier {
  name: string;
  document?: string;
  costClassification?: "fixed" | "variable";
  category?: string;
}

/** Fornecedor sendo editado (modo edição do formulário). */
export interface EditingSupplier {
  id: string;
  name: string;
  document?: string;
  email?: string;
  phone?: string;
  costClassification?: "fixed" | "variable";
  category?: string;
}

/**
 * Formulário de fornecedor. Sem `editing`: cria (com AUTOPREENCHIMENTO ao digitar
 * um nome já cadastrado) e permite EXCLUIR o fornecedor digitado. Com `editing`:
 * edita o fornecedor daquele id. Client component só para essas interações.
 */
export function SupplierForm({
  known,
  categories,
  editing,
}: {
  known: KnownSupplier[];
  categories: string[];
  editing?: EditingSupplier;
}) {
  const byName = useMemo(() => {
    const m = new Map<string, KnownSupplier>();
    for (const k of known) m.set(k.name.trim().toUpperCase(), k);
    return m;
  }, [known]);

  const isEditing = Boolean(editing);
  const [name, setName] = useState(editing?.name ?? "");
  const [document, setDocument] = useState(editing?.document ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [cost, setCost] = useState(editing?.costClassification ?? "");
  const [category, setCategory] = useState(editing?.category ?? "");

  function onNameChange(value: string) {
    const upper = value.toUpperCase();
    setName(upper);
    if (isEditing) return; // em edição, o nome não autopreenche de outro registro
    const match = byName.get(upper.trim());
    if (match) {
      // Autopreenche a partir do cadastro anterior (usuário pode editar).
      setDocument(match.document ?? "");
      setCost(match.costClassification ?? "");
      setCategory(match.category ?? "");
    }
  }

  return (
    <form action={isEditing ? updateSupplierAction : createSupplierAction} className="grid gap-4 md:grid-cols-4">
      {isEditing ? <input type="hidden" name="id" value={editing!.id} /> : null}
      <Field label="FORNECEDOR">
        <input
          name="name"
          required
          list={isEditing ? undefined : "fornecedores-conhecidos"}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className={inputClass}
          style={{ textTransform: "uppercase" }}
        />
        {!isEditing ? (
          <datalist id="fornecedores-conhecidos">
            {known.map((k) => (
              <option key={k.name} value={k.name} />
            ))}
          </datalist>
        ) : null}
      </Field>
      <Field label="CNPJ/CPF (opcional)">
        <input
          name="document"
          value={document}
          onChange={(e) => setDocument(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="E-mail">
        <input
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="Telefone">
        <input
          name="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="Classificação do CUSTO">
        <select
          name="costClassification"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          className={inputClass}
        >
          <option value="">— selecione —</option>
          <option value="fixed">Custo Fixo</option>
          <option value="variable">Custo Variável</option>
        </select>
      </Field>
      <Field label="CATEGORIA">
        <select
          name="category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={inputClass}
        >
          <option value="">— selecione —</option>
          {category && !categories.includes(category) ? (
            <option value={category}>{category}</option>
          ) : null}
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
      <div className="flex items-end gap-2">
        <Button>{isEditing ? "Salvar" : "Cadastrar"}</Button>
        {!isEditing ? (
          // Exclui o fornecedor digitado no campo FORNECEDOR (formAction sobrepõe a action do form).
          <button
            type="submit"
            formAction={deleteSupplierAction}
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
          >
            Deletar
          </button>
        ) : null}
      </div>
    </form>
  );
}
