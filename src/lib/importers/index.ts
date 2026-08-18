/** Importadores de extrato bancário — funções puras (OFX, CSV e stub CNAB240). */

export {
  normalizeText,
  parseDecimalToCents,
  parseLocalizedAmountToCents,
  type ParsedStatement,
  type StatementTransaction,
} from "./common";
export { parseOfx } from "./ofx";
export { parseCsv, parseCsvStatement, type CsvSeparator } from "./csv";
export { parseCnab } from "./cnab";
