"use client";

import { useMemo, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { createSupplierAction } from "../actions";

/** Dados mínimos de cada fornecedor já cadastrado, para o autopreenchimento. */
export interface KnownSupplier {
  name: string;
  document?: string;
  costClassification?: "fixed" | "variable";
  category?: string;
}

/**
 * Formulário de novo fornecedor com AUTOPREENCHIMENTO: ao digitar um nome já
 * cadastrado, CNPJ/CPF, Classificação do Custo e Categoria são preenchidos com
 * o que foi salvo antes (editável). Client component só para essa interação.
 */
export function SupplierForm({ known }: { known: KnownSupplier[] }) {
  const byName = useMemo(() => {
    const m = new Map<string, KnownSupplier>();
    for (const k of known) m.set(k.name.trim().toUpperCase(), k);
    return m;
  }, [known]);

  const [name, setName] = useState("");
  const [document, setDocument] = useState("");
  const [cost, setCost] = useState("");
  const [category, setCategory] = useState("");

  function onNameChange(value: string) {
    const upper = value.toUpperCase();
    setName(upper);
    const match = byName.get(upper.trim());
    if (match) {
      // Autopreenche a partir do cadastro anterior (usuário pode editar).
      setDocument(match.document ?? "");
      setCost(match.costClassification ?? "");
      setCategory(match.category ?? "");
    }
  }

  return (
    <form action={createSupplierAction} className="grid gap-4 md:grid-cols-4">
      <Field label="FORNECEDOR">
        <input
          name="name"
          required
          list="fornecedores-conhecidos"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className={inputClass}
          style={{ textTransform: "uppercase" }}
        />
        <datalist id="fornecedores-conhecidos">
          {known.map((k) => (
            <option key={k.name} value={k.name} />
          ))}
        </datalist>
      </Field>
      <Field label="CNPJ/CPF">
        <input
          name="document"
          required
          value={document}
          onChange={(e) => setDocument(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="E-mail">
        <input name="email" type="email" className={inputClass} />
      </Field>
      <Field label="Telefone">
        <input name="phone" className={inputClass} />
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
        <input
          name="category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={inputClass}
        />
      </Field>
      <div className="flex items-end">
        <Button>Cadastrar</Button>
      </div>
    </form>
  );
}
