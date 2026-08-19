/**
 * Cria uma EMPRESA e um USUÁRIO ADMIN reais no banco (produção), sem dados
 * fictícios. Use uma vez, no primeiro acesso. Idempotente por e-mail/CNPJ:
 * se o usuário ou a empresa já existirem, não duplica.
 *
 * Executar (dentro do container migrate, que tem node_modules completo):
 *   COMPANY_NAME="Minha Empresa Ltda" COMPANY_CNPJ="00.000.000/0001-00" \
 *   ADMIN_NAME="Fulano" ADMIN_EMAIL="fulano@empresa.com" ADMIN_PASSWORD="senhaForte" \
 *   npx tsx scripts/create-admin.ts
 *
 * Requer DATABASE_URL apontando para o Postgres migrado.
 */

import { PrismaClient } from "@prisma/client";
import { createPrismaRepositories } from "../src/adapters/prisma/repos";
import { DEFAULT_COMPANY_CONFIG } from "../src/core/config";
import { hashPassword } from "../src/lib/password";

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Variável obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

function normalizeEmail(email: string): string {
  const v = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    console.error(`E-mail inválido: "${email}"`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const companyName = req("COMPANY_NAME");
  const companyCnpj = req("COMPANY_CNPJ");
  const adminName = req("ADMIN_NAME");
  const adminEmail = normalizeEmail(req("ADMIN_EMAIL"));
  const adminPassword = req("ADMIN_PASSWORD");
  if (adminPassword.length < 8) {
    console.error("ADMIN_PASSWORD deve ter ao menos 8 caracteres.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const repos = createPrismaRepositories(prisma);
    const now = new Date().toISOString();

    // Empresa (idempotente por CNPJ).
    const existingCompany = await repos.companies.findByCnpj(companyCnpj);
    const company =
      existingCompany ??
      (await repos.companies.create({
        id: `co_${Date.now().toString(36)}`,
        name: companyName,
        cnpj: companyCnpj,
        timezone: process.env.DEFAULT_TIMEZONE ?? "America/Sao_Paulo",
        defaultCurrency: "BRL",
        config: DEFAULT_COMPANY_CONFIG,
        active: true,
        createdAt: now,
        updatedAt: now,
      }));
    if (existingCompany) console.log(`Empresa já existia: ${company.name} (${company.id}).`);
    else console.log(`Empresa criada: ${company.name} (${company.id}).`);

    // Usuário admin (idempotente por e-mail).
    let user = await repos.users.findByEmail(adminEmail);
    if (!user) {
      user = await repos.users.create({
        id: `usr_${Date.now().toString(36)}`,
        name: adminName,
        email: adminEmail,
        passwordHash: hashPassword(adminPassword),
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`Usuário admin criado: ${user.email} (${user.id}).`);
    } else {
      console.log(`Usuário já existia: ${user.email} (${user.id}) — senha NÃO alterada.`);
    }

    // Vínculo admin (idempotente).
    const membership = await repos.memberships.findByUserAndCompany(user.id, company.id);
    if (!membership) {
      await repos.memberships.create({
        id: `mem_${Date.now().toString(36)}`,
        userId: user.id,
        companyId: company.id,
        role: "admin",
        approvalLimitCents: null, // admin: alçada ilimitada
      });
      console.log("Vínculo admin criado.");
    } else {
      console.log("Vínculo já existia.");
    }

    console.log("");
    console.log("Pronto. Acesse o app e faça login com:");
    console.log(`  E-mail: ${adminEmail}`);
    console.log("  Senha:  (a que você definiu em ADMIN_PASSWORD)");
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("Falha ao criar admin:", err);
  process.exitCode = 1;
});
