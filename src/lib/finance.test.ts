import { describe, expect, it } from 'vitest';
import {
  buildImportSummary,
  amountForCategoryFlow,
  categoriesWithExpenses,
  classifyTransaction,
  createTransactionClassifier,
  findPotentialDuplicateIds,
  findSameMerchantTransactionIds,
  hasBankTransactionHeaders,
  ikeaBarkarbyRules,
  internalTransferRule,
  isExcludedFromOverview,
  isIncludedInOverview,
  netTransactionAmount,
  normalizeMerchant,
  needsCategoryDecision,
  parseDecimal,
  parseExcelDate,
  sortCategoriesByUsage,
  sumCategoryFlow,
  transactionsForCategory,
    transactionsForCategoryFlow,
  toDuplicateKey,
} from './finance';

describe('merchant normalization', () => {
  it('keeps the original merchant text but normalizes conservatively', () => {
    const result = normalizeMerchant('Kortköp 250923 ICA MAXI BROMMA 12495');
    expect(result.raw).toBe('Kortköp 250923 ICA MAXI BROMMA 12495');
    expect(result.normalized).toBe('ICA MAXI BROMMA');
    expect(result.group).toBe('ICA MAXI');
  });

  it('handles variants like asterisks and trailing codes', () => {
    const result = normalizeMerchant('ICA MAXI*12344');
    expect(result.normalized).toBe('ICA MAXI');
    expect(result.group).toBe('ICA MAXI');
  });

  it('finds all existing transactions with the same normalized merchant name', () => {
    const ids = findSameMerchantTransactionIds([
      { id: 1, merchant: 'ICA MAXI*12344' },
      { id: 2, merchant: 'Kortköp 250923 ica maxi 12495' },
      { id: 3, merchant: 'ICA NÄRA' },
    ], 'ICA MAXI');

    expect(ids).toEqual(['1', '2', '3']);
  });

  it('groups merchant-family variants while excluding unrelated roots', () => {
    const ids = findSameMerchantTransactionIds([
      { id: 1, merchant: 'Eon' },
      { id: 2, merchant: 'Eon kundsupport' },
      { id: 3, merchant: 'Eon elhandel' },
      { id: 4, merchant: 'E.ON elhandel' },
      { id: 5, merchant: 'ICA Nära' },
    ], 'Eon kundsupport');

    expect(ids).toEqual(['1', '2', '3', '4']);
  });

  it('matches small merchant spelling variations but not short generic roots', () => {
    const ids = findSameMerchantTransactionIds([
      { id: 1, merchant: 'Netflix' },
      { id: 2, merchant: 'Netflx' },
      { id: 3, merchant: 'HBO Max' },
    ], 'Netflix');

    expect(ids).toEqual(['1', '2']);
  });

  it('keeps IKEA Barkarby IF and HF in separate merchant families', () => {
    const rows = [
      { id: 1, merchant: 'IKEA BARKARBY IF' },
      { id: 2, merchant: 'IKEA BARKARBY HF' },
      { id: 3, merchant: 'IKEA BARKARBY HF KORTKÖP' },
    ];

    expect(findSameMerchantTransactionIds(rows, 'IKEA BARKARBY HF')).toEqual(['2', '3']);
    expect(findSameMerchantTransactionIds(rows, 'IKEA BARKARBY IF')).toEqual(['1']);
  });

  it('does not apply a learned IF category to an HF transaction', () => {
    const decision = classifyTransaction(
      { merchant: 'IKEA BARKARBY HF', amount: -35 },
      [{
        id: 'learned-ikea-if',
        match: 'IKEA BARKARBY IF',
        category: 'Restaurang / Café',
        priority: 10000,
        matchMode: 'merchant-similar',
      }]
    );

    expect(decision.needsReview).toBe(true);
  });

  it('routes IKEA Barkarby HF to housing projects and IF to restaurant', () => {
    const classifier = createTransactionClassifier(ikeaBarkarbyRules);
    expect(classifier({ merchant: 'IKEA BARKARBY HF', amount: -499 }).category).toBe('Boende / Projekt');
    expect(classifier({ merchant: 'IKEA BARKARBY IF', amount: -199 }).category).toBe('Restaurang / Café');
  });

  it('normalizes sent and received Swedish phone-number transfers by direction', () => {
    expect(normalizeMerchant('Skickat +46755123456').normalized).toBe('Swish skickat');
    expect(normalizeMerchant('Skickad +46755123456').normalized).toBe('Swish skickat');
    expect(normalizeMerchant('Swish till +46 70 011 22 33').normalized).toBe('Swish skickat');
    expect(normalizeMerchant('Swish skickat till +46 (0)70 011 22 33').normalized).toBe('Swish skickat');
    expect(normalizeMerchant('Skickat Swish').normalized).toBe('Swish skickat');
    expect(normalizeMerchant('Mottagen +46755123456').normalized).toBe('Swish mottaget');
    expect(normalizeMerchant('Swish mottagen från +46 70 011 22 33').normalized).toBe('Swish mottaget');
    expect(normalizeMerchant('Mottaget 070-011 22 33').normalized).toBe('Swish mottaget');
    expect(normalizeMerchant('Mottagen +123456789').normalized).not.toBe('Swish mottaget');
  });

  it('groups received Swish transactions from different phone numbers', () => {
    const ids = findSameMerchantTransactionIds([
      { id: 1, merchant: 'Mottagen +46755123456' },
      { id: 2, merchant: 'Mottaget 070-011 22 33' },
      { id: 3, merchant: 'Skickat +46755123456' },
    ], 'Mottagen +46700987654');

    expect(ids).toEqual(['1', '2']);
    expect(findSameMerchantTransactionIds([
      { id: 1, merchant: 'Swish mottaget' },
      { id: 2, merchant: 'Mottagen +46755123456' },
    ], 'Swish mottaget')).toEqual(['1', '2']);
  });

  it('groups existing raw and legacy sent-Swish rows and learns the choice for future rows', () => {
    const rows = [
      { id: 1, merchant: 'Skickat +46755123456' },
      { id: 2, merchant: 'Skickat +46700112233' },
      { id: 3, merchant: 'Skickad +46700445566' },
      { id: 4, merchant: 'Skickat Swish' },
      { id: 5, merchant: 'Mottagen +46755123456' },
    ];
    const ids = findSameMerchantTransactionIds(rows, rows[0].merchant);
    const merchantKey = normalizeMerchant(rows[0].merchant).normalized;
    const nextImport = classifyTransaction(
      { merchant: 'Skickad +46700987654', amount: -75 },
      [{ id: 'learned-swish-out', match: merchantKey, category: 'Övrigt', priority: 10000, matchMode: 'merchant-prefix' }]
    );

    expect(ids).toEqual(['1', '2', '3', '4']);
    expect(nextImport.category).toBe('Övrigt');
  });

  it('keeps different Swish phone numbers distinct for duplicate detection', () => {
    const ids = findPotentialDuplicateIds([
      { id: 1, date: '2025-03-31', merchant: 'Mottagen +46755123456', amount: 500 },
      { id: 2, date: '2025-03-31', merchant: 'Mottagen +46700987654', amount: 500 },
      { id: 3, date: '2025-03-31', merchant: 'Mottagen 0755-123 456', amount: 500 },
    ]);

    expect(ids).toEqual(new Set(['1', '3']));
  });
});

describe('date and amount parsing', () => {
  it('converts Excel serial dates correctly', () => {
    const dt = parseExcelDate(45234);
    expect(dt).toBeTruthy();
    expect(dt?.getFullYear()).toBe(2023);
    expect(dt?.getMonth()).toBe(10);
  });

  it('handles Swedish and English decimal formats', () => {
    expect(parseDecimal('1.234,56')).toBe(1234.56);
    expect(parseDecimal('1,234.56')).toBe(1234.56);
  });

  it('recognizes the bank export headers shown in the import preview', () => {
    expect(hasBankTransactionHeaders([
      'Bokföringsdag',
      'Transaktionsdag',
      'Valutadag',
      'Referens',
      'Beskrivning',
      'Belopp',
      'Bokfört saldo',
    ])).toBe(true);
  });
});

describe('duplicate detection', () => {
  it('creates a stable duplicate key', () => {
    const key = toDuplicateKey({
      date: '2024-09-10',
      merchant: 'ICA MAXI BROMMA',
      amount: 243.5,
    });
    expect(key).toBe('2024-09-10|ICA MAXI BROMMA|243.5');
  });

  it('flags possible duplicates but keeps each transaction identifiable', () => {
    const ids = findPotentialDuplicateIds([
      { id: 1, date: '2025-03-31', merchant: 'ICA MAXI', amount: -42.5 },
      { id: 2, date: '2025-03-31', merchant: 'ica maxi', amount: -42.5 },
      { id: 3, date: '2025-04-01', merchant: 'ICA MAXI', amount: -42.5 },
    ]);

    expect(ids).toEqual(new Set(['1', '2']));
  });
});

