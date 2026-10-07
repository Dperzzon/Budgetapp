import {
  hasBankTransactionHeaders,
  inferTransactionType,
  type TransactionType,
} from './finance';

export type ImportedBankTransaction = {
  id: string;
  date: string;
  merchant: string;
  amountCents: number;
  category: string;
  transactionType: TransactionType;
  sourceFile: string;
  needsReview: boolean;
  categoryDecided: boolean;
  importBatchId?: number | null;
  importedSheet: string | null;
  importedRow: number | null;
};

export type ImportIssue = {
  severity: 'warning' | 'blocking';
  code: string;
  sheet: string;
  rowNumber: number;
  field?: 'date' | 'merchant' | 'amount';
  originalValue: unknown;
  message: string;
};

export type SheetSummary = {
  sheet: string;
  acceptedRows: number;
  warnings: number;
  blockingErrors: number;
};

export type ImportResult = {
  acceptedRows: ImportedBankTransaction[];
  warnings: ImportIssue[];
  blockingErrors: ImportIssue[];
  sheetSummaries: SheetSummary[];
};

type Classifier = (transaction: { merchant: string; amountCents: number }) => {
  category: string;
  needsReview: boolean;
  transactionType?: TransactionType;
};

export type WorksheetRow = {
  rowNumber: number;
  values: unknown[];
};

export type WorksheetRows = {
  name: string;
  rows: WorksheetRow[];
};

type ParsedCents =
  | { kind: 'empty' }
  | { kind: 'invalid'; originalValue: unknown }
  | { kind: 'valid'; value: number; originalValue: unknown };

type ParsedDate =
  | { kind: 'invalid'; originalValue: unknown }
  | { kind: 'valid'; value: string };

type ColumnLayout = {
  date: number;
  merchant: number;
  debit: number;
  credit: number;
  amount: number;
};

const normalizeText = (value: unknown): string => String(value ?? '').trim();
const normalizeHeader = (value: unknown): string => normalizeText(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '');

export const unwrapExcelCellValue = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if ('result' in value) return value.result;
  if ('richText' in value && Array.isArray(value.richText)) {
    return value.richText
      .map((part) => typeof part === 'object' && part && 'text' in part ? part.text : '')
      .join('');
  }
  if ('text' in value) return value.text;
  return value;
};

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

const CENTS_EPSILON = 1e-7;

const numericMoneyToCents = (value: number): number | null => {
  if (!Number.isFinite(value)) return null;
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > CENTS_EPSILON) return null;
  return rounded;
};

export const parseMoneyToCents = (value: unknown): ParsedCents => {
  if (value === null || value === undefined || normalizeText(value) === '') return { kind: 'empty' };
  if (typeof value === 'number') {
    const cents = numericMoneyToCents(value);
    return cents === null
      ? { kind: 'invalid', originalValue: value }
      : { kind: 'valid', value: cents, originalValue: value };
  }

  const raw = normalizeText(value);
  const parenthesizedNegative = /^\(.*\)$/.test(raw);
  let numericText = raw
    .replace(/^\((.*)\)$/, '$1')
    .replace(/\s|\u00a0/g, '')
    .replace(/(?:SEK|kr)$/i, '');
  if (!/^[+-]?[0-9.,]+$/.test(numericText)) {
    return { kind: 'invalid', originalValue: value };
  }
  const explicitNegative = numericText.startsWith('-');
  numericText = numericText.replace(/^[+-]/, '');

  const lastComma = numericText.lastIndexOf(',');
  const lastDot = numericText.lastIndexOf('.');
  const decimalSeparator = lastComma >= 0 && lastDot >= 0
    ? (lastComma > lastDot ? ',' : '.')
    : lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : null;
  const thousandsSeparator = decimalSeparator === ',' && lastDot >= 0
    ? '.'
    : decimalSeparator === '.' && lastComma >= 0 ? ',' : null;
  if (decimalSeparator && numericText.split(decimalSeparator).length !== 2) {
    return { kind: 'invalid', originalValue: value };
  }

  const [integerPartRaw, fraction = ''] = decimalSeparator
    ? numericText.split(decimalSeparator)
    : [numericText, ''];
  if (fraction.length > 2 || !/^\d{0,2}$/.test(fraction)) {
    return { kind: 'invalid', originalValue: value };
  }
  if (thousandsSeparator) {
    const groups = integerPartRaw.split(thousandsSeparator);
    if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((group) => !/^\d{3}$/.test(group))) {
      return { kind: 'invalid', originalValue: value };
    }
  } else if (/[.,]/.test(integerPartRaw)) {
    return { kind: 'invalid', originalValue: value };
  }

  const integerDigits = thousandsSeparator
    ? integerPartRaw.split(thousandsSeparator).join('')
    : integerPartRaw;
  if (!/^\d+$/.test(integerDigits)) return { kind: 'invalid', originalValue: value };
  const cents = Number(integerDigits) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return { kind: 'invalid', originalValue: value };
  const signedCents = parenthesizedNegative || explicitNegative ? -cents : cents;
  return { kind: 'valid', value: signedCents, originalValue: value };
};

