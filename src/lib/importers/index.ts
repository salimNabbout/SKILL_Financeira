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
export {
  CNAB240_LAYOUT,
  CNAB240_LINE_LENGTH,
  looksLikeCnab240,
  parseCnab,
  parseCnab240,
} from "./cnab";
export {
  decodeStatementBuffer,
  detectStatementFormat,
  MAX_STATEMENT_FILE_BYTES,
  type StatementEncoding,
  type StatementFormat,
} from "./decode";
export { extractStatementUpload, type StatementUpload } from "./upload";