describe('classification and summary', () => {
  it('returns all and only transactions in the selected category', () => {
    const rows = [
      { id: 1, category: 'Lön', amount: 25000 },
      { id: 2, category: 'Lön', amount: 1200 },
      { id: 3, category: 'Uthyrning', amount: 8000 },
    ];

    expect(transactionsForCategory(rows, 'Lön').map((row) => row.id)).toEqual([1, 2]);
  });

  it('separates positive and negative rows in category detail views', () => {
    const rows = [
      { id: 1, category: 'Övrigt', amount: 150 },
      { id: 2, category: 'Övrigt', amount: -150 },
      { id: 3, category: 'Lön', amount: 5000 },
    ];

    expect(transactionsForCategoryFlow(rows, 'Övrigt', 'income').map((row) => row.id)).toEqual([1]);
    expect(transactionsForCategoryFlow(rows, 'Övrigt', 'expense').map((row) => row.id)).toEqual([2]);
  });

  it('treats savings deposits as positive savings and withdrawals as negative savings', () => {
    const rows = [
      { id: 1, category: 'Sparande', amount: -500 },
      { id: 2, category: 'Sparande', amount: -100 },
      { id: 3, category: 'Sparande', amount: 200 },
    ];

    expect(transactionsForCategoryFlow(rows, 'Sparande', 'income')).toHaveLength(3);
    expect(transactionsForCategoryFlow(rows, 'Sparande', 'expense')).toHaveLength(0);
    expect(amountForCategoryFlow(rows[0], 'Sparande', 'income')).toBe(500);
    expect(sumCategoryFlow(rows, 'Sparande', 'income')).toBe(400);
  });

  it('nets incoming and outgoing transactions in a category', () => {
    expect(netTransactionAmount([
      { amount: 100000 },
      { amount: -100000 },
    ])).toBe(0);
  });

  it('automatically categorizes bank internal transfers and excludes that category from reports', () => {
    const decision = classifyTransaction(
      { merchant: 'Överföring via internet', amount: -1200 },
      [internalTransferRule]
    );

    expect(decision.category).toBe('Överföring mellan konto');
    expect(decision.needsReview).toBe(false);
    expect(isExcludedFromOverview(decision.category)).toBe(true);
  });

  it('excludes only internal account transfers from overview statistics', () => {
    expect(isExcludedFromOverview('Överföring mellan konto')).toBe(true);
    expect(isExcludedFromOverview('Övrigt')).toBe(false);
  });

  it('hides exact-zero transactions from overview without excluding signed entries', () => {
    expect(isIncludedInOverview({ amount: 0, category: 'Övrigt' })).toBe(false);
    expect(isIncludedInOverview({ amount: -10, category: 'Övrigt' })).toBe(true);
    expect(isIncludedInOverview({ amount: 10, category: 'Övrigt' })).toBe(true);
  });

  it('only lists expense categories with a nonzero expense transaction', () => {
    expect(categoriesWithExpenses([
      { category: 'Mat / Dagligvaror', amount: -50 },
      { category: 'Boende / El', amount: 0 },
      { category: 'Sparande', amount: -100 },
      { category: 'Lön', amount: 1000 },
    ])).toEqual(['Mat / Dagligvaror']);
  });

  it('moves an approved duplicate category out of pending review', () => {
    expect(needsCategoryDecision({ needsReview: false, categoryDecided: true }, true)).toBe(false);
    expect(needsCategoryDecision({ needsReview: false, categoryDecided: false }, true)).toBe(true);
    expect(needsCategoryDecision({ needsReview: true, categoryDecided: false }, false)).toBe(true);
  });

  it('orders categories by use and preserves the default order for ties', () => {
    expect(sortCategoriesByUsage(
      ['Mat / Dagligvaror', 'Boende / El', 'Övrigt'],
      [
        { category: 'Övrigt' },
        { category: 'Boende / El' },
        { category: 'Övrigt' },
      ]
    )).toEqual(['Övrigt', 'Boende / El', 'Mat / Dagligvaror']);
  });

  it('respects rule priority and manual overrides', () => {
    const ruleSet = [
      { id: 'explicit', match: 'ICA MAXI', category: 'Mat / Dagligvaror', priority: 100 },
      { id: 'alias', match: 'ICA', category: 'Mat / Dagligvaror', priority: 40 },
    ];
    const decision = classifyTransaction(
      { merchant: 'ICA MAXI BROMMA', amount: -243.5 },
      ruleSet,
      { category: 'Övrigt' }
    );

    expect(decision.category).toBe('Mat / Dagligvaror');
    expect(decision.source).toBe('explicit-user-rule');
  });

  it('prefers a previously learned merchant category over built-in rules', () => {
    const decision = classifyTransaction(
      { merchant: 'ICA MAXI BROMMA', amount: -243.5 },
      [
        { id: 'learned-ica', match: 'ICA MAXI', category: 'Övrigt', priority: 10000 },
        { id: 'built-in-ica', match: 'ICA MAXI', category: 'Mat / Dagligvaror', priority: 100 },
      ]
    );

    expect(decision.category).toBe('Övrigt');
    expect(decision.ruleId).toBe('learned-ica');
  });

  it('applies a learned prefix rule to merchant name variants', () => {
    const decision = classifyTransaction(
      { merchant: 'Eon kundsupport', amount: -55 },
      [{
        id: 'learned-eon',
        match: 'Eon',
        category: 'Boende / El',
        priority: 10000,
        matchMode: 'merchant-prefix',
      }]
    );

    expect(decision.category).toBe('Boende / El');
  });

  it('applies a learned received-Swish rule to different incoming phone numbers', () => {
    const decision = classifyTransaction(
      { merchant: 'Mottagen +46700987654', amount: 250 },
      [{
        id: 'learned-swish-in',
        match: 'Swish mottaget',
        category: 'Uthyrning',
        priority: 10000,
        matchMode: 'merchant-prefix',
      }]
    );

    expect(decision.category).toBe('Uthyrning');
    expect(decision.needsReview).toBe(false);
  });

  it('builds a summary that tracks new and reviewed transactions', () => {
    const summary = buildImportSummary({
      totalFound: 243,
      newTransactions: 229,
      alreadyImported: 14,
      autoCategorized: 198,
      viaRules: 25,
      needsReview: 6,
      duplicateImports: 0,
    });

    expect(summary.totalFound).toBe(243);
    expect(summary.reviewCount).toBe(6);
    expect(summary.newTransactions).toBe(229);
  });
});
