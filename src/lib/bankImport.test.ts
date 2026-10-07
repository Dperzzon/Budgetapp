import { describe, expect, it } from 'vitest';
import { createTransactionClassifier } from './finance';
import { parseWorkbookSheets, sha256Hex, unwrapExcelCellValue, type WorksheetRows } from './bankImport';

const worksheet = (name: string, rows: unknown[][]): WorksheetRows => ({
  name,
  rows: rows.map((values, index) => ({ rowNumber: index + 1, values })),
});

const parse = (sheets: WorksheetRows[]) =>
  parseWorkbookSheets(sheets, 'bank.xlsx', 123, createTransactionClassifier([]));

describe('bank workbook import validation', () => {
  it('hashes exact bytes independently of file name and changes when bytes change', async () => {
    const originalBytes = new TextEncoder().encode('same workbook bytes').buffer;
    const renamedFileBytes = new TextEncoder().encode('same workbook bytes').buffer;
    const changedBytes = new TextEncoder().encode('same workbook byteS').buffer;

    const originalHash = await sha256Hex(originalBytes);
    const renamedHash = await sha256Hex(renamedFileBytes);
    const changedHash = await sha256Hex(changedBytes);

    expect(originalHash).toHaveLength(64);
    expect(renamedHash).toBe(originalHash);
    expect(changedHash).not.toBe(originalHash);
  });

  it('accepts Swedish and international decimals from multiple sheets', () => {
    const result = parse([
      worksheet('Svenska', [
        ['Bokföringsdag', 'Beskrivning', 'Belopp'],
        ['2026-01-31', 'ICA MAXI', '-1.234,50'],
      ]),
      worksheet('English', [
        ['Date', 'Description', 'Amount'],
        ['2026-02-28', 'SHOP', '-1,234.50'],
      ]),
    ]);

    expect(result.acceptedRows.map(({ date, amountCents }) => ({ date, amountCents }))).toEqual([
      { date: '2026-01-31', amountCents: -123450 },
      { date: '2026-02-28', amountCents: -123450 },
    ]);
    expect(result.blockingErrors).toEqual([]);
    expect(result.acceptedRows.map(({ importedSheet, importedRow }) => ({ importedSheet, importedRow }))).toEqual([
      { importedSheet: 'Svenska', importedRow: 2 },
      { importedSheet: 'English', importedRow: 2 },
    ]);
    expect(new Set(result.acceptedRows.map((transaction) => transaction.id)).size).toBe(2);
  });

  it('accepts debit and credit columns while ignoring empty rows', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Debit', 'Credit'],
      ['2026-01-01', 'Groceries', '1 234,50', ''],
      ['', '', '', ''],
      ['2026-01-02', 'Salary', '', 25000],
    ])]);

    expect(result.acceptedRows.map(({ merchant, amountCents }) => ({ merchant, amountCents }))).toEqual([
      { merchant: 'Groceries', amountCents: -123450 },
      { merchant: 'Salary', amountCents: 2500000 },
    ]);
    expect(result.blockingErrors).toEqual([]);
  });

  it('assigns conservative initial transaction types to imported rows', () => {
    const classify = createTransactionClassifier([
      { id: 'salary', match: 'SALARY', category: 'Lön', priority: 100 },
      { id: 'saving', match: 'SAVE', category: 'Sparande', priority: 100 },
      { id: 'amortization', match: 'LOAN PRINCIPAL', category: 'Sparande / Amortering', priority: 100 },
      { id: 'transfer', match: 'OWN ACCOUNT', category: 'Överföring mellan konto', priority: 100 },
    ]);
    const result = parseWorkbookSheets([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'SALARY', 30000],
      ['2026-01-02', 'GROCERIES', -1000],
      ['2026-01-03', 'SAVE', -2000],
      ['2026-01-04', 'LOAN PRINCIPAL', -3000],
      ['2026-01-05', 'OWN ACCOUNT', 10000],
      ['2026-01-06', 'UNKNOWN POSITIVE', 500],
    ])], 'bank.xlsx', 123, classify);

    expect(result.acceptedRows.map((row) => row.transactionType)).toEqual([
      'income',
      'expense',
      'saving',
      'amortization',
      'transfer',
      'unclassified',
    ]);
  });

  it('uses an explicit learned type without changing the classified category', () => {
    const result = parseWorkbookSheets([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'Mottagen +46700987654', 500],
    ])], 'bank.xlsx', 123, () => ({
      category: 'Okategoriserat',
      needsReview: true,
      transactionType: 'income',
    }));

    expect(result.acceptedRows[0]).toMatchObject({
      category: 'Okategoriserat',
      needsReview: true,
      transactionType: 'income',
    });
  });

  it('reports an invalid amount instead of converting it to zero', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'Broken', 'inte ett belopp'],
    ])]);

    expect(result.acceptedRows).toEqual([]);
    expect(result.blockingErrors).toEqual([
      expect.objectContaining({
        code: 'invalid-amount',
        rowNumber: 2,
        originalValue: 'inte ett belopp',
      }),
    ]);
  });

  it('reports an exact zero amount as an explicit excluded warning', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'Zero', 0],
    ])]);

    expect(result.acceptedRows).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'zero-amount-excluded',
      rowNumber: 2,
      originalValue: 0,
    }));
  });

  it('accepts negative amounts', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'Purchase', '(125,50)'],
    ])]);

    expect(result.acceptedRows[0].amountCents).toBe(-12550);
  });

  it('parses supported money formats exactly into cents', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'Swedish spaced', '1 234,56'],
      ['2026-01-02', 'Swedish compact', '1234,56'],
      ['2026-01-03', 'International', '1234.56'],
      ['2026-01-04', 'One cent', '0,01'],
      ['2026-01-05', 'Negative cent', '-0.01'],
      ['2026-01-06', 'Numeric cell', 42.25],
      ['2026-01-07', 'Floating noise', 10.099999999999],
      ['2026-01-08', 'Negative floating noise', -10.099999999999],
    ])]);

    expect(result.acceptedRows.map((row) => row.amountCents)).toEqual([
      123456,
      123456,
      123456,
      1,
      -1,
      4225,
      1010,
      -1010,
    ]);
    expect(result.blockingErrors).toEqual([]);
  });

  it('blocks real precision beyond cents instead of rounding it', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'Text precision', '123.456'],
      ['2026-01-02', 'Numeric precision', 10.123],
    ])]);

    expect(result.acceptedRows).toEqual([]);
    expect(result.blockingErrors).toEqual([
      expect.objectContaining({ code: 'invalid-amount', rowNumber: 2 }),
      expect.objectContaining({ code: 'invalid-amount', rowNumber: 3 }),
    ]);
  });

  it('blocks invalid dates without using platform-dependent fallback parsing', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['October 5, 2026', 'Purchase', -100],
      ['2026-02-30', 'Purchase', -100],
    ])]);

    expect(result.acceptedRows).toEqual([]);
    expect(result.blockingErrors.map((issue) => issue.code)).toEqual([
      'invalid-date',
      'invalid-date',
    ]);
  });

  it('parses Excel serial dates and explicit Swedish text dates', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      [45234, 'Serial', -100],
      ['05/10/2026', 'Text', -200],
    ])]);

    expect(result.acceptedRows.map((row) => row.date)).toEqual(['2023-11-04', '2026-10-05']);
  });

  it('preserves a calendar date from a local-midnight Date without timezone shifting', () => {
    const value = new Date(2026, 9, 5, 0, 0, 0, 0);
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      [value, 'Date value', -100],
    ])]);

    expect(result.acceptedRows[0].date).toBe('2026-10-05');
  });

  it('reports sheets without headers and blocks a workbook with no transaction sheet', () => {
    const result = parse([worksheet('Notes', [
      ['Information'],
      ['No transactions here'],
    ])]);

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'sheet-without-transactions',
      sheet: 'Notes',
    }));
    expect(result.blockingErrors).toContainEqual(expect.objectContaining({
      code: 'no-transaction-data',
    }));
  });

  it('blocks rows where debit and credit both contain values', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Debit', 'Credit'],
      ['2026-01-01', 'Conflict', 100, 50],
    ])]);

    expect(result.blockingErrors).toContainEqual(expect.objectContaining({
      code: 'debit-credit-conflict',
      rowNumber: 2,
    }));
  });

  it('blocks missing merchants and warns about unknown categories', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', '', -100],
      ['2026-01-02', 'UNKNOWN SHOP', -200],
    ])]);

    expect(result.blockingErrors).toContainEqual(expect.objectContaining({
      code: 'missing-merchant',
      rowNumber: 2,
    }));
    expect(result.acceptedRows).toHaveLength(1);
    expect(result.acceptedRows[0].amountCents).toBe(-20000);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'unknown-category',
      rowNumber: 3,
    }));
  });

  it('uses a formula cached result and exposes a formula without a result as invalid', () => {
    expect(unwrapExcelCellValue({ formula: '1+1', result: -200 })).toBe(-200);
    const unresolved = unwrapExcelCellValue({ formula: '1+1' });
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'Resolved formula', unwrapExcelCellValue({ formula: '1+1', result: -200 })],
      ['2026-01-02', 'Unresolved formula', unresolved],
    ])]);

    expect(result.acceptedRows).toHaveLength(1);
    expect(result.acceptedRows[0].amountCents).toBe(-20000);
    expect(result.blockingErrors).toContainEqual(expect.objectContaining({
      code: 'invalid-amount',
      rowNumber: 3,
    }));
  });

  it('keeps a blocking error visible after the accepted-row preview limit', () => {
    const rows: unknown[][] = [
      ['Date', 'Description', 'Amount'],
      ...Array.from({ length: 105 }, (_, index) => [
        '2026-01-01',
        `Merchant ${index + 1}`,
        index === 104 ? 'broken' : -100,
      ]),
    ];
    const result = parse([worksheet('Transactions', rows)]);

    expect(result.acceptedRows).toHaveLength(104);
    expect(result.blockingErrors).toContainEqual(expect.objectContaining({
      code: 'invalid-amount',
      rowNumber: 106,
    }));
  });

  it('gives every relevant non-empty data row a visible outcome', () => {
    const result = parse([worksheet('Transactions', [
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'Accepted', -100],
      ['2026-01-02', 'Zero', 0],
      ['bad date', 'Blocked', -50],
      ['', '', ''],
    ])]);

    const visibleRows = new Set([
      ...result.acceptedRows.map((row) => Number(row.id.split('-').slice(-1)[0])),
      ...result.warnings.filter((issue) => issue.rowNumber > 0).map((issue) => issue.rowNumber),
      ...result.blockingErrors.filter((issue) => issue.rowNumber > 0).map((issue) => issue.rowNumber),
    ]);
    expect(visibleRows).toEqual(new Set([2, 3, 4]));
  });
});