const findHeaderIndex = (headers: string[], candidates: string[]): number => {
  const normalizedHeaders = headers.map(normalizeHeader);
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeHeader(candidate);
    const index = normalizedHeaders.findIndex((header) => header.includes(normalizedCandidate));
    if (index >= 0) return index;
  }
  return -1;
};

const createColumnLayout = (headers: string[]): ColumnLayout => ({
  date: findHeaderIndex(headers, ['bokforingsdatum', 'bokforingsdag', 'transaktionsdatum', 'transactiondate', 'datum', 'date']),
  merchant: findHeaderIndex(headers, ['beskrivning', 'transactiontext', 'transaktionstext', 'description', 'mottagare', 'payee', 'merchant', 'text', 'name']),
  debit: findHeaderIndex(headers, ['debet', 'debit', 'withdrawal', 'utgift']),
  credit: findHeaderIndex(headers, ['kredit', 'credit', 'inkomst']),
  amount: findHeaderIndex(headers, ['amount', 'belopp', 'transaktionsbelopp', 'summa', 'total']),
});

const datePartsAreValid = (year: number, month: number, day: number): boolean => {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day;
};

const formatDateParts = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const parseDate = (value: unknown): ParsedDate => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const utcMidnight = value.getUTCHours() === 0 && value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
    const localMidnight = value.getHours() === 0 && value.getMinutes() === 0 &&
      value.getSeconds() === 0 && value.getMilliseconds() === 0;
    if (utcMidnight) {
      return { kind: 'valid', value: formatDateParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()) };
    }
    if (localMidnight) {
      return { kind: 'valid', value: formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate()) };
    }
    return { kind: 'invalid', originalValue: value };
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 80000) {
    const wholeDays = Math.floor(value);
    const date = new Date((wholeDays - 25569) * 86400 * 1000);
    return { kind: 'valid', value: formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) };
  }

  const text = normalizeText(value);
  const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoDate) {
    const [, year, month, day] = isoDate.map(Number);
    return datePartsAreValid(year, month, day)
      ? { kind: 'valid', value: formatDateParts(year, month, day) }
      : { kind: 'invalid', originalValue: value };
  }

  const europeanDate = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (europeanDate) {
    const day = Number(europeanDate[1]);
    const month = Number(europeanDate[2]);
    const year = europeanDate[3].length === 2 ? 2000 + Number(europeanDate[3]) : Number(europeanDate[3]);
    return datePartsAreValid(year, month, day)
      ? { kind: 'valid', value: formatDateParts(year, month, day) }
      : { kind: 'invalid', originalValue: value };
  }

  return { kind: 'invalid', originalValue: value };
};

const valueAt = (values: unknown[], index: number): unknown => index >= 0 ? values[index] : '';

const populatedNumber = (parsed: ParsedCents): parsed is Extract<ParsedCents, { kind: 'valid' }> =>
  parsed.kind === 'valid' && parsed.value !== 0;

const parseAmount = (
  values: unknown[],
  layout: ColumnLayout
): { amountCents?: number; issue?: Omit<ImportIssue, 'severity' | 'sheet' | 'rowNumber'>; zeroValue?: unknown } => {
  const debit = parseMoneyToCents(valueAt(values, layout.debit));
  const credit = parseMoneyToCents(valueAt(values, layout.credit));
  const amount = parseMoneyToCents(valueAt(values, layout.amount));
  const populated = [
    ['debit', debit],
    ['credit', credit],
    ['amount', amount],
  ] as const;
  const invalid = populated.find(([, parsed]) => parsed.kind === 'invalid');
  if (invalid) {
    return {
      issue: {
        code: 'invalid-amount',
        field: 'amount',
        originalValue: invalid[1].kind === 'invalid' ? invalid[1].originalValue : '',
        message: 'Beloppet kunde inte tolkas.',
      },
    };
  }

  if (populatedNumber(debit) && populatedNumber(credit)) {
    return {
      issue: {
        code: 'debit-credit-conflict',
        field: 'amount',
        originalValue: { debit: debit.originalValue, credit: credit.originalValue },
        message: 'Både debit och credit innehåller ett belopp.',
      },
    };
  }
  if (populatedNumber(amount) && (populatedNumber(debit) || populatedNumber(credit))) {
    return {
      issue: {
        code: 'ambiguous-amount',
        field: 'amount',
        originalValue: {
          amount: amount.originalValue,
          debit: debit.kind === 'valid' ? debit.originalValue : '',
          credit: credit.kind === 'valid' ? credit.originalValue : '',
        },
        message: 'Raden innehåller flera möjliga beloppskällor.',
      },
    };
  }

  if (populatedNumber(debit)) return { amountCents: -Math.abs(debit.value) };
  if (populatedNumber(credit)) return { amountCents: Math.abs(credit.value) };
  if (populatedNumber(amount)) return { amountCents: amount.value };

  const explicitZero = populated.find(([, parsed]) => parsed.kind === 'valid');
  if (explicitZero?.[1].kind === 'valid') return { zeroValue: explicitZero[1].originalValue };
  return {
    issue: {
      code: 'missing-amount',
      field: 'amount',
      originalValue: '',
      message: 'Raden saknar belopp.',
    },
  };
};

