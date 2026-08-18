/** Erros de domínio tipados — mapeiam para respostas HTTP e envelopes de skill. */

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super("validation_error", message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super("not_found", `${entity} não encontrado(a): ${id}`);
    this.name = "NotFoundError";
  }
}

export class PermissionError extends DomainError {
  constructor(message: string) {
    super("permission_denied", message);
    this.name = "PermissionError";
  }
}

/** Violação de segregação de funções (quem cria não aprova; quem aprova não executa). */
export class SegregationError extends DomainError {
  constructor(message: string) {
    super("segregation_of_duties", message);
    this.name = "SegregationError";
  }
}

export class IntegrationUnavailableError extends DomainError {
  constructor(integration: string) {
    super("integration_unavailable", `Integração indisponível: ${integration}`);
    this.name = "IntegrationUnavailableError";
  }
}
