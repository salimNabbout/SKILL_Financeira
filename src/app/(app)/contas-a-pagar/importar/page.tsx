import Link from "next/link";
import { Badge, Button, Card, PageHeader, Table, Td } from "@/components/ui";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { formatBR, formatBRL } from "@/lib/format";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { IMPORT_CSV_COLUMNS, type ImportPreview } from "../_lib/import-csv";
import { analisarCsvAction, confirmarImportacaoAction } from "./actions";
import { AreaUpload } from "./_lib/area-upload";

/**
 * Importação de títulos a pagar por CSV, em duas etapas explícitas:
 * enviar o arquivo → conferir a pré-visualização → confirmar.
 *
 * Nada é gravado antes do "Confirmar importação". A prévia trafega no
 * formulário (campo oculto), então o servidor não guarda estado entre as
 * etapas — e um usuário que desistir simplesmente fecha a página.
 *
 * É uma página, e não um modal, porque o app não tem componente de diálogo e
 * todas as telas são Server Components.
 */
export default async function ImportarContasAPagarPage({
  searchParams,
}: {
  searchParams: Promise<{
    erro?: string;
    previa?: string;
    importados?: string;
    ignorados?: string;
    falhas?: string;
    detalhe?: string;
  }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const podeLancar = hasPermission(session.membership.role, "payable.create");

  let previa: ImportPreview | null = null;
  if (sp.previa) {
    try {
      previa = JSON.parse(Buffer.from(sp.previa, "base64url").toString("utf8")) as ImportPreview;
    } catch {
      previa = null;
    }
  }

  const concluido = sp.importados !== undefined;
  const duplicadas = previa?.validas.filter((l) => l.duplicado).length ?? 0;

  return (
    <div>
      <PageHeader
        title="Importar títulos a pagar"
        subtitle="Envie um CSV, confira a pré-visualização e confirme. Nada é gravado antes da confirmação."
        actions={
          <Link href="/contas-a-pagar" className="text-sm text-[var(--brand)] underline">
            ← Contas a pagar
          </Link>
        }
      />
      <Flash erro={sp.erro} />

      {!podeLancar ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seu papel não permite lançar títulos.
        </p>
      ) : concluido ? (
        <Card title="Importação concluída">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <p className="text-xs text-[var(--ink-muted)]">Importados</p>
              <p className="text-2xl font-semibold text-[var(--ok)]">{sp.importados}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--ink-muted)]">Ignorados (duplicados)</p>
              <p className="text-2xl font-semibold">{sp.ignorados ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--ink-muted)]">Com falha</p>
              <p className="text-2xl font-semibold text-[var(--crit)]">{sp.falhas ?? 0}</p>
            </div>
          </div>
          {sp.detalhe ? (
            <p className="mt-3 text-xs text-[var(--crit)]">{sp.detalhe}</p>
          ) : null}
          <div className="mt-4 flex gap-3">
            <Link
              href="/contas-a-pagar"
              className="text-sm text-[var(--brand)] underline"
            >
              Ver os títulos
            </Link>
            <Link href="/contas-a-pagar/importar" className="text-sm text-[var(--brand)] underline">
              Importar outro arquivo
            </Link>
          </div>
        </Card>
      ) : previa ? (
        <>
          <Card className="mb-4" title="Resumo da conferência">
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <p className="text-xs text-[var(--ink-muted)]">Linhas válidas</p>
                <p className="text-2xl font-semibold text-[var(--ok)]">{previa.validas.length}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--ink-muted)]">Com erro</p>
                <p className="text-2xl font-semibold text-[var(--crit)]">{previa.erros.length}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--ink-muted)]">Possíveis duplicatas</p>
                <p className="text-2xl font-semibold text-[var(--warn)]">{duplicadas}</p>
              </div>
            </div>
            {previa.truncado ? (
              <p className="mt-3 text-xs text-[var(--warn)]">
                O arquivo passou do limite de linhas por importação e foi cortado. Divida-o e
                importe em partes.
              </p>
            ) : null}

            <form action={confirmarImportacaoAction} className="mt-4 flex flex-wrap items-center gap-3">
              {/* A prévia validada volta ao servidor no próprio formulário:
                  sem sessão, sem cache, sem gravar nada antes do aceite. */}
              <input
                type="hidden"
                name="linhas"
                value={Buffer.from(JSON.stringify(previa.validas), "utf8").toString("base64url")}
              />
              {duplicadas > 0 ? (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="incluirDuplicadas" className="h-4 w-4" />
                  Importar também as {duplicadas} possíveis duplicatas
                </label>
              ) : null}
              <Button>Confirmar importação</Button>
              <Link href="/contas-a-pagar/importar" className="text-sm text-[var(--ink-muted)] underline">
                Cancelar
              </Link>
            </form>
          </Card>

          {previa.validas.length > 0 ? (
            <Card className="mb-4" title={`Linhas válidas (${previa.validas.length})`}>
              <Table
                headers={[
                  "Linha",
                  "Fornecedor",
                  "Descrição",
                  "Documento",
                  "Emissão",
                  "Vencimento",
                  "Parcelas",
                  "Valor",
                  "Situação",
                ]}
                align={["l", "l", "l", "l", "l", "l", "l", "r", "l"]}
              >
                {previa.validas.map((l) => (
                  <tr key={l.linha}>
                    <Td>{l.linha}</Td>
                    <Td>{l.supplierName}</Td>
                    <Td>{l.description}</Td>
                    <Td>{l.documentNumber ?? "—"}</Td>
                    <Td>{formatBR(l.issueDate)}</Td>
                    <Td>{formatBR(l.dueDate)}</Td>
                    <Td>{l.installmentCount}</Td>
                    <Td right>{formatBRL(l.amountCents)}</Td>
                    <Td>
                      {l.duplicado ? (
                        <Badge tone="warn">Possível duplicata</Badge>
                      ) : (
                        <Badge tone="ok">Nova</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          ) : null}

          {previa.erros.length > 0 ? (
            <Card title={`Linhas com erro (${previa.erros.length})`}>
              <Table headers={["Linha", "Motivo", "Conteúdo"]} align={["l", "l", "l"]}>
                {previa.erros.map((e) => (
                  <tr key={e.linha}>
                    <Td>{e.linha}</Td>
                    <Td>
                      <span className="text-[var(--crit)]">{e.motivo}</span>
                    </Td>
                    <Td>
                      <span className="text-xs text-[var(--ink-muted)]">
                        {e.bruto.join(" ; ").slice(0, 120)}
                      </span>
                    </Td>
                  </tr>
                ))}
              </Table>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <a
                  href={`/contas-a-pagar/importar/erros?previa=${sp.previa}`}
                  className="text-sm text-[var(--brand)] underline"
                >
                  Baixar log de erros (CSV)
                </a>
                <p className="text-xs text-[var(--ink-muted)]">
                  Essas linhas <strong>não</strong> serão importadas. Corrija a planilha e envie de
                  novo, ou confirme só as válidas.
                </p>
              </div>
            </Card>
          ) : null}
        </>
      ) : (
        <Card title="1 — Envie o arquivo">
          <p className="mb-3 text-sm text-[var(--ink-muted)]">
            O arquivo deve ter as colunas: {IMPORT_CSV_COLUMNS.join("; ")}. Fornecedor, categoria e
            centro de custo precisam existir nos cadastros.
          </p>
          <a
            href="/contas-a-pagar/importar/modelo"
            className="mb-4 inline-block text-sm text-[var(--brand)] underline"
          >
            Baixar modelo CSV
          </a>
          <form action={analisarCsvAction}>
            <AreaUpload />
            <div className="mt-3">
              <Button>Analisar arquivo</Button>
            </div>
          </form>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            A análise apenas confere os dados — nenhum título é criado nesta etapa.
          </p>
        </Card>
      )}
    </div>
  );
}
