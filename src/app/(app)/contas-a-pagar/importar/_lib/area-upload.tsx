"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";

/**
 * Área de upload com arrastar-e-soltar.
 *
 * Único componente cliente do fluxo de importação: precisa de eventos de drag
 * e do nome do arquivo escolhido. O envio continua sendo um form comum,
 * processado por server action.
 */
export function AreaUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [nome, setNome] = useState<string | null>(null);
  const [sobre, setSobre] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const { pending } = useFormStatus();

  function aceitar(arquivos: FileList | null) {
    const arquivo = arquivos?.[0];
    if (!arquivo) return;
    if (!/\.csv$/i.test(arquivo.name)) {
      setErro("Só arquivos .csv são aceitos.");
      setNome(null);
      return;
    }
    setErro(null);
    setNome(arquivo.name);
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setSobre(true);
        }}
        onDragLeave={() => setSobre(false)}
        onDrop={(e) => {
          e.preventDefault();
          setSobre(false);
          // Espelha o arquivo solto no input real: é ele que o form envia.
          if (inputRef.current && e.dataTransfer.files.length > 0) {
            inputRef.current.files = e.dataTransfer.files;
            aceitar(e.dataTransfer.files);
          }
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-6 text-center transition ${
          sobre
            ? "border-[var(--brand)] bg-[var(--brand-soft,transparent)]"
            : "border-[var(--line)] hover:bg-[var(--surface-2)]"
        }`}
      >
        <p className="text-sm font-medium">
          {nome ?? "Arraste o arquivo CSV aqui ou clique para escolher"}
        </p>
        <p className="text-xs text-[var(--ink-muted)]">Somente .csv</p>
        <input
          ref={inputRef}
          type="file"
          name="arquivo"
          accept=".csv,text/csv"
          required
          className="sr-only"
          onChange={(e) => aceitar(e.target.files)}
        />
      </div>
      {erro ? <p className="mt-2 text-xs text-[var(--crit)]">{erro}</p> : null}
      {pending ? (
        <p className="mt-2 text-xs text-[var(--ink-muted)]">Analisando o arquivo…</p>
      ) : null}
    </div>
  );
}
