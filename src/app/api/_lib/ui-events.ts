/**
 * Eventos de atividade vindos do front-end, em lote (telemetria de auditoria).
 * Corpo: { eventos: [{ tipo, tela, rotulo?, elemento?, detalhes?, timestamp? }] }.
 * Usuário, empresa, IP e user-agent vêm SEMPRE da sessão/requisição — o
 * cliente não tem como se passar por outro usuário. Testável sem Next.
 */

import { z } from "zod";
import type { ActivityLog } from "@/core/activity";
import { ValidationError } from "@/core/errors";

export const uiEventSchema = z.object({
  tipo: z.enum(["clique", "submissao", "navegacao", "interacao"]),
  tela: z.string().trim().min(1).max(300),
  rotulo: z.string().trim().max(160).optional(),
  elemento: z.string().trim().max(160).optional(),
  detalhes: z.record(z.unknown()).optional(),
  timestamp: z.string().max(40).optional(),
});
export type UiEvent = z.infer<typeof uiEventSchema>;

/** Lote limitado: o front agrupa (~2s ou 20 eventos); 50 é folga, não convite. */
export const uiEventsBatchSchema = z.object({
  eventos: z.array(uiEventSchema).min(1).max(50),
});

export interface UiEventsSession {
  user: { id: string };
  company: { id: string };
}

export interface UiEventsMeta {
  ip?: string;
  userAgent?: string;
}

/** Valida o lote e grava cada evento com origem "frontend". */
export async function registerUiEvents(
  activity: ActivityLog,
  session: UiEventsSession,
  raw: unknown,
  meta: UiEventsMeta = {}
): Promise<{ recebidos: number }> {
  const parsed = uiEventsBatchSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`Entrada inválida: ${detail}`);
  }
  for (const ev of parsed.data.eventos) {
    // record() mascara chaves sensíveis nos detalhes e nunca lança.
    await activity.record(session.company.id, {
      userId: session.user.id,
      origin: "frontend",
      eventType: ev.tipo,
      screen: ev.tela,
      label: ev.rotulo,
      elementId: ev.elemento,
      details: ev.detalhes,
      timestamp: ev.timestamp,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
  return { recebidos: parsed.data.eventos.length };
}
