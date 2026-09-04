/**
 * Âncora EXTERNA do head da trilha de auditoria.
 *
 * A cadeia de hash detecta adulteração de conteúdo e truncamento do início/meio
 * sozinha. O truncamento do FIM — apagar os últimos registros — não é detectável
 * só pelos dados presentes: o que sobra continua sendo um prefixo válido. Por
 * isso existe a âncora `AuditHead` (seq + hash do último registro).
 *
 * Só que a âncora mora no MESMO banco. Quem apagar os registros também alcança
 * ela. Este script imprime a âncora no stdout, uma linha JSON por empresa: o log
 * do provedor (Render) passa a guardar uma cópia fora do banco, que ninguém com
 * acesso ao Postgres consegue reescrever.
 *
 * Saída (uma linha por empresa, JSON puro para ser grepável):
 *   {"companyId":"co_x","seq":128,"hash":"ab..","verifiedAt":"2026-..","ok":true}
 *
 * `ok: false` significa que a cadeia NÃO fecha agora — investigar imediatamente.
 *
 * Uso: `npx tsx scripts/audit-anchor.ts` (requer DATABASE_URL). Roda 1x/dia pelo
 * scheduler; ver docs/auditoria-hardening.md para comparar log × banco.
 */

import { PrismaClient } from "@prisma/client";

import { createPrismaRepositories } from "../src/adapters/prisma/repos";
import { verifyChain } from "../src/core/audit";
import type { Repositories } from "../src/core/repositories";

export interface AnchorLine {
  companyId: string;
  /** seq do último registro segundo a âncora (0 quando a trilha está vazia). */
  seq: number;
  hash: string;
  verifiedAt: string;
  /** A cadeia fecha, incluindo o head ancorado. */
  ok: boolean;
  /** Presente só quando ok=false: primeiro seq em que a verificação falhou. */
  brokenAtSeq?: number;
}

/**
 * Lê a âncora de cada empresa, verifica a cadeia CONTRA ela e devolve uma linha
 * por empresa. Exportado para teste — o script só imprime o resultado.
 */
export async function buildAnchorLines(
  repos: Repositories,
  now: Date
): Promise<AnchorLine[]> {
  const companies = await repos.companies.listAll();
  const linhas: AnchorLine[] = [];
  for (const company of companies) {
    const head = await repos.audit.getHead(company.id);
    const records = await repos.audit.list(company.id);
    // Sem head ancorado a verificação ainda vale para o encadeamento; o
    // truncamento do fim é que fica indetectável — por isso seq/hash zerados.
    const resultado = verifyChain(records, head ? { seq: head.seq, hash: head.hash } : undefined);
    linhas.push({
      companyId: company.id,
      seq: head?.seq ?? 0,
      hash: head?.hash ?? "",
      verifiedAt: now.toISOString(),
      ok: resultado.valid,
      ...(resultado.valid ? {} : { brokenAtSeq: resultado.brokenAtSeq }),
    });
  }
  return linhas;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const repos = createPrismaRepositories(prisma);
    const linhas = await buildAnchorLines(repos, new Date());
    for (const linha of linhas) {
      // Uma linha JSON por empresa — o log do provedor vira a cópia externa.
      console.log(JSON.stringify(linha));
    }
    // Saída != 0 quando alguma cadeia não fecha: o job falha e chama atenção.
    if (linhas.some((l) => !l.ok)) process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

// Só executa quando chamado direto (o teste importa buildAnchorLines).
if (process.argv[1]?.includes("audit-anchor")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