const createIssue = (
  severity: ImportIssue['severity'],
  sheet: string,
  rowNumber: number,
  issue: Omit<ImportIssue, 'severity' | 'sheet' | 'rowNumber'>
): ImportIssue => ({ severity, sheet, rowNumber, ...issue });

export function parseWorkbookSheets(
  sheets: WorksheetRows[],
  fileName: string,
  lastModified: number,
  classify: Classifier
): ImportResult {
  const result: ImportResult = {
    acceptedRows: [],
    warnings: [],
    blockingErrors: [],
    sheetSummaries: [],
  };
  let sheetsWithHeaders = 0;

  sheets.forEach((worksheet, sheetIndex) => {
    const acceptedBefore = result.acceptedRows.length;
    const warningsBefore = result.warnings.length;
    const blockingBefore = result.blockingErrors.length;
    const headerIndex = worksheet.rows.findIndex((row) => hasBankTransactionHeaders(row.values));
    if (headerIndex < 0) {
      result.warnings.push(createIssue('warning', worksheet.name, 0, {
        code: 'sheet-without-transactions',
        originalValue: worksheet.name,
        message: 'Sheeten saknar identifierbara transaktionsrubriker och importerades inte.',
      }));
    } else {
      sheetsWithHeaders += 1;
      const headers = worksheet.rows[headerIndex].values.map(normalizeText);
      const layout = createColumnLayout(headers);

      for (let rowIndex = headerIndex + 1; rowIndex < worksheet.rows.length; rowIndex += 1) {
        const row = worksheet.rows[rowIndex];
        const values = row.values;
        if (!values.some((value) => normalizeText(value))) continue;

        const parsedAmount = parseAmount(values, layout);
        if (parsedAmount.issue) {
          result.blockingErrors.push(createIssue(
            'blocking',
            worksheet.name,
            row.rowNumber,
            parsedAmount.issue
          ));
          continue;
        }
        if (parsedAmount.amountCents === undefined) {
          result.warnings.push(createIssue('warning', worksheet.name, row.rowNumber, {
            code: 'zero-amount-excluded',
            field: 'amount',
            originalValue: parsedAmount.zeroValue,
            message: 'Raden har nollbelopp och kommer inte att importeras.',
          }));
          continue;
        }

        const merchantValue = valueAt(values, layout.merchant);
        const merchant = normalizeText(merchantValue).replace(/\s+/g, ' ');
        if (!merchant) {
          result.blockingErrors.push(createIssue('blocking', worksheet.name, row.rowNumber, {
            code: 'missing-merchant',
            field: 'merchant',
            originalValue: merchantValue,
            message: 'Raden saknar merchant eller beskrivning.',
          }));
          continue;
        }

        const dateValue = valueAt(values, layout.date);
        const parsedDate = parseDate(dateValue);
        if (parsedDate.kind === 'invalid') {
          result.blockingErrors.push(createIssue('blocking', worksheet.name, row.rowNumber, {
            code: 'invalid-date',
            field: 'date',
            originalValue: parsedDate.originalValue,
            message: 'Datumet kunde inte tolkas säkert.',
          }));
          continue;
        }

        const decision = classify({ merchant, amountCents: parsedAmount.amountCents });
        const transactionType = decision.transactionType ??
          inferTransactionType(decision.category, parsedAmount.amountCents);
        const transaction: ImportedBankTransaction = {
          id: `${fileName}-${lastModified}-${sheetIndex}-${row.rowNumber}`,
          date: parsedDate.value,
          merchant,
          amountCents: parsedAmount.amountCents,
          category: decision.category,
          transactionType,
          sourceFile: fileName,
          needsReview: decision.needsReview,
          categoryDecided: false,
          importedSheet: worksheet.name,
          importedRow: row.rowNumber,
        };
        result.acceptedRows.push(transaction);
        if (decision.needsReview) {
          result.warnings.push(createIssue('warning', worksheet.name, row.rowNumber, {
            code: 'unknown-category',
            field: 'merchant',
            originalValue: merchantValue,
            message: 'Ingen säker kategori hittades. Raden importeras för manuell granskning.',
          }));
        }
      }
    }

    result.sheetSummaries.push({
      sheet: worksheet.name,
      acceptedRows: result.acceptedRows.length - acceptedBefore,
      warnings: result.warnings.length - warningsBefore,
      blockingErrors: result.blockingErrors.length - blockingBefore,
    });
  });

  if (sheetsWithHeaders === 0) {
    result.blockingErrors.push(createIssue('blocking', fileName, 0, {
      code: 'no-transaction-data',
      originalValue: fileName,
      message: 'Hittade inget sheet med datum- och beloppskolumner.',
    }));
  } else if (result.acceptedRows.length === 0 && result.blockingErrors.length === 0) {
    result.blockingErrors.push(createIssue('blocking', fileName, 0, {
      code: 'no-accepted-rows',
      originalValue: fileName,
      message: 'Inga transaktioner kunde godkännas för import.',
    }));
  }

  return result;
}
