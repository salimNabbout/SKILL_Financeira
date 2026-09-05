/**
 * Lista os itens/contas do Pluggy para montar o PLUGGY_ACCOUNT_MAP.
 *
 * Uso (na VPS ou local, com o env de produção carregado):
 *   npm run pluggy:accounts
 *
 * Exige PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no ambiente. Se DATABASE_URL
 * estiver definido, lista também as contas bancárias locais (BankAccount) para
 * casar os ids na hora. NUNCA imprime segredos.
 *
 * Se a listagem GET /items não estiver disponível para a sua chave, defina
 * PLUGGY_ITEM_IDS="<itemId1>,<itemId2>" (ids visíveis em dashboard.pluggy.ai)
 * que o script consulta as contas item a item.
 */

const BASE_URL = process.env.PLUGGY_BASE_URL ?? "https://api.pluggy.ai";

interface PluggyItem {
  id: string;
  connector?: { name?: string };
  status?: string;
}
interface PluggyAccountRow {
  id: string;
  type?: string;
  subtype?: string;
  number?: string;
  balance?: number;
  currencyCode?: string;
  updatedAt?: string;
}

function fail(message: string): never {
  console.error(`ERRO: ${message}`);
  process.exit(1);
}

async function pluggyJson<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, { headers: { "X-API-KEY": apiKey } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Pluggy ${path.split("?")[0]} retornou ${response.status}: ${body.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

function pad(value: unknown, width: number): string {
  return String(value ?? "—").padEnd(width);
}

async function main(): Promise<void> {
  const clientId = process.env.PLUGGY_CLIENT_ID;
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fail("defina PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no ambiente (dashboard.pluggy.ai → API Keys).");
  }

  const authResponse = await fetch(`${BASE_URL}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!authResponse.ok) {
    fail(`Pluggy /auth retornou ${authResponse.status} — credenciais inválidas ou expiradas.`);
  }
  const { apiKey } = (await authResponse.json()) as { apiKey?: string };
  if (!apiKey) fail("Pluggy /auth não devolveu apiKey.");

  // Itens (conexões bancárias): GET /items ou, se indisponível, PLUGGY_ITEM_IDS.
  let items: PluggyItem[] = [];
  const itemIdsEnv = process.env.PLUGGY_ITEM_IDS;
  if (itemIdsEnv) {
    items = await Promise.all(
      itemIdsEnv.split(",").map((id) => pluggyJson<PluggyItem>(`/items/${id.trim()}`, apiKey!))
    );
  } else {
    try {
      const page = await pluggyJson<{ results: PluggyItem[] }>("/items", apiKey);
      items = page.results ?? [];
    } catch (error) {
      fail(
        `não consegui listar GET /items (${error instanceof Error ? error.message : error}).\n` +
          `Alternativa: copie os itemIds em dashboard.pluggy.ai e rode com PLUGGY_ITEM_IDS="id1,id2".`
      );
    }
  }
  if (items.length === 0) {
    console.log(
      "Nenhum item conectado. Conecte a conta pelo Pluggy Connect (dashboard.pluggy.ai) — o consentimento Open Finance é dado pelo titular da conta."
    );
  }

  console.log("\nContas no Pluggy:");
  console.log(
    pad("itemId", 38) + pad("connector", 26) + pad("accountId", 38) + pad("type/subtype", 26) + pad("number", 16) + pad("balance", 14) + "updatedAt"
  );
  for (const item of items) {
    const accounts = await pluggyJson<{ results: PluggyAccountRow[] }>(
      `/accounts?itemId=${item.id}`,
      apiKey
    );
    for (const acc of accounts.results ?? []) {
      console.log(
        pad(item.id, 38) +
          pad(item.connector?.name, 26) +
          pad(acc.id, 38) +
          pad(`${acc.type ?? "—"}/${acc.subtype ?? "—"}`, 26) +
          pad(acc.number, 16) +
          pad(acc.balance?.toFixed(2), 14) +
          (acc.updatedAt ?? "—")
      );
    }
  }

  // Contas locais para casar os ids (só se houver banco configurado).
  if (process.env.DATABASE_URL) {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const locals = await prisma.bankAccount.findMany({
        select: { id: true, name: true, bankCode: true, accountNumberMasked: true, active: true },
        orderBy: { name: "asc" },
      });
      console.log("\nContas bancárias locais (BankAccount):");
      console.log(pad("id", 42) + pad("name", 30) + pad("bankCode", 10) + "accountNumberMasked");
      for (const b of locals) {
        console.log(
          pad(b.id, 42) + pad(b.name + (b.active ? "" : " (inativa)"), 30) + pad(b.bankCode, 10) + b.accountNumberMasked
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  } else {
    console.log("\n(DATABASE_URL não definido — pulei a listagem das contas locais.)");
  }

  console.log(
    '\nMonte o PLUGGY_ACCOUNT_MAP com pares "idLocal=accountIdPluggy" separados por vírgula, ex.:'
  );
  console.log('PLUGGY_ACCOUNT_MAP="ba_xxx=00000000-0000-0000-0000-000000000000"');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
