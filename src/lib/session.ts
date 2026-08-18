/**
 * Sessão autenticada via cookie HttpOnly assinado (HMAC-SHA256).
 * Produção deve considerar um IdP robusto; o mecanismo aqui é simples,
 * auditável e sem dependências, adequado ao MVP.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Actor, Company, Membership, User } from "@/core/entities";
import { resolveCompanyConfig, type CompanyConfig } from "@/core/config";
import { getContainer } from "./container";

const COOKIE_NAME = "financeira_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 horas

interface SessionPayload {
  userId: string;
  companyId: string;
  exp: number;
}

function secret(): string {
  return process.env.SESSION_SECRET ?? "dev-secret-change-me-0123456789abcdef";
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function encodeSession(payload: SessionPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data)}`;
}

export function decodeSession(value: string): SessionPayload | null {
  const [data, mac] = value.split(".");
  if (!data || !mac) return null;
  const expected = sign(data);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function setSessionCookie(userId: string, companyId: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, encodeSession({ userId, companyId, exp: Date.now() + SESSION_TTL_MS }), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export interface SessionInfo {
  user: User;
  membership: Membership;
  company: Company;
  config: CompanyConfig;
  actor: Actor;
}

export async function getSession(): Promise<SessionInfo | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  const payload = decodeSession(raw);
  if (!payload) return null;

  const { repos } = await getContainer();
  const user = await repos.users.getById(payload.userId);
  if (!user || !user.active) return null;
  const membership = await repos.memberships.findByUserAndCompany(payload.userId, payload.companyId);
  if (!membership) return null;
  const company = await repos.companies.getById(payload.companyId);
  if (!company || !company.active) return null;

  return {
    user,
    membership,
    company,
    config: resolveCompanyConfig(company.config),
    actor: { type: "user", id: user.id, role: membership.role },
  };
}

/** Para páginas protegidas: redireciona ao login se não autenticado. */
export async function requireSession(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
