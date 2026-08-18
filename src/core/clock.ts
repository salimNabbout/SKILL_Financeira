/** Relógio injetável — todo código de domínio usa Clock, nunca new Date() direto. */

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Relógio fixo para testes e cenários determinísticos. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(iso: string) {
    this.current = new Date(iso);
    if (Number.isNaN(this.current.getTime())) {
      throw new Error(`FixedClock: instante inválido: ${iso}`);
    }
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}
