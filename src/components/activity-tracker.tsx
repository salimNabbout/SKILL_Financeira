"use client";

/**
 * Rastreador global de atividade — delegação de eventos no document.
 * Captura cliques em elementos interativos, interações com controles de
 * formulário (sem valores), submissões e navegação entre telas, e envia em
 * LOTE para POST /api/v1/ui-events (fetch keepalive; sendBeacon ao sair da
 * página, para não travar a UI).
 *
 * Regras:
 * - nunca previne default nem lança: telemetria jamais quebra a ação principal;
 * - não registra mousemove/scroll/hover nem cliques em área vazia;
 * - deduplica cliques repetidos no mesmo elemento em < 300ms;
 * - NUNCA lê valores de campos — só rótulo visível e identidade do elemento;
 * - fila limitada: sob falha do servidor, eventos são descartados em silêncio.
 */

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const ENDPOINT = "/api/v1/ui-events";
const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH = 20; // fila neste tamanho antecipa o envio
const SEND_MAX = 50; // teto do lote aceito pelo servidor
const MAX_QUEUE = 200;
const DEDUPE_MS = 300;

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  "[data-action]",
].join(", ");

interface UiEvent {
  tipo: "clique" | "submissao" | "navegacao" | "interacao";
  tela: string;
  rotulo?: string;
  elemento?: string;
  detalhes?: Record<string, unknown>;
  timestamp: string;
}

// Estado do módulo (o componente monta uma única vez, no layout autenticado).
const queue: UiEvent[] = [];
let lastSignature = "";
let lastSignatureAt = 0;

function send(eventos: UiEvent[], useBeacon: boolean): void {
  try {
    const body = JSON.stringify({ eventos });
    if (useBeacon && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Telemetria nunca quebra a UI.
  }
}

function flush(): void {
  if (queue.length === 0) return;
  send(queue.splice(0, SEND_MAX), false);
}

/** Esvazia tudo via sendBeacon — chamado ao ocultar/sair da página. */
function flushAll(): void {
  while (queue.length > 0) send(queue.splice(0, SEND_MAX), true);
}

function enqueue(event: Omit<UiEvent, "timestamp">): void {
  try {
    const sig = `${event.tipo}|${event.tela}|${event.rotulo ?? ""}|${event.elemento ?? ""}`;
    const now = Date.now();
    if (sig === lastSignature && now - lastSignatureAt < DEDUPE_MS) return;
    lastSignature = sig;
    lastSignatureAt = now;
    if (queue.length >= MAX_QUEUE) queue.shift(); // descarta o mais antigo
    queue.push({ ...event, timestamp: new Date().toISOString() });
    if (queue.length >= MAX_BATCH) flush();
  } catch {
    // nunca quebra a UI
  }
}

function labelOf(el: Element): string | undefined {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 120);
  const aria = el.getAttribute("aria-label") ?? el.getAttribute("title");
  if (aria) return aria.slice(0, 120);
  // Para <input type=submit|button>, o rótulo visível é o value (estático).
  if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) {
    return el.value || undefined;
  }
  return undefined;
}

function identityOf(el: Element): string | undefined {
  return el.id || el.getAttribute("name") || el.getAttribute("data-action") || undefined;
}

function onClick(e: MouseEvent): void {
  try {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest(INTERACTIVE_SELECTOR);
    if (!el) return; // clique em área vazia: não registra
    enqueue({
      tipo: "clique",
      tela: window.location.pathname,
      rotulo: labelOf(el),
      elemento: identityOf(el),
      detalhes: { tag: el.tagName.toLowerCase() },
    });
  } catch {
    // nunca quebra a UI
  }
}

function onSubmit(e: SubmitEvent): void {
  try {
    const form = e.target instanceof HTMLFormElement ? e.target : null;
    const submitter = e.submitter;
    enqueue({
      tipo: "submissao",
      tela: window.location.pathname,
      rotulo: submitter ? labelOf(submitter) : undefined,
      elemento:
        form?.id ||
        form?.getAttribute("name") ||
        (submitter ? identityOf(submitter) : undefined) ||
        undefined,
    });
  } catch {
    // nunca quebra a UI
  }
}

function onChange(e: Event): void {
  try {
    const el = e.target;
    const isSelect = el instanceof HTMLSelectElement;
    const isToggleOrFilter =
      el instanceof HTMLInputElement && ["checkbox", "radio", "date"].includes(el.type);
    if (!isSelect && !isToggleOrFilter) return; // campos de texto: nem identidade, nem valor
    enqueue({
      tipo: "interacao",
      tela: window.location.pathname,
      elemento: identityOf(el),
      // NUNCA o valor escolhido — só o tipo do controle (LGPD).
      detalhes: { controle: isSelect ? "select" : (el as HTMLInputElement).type },
    });
  } catch {
    // nunca quebra a UI
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") flushAll();
}

export function ActivityTracker() {
  const pathname = usePathname();

  // Navegação: dispara na carga da página e a cada troca de rota do App Router.
  useEffect(() => {
    enqueue({ tipo: "navegacao", tela: pathname });
  }, [pathname]);

  useEffect(() => {
    const interval = window.setInterval(flush, FLUSH_INTERVAL_MS);
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flushAll);
      flush();
    };
  }, []);

  return null;
}
