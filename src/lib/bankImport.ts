import { hasBankTransactionHeaders, parseDecimal } from './finance';

export type ImportedBankTransaction = {
  id: string;
  date: string;
  merchant: string;
  amount: number;
  category: string;
  sourceFile: string;
  needsReview: boolean;
  categoryDecided: boolean;
};

type Classifier = (transaction: { merchant: string; amount: number }) => {
  category: string;
  needsReview: boolean;
};

type WorksheetRows = {
  name: string;
  rows: unknown[][];
};

const normalizeText = (value: unknown): string => String(value ?? '').trim();
const normalizeHeader = (value: unknown): string => normalizeText(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '');

const parseCellNumber = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = normalizeText(value);
  const parenthesizedNegative = /^\(.*\)$/.test(raw);
  const parsed = parseDecimal(raw.replace(/[^0-9,.-]/g, ''));
  if (!Number.isFinite(parsed)) return 0;
  return parenthesizedNegative ? -Math.abs(parsed) : parsed;
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

type ColumnLayout = {
  date: number;
  merchant: number;
  debit: number;
  credit: number;
  amount: number;
};

const createColumnLayout = (headers: string[]): ColumnLayout => ({
  date: findHeaderIndex(headers, ['bokforingsdatum', 'bokforingsdag', 'transaktionsdatum', 'transactiondate', 'datum', 'date']),
  merchant: findHeaderIndex(headers, ['beskrivning', 'transactiontext', 'transaktionstext', 'description', 'mottagare', 'payee', 'merchant', 'text', 'name']),
  debit: findHeaderIndex(headers, ['debet', 'debit', 'withdrawal', 'utgift']),
  credit: findHeaderIndex(headers, ['kredit', 'credit', 'inkomst']),
  amount: findHeaderIndex(headers, ['amount', 'belopp', 'transaktionsbelopp', 'summa', 'total']),
});

const inferDate = (value: unknown): string => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const date = new Date((value - 25569) * 86400 * 1000);
    return Number.isNaN(date.getTime()) ? 'Okänt datum' : date.toISOString().slice(0, 10);
  }

  const text = normalizeText(value);
  const europeanDate = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (europeanDate) {
    const [, day, month, rawYear] = europeanDate;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    const normalized = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const date = new Date(`${normalized}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized ? 'Okänt datum' : normalized;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? 'Okänt datum' : text;
  }
  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? 'Okänt datum' : fallback.toISOString().slice(0, 10);
};

const valueAt = (values: unknown[], index: number): unknown => index >= 0 ? values[index] : '';

const inferAmount = (values: unknown[], layout: ColumnLayout): number => {
  const debit = parseCellNumber(valueAt(values, layout.debit));
  const credit = parseCellNumber(valueAt(values, layout.credit));
  const amount = parseCellNumber(valueAt(values, layout.amount));
  if (debit !== 0) return -Math.abs(debit);
  if (credit !== 0) return Math.abs(credit);
  return amount;
};

const inferMerchant = (values: unknown[], layout: ColumnLayout): string => {
  const raw = normalizeText(valueAt(values, layout.merchant)).replace(/\s+/g, ' ');
  return raw || 'Okänd merchant';
};

export function parseWorkbookSheets(
  sheets: WorksheetRows[],
  fileName: string,
  lastModified: number,
  classify: Classifier
): ImportedBankTransaction[] {
  const imported: ImportedBankTransaction[] = [];

  sheets.forEach((worksheet, sheetIndex) => {
    const headerIndex = worksheet.rows.findIndex(hasBankTransactionHeaders);
    if (headerIndex < 0) return;
    const headers = worksheet.rows[headerIndex].map(normalizeText);
    const layout = createColumnLayout(headers);

    for (let rowIndex = headerIndex + 1; rowIndex < worksheet.rows.length; rowIndex += 1) {
      const values = worksheet.rows[rowIndex];
      if (!values.some((value) => normalizeText(value))) continue;
      const amount = inferAmount(values, layout);
      if (amount === 0) continue;

      const merchant = inferMerchant(values, layout);
      const date = inferDate(valueAt(values, layout.date));
      const decision = classify({ merchant, amount });
      imported.push({
        id: `${fileName}-${lastModified}-${sheetIndex}-${rowIndex - headerIndex - 1}`,
        date,
        merchant,
        amount,
        category: decision.category,
        sourceFile: fileName,
        needsReview: decision.needsReview || date === 'Okänt datum' || merchant === 'Okänd merchant',
        categoryDecided: false,
      });
    }
  });

  if (imported.length === 0) {
    throw new Error('Hittade inga transaktioner. Kontrollera att filen har datum- och beloppskolumner.');
  }
  return imported;
}