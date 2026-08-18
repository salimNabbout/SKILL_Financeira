/**
 * CNAB240 — STUB HONESTO (não implementado no MVP).
 *
 * Formato previsto (padrão FEBRABAN, arquivo posicional com linhas de 240
 * caracteres): registro tipo 0 (header de arquivo), tipo 1 (header de lote),
 * tipo 3 (detalhes — segmentos A/B para pagamentos e segmento E para extrato
 * de conta, usado na conciliação), tipo 5 (trailer de lote) e tipo 9 (trailer
 * de arquivo). Valores vêm sem separador decimal (últimos 2 dígitos são os
 * centavos) e datas no formato DDMMAAAA. A implementação futura deve devolver
 * o mesmo ParsedStatement dos demais importadores.
 */

import { IntegrationUnavailableError } from "@/core/errors";
import type { ParsedStatement } from "./common";

export function parseCnab(_content: string): ParsedStatement {
  throw new IntegrationUnavailableError("CNAB240 — não implementado no MVP; use OFX ou CSV");
}
