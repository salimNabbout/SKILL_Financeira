"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { BankAccount, BankAccountType } from "@/core/entities";
import {
  errorMessage,
  fdString,
  maskAccountNumber,
  parseBRLToCents,
} from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cadastros/contas-bancarias";
const TYPES: BankAccountType[] = ["checking", "savings", "payment"];

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createBankAccountAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "bank_account.manage")) {
    fail("Sem permissão para gerenciar contas bancárias (bank_account.manage).");
  }

  const name = fdString(formData, "name");
  const bankCode = fdString(formData, "bankCode");
  const agency = fdString(formData, "agency");
  const fullNumber = fdString(formData, "accountNumber");
  const type = fdString(formData, "type") as BankAccountType;
  const openingBalanceDate = fdString(formData, "openingBalanceDate");
  if (!name || !bankCode || !agency || !fullNumber || !openingBalanceDate) {
    fail("Preencha nome, banco, agência, número da conta e data do saldo inicial.");
  }
  if (!TYPES.includes(type)) fail("Tipo de conta inválido.");

  // O número completo NUNCA é persistido — apenas a máscara com os 4 últimos dígitos.
  let accountNumberMasked = "";
  let openingBalanceCents = 0;
  try {
    accountNumberMasked = maskAccountNumber(fullNumber);
    openingBalanceCents = parseBRLToCents(fdString(formData, "openingBalance") || "0");
  } catch (error) {
    fail(errorMessage(error));
  }

  // Idempotência por chave natural: banco + agência + máscara.
  let existing: BankAccount | undefined;
  try {
    existing = (await container.repos.bankAccounts.listAll(companyId)).find(
      (b) =>
        b.bankCode === bankCode && b.agency === agency && b.accountNumberMasked === accountNumberMasked
    );
  } catch (error) {
    fail(errorMessage(error));
  }
  if (existing) {
    ok(`Conta ${accountNumberMasked} (banco ${bankCode}) já estava cadastrada — nenhum registro duplicado.`);
  }

  try {
    const now = container.clock.now().toISOString();
    const account: BankAccount = {
      id: container.ids.next("bac"),
      companyId,
      name,
      bankCode,
      agency,
      accountNumberMasked,
      type,
      currency: "BRL",
      openingBalanceCents,
      openingBalanceDate,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await container.repos.bankAccounts.create(account);
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "bank_account.created",
      entityType: "bank_account",
      entityId: account.id,
      // A trilha registra apenas o número mascarado (nunca o completo).
      after: account,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(`Conta bancária "${name}" cadastrada (${accountNumberMasked}).`);
}
