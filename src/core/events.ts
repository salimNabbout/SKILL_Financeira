/**
 * Barramento de eventos de domínio.
 * MVP: in-process, síncrono, com persistência (outbox) no repositório de eventos.
 * Evolução: adaptador BullMQ/Redis implementando a mesma interface.
 */

import type { EventRecordEntity, ID } from "./entities";
import type { EventRepo } from "./repositories";
import type { Clock } from "./clock";
import type { IdGenerator } from "./ids";

/** Catálogo de tipos de evento — string literal para permitir extensão controlada. */
export type EventType =
  | "payable.created"
  | "payable.updated"
  | "payable.canceled"
  | "payment.scheduled"
  | "payment.approved"
  | "payment.rejected"
  | "payment.executed"
  | "payment.reversed"
  | "receivable.created"
  | "receivable.updated"
  | "receivable.received"
  | "receivable.canceled"
  | "receivable.overdue_detected"
  | "invoice.created"
  | "invoice.issued"
  | "invoice.canceled"
  | "statement.imported"
  | "reconciliation.auto_matched"
  | "reconciliation.suggested"
  | "reconciliation.confirmed"
  | "reconciliation.audited"
  | "reconciliation.rejected"
  | "collection.message_drafted"
  | "collection.message_sent"
  | "budget.deviation_detected"
  | "cashflow.updated"
  | "cashflow.shortfall_detected"
  | "controls.anomaly_detected"
  | "accounting.entry_prepared"
  | "accounting.batch_exported"
  | "alert.raised"
  | "approval.requested"
  | "approval.partially_approved"
  | "approval.decided"
  | "flow.completed"
  | "report.generated";

export interface DomainEvent<P = unknown> {
  id: ID;
  companyId: ID;
  type: EventType;
  payload: P;
  /** Skill ou orquestrador que publicou. */
  source: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
}

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export interface EventBus {
  publish(event: Omit<DomainEvent, "id" | "occurredAt">): Promise<DomainEvent>;
  subscribe(type: EventType | "*", handler: EventHandler): void;
}

/**
 * Barramento in-process: persiste no outbox e despacha de forma síncrona.
 * Erros de handler são isolados (não derrubam o publicador) e registrados.
 */
export class InMemoryEventBus implements EventBus {
  private handlers = new Map<string, EventHandler[]>();
  private errors: { event: DomainEvent; error: unknown }[] = [];

  constructor(
    private readonly repo: EventRepo,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

  async publish(event: Omit<DomainEvent, "id" | "occurredAt">): Promise<DomainEvent> {
    const full: DomainEvent = {
      ...event,
      id: this.ids.next("evt"),
      occurredAt: this.clock.now().toISOString(),
    };
    const record: EventRecordEntity = {
      id: full.id,
      companyId: full.companyId,
      type: full.type,
      payload: full.payload,
      source: full.source,
      correlationId: full.correlationId,
      causationId: full.causationId,
      occurredAt: full.occurredAt,
    };
    await this.repo.append(record);
    const subs = [...(this.handlers.get(full.type) ?? []), ...(this.handlers.get("*") ?? [])];
    for (const handler of subs) {
      try {
        await handler(full);
      } catch (error) {
        this.errors.push({ event: full, error });
      }
    }
    return full;
  }

  subscribe(type: EventType | "*", handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** Erros de handlers isolados durante o despacho (para inspeção/telemetria). */
  get handlerErrors(): ReadonlyArray<{ event: DomainEvent; error: unknown }> {
    return this.errors;
  }
}
