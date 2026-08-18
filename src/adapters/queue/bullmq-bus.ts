/**
 * Barramento de eventos sobre BullMQ/Redis — mesma interface EventBus do
 * barramento in-process, agora com processamento assíncrono real:
 *
 * - publish: grava o OUTBOX no banco (fonte oficial) e enfileira o evento;
 * - worker: consome a fila e despacha aos handlers registrados;
 * - falha de handler: BullMQ re-tenta com backoff exponencial; esgotadas as
 *   tentativas, o job permanece em "failed" (fila morta consultável).
 *
 * Ativação: EVENT_BUS=bullmq + REDIS_URL no modo produção (ver container).
 * O worker roda em processo próprio: `npx tsx scripts/event-worker.ts`.
 */

import { Queue, Worker } from "bullmq";
import type { Clock } from "@/core/clock";
import type { EventRecordEntity } from "@/core/entities";
import type { DomainEvent, EventBus, EventHandler, EventType } from "@/core/events";
import type { IdGenerator } from "@/core/ids";
import type { EventRepo } from "@/core/repositories";

export interface BullMqBusOptions {
  redisUrl: string;
  /** Nome da fila (default "financeira-eventos"; testes usam nomes únicos). */
  queueName?: string;
  /** Tentativas por evento antes de ir para a fila morta (default 5). */
  attempts?: number;
  /** Delay-base do backoff exponencial em ms (default 500). */
  backoffMs?: number;
}

/** ioredis exige maxRetriesPerRequest: null para as conexões bloqueantes do Worker. */
function connectionOf(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    maxRetriesPerRequest: null as null,
  };
}

export class BullMqEventBus implements EventBus {
  private readonly queue: Queue;
  private readonly handlers = new Map<string, EventHandler[]>();
  private worker?: Worker;
  readonly queueName: string;
  private readonly options: Required<Pick<BullMqBusOptions, "attempts" | "backoffMs">> &
    BullMqBusOptions;

  constructor(
    private readonly repo: EventRepo,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: BullMqBusOptions
  ) {
    this.options = { attempts: 5, backoffMs: 500, ...options };
    this.queueName = options.queueName ?? "financeira-eventos";
    this.queue = new Queue(this.queueName, { connection: connectionOf(options.redisUrl) });
  }

  async publish(event: Omit<DomainEvent, "id" | "occurredAt">): Promise<DomainEvent> {
    const full: DomainEvent = {
      ...event,
      id: this.ids.next("evt"),
      occurredAt: this.clock.now().toISOString(),
    };
    // Outbox primeiro: o banco é a fonte oficial mesmo se o Redis falhar depois.
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
    await this.queue.add(full.type, full, {
      attempts: this.options.attempts,
      backoff: { type: "exponential", delay: this.options.backoffMs },
      removeOnComplete: 1000, // mantém os últimos concluídos para inspeção
      removeOnFail: false, // fila morta: falhas permanecem consultáveis
    });
    return full;
  }

  subscribe(type: EventType | "*", handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /**
   * Inicia o worker que consome a fila e despacha aos handlers registrados
   * NESTA instância. Erro em qualquer handler falha o job inteiro → retry.
   */
  startWorker(concurrency = 4): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(
      this.queueName,
      async (job) => {
        const event = job.data as DomainEvent;
        const subs = [
          ...(this.handlers.get(event.type) ?? []),
          ...(this.handlers.get("*") ?? []),
        ];
        for (const handler of subs) await handler(event);
      },
      { connection: connectionOf(this.options.redisUrl), concurrency }
    );
    return this.worker;
  }

  /** Contagem da fila morta (jobs que esgotaram as tentativas). */
  async failedCount(): Promise<number> {
    return this.queue.getFailedCount();
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  /** Uso exclusivo em testes: apaga a fila inteira. */
  async obliterate(): Promise<void> {
    await this.queue.obliterate({ force: true });
  }
}
