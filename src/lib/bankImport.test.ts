import { describe, expect, it } from 'vitest';
import { createTransactionClassifier } from './finance';
import { parseWorkbookSheets } from './bankImport';

describe('bank workbook import', () => {
  it('imports matching transaction rows from every worksheet with unique ids', () => {
    const headers = ['Bokföringsdag', 'Beskrivning', 'Belopp'];
    const transactions = parseWorkbookSheets([
      { name: 'Januari', rows: [headers, ['2026-01-31', 'ICA MAXI', -100]] },
      { name: 'Februari', rows: [headers, ['2026-02-28', 'ELLEVIO', -200]] },
      { name: 'September', rows: [headers, ['2026-09-30', 'LÖN', 300]] },
    ], 'bank.xlsx', 123, createTransactionClassifier([]));

    expect(transactions).toHaveLength(3);
    expect(transactions.map((transaction) => transaction.date)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-09-30',
    ]);
    expect(new Set(transactions.map((transaction) => transaction.id)).size).toBe(3);
  });

  it('uses debit and credit columns and skips empty rows without stopping the import', () => {
    const transactions = parseWorkbookSheets([{
      name: 'Transactions',
      rows: [
        ['Date', 'Description', 'Debit', 'Credit'],
        ['2026-01-01', 'Groceries', '1 234,50', ''],
        ['', '', '', ''],
        ['2026-01-02', 'Salary', '', 25000],
      ],
    }], 'bank.xlsx', 456, createTransactionClassifier([]));

    expect(transactions.map(({ merchant, amount }) => ({ merchant, amount }))).toEqual([
      { merchant: 'Groceries', amount: -1234.5 },
      { merchant: 'Salary', amount: 25000 },
    ]);
  });
});