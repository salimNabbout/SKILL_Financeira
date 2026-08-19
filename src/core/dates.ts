/**
 * Datas de negócio como strings ISO "YYYY-MM-DD" (sem hora), interpretadas no
 * fuso da empresa (padrão America/Sao_Paulo). Carimbos de tempo em UTC.
 * Sem dependências externas: usa Intl para conversão de fuso.
 */

export type ISODate = string; // YYYY-MM-DD
export type ISOMonth = string; // YYYY-MM

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(s: string): s is ISODate {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function assertISODate(s: string): ISODate {
  if (!isISODate(s)) throw new Error(`Data inválida (esperado YYYY-MM-DD): ${s}`);
  return s;
}

/** Data "de hoje" no fuso informado, dado um instante UTC. */
export function todayInTz(now: Date, timeZone: string): ISODate {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now); // en-CA => YYYY-MM-DD
}

/** Hora local (0–23) do instante no fuso informado. */
export function hourInTz(now: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  });
  return Number(fmt.format(now));
}

/** Converte ISODate para Date UTC ao meio-dia (evita bugs de DST/fuso). */
export function toUtcNoon(date: ISODate): Date {
  return new Date(`${date}T12:00:00Z`);
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = toUtcNoon(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(date: ISODate, months: number): ISODate {
  const d = toUtcNoon(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/** b - a em dias (positivo se b é depois de a). */
export function diffDays(a: ISODate, b: ISODate): number {
  const ms = toUtcNoon(b).getTime() - toUtcNoon(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function isBefore(a: ISODate, b: ISODate): boolean {
  return a < b; // formato ISO ordena lexicograficamente
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

export function monthOf(date: ISODate): ISOMonth {
  return date.slice(0, 7);
}

export function startOfMonth(month: ISOMonth): ISODate {
  return `${month}-01`;
}

export function endOfMonth(month: ISOMonth): ISODate {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

/** Lista meses de start a end inclusive. ["2026-01", "2026-02", ...] */
export function monthsBetween(start: ISOMonth, end: ISOMonth): ISOMonth[] {
  const out: ISOMonth[] = [];
  let [y, m] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Formata para exibição pt-BR: 2026-08-18 -> 18/08/2026 */
export function formatBR(date: ISODate): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}
