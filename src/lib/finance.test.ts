import { describe, expect, it } from 'vitest';
import {
  buildImportSummary,
  buildBudgetAnalysis,
  buildFinancialHealthSummary,
  buildMonthlyInsights,
  buildRecurringCostTrendInsights,
  buildRecurringExpenseInsights,
  amountForCategoryFlow,
  availableConsumptionBudgetCategories,
  calculateCategoryTotals,
  calculateFinancialSummary,
  categoriesWithExpenses,
  classifyTransaction,
  createTransactionClassifier,
  filterTransactionsByDirection,
  findExactMerchantTransactionIds,
  findExactMerchantTransactionIdsForType,
  findLearnedTransactionType,
  findPotentialDuplicateIds,
  findSameMerchantTransactionIds,
  formatCurrencyFromCents,
  getPeriodStatus,
  hasBankTransactionHeaders,
  getCoveredMonths,
  inferTransactionType,
  isCategoryTransactionTypeConsistent,
  isRelevantMonthlyChange,
  ikeaBarkarbyRules,
  internalTransferRule,
  isExcludedFromOverview,
  isIncludedInOverview,
  netTransactionAmount,
  normalizeMerchant,
  needsCategoryDecision,
  parseExcelDate,
  sortCategoriesByUsage,
  sumCategoryFlow,
  transactionTypeRuleKey,
  transactionsForCategory,
    transactionsForCategoryFlow,
  toDuplicateKey,
  type MonthlyInsightTransaction,
} from './finance';

const insightTransaction = (
  id: number,
  date: string,
  category: string,
  amountCents: number,
  transactionType: MonthlyInsightTransaction['transactionType'] = 'expense',
  merchant = category
): MonthlyInsightTransaction => ({
  id,
  date,
  merchant,
  category,
  amountCents,
  transactionType,
});

describe('budget correctness', () => {
  const today = new Date(2026, 9, 6);
  const transaction = (
    date: string,
    category: string,
    amountCents: number,
    transactionType: 'income' | 'expense' | 'saving' | 'amortization' | 'transfer' | 'refund' | 'unclassified'
  ) => ({ date, category, amountCents, transactionType });

  const analyze = (
    yearTransactions: ReturnType<typeof transaction>[],
    budgets: Record<string, number> = {},
    periodTransactions = yearTransactions,
    kind: 'consumption' | 'income' | 'saving' | 'amortization' = 'consumption',
    year = 2026
  ) => buildBudgetAnalysis({
    periodTransactions,
    yearTransactions,
    budgets,
    kind,
    year,
    today,
  });

  describe('period status', () => {
    const now = new Date(2026, 9, 7);

    it('classifies previous, current, future, and future-year months centrally', () => {
      expect(getPeriodStatus(2026, 9, now)).toBe('past');
      expect(getPeriodStatus(2026, 10, now)).toBe('current');
      expect(getPeriodStatus(2026, 11, now)).toBe('future');
      expect(getPeriodStatus(2027, 1, now)).toBe('future');
    });
  });

  it('counts only completed months with relevant consumption data', () => {
    const rows = [
      transaction('2026-01-10', 'Mat', -10000, 'expense'),
      transaction('2026-03-10', 'Mat', 1000, 'refund'),
      transaction('2026-05-10', 'Intern', -50000, 'transfer'),
      transaction('2026-06-10', 'Övrigt', 50000, 'unclassified'),
      transaction('2026-10-01', 'Mat', -20000, 'expense'),
    ];

    expect(getCoveredMonths(rows, 2026, 'consumption', today)).toEqual([
      '2026-01',
      '2026-03',
    ]);
  });

  it('counts one, five, and twelve covered months including gaps', () => {
    const one = [transaction('2026-01-01', 'Mat', -100, 'expense')];
    const five = [1, 2, 4, 7, 9].map((month) =>
      transaction(`2026-${String(month).padStart(2, '0')}-01`, 'Mat', -100, 'expense')
    );
    const twelve = Array.from({ length: 12 }, (_, index) =>
      transaction(`2025-${String(index + 1).padStart(2, '0')}-01`, 'Mat', -100, 'expense')
    );

    expect(getCoveredMonths(one, 2026, 'consumption', today)).toHaveLength(1);
    expect(getCoveredMonths(five, 2026, 'consumption', today)).toHaveLength(5);
    expect(getCoveredMonths(twelve, 2025, 'consumption', today)).toHaveLength(12);
  });

  it('uses all covered months for a completed historical year', () => {
    const rows = [
      transaction('2025-10-01', 'Mat', -10000, 'expense'),
      transaction('2025-12-01', 'Mat', -20000, 'expense'),
    ];

    expect(getCoveredMonths(rows, 2025, 'consumption', today)).toEqual([
      '2025-10',
      '2025-12',
    ]);
  });

  it('calculates the historical monthly average from five covered months, not twelve', () => {
    const values = [100000, 120000, 110000, 90000, 130000];
    const rows = values.map((amount, index) =>
      transaction(`2026-0${index + 1}-01`, 'Mat', -amount, 'expense')
    );
    const analysis = analyze(rows);

    expect(analysis.coveredMonths).toHaveLength(5);
    expect(analysis.rows[0].historicalMonthlyAverageCents).toBe(110000);
    expect(analysis.rows[0].forecastAnnualCents).toBe(1320000);
  });

  it('creates rows from the union of actual and saved budget categories', () => {
    const analysis = analyze(
      [
        transaction('2026-01-01', 'Endast utfall', -10000, 'expense'),
        transaction('2026-01-02', 'Båda', -20000, 'expense'),
      ],
      { 'Endast budget': 500000, 'Båda': 300000 }
    );
    const rows = Object.fromEntries(analysis.rows.map((row) => [row.category, row]));

    expect(Object.keys(rows).sort()).toEqual(['Båda', 'Endast budget', 'Endast utfall']);
    expect(rows['Endast budget']).toMatchObject({
      budgetCents: 500000,
      actualCents: 0,
      remainingCents: 500000,
      percentUsed: 0,
    });
  });

  it('offers only consumption categories that are not already in the budget table', () => {
    expect(availableConsumptionBudgetCategories(
      [
        'Mat',
        'Transport',
        'Mat',
        'Lön',
        'Sparande',
        'Sparande / Amortering',
        'Överföring mellan konto',
        'Okategoriserat',
      ],
      ['Transport']
    )).toEqual(['Mat']);
  });

  it('nets refunds and excludes non-consumption transaction types', () => {
    const analysis = analyze([
      transaction('2026-01-01', 'Mat', -100000, 'expense'),
      transaction('2026-01-02', 'Mat', 30000, 'refund'),
      transaction('2026-01-03', 'Mat', 500000, 'income'),
      transaction('2026-01-04', 'Mat', -500000, 'saving'),
      transaction('2026-01-05', 'Mat', -500000, 'amortization'),
      transaction('2026-01-06', 'Mat', -500000, 'transfer'),
      transaction('2026-01-07', 'Mat', 500000, 'unclassified'),
    ]);

    expect(analysis.rows).toHaveLength(1);
    expect(analysis.rows[0].actualCents).toBe(70000);
  });

  it('keeps negative actuals when refunds exceed expenses', () => {
    const analysis = analyze([
      transaction('2026-01-01', 'Mat', -10000, 'expense'),
      transaction('2026-01-02', 'Mat', 20000, 'refund'),
    ]);

    expect(analysis.rows[0].actualCents).toBe(-10000);
  });

  it('defines percentage edge cases without NaN or Infinity', () => {
    const cases = [
      ['Half', 100000, -50000, 50],
      ['Full', 100000, -100000, 100],
      ['Over', 100000, -120000, 120],
      ['Zero', 0, 0, null],
      ['No budget', 0, -50000, null],
    ] as const;
    for (const [category, budget, amount, expected] of cases) {
      const analysis = analyze(
        amount === 0 ? [] : [transaction('2026-01-01', category, amount, 'expense')],
        { [category]: budget }
      );
      expect(analysis.rows[0].percentUsed).toBe(expected);
    }
  });

  it('requires two completed covered months before forecasting', () => {
    expect(analyze([], { Mat: 100000 }).rows[0].forecastAnnualCents).toBeNull();
    expect(analyze([
      transaction('2026-01-01', 'Mat', -100000, 'expense'),
    ]).rows[0].forecastAnnualCents).toBeNull();
    expect(analyze([
      transaction('2026-01-01', 'Mat', -100000, 'expense'),
      transaction('2026-02-01', 'Mat', -120000, 'expense'),
      transaction('2026-10-01', 'Mat', -900000, 'expense'),
    ]).rows[0].forecastAnnualCents).toBe(1320000);
  });

  it('separates consumption, saving, and amortization goals', () => {
    const rows = [
      transaction('2026-01-01', 'Mat', -100000, 'expense'),
      transaction('2026-01-02', 'Sparande', -500000, 'saving'),
      transaction('2026-01-03', 'Sparande / Amortering', -300000, 'amortization'),
    ];

    expect(analyze(rows, { Sparande: 600000 }).rows.map((row) => row.category)).toEqual(['Mat']);
    expect(analyze(rows, { Sparande: 600000 }, rows, 'saving').rows[0]).toMatchObject({
      actualCents: 500000,
      budgetCents: 600000,
      remainingCents: 100000,
    });
    expect(analyze(
      rows,
      { 'Sparande / Amortering': 400000 },
      rows,
      'amortization'
    ).rows[0]).toMatchObject({
      actualCents: 300000,
      budgetCents: 400000,
      remainingCents: 100000,
    });
  });
});

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

  it('matches only the exact normalized merchant key for explicit bulk changes', () => {
    const ids = findExactMerchantTransactionIds([
      { id: 1, merchant: 'ICA MAXI*12344' },
      { id: 2, merchant: 'Kortköp ICA MAXI 98765' },
      { id: 3, merchant: 'ICA NÄRA' },
      { id: 4, merchant: 'ICA Banken' },
    ], 'ICA MAXI 12344');

    expect(ids).toEqual(['1', '2']);
  });

  it('groups received Swish separately from sent Swish for type changes', () => {
    const transactions = [
      { id: 1, merchant: 'Mottagen +46700111111' },
      { id: 2, merchant: 'Mottagen +46700222222' },
      { id: 3, merchant: 'Swish betalning +46700333333' },
    ];

    expect(findExactMerchantTransactionIds(transactions, transactions[0].merchant)).toEqual(['1', '2']);
    expect(findExactMerchantTransactionIds(transactions, transactions[2].merchant)).toEqual(['3']);
  });

  it('finds a learned type only for the exact normalized Swish direction', () => {
    const rules = [{ merchantKey: 'SWISH MOTTAGET', transactionType: 'income' as const }];

    expect(findLearnedTransactionType('Mottagen +46700987654', 50000, rules)).toBe('income');
    expect(findLearnedTransactionType('Mottagen +46700987654', -50000, rules)).toBeUndefined();
    expect(findLearnedTransactionType('Swish betalning +46700987654', 50000, rules)).toBeUndefined();
  });

  it('keeps positive and negative merchant matches separate for type changes', () => {
    const transactions = [
      { id: 1, merchant: 'KJELL & CO', amountCents: 26990 },
      { id: 2, merchant: 'KJELL & CO', amountCents: -109900 },
      { id: 3, merchant: 'KJELL & CO', amountCents: 49900 },
    ];

    expect(findExactMerchantTransactionIdsForType(
      transactions,
      transactions[0].merchant,
      transactions[0].amountCents
    )).toEqual(['1', '3']);
    expect(transactionTypeRuleKey('KJELL & CO', 26990)).toBe('CREDIT:KJELL & CO');
    expect(findLearnedTransactionType('KJELL & CO', -109900, [
      { merchantKey: 'CREDIT:KJELL & CO', transactionType: 'refund' },
    ])).toBeUndefined();
  });

  it('filters review transactions by incoming and outgoing amounts', () => {
    const transactions = [
      { id: 1, amountCents: 5000 },
      { id: 2, amountCents: -3000 },
      { id: 3, amountCents: 0 },
    ];

    expect(filterTransactionsByDirection(transactions, 'incoming').map(({ id }) => id)).toEqual([1]);
    expect(filterTransactionsByDirection(transactions, 'outgoing').map(({ id }) => id)).toEqual([2]);
    expect(filterTransactionsByDirection(transactions, 'all')).toEqual(transactions);
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
      { merchant: 'IKEA BARKARBY HF', amountCents: -3500 },
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
    expect(classifier({ merchant: 'IKEA BARKARBY HF', amountCents: -49900 }).category).toBe('Boende / Projekt');
    expect(classifier({ merchant: 'IKEA BARKARBY IF', amountCents: -19900 }).category).toBe('Restaurang / Café');
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
      { merchant: 'Skickad +46700987654', amountCents: -7500 },
      [{ id: 'learned-swish-out', match: merchantKey, category: 'Övrigt', priority: 10000, matchMode: 'merchant-prefix' }]
    );

    expect(ids).toEqual(['1', '2', '3', '4']);
    expect(nextImport.category).toBe('Övrigt');
  });

  it('keeps different Swish phone numbers distinct for duplicate detection', () => {
    const ids = findPotentialDuplicateIds([
      { id: 1, date: '2025-03-31', merchant: 'Mottagen +46755123456', amountCents: 50000 },
      { id: 2, date: '2025-03-31', merchant: 'Mottagen +46700987654', amountCents: 50000 },
      { id: 3, date: '2025-03-31', merchant: 'Mottagen 0755-123 456', amountCents: 50000 },
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
      amountCents: 24350,
    });
    expect(key).toBe('2024-09-10|ICA MAXI BROMMA|24350');
  });

  it('flags possible duplicates but keeps each transaction identifiable', () => {
    const ids = findPotentialDuplicateIds([
      { id: 1, date: '2025-03-31', merchant: 'ICA MAXI', amountCents: -4250 },
      { id: 2, date: '2025-03-31', merchant: 'ica maxi', amountCents: -4250 },
      { id: 3, date: '2025-04-01', merchant: 'ICA MAXI', amountCents: -4250 },
    ]);

    expect(ids).toEqual(new Set(['1', '2']));
  });
});

describe('classification and summary', () => {
  it('returns all and only transactions in the selected category', () => {
    const rows = [
      { id: 1, category: 'Lön', amountCents: 2500000 },
      { id: 2, category: 'Lön', amountCents: 120000 },
      { id: 3, category: 'Uthyrning', amountCents: 800000 },
    ];

    expect(transactionsForCategory(rows, 'Lön').map((row) => row.id)).toEqual([1, 2]);
  });

  describe('financial semantics', () => {
      it('formats cents as Swedish kronor only at the presentation boundary', () => {
        expect(formatCurrencyFromCents(123456)).toBe('1 234,56 kr');
        expect(formatCurrencyFromCents(-1)).toBe('−0,01 kr');
      });

      describe('monthly change insights', () => {
        const today = new Date(2026, 9, 6);

        it('calculates higher, lower, unchanged, new, and missing categories with consumption semantics', () => {
          const transactions = [
            insightTransaction(1, '2026-01-10', 'Mat', -100_000),
            insightTransaction(2, '2026-01-11', 'Transport', -50_000),
            insightTransaction(3, '2026-01-12', 'Oförändrad', -20_000),
            insightTransaction(4, '2026-01-13', 'Nollbas', -10_000),
            insightTransaction(5, '2026-01-14', 'Nollbas', 10_000, 'refund'),
            insightTransaction(6, '2026-02-10', 'Mat', -100_000),
            insightTransaction(7, '2026-02-11', 'Transport', -50_000),
            insightTransaction(8, '2026-02-12', 'Oförändrad', -20_000),
            insightTransaction(9, '2026-02-13', 'Nollbas', -10_000),
            insightTransaction(10, '2026-02-14', 'Nollbas', 10_000, 'refund'),
            insightTransaction(11, '2026-03-10', 'Mat', -160_000),
            insightTransaction(12, '2026-03-11', 'Mat', 20_000, 'refund'),
            insightTransaction(13, '2026-03-12', 'Oförändrad', -20_000),
            insightTransaction(14, '2026-03-13', 'Ny kategori', -30_000),
            insightTransaction(15, '2026-03-14', 'Nollbas', -30_000),
            insightTransaction(16, '2026-03-15', 'Ignorerad', -999_999, 'transfer'),
            insightTransaction(17, '2026-03-16', 'Ignorerad', -999_999, 'saving'),
            insightTransaction(18, '2026-03-17', 'Ignorerad', -999_999, 'amortization'),
            insightTransaction(19, '2026-03-18', 'Ignorerad', -999_999, 'unclassified'),
            insightTransaction(20, '2026-03-19', 'Ignorerad', 999_999, 'income'),
          ];

          const result = buildMonthlyInsights(transactions, 2026, 3, today);
          const changes = new Map(result.categoryChanges.map((change) => [change.category, change]));

          expect(changes.get('Mat')).toMatchObject({
            currentCents: 140_000,
            baselineCents: 100_000,
            deltaCents: 40_000,
            deltaPercent: 40,
          });


          expect(changes.get('Transport')).toMatchObject({
            currentCents: 0,
            baselineCents: 50_000,
            deltaCents: -50_000,
            deltaPercent: -100,
          });
          expect(changes.get('Oförändrad')?.deltaCents).toBe(0);
          expect(changes.get('Ny kategori')).toMatchObject({
            baselineCents: 0,
            deltaCents: 30_000,
            deltaPercent: null,
          });
          expect(changes.get('Nollbas')).toMatchObject({
            baselineCents: 0,
            deltaCents: 30_000,
            deltaPercent: null,
          });
          expect(changes.has('Ignorerad')).toBe(false);
        });

        it('requires history and falls back only to the immediately previous completed month', () => {
          const noHistory = buildMonthlyInsights([
            insightTransaction(1, '2026-03-10', 'Mat', -50_000),
          ], 2026, 3, today);
          const previousMonth = buildMonthlyInsights([
            insightTransaction(1, '2026-02-10', 'Mat', -40_000),
            insightTransaction(2, '2026-03-10', 'Mat', -50_000),
          ], 2026, 3, today);
          const oldMonthWithGap = buildMonthlyInsights([
            insightTransaction(1, '2026-01-10', 'Mat', -40_000),
            insightTransaction(2, '2026-03-10', 'Mat', -50_000),
          ], 2026, 3, today);

          expect(noHistory.status).toBe('insufficient-history');
          expect(previousMonth).toMatchObject({
            status: 'available',
            baselineKind: 'previous-month',
            baselineLabel: 'Jämfört med februari 2026',
            baselineMonthCount: 1,
          });
          expect(oldMonthWithGap.status).toBe('insufficient-history');
        });

        it('uses all earlier completed consumption months for a historical average, including gaps', () => {
          const transactions = [
            insightTransaction(1, '2026-01-10', 'Mat', -10_000),
            insightTransaction(2, '2026-03-10', 'Mat', -30_000),
            insightTransaction(3, '2026-05-10', 'Mat', -50_000),
            insightTransaction(4, '2026-07-10', 'Mat', -70_000),
            insightTransaction(5, '2026-08-10', 'Mat', -90_000),
            insightTransaction(6, '2026-09-10', 'Mat', -60_000),
          ];

          const twoMonths = buildMonthlyInsights(transactions, 2026, 5, today);
          const fiveMonths = buildMonthlyInsights(transactions, 2026, 9, today);

          expect(twoMonths).toMatchObject({
            baselineKind: 'historical-average',
            baselineMonthCount: 2,
            baselineLabel: 'Jämfört med snittet för 2 avslutade månader',
          });
          expect(twoMonths.categoryChanges[0].baselineCents).toBe(20_000);
          expect(fiveMonths).toMatchObject({
            baselineKind: 'historical-average',
            baselineMonthCount: 5,
            baselineLabel: 'Jämfört med snittet för 5 avslutade månader',
          });
          expect(fiveMonths.categoryChanges[0].baselineCents).toBe(50_000);
        });

        it('does not compare an incomplete current month with full historical months', () => {
          const result = buildMonthlyInsights([
            insightTransaction(1, '2026-08-10', 'Mat', -40_000),
            insightTransaction(2, '2026-09-10', 'Mat', -50_000),
            insightTransaction(3, '2026-10-01', 'Mat', -10_000),
          ], 2026, 10, today);

          expect(result.status).toBe('incomplete-month');
          expect(result.categoryChanges).toEqual([]);
          expect(result.totalDeltaCents).toBe(0);
        });

        it('does not calculate changes for a future month or future year', () => {
          const transactions = [
            insightTransaction(1, '2026-08-10', 'Mat', -40_000),
            insightTransaction(2, '2026-09-10', 'Mat', -50_000),
            insightTransaction(3, '2026-11-10', 'Mat', -60_000),
            insightTransaction(4, '2027-01-10', 'Mat', -70_000),
          ];

          const futureMonth = buildMonthlyInsights(transactions, 2026, 11, today);
          const futureYear = buildMonthlyInsights(transactions, 2027, 1, today);

          expect(futureMonth).toMatchObject({
            status: 'future-period',
            categoryChanges: [],
            unusualTransactions: [],
            topMerchants: [],
          });
          expect(futureYear).toMatchObject({
            status: 'future-period',
            categoryChanges: [],
            unusualTransactions: [],
            topMerchants: [],
          });
        });

        it('filters noise using both absolute and percentage thresholds', () => {
          expect(isRelevantMonthlyChange({
            category: 'Litet',
            currentCents: 2_000,
            baselineCents: 500,
            deltaCents: 1_500,
            deltaPercent: 300,
          })).toBe(false);
          expect(isRelevantMonthlyChange({
            category: 'Absolut',
            currentCents: 30_000,
            baselineCents: 5_000,
            deltaCents: 25_000,
            deltaPercent: 500,
          })).toBe(true);
          expect(isRelevantMonthlyChange({
            category: 'Procent',
            currentCents: 60_000,
            baselineCents: 50_000,
            deltaCents: 10_000,
            deltaPercent: 20,
          })).toBe(true);
          expect(isRelevantMonthlyChange({
            category: 'För liten procent',
            currentCents: 60_000,
            baselineCents: 50_000,
            deltaCents: 10_000,
            deltaPercent: 19.9,
          })).toBe(false);
        });

        it('finds unusually large expenses while excluding other financial types', () => {
          const transactions = [
            insightTransaction(1, '2026-01-01', 'Mat', -10_000, 'expense', 'ICA'),
            insightTransaction(2, '2026-01-02', 'Mat', -12_000, 'expense', 'ICA'),
            insightTransaction(3, '2026-01-03', 'Mat', -8_000, 'expense', 'COOP'),
            insightTransaction(4, '2026-02-01', 'Mat', -11_000, 'expense', 'COOP'),
            insightTransaction(5, '2026-02-02', 'Mat', -9_000, 'expense', 'WILLYS'),
            insightTransaction(6, '2026-03-01', 'Hem', -100_000, 'expense', 'IKEA'),
            insightTransaction(7, '2026-03-02', 'Hem', -99_999, 'expense', 'NORMALT KÖP'),
            insightTransaction(8, '2026-03-03', 'Överföring', -900_000, 'transfer', 'EGET KONTO'),
            insightTransaction(9, '2026-03-04', 'Sparande', -900_000, 'saving', 'SPAR'),
            insightTransaction(10, '2026-03-05', 'Lån', -900_000, 'amortization', 'BANK'),
            insightTransaction(11, '2026-03-06', 'Hem', 900_000, 'refund', 'IKEA'),
          ];

          const result = buildMonthlyInsights(transactions, 2026, 3, today);

          expect(result.unusualTransactions.map((transaction) => transaction.merchant)).toEqual(['IKEA']);
        });

        it('requires enough historical purchases and suppresses a historically normal large merchant', () => {
          const insufficient = buildMonthlyInsights([
            insightTransaction(1, '2026-01-01', 'Mat', -10_000),
            insightTransaction(2, '2026-02-01', 'Mat', -10_000),
            insightTransaction(3, '2026-03-01', 'Hem', -500_000, 'expense', 'IKEA'),
          ], 2026, 3, today);
          const repeated = buildMonthlyInsights([
            insightTransaction(1, '2026-01-01', 'Boende', -200_000, 'expense', 'HYRESVÄRD'),
            insightTransaction(2, '2026-01-02', 'Mat', -10_000, 'expense', 'ICA'),
            insightTransaction(3, '2026-01-03', 'Mat', -12_000, 'expense', 'COOP'),
            insightTransaction(4, '2026-02-01', 'Boende', -200_000, 'expense', 'HYRESVÄRD'),
            insightTransaction(5, '2026-02-02', 'Mat', -9_000, 'expense', 'WILLYS'),
            insightTransaction(6, '2026-03-01', 'Boende', -210_000, 'expense', 'HYRESVÄRD'),
          ], 2026, 3, today);

          expect(insufficient.unusualTransactions).toEqual([]);
          expect(repeated.unusualTransactions).toEqual([]);
        });

        it('aggregates exact normalized merchants, nets same-merchant refunds, and sorts spend', () => {
          const result = buildMonthlyInsights([
            insightTransaction(1, '2026-01-01', 'Mat', -10_000),
            insightTransaction(2, '2026-02-01', 'Mat', -10_000),
            insightTransaction(3, '2026-03-01', 'Mat', -30_000, 'expense', 'ICA MAXI*12344'),
            insightTransaction(4, '2026-03-02', 'Mat', -20_000, 'expense', 'Kortköp ICA MAXI 98765'),
            insightTransaction(5, '2026-03-03', 'Mat', 5_000, 'refund', 'ICA MAXI'),
            insightTransaction(6, '2026-03-04', 'Övrigt', -40_000, 'expense', 'ICA Banken'),
            insightTransaction(7, '2026-03-05', 'Transport', -10_000, 'expense', 'Circle K'),
          ], 2026, 3, today);

          expect(result.topMerchants).toEqual([
            { merchant: 'ICA MAXI', spendCents: 45_000, transactionCount: 3 },
            { merchant: 'ICA Banken', spendCents: 40_000, transactionCount: 1 },
            { merchant: 'Circle K', spendCents: 10_000, transactionCount: 1 },
          ]);
        });

        it('calculates total change and deterministic leading explanations', () => {
          const transactions = [
            insightTransaction(1, '2026-01-01', 'Mat', -100_000),
            insightTransaction(2, '2026-01-02', 'Restaurang', -40_000),
            insightTransaction(3, '2026-01-03', 'El', -20_000),
            insightTransaction(4, '2026-01-04', 'Transport', -30_000),
            insightTransaction(5, '2026-01-05', 'Övrigt', -10_000),
            insightTransaction(6, '2026-02-01', 'Mat', -100_000),
            insightTransaction(7, '2026-02-02', 'Restaurang', -40_000),
            insightTransaction(8, '2026-02-03', 'El', -20_000),
            insightTransaction(9, '2026-02-04', 'Transport', -30_000),
            insightTransaction(10, '2026-02-05', 'Övrigt', -10_000),
            insightTransaction(11, '2026-03-01', 'Mat', -300_000),
            insightTransaction(12, '2026-03-02', 'Restaurang', -160_000),
            insightTransaction(13, '2026-03-03', 'El', -70_000),
            insightTransaction(14, '2026-03-04', 'Transport', 10_000),
            insightTransaction(15, '2026-03-05', 'Övrigt', -80_000),
          ];

          const result = buildMonthlyInsights(transactions, 2026, 3, today);

          expect(result.currentTotalCents).toBe(600_000);
          expect(result.baselineTotalCents).toBe(200_000);
          expect(result.totalDeltaCents).toBe(400_000);
          expect(result.biggestIncreases.map(({ category, deltaCents }) => ({ category, deltaCents })))
            .toEqual([
              { category: 'Mat', deltaCents: 200_000 },
              { category: 'Restaurang', deltaCents: 120_000 },
              { category: 'Övrigt', deltaCents: 70_000 },
              { category: 'El', deltaCents: 50_000 },
            ]);
          expect(result.biggestDecreases.map(({ category, deltaCents }) => ({ category, deltaCents })))
            .toEqual([{ category: 'Transport', deltaCents: -40_000 }]);
        });

        it('does not promote a category decrease based on one active historical month', () => {
          const result = buildMonthlyInsights([
            insightTransaction(1, '2026-04-10', 'Boende / Underhåll', -500_000),
            insightTransaction(2, '2026-04-12', 'Mat', -10_000),
            insightTransaction(3, '2026-05-12', 'Mat', -10_000),
          ], 2026, 6, today);

          expect(result.totalDeltaCents).toBeLessThan(0);
          expect(result.categoryChanges).toContainEqual(expect.objectContaining({
            category: 'Boende / Underhåll',
            deltaCents: -250_000,
          }));
          expect(result.biggestDecreases).not.toContainEqual(expect.objectContaining({
            category: 'Boende / Underhåll',
          }));
        });

        it('keeps a decrease backed by at least two active historical months', () => {
          const result = buildMonthlyInsights([
            insightTransaction(1, '2026-01-10', 'Boende', -200_000),
            insightTransaction(2, '2026-02-10', 'Boende', -210_000),
            insightTransaction(3, '2026-03-10', 'Boende', -205_000),
            insightTransaction(4, '2026-04-10', 'Boende', -120_000),
          ], 2026, 4, today);

          expect(result.biggestDecreases).toContainEqual(expect.objectContaining({
            category: 'Boende',
            currentCents: 120_000,
            baselineCents: 205_000,
            deltaCents: -85_000,
          }));
        });

        it('requires a 10 percent decrease while leaving meaningful decreases visible', () => {
          const small = buildMonthlyInsights([
            insightTransaction(1, '2026-01-10', 'Mat', -1_000_000),
            insightTransaction(2, '2026-02-10', 'Mat', -1_000_000),
            insightTransaction(3, '2026-03-10', 'Mat', -990_000),
          ], 2026, 3, today);
          const largeAbsoluteButSmallPercent = buildMonthlyInsights([
            insightTransaction(1, '2026-01-10', 'Boende', -10_000_000),
            insightTransaction(2, '2026-02-10', 'Boende', -10_000_000),
            insightTransaction(3, '2026-03-10', 'Boende', -9_900_000),
          ], 2026, 3, today);
          const meaningful = buildMonthlyInsights([
            insightTransaction(1, '2026-01-10', 'Transport', -500_000),
            insightTransaction(2, '2026-02-10', 'Transport', -500_000),
            insightTransaction(3, '2026-03-10', 'Transport', -400_000),
          ], 2026, 3, today);

          expect(small.biggestDecreases).toEqual([]);
          expect(largeAbsoluteButSmallPercent.biggestDecreases).toEqual([]);
          expect(meaningful.biggestDecreases).toContainEqual(expect.objectContaining({
            category: 'Transport',
            deltaCents: -100_000,
            deltaPercent: -20,
          }));
        });

        it('does not apply the active-month requirement to category increases', () => {
          const result = buildMonthlyInsights([
            insightTransaction(1, '2026-04-10', 'Mat', -10_000),
            insightTransaction(2, '2026-05-10', 'Mat', -10_000),
            insightTransaction(3, '2026-06-10', 'Boende / Underhåll', -500_000),
          ], 2026, 6, today);

          expect(result.biggestIncreases).toContainEqual(expect.objectContaining({
            category: 'Boende / Underhåll',
            currentCents: 500_000,
            baselineCents: 0,
            deltaCents: 500_000,
          }));
        });

        it('does not apply the decrease percentage floor to category increases', () => {
          const result = buildMonthlyInsights([
            insightTransaction(1, '2026-01-10', 'Mat', -500_000),
            insightTransaction(2, '2026-02-10', 'Mat', -500_000),
            insightTransaction(3, '2026-03-10', 'Mat', -600_000),
          ], 2026, 3, today);

          expect(result.biggestIncreases).toContainEqual(expect.objectContaining({
            category: 'Mat',
            deltaCents: 100_000,
            deltaPercent: 20,
          }));
        });
      });

    const transaction = (
      amountCents: number,
      transactionType: Parameters<typeof calculateFinancialSummary>[0][number]['transactionType']
    ) => ({ amountCents, transactionType });

    it('infers initial types conservatively from category and amount', () => {
      expect(inferTransactionType('Lön', 30000)).toBe('income');
      expect(inferTransactionType('Bidrag', 1000)).toBe('income');
      expect(inferTransactionType('Uthyrning', 5000)).toBe('income');
      expect(inferTransactionType('Sparande', -2000)).toBe('saving');
      expect(inferTransactionType('Sparande / Amortering', -3000)).toBe('amortization');
      expect(inferTransactionType('Överföring mellan konto', 10000)).toBe('transfer');
      expect(inferTransactionType('Övrigt', -100)).toBe('expense');
      expect(inferTransactionType('Mat / Dagligvaror', 300)).toBe('unclassified');
    });

    it('requires intrinsic categories to match their explicit transaction types', () => {
      expect(isCategoryTransactionTypeConsistent('Överföring mellan konto', 'transfer')).toBe(true);
      expect(isCategoryTransactionTypeConsistent('Överföring mellan konto', 'expense')).toBe(false);
      expect(isCategoryTransactionTypeConsistent('Sparande', 'saving')).toBe(true);
      expect(isCategoryTransactionTypeConsistent('Sparande', 'expense')).toBe(false);
      expect(isCategoryTransactionTypeConsistent('Sparande / Amortering', 'amortization')).toBe(true);
      expect(isCategoryTransactionTypeConsistent('Sparande / Amortering', 'saving')).toBe(false);
      for (const category of ['Lön', 'Bidrag', 'Uthyrning']) {
        expect(isCategoryTransactionTypeConsistent(category, 'income')).toBe(true);
        expect(isCategoryTransactionTypeConsistent(category, 'expense')).toBe(false);
      }
    });

    it('allows ordinary categories to be expenses or refunds', () => {
      expect(isCategoryTransactionTypeConsistent('Mat / Dagligvaror', 'expense')).toBe(true);
      expect(isCategoryTransactionTypeConsistent('Mat / Dagligvaror', 'refund')).toBe(true);
    });

    it('keeps consumption unchanged until a transfer category also receives transfer type', () => {
      const originalTransaction = {
        category: 'Övrigt',
        amountCents: -10_000,
        transactionType: 'expense' as const,
      };
      const categoryChangedTransaction = {
        category: 'Överföring mellan konto',
        amountCents: -10_000,
        transactionType: 'expense' as const,
      };
      const typeResolvedTransaction = {
        ...categoryChangedTransaction,
        transactionType: 'transfer' as const,
      };
      const original = calculateFinancialSummary([originalTransaction]);
      const categoryChanged = calculateFinancialSummary([categoryChangedTransaction]);
      const typeResolved = calculateFinancialSummary([typeResolvedTransaction]);

      expect(original.consumptionExpensesCents).toBe(10_000);
      expect(categoryChanged.consumptionExpensesCents).toBe(10_000);
      expect(typeResolved.consumptionExpensesCents).toBe(0);
    });

    it('counts only explicit income as income', () => {
      const summary = calculateFinancialSummary([
        transaction(30000, 'income'),
        transaction(5000, 'unclassified'),
        transaction(300, 'refund'),
        transaction(10000, 'transfer'),
      ]);

      expect(summary.incomeCents).toBe(30000);
      expect(summary.unclassifiedCount).toBe(1);
    });

    it('nets expenses and refunds including full and oversized refunds', () => {
      expect(calculateFinancialSummary([
        transaction(-1000, 'expense'),
        transaction(300, 'refund'),
      ]).consumptionExpensesCents).toBe(700);
      expect(calculateFinancialSummary([
        transaction(-1000, 'expense'),
        transaction(1000, 'refund'),
      ]).consumptionExpensesCents).toBe(0);
      expect(calculateFinancialSummary([
        transaction(-1000, 'expense'),
        transaction(1200, 'refund'),
      ]).consumptionExpensesCents).toBe(-200);
    });

    it('nets refunds into the same category budget outcome', () => {
      const totals = calculateCategoryTotals([
        { category: 'Mat / Dagligvaror', amountCents: -1000, transactionType: 'expense' },
        { category: 'Mat / Dagligvaror', amountCents: 300, transactionType: 'refund' },
        { category: 'Mat / Dagligvaror', amountCents: -5000, transactionType: 'saving' },
        { category: 'Mat / Dagligvaror', amountCents: -3000, transactionType: 'amortization' },
        { category: 'Mat / Dagligvaror', amountCents: -10000, transactionType: 'transfer' },
      ], ['expense', 'refund']);

      expect(totals.get('Mat / Dagligvaror')).toBe(700);
    });

    it('treats savings withdrawals as negative direct savings', () => {
      expect(calculateFinancialSummary([
        transaction(-2000, 'saving'),
      ]).directSavingsCents).toBe(2000);
      expect(calculateFinancialSummary([
        transaction(500, 'saving'),
      ]).directSavingsCents).toBe(-500);
    });

    it('tracks amortization and total wealth building separately', () => {
      const summary = calculateFinancialSummary([
        transaction(-2000, 'saving'),
        transaction(-3000, 'amortization'),
      ]);

      expect(summary.directSavingsCents).toBe(2000);
      expect(summary.amortizationCents).toBe(3000);
      expect(summary.totalWealthBuildingCents).toBe(5000);
    });

    it('excludes both directions of transfers from all main figures', () => {
      expect(calculateFinancialSummary([
        transaction(-10000, 'transfer'),
        transaction(10000, 'transfer'),
      ])).toEqual({
        incomeCents: 0,
        consumptionExpensesCents: 0,
        directSavingsCents: 0,
        amortizationCents: 0,
        totalWealthBuildingCents: 0,
        remainingAfterSpendingAndSavingCents: 0,
        unclassifiedCount: 0,
      });
    });

    it('calculates a mixed month from explicit transaction types', () => {
      const summary = calculateFinancialSummary([
        transaction(4000000, 'income'),
        transaction(-2000000, 'expense'),
        transaction(100000, 'refund'),
        transaction(-500000, 'saving'),
        transaction(-300000, 'amortization'),
        transaction(-1000000, 'transfer'),
        transaction(1000000, 'transfer'),
      ]);

      expect(summary).toEqual({
        incomeCents: 4000000,
        consumptionExpensesCents: 1900000,
        directSavingsCents: 500000,
        amortizationCents: 300000,
        totalWealthBuildingCents: 800000,
        remainingAfterSpendingAndSavingCents: 1300000,
        unclassifiedCount: 0,
      });
    });
  });

  it('separates positive and negative rows in category detail views', () => {
    const rows = [
      { id: 1, category: 'Övrigt', amountCents: 15000, transactionType: 'refund' as const },
      { id: 2, category: 'Övrigt', amountCents: -15000, transactionType: 'expense' as const },
      { id: 3, category: 'Lön', amountCents: 500000, transactionType: 'income' as const },
    ];

    expect(transactionsForCategoryFlow(rows, 'Övrigt', 'income').map((row) => row.id)).toEqual([]);
    expect(transactionsForCategoryFlow(rows, 'Övrigt', 'expense').map((row) => row.id)).toEqual([1, 2]);
  });

  it('treats savings deposits as positive savings and withdrawals as negative savings', () => {
    const rows = [
      { id: 1, category: 'Sparande', amountCents: -50000, transactionType: 'saving' as const },
      { id: 2, category: 'Sparande', amountCents: -10000, transactionType: 'saving' as const },
      { id: 3, category: 'Sparande', amountCents: 20000, transactionType: 'saving' as const },
    ];

    expect(transactionsForCategoryFlow(rows, 'Sparande', 'income')).toHaveLength(3);
    expect(transactionsForCategoryFlow(rows, 'Sparande', 'expense')).toHaveLength(0);
    expect(amountForCategoryFlow(rows[0], 'Sparande', 'income')).toBe(50000);
    expect(sumCategoryFlow(rows, 'Sparande', 'income')).toBe(40000);
  });

  it('nets incoming and outgoing transactions in a category', () => {
    expect(netTransactionAmount([
      { amountCents: 100000 },
      { amountCents: -100000 },
    ])).toBe(0);
  });

  it('automatically categorizes bank internal transfers and excludes that category from reports', () => {
    const decision = classifyTransaction(
      { merchant: 'Överföring via internet', amountCents: -120000 },
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
    expect(isIncludedInOverview({ amountCents: 0, transactionType: 'expense' })).toBe(false);
    expect(isIncludedInOverview({ amountCents: -10, transactionType: 'expense' })).toBe(true);
    expect(isIncludedInOverview({ amountCents: 10, transactionType: 'unclassified' })).toBe(true);
    expect(isIncludedInOverview({ amountCents: -10, transactionType: 'transfer' })).toBe(false);
  });

  it('only lists expense categories with a nonzero expense transaction', () => {
    expect(categoriesWithExpenses([
      { category: 'Mat / Dagligvaror', amountCents: -5000, transactionType: 'expense' },
      { category: 'Boende / El', amountCents: 0, transactionType: 'expense' },
      { category: 'Sparande', amountCents: -10000, transactionType: 'saving' },
      { category: 'Lön', amountCents: 100000, transactionType: 'income' },
    ])).toEqual(['Mat / Dagligvaror']);
  });

  it('moves an approved duplicate category out of pending review', () => {
    expect(needsCategoryDecision({
      needsReview: false,
      categoryDecided: true,
      category: 'Mat / Dagligvaror',
      transactionType: 'expense',
    }, true)).toBe(false);
    expect(needsCategoryDecision({
      needsReview: false,
      categoryDecided: false,
      category: 'Mat / Dagligvaror',
      transactionType: 'expense',
    }, true)).toBe(true);
    expect(needsCategoryDecision({
      needsReview: true,
      categoryDecided: false,
      category: 'Mat / Dagligvaror',
      transactionType: 'expense',
    }, false)).toBe(true);
  });

  it('keeps a semantic category and type conflict in pending review', () => {
    expect(needsCategoryDecision({
      needsReview: false,
      categoryDecided: true,
      category: 'Överföring mellan konto',
      transactionType: 'expense',
    }, false)).toBe(true);
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
      { merchant: 'ICA MAXI BROMMA', amountCents: -24350 },
      ruleSet,
      { category: 'Övrigt' }
    );

    expect(decision.category).toBe('Mat / Dagligvaror');
    expect(decision.source).toBe('explicit-user-rule');
  });

  it('prefers a previously learned merchant category over built-in rules', () => {
    const decision = classifyTransaction(
      { merchant: 'ICA MAXI BROMMA', amountCents: -24350 },
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
      { merchant: 'Eon kundsupport', amountCents: -5500 },
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

  it('keeps a learned exact merchant rule away from other merchants with the same first token', () => {
    const rule = {
      id: 'learned-ica-maxi',
      match: 'ICA MAXI',
      category: 'Mat / Dagligvaror',
      priority: 10000,
      matchMode: 'merchant-exact' as const,
    };

    expect(classifyTransaction({ merchant: 'ICA MAXI*12344', amountCents: -10000 }, [rule]).category)
      .toBe('Mat / Dagligvaror');
    expect(classifyTransaction({ merchant: 'ICA Banken', amountCents: -10000 }, [rule]).needsReview)
      .toBe(true);
  });

  it('applies a learned received-Swish rule to different incoming phone numbers', () => {
    const decision = classifyTransaction(
      { merchant: 'Mottagen +46700987654', amountCents: 25000 },
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

describe('recurring expense insights', () => {
  const today = new Date(2026, 9, 6);
  const recurring = (
    id: number,
    date: string,
    amountCents: number,
    merchant = 'NETFLIX',
    transactionType: MonthlyInsightTransaction['transactionType'] = 'expense'
  ) => insightTransaction(id, date, 'Media', amountCents, transactionType, merchant);

  it('detects a stable monthly cost with high confidence and annual cost', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -14_900),
      recurring(2, '2026-02-27', -14_900),
      recurring(3, '2026-03-24', -14_900),
      recurring(4, '2026-04-26', -14_900),
      recurring(5, '2026-05-25', -14_900),
    ], 2026, 5, today);

    expect(result.status).toBe('available');
    expect(result.insights[0]).toMatchObject({
      frequency: 'monthly',
      confidence: 'high',
      occurrences: 5,
      activeMonths: 5,
      monthsObserved: 5,
      medianAmountCents: 14_900,
      latestAmountCents: 14_900,
      estimatedAnnualCostCents: 178_800,
    });


  });

  it('keeps a monthly pattern with one missed month but lowers confidence', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -39_900, 'GYM'),
      recurring(2, '2026-02-25', -39_900, 'GYM'),
      recurring(3, '2026-03-25', -39_900, 'GYM'),
      recurring(4, '2026-05-25', -39_900, 'GYM'),
      recurring(5, '2026-06-25', -39_900, 'GYM'),
    ], 2026, 6, today);

    expect(result.insights[0]).toMatchObject({
      frequency: 'monthly',
      confidence: 'medium',
      activeMonths: 5,
      monthsObserved: 6,
    });
  });

  it('excludes frequent variable purchases instead of calling them monthly', () => {
    const transactions = Array.from({ length: 30 }, (_, index) =>
      recurring(
        index + 1,
        `2026-${String(Math.floor(index / 10) + 1).padStart(2, '0')}-${String(index % 10 + 1).padStart(2, '0')}`,
        -(1_000 + index * 731),
        'ICA MAXI'
      )
    );

    expect(buildRecurringExpenseInsights(transactions, 2026, 3, today)).toMatchObject({
      status: 'no-candidates',
      insights: [],
    });
  });

  it('detects quarterly and annual costs with exact annualization', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2025-10-15', -100_000, 'FÖRSÄKRING KVARTAL'),
      recurring(2, '2026-01-16', -100_000, 'FÖRSÄKRING KVARTAL'),
      recurring(3, '2026-04-14', -100_000, 'FÖRSÄKRING KVARTAL'),
      recurring(4, '2026-07-17', -100_000, 'FÖRSÄKRING KVARTAL'),
      recurring(5, '2025-07-10', -350_000, 'ÅRSFÖRSÄKRING'),
      recurring(6, '2026-07-12', -350_000, 'ÅRSFÖRSÄKRING'),
    ], 2026, 7, today);
    const byMerchant = new Map(result.insights.map((insight) => [insight.merchantLabel, insight]));

    expect(byMerchant.get('FÖRSÄKRING KVARTAL')).toMatchObject({
      frequency: 'quarterly',
      estimatedAnnualCostCents: 400_000,
    });
    expect(byMerchant.get('ÅRSFÖRSÄKRING')).toMatchObject({
      frequency: 'annual',
      confidence: 'medium',
      estimatedAnnualCostCents: 350_000,
    });
  });

  it('uses the previous median for a relevant price increase', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -14_900),
      recurring(2, '2026-02-25', -14_900),
      recurring(3, '2026-03-25', -14_900),
      recurring(4, '2026-04-25', -14_900),
      recurring(5, '2026-05-25', -17_900),
    ], 2026, 5, today);

    expect(result.insights[0]).toMatchObject({
      medianAmountCents: 14_900,
      comparisonMedianCents: 14_900,
      latestAmountCents: 17_900,
      deltaFromMedianCents: 3_000,
      hasRelevantPriceChange: true,
    });
    expect(result.insights[0].deltaPercent).toBeCloseTo(20.134, 2);
  });

  it('does not flag a trivial price change and lowers confidence for unstable amounts', () => {
    const trivial = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -14_900),
      recurring(2, '2026-02-25', -14_900),
      recurring(3, '2026-03-25', -14_900),
      recurring(4, '2026-04-25', -15_100),
    ], 2026, 4, today);
    const unstable = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -10_000, 'ELBOLAG'),
      recurring(2, '2026-02-25', -50_000, 'ELBOLAG'),
      recurring(3, '2026-03-25', -12_000, 'ELBOLAG'),
      recurring(4, '2026-04-25', -90_000, 'ELBOLAG'),
    ], 2026, 4, today);

    expect(trivial.insights[0].hasRelevantPriceChange).toBe(false);
    expect(unstable.insights[0]).toMatchObject({
      frequency: 'monthly',
      confidence: 'low',
      hasStablePriceHistory: false,
      hasRelevantPriceChange: false,
    });
  });

  it('does not flag normal variation in an otherwise stable recurring cost', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -398_000, 'LÅN'),
      recurring(2, '2026-02-25', -402_000, 'LÅN'),
      recurring(3, '2026-03-25', -397_000, 'LÅN'),
      recurring(4, '2026-04-25', -405_000, 'LÅN'),
      recurring(5, '2026-05-25', -400_500, 'LÅN'),
    ], 2026, 5, today);

    expect(result.insights[0]).toMatchObject({
      amountStabilityRatio: 1,
      hasRelevantPriceChange: false,
    });
  });

  it('requires a larger price change for medium-stability recurring costs', () => {
    const material = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -400_000, 'VARIABEL KOSTNAD'),
      recurring(2, '2026-02-25', -400_000, 'VARIABEL KOSTNAD'),
      recurring(3, '2026-03-25', -400_000, 'VARIABEL KOSTNAD'),
      recurring(4, '2026-04-25', -480_000, 'VARIABEL KOSTNAD'),
    ], 2026, 4, today);
    const immaterial = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -400_000, 'VARIABEL KOSTNAD'),
      recurring(2, '2026-02-25', -400_000, 'VARIABEL KOSTNAD'),
      recurring(3, '2026-03-25', -400_000, 'VARIABEL KOSTNAD'),
      recurring(4, '2026-04-25', -404_000, 'VARIABEL KOSTNAD'),
    ], 2026, 4, today);

    expect(material.insights[0]).toMatchObject({
      amountStabilityRatio: 0.75,
      hasRelevantPriceChange: true,
    });
    expect(immaterial.insights[0].hasRelevantPriceChange).toBe(false);
  });

  it('never shows latest price change for low-stability recurring costs', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2026-01-25', -300_000, 'LÅG STABILITET'),
      recurring(2, '2026-02-25', -400_000, 'LÅG STABILITET'),
      recurring(3, '2026-03-25', -500_000, 'LÅG STABILITET'),
      recurring(4, '2026-04-25', -800_000, 'LÅG STABILITET'),
    ], 2026, 4, today);

    expect(result.insights[0].amountStabilityRatio).toBeLessThan(0.6);
    expect(result.insights[0].hasRelevantPriceChange).toBe(false);
  });

  it('keeps exact normalized merchants together without first-token grouping', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2026-01-10', -20_000, 'ICA MAXI*12344'),
      recurring(2, '2026-02-10', -20_000, 'Kortköp ICA MAXI 98765'),
      recurring(3, '2026-03-10', -20_000, 'ICA MAXI'),
      recurring(4, '2026-01-12', -30_000, 'ICA Banken'),
      recurring(5, '2026-02-12', -30_000, 'ICA Banken'),
      recurring(6, '2026-03-12', -30_000, 'ICA Banken'),
    ], 2026, 3, today);

    expect(result.insights.map((insight) => insight.merchantLabel).sort()).toEqual([
      'ICA Banken',
      'ICA MAXI',
    ]);
  });

  it('excludes non-expense types and two random purchases', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2026-01-01', -10_000, 'TRANSFER', 'transfer'),
      recurring(2, '2026-02-01', -10_000, 'TRANSFER', 'transfer'),
      recurring(3, '2026-03-01', -10_000, 'TRANSFER', 'transfer'),
      recurring(4, '2026-01-02', -10_000, 'SAVING', 'saving'),
      recurring(5, '2026-02-02', -10_000, 'SAVING', 'saving'),
      recurring(6, '2026-03-02', -10_000, 'SAVING', 'saving'),
      recurring(7, '2026-01-03', -10_000, 'AMORT', 'amortization'),
      recurring(8, '2026-02-03', -10_000, 'AMORT', 'amortization'),
      recurring(9, '2026-03-03', -10_000, 'AMORT', 'amortization'),
      recurring(10, '2026-01-04', 10_000, 'INCOME', 'income'),
      recurring(11, '2026-02-04', 10_000, 'INCOME', 'income'),
      recurring(12, '2026-03-04', 10_000, 'INCOME', 'income'),
      recurring(13, '2026-01-05', 10_000, 'REFUND', 'refund'),
      recurring(14, '2026-02-05', 10_000, 'REFUND', 'refund'),
      recurring(15, '2026-03-05', 10_000, 'REFUND', 'refund'),
      recurring(16, '2026-01-06', -10_000, 'UNKNOWN', 'unclassified'),
      recurring(17, '2026-02-06', -10_000, 'UNKNOWN', 'unclassified'),
      recurring(18, '2026-03-06', -10_000, 'UNKNOWN', 'unclassified'),
      recurring(19, '2026-01-15', -5_000, 'RESTAURANG'),
      recurring(20, '2026-03-20', -8_000, 'RESTAURANG'),
    ], 2026, 3, today);

    expect(result.insights).toEqual([]);
  });

  it('allows a current-month charge as latest without treating absence as missing', () => {
    const withOctober = buildRecurringExpenseInsights([
      recurring(1, '2026-06-25', -14_900),
      recurring(2, '2026-07-25', -14_900),
      recurring(3, '2026-08-25', -14_900),
      recurring(4, '2026-09-25', -14_900),
      recurring(5, '2026-10-05', -17_900),
    ], 2026, 10, today);
    const withoutOctober = buildRecurringExpenseInsights([
      recurring(1, '2026-06-25', -14_900),
      recurring(2, '2026-07-25', -14_900),
      recurring(3, '2026-08-25', -14_900),
      recurring(4, '2026-09-25', -14_900),
    ], 2026, 10, today);

    expect(withOctober.insights[0]).toMatchObject({
      latestDate: '2026-10-05',
      latestAmountCents: 17_900,
      monthsObserved: 5,
    });
    expect(withoutOctober.insights[0]).toMatchObject({
      latestDate: '2026-09-25',
      monthsObserved: 4,
    });
  });

  it('keeps irregular annual cost null', () => {
    const result = buildRecurringExpenseInsights([
      recurring(1, '2025-10-10', -20_000, 'REGELBUNDET KÖP'),
      recurring(2, '2025-11-10', -20_000, 'REGELBUNDET KÖP'),
      recurring(3, '2026-04-10', -20_000, 'REGELBUNDET KÖP'),
      recurring(4, '2026-09-10', -20_000, 'REGELBUNDET KÖP'),
    ], 2026, 9, today);

    expect(result.insights[0]).toMatchObject({
      frequency: 'irregular',
      confidence: 'low',
      estimatedAnnualCostCents: null,
    });
  });
});

describe('recurring cost trend insights', () => {
  const today = new Date(2026, 9, 6);
  const cost = (
    id: number,
    date: string,
    amountCents: number,
    merchant = 'NETFLIX',
    transactionType: MonthlyInsightTransaction['transactionType'] = 'expense'
  ) => insightTransaction(id, date, 'Media', -amountCents, transactionType, merchant);

  it('does not turn one latest-payment spike into a long-term increase', () => {
    const result = buildRecurringCostTrendInsights([
      cost(1, '2026-01-25', 14_900),
      cost(2, '2026-02-25', 14_900),
      cost(3, '2026-03-25', 14_900),
      cost(4, '2026-04-25', 14_900),
      cost(5, '2026-05-25', 17_900),
    ], 2026, 5, today);

    expect(result.trends[0].trend).toBe('stable');
    expect(result.increasing).toEqual([]);
  });

  describe('financial health prioritization', () => {
    const budgetRow = (
      category: string,
      budgetCents: number,
      actualCents: number
    ) => ({
      category,
      hasBudget: true,
      budgetCents,
      actualCents,
      remainingCents: budgetCents - actualCents,
      percentUsed: budgetCents > 0 ? actualCents / budgetCents * 100 : null,
      historicalMonthlyAverageCents: null,
      forecastAnnualCents: null,
    });
    const baseInput = () => ({
      financialSummary: calculateFinancialSummary([]),
      consumptionBudgetRows: [] as ReturnType<typeof budgetRow>[],
      savingBudgetRows: [] as ReturnType<typeof budgetRow>[],
      amortizationBudgetRows: [] as ReturnType<typeof budgetRow>[],
      monthlyInsights: null,
      recurringInsights: {
        status: 'no-candidates' as const,
        observedMonthCount: 6,
        insights: [],
      },
      costTrends: {
        status: 'available' as const,
        trends: [],
        increasing: [],
        decreasing: [],
      },
      periodStatus: 'past' as const,
    });

    it('returns a transparent good status when there are no relevant signals', () => {
      const result = buildFinancialHealthSummary(baseInput());

      expect(result).toMatchObject({
        status: 'good',
        headline: 'Ekonomin ser stabil ut',
        insights: [],
        importantCount: 0,
        attentionCount: 0,
        positiveCount: 0,
      });
    });

    it('returns no outcome assessment for a future period', () => {
      const result = buildFinancialHealthSummary({
        ...baseInput(),
        periodStatus: 'future',
        consumptionBudgetRows: [budgetRow('Mat', 500_000, 0)],
        savingBudgetRows: [budgetRow('Sparande', 100_000, 0)],
      });

      expect(result).toMatchObject({
        status: 'future',
        headline: 'Den här perioden har inte börjat ännu',
        insights: [],
        importantCount: 0,
        attentionCount: 0,
        positiveCount: 0,
      });
    });

    it('creates important budget overrun and meaningful under-budget signals in cents', () => {
      const over = buildFinancialHealthSummary({
        ...baseInput(),
        consumptionBudgetRows: [budgetRow('Mat', 500_000, 650_000)],
      });
      const under = buildFinancialHealthSummary({
        ...baseInput(),
        consumptionBudgetRows: [budgetRow('Mat', 500_000, 400_000)],
      });

      expect(over.insights[0]).toMatchObject({
        severity: 'important',
        amountCents: 150_000,
        source: 'budget',
        summary: '1 500,00 kr över budget',
      });
      expect(over.insights[0].priorityScore).toBeGreaterThanOrEqual(100);
      expect(under.insights[0]).toMatchObject({
        severity: 'positive',
        amountCents: 100_000,
        source: 'budget',
        summary: '1 000,00 kr under budget',
      });
    });

    it('maps large monthly increases to attention and decreases to positive', () => {
      const monthlyInsights = {
        status: 'available' as const,
        baselineKind: 'historical-average' as const,
        baselineLabel: 'Jämfört med snitt',
        baselineMonthCount: 3,
        currentTotalCents: 600_000,
        baselineTotalCents: 550_000,
        totalDeltaCents: 50_000,
        categoryChanges: [],
        biggestIncreases: [{
          category: 'Mat',
          currentCents: 300_000,
          baselineCents: 200_000,
          deltaCents: 100_000,
          deltaPercent: 50,
        }],
        biggestDecreases: [{
          category: 'Transport',
          currentCents: 50_000,
          baselineCents: 100_000,
          deltaCents: -50_000,
          deltaPercent: -50,
        }],
        unusualTransactions: [],
        topMerchants: [],
      };
      const result = buildFinancialHealthSummary({ ...baseInput(), monthlyInsights });

      expect(result.insights).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'monthly-increase-Mat',
          severity: 'important',
          source: 'monthly-change',
        }),
        expect.objectContaining({
          id: 'monthly-decrease-Transport',
          severity: 'positive',
          source: 'monthly-change',
        }),
      ]));
    });

    it('keeps the dominant category and removes the duplicated total increase', () => {
      const monthlyInsights = {
        status: 'available' as const,
        baselineKind: 'historical-average' as const,
        baselineLabel: 'Jämfört med snitt',
        baselineMonthCount: 3,
        currentTotalCents: 1_000_000,
        baselineTotalCents: 500_000,
        totalDeltaCents: 500_000,
        categoryChanges: [],
        biggestIncreases: [{
          category: 'Mat',
          currentCents: 700_000,
          baselineCents: 300_000,
          deltaCents: 400_000,
          deltaPercent: 133.33,
        }],
        biggestDecreases: [],
        unusualTransactions: [],
        topMerchants: [],
      };

      const result = buildFinancialHealthSummary({ ...baseInput(), monthlyInsights });

      expect(result.insights).toContainEqual(expect.objectContaining({
        id: 'monthly-increase-Mat',
      }));
      expect(result.insights).not.toContainEqual(expect.objectContaining({
        id: 'monthly-total-increase',
      }));
    });

    it('keeps the total increase when change is distributed across categories', () => {
      const changes = [
        ['Mat', 150_000],
        ['Transport', 150_000],
        ['Nöjen', 100_000],
        ['Övrigt', 100_000],
      ] as const;
      const monthlyInsights = {
        status: 'available' as const,
        baselineKind: 'historical-average' as const,
        baselineLabel: 'Jämfört med snitt',
        baselineMonthCount: 3,
        currentTotalCents: 1_000_000,
        baselineTotalCents: 500_000,
        totalDeltaCents: 500_000,
        categoryChanges: [],
        biggestIncreases: changes.map(([category, deltaCents]) => ({
          category,
          currentCents: deltaCents,
          baselineCents: 0,
          deltaCents,
          deltaPercent: null,
        })),
        biggestDecreases: [],
        unusualTransactions: [],
        topMerchants: [],
      };

      const result = buildFinancialHealthSummary({ ...baseInput(), monthlyInsights });

      expect(result.insights).toContainEqual(expect.objectContaining({
        id: 'monthly-total-increase',
      }));
    });

    it('keeps the dominant category and removes the duplicated total decrease', () => {
      const monthlyInsights = {
        status: 'available' as const,
        baselineKind: 'historical-average' as const,
        baselineLabel: 'Jämfört med snitt',
        baselineMonthCount: 3,
        currentTotalCents: 500_000,
        baselineTotalCents: 1_000_000,
        totalDeltaCents: -500_000,
        categoryChanges: [],
        biggestIncreases: [],
        biggestDecreases: [{
          category: 'Mat',
          currentCents: 300_000,
          baselineCents: 700_000,
          deltaCents: -400_000,
          deltaPercent: -57.14,
        }],
        unusualTransactions: [],
        topMerchants: [],
      };

      const result = buildFinancialHealthSummary({ ...baseInput(), monthlyInsights });

      expect(result.insights).toContainEqual(expect.objectContaining({
        id: 'monthly-decrease-Mat',
      }));
      expect(result.insights).not.toContainEqual(expect.objectContaining({
        id: 'monthly-total-decrease',
      }));
    });

    it('lets a long-term merchant trend replace the latest-price signal', () => {
      const recurring = {
        merchantKey: 'NETFLIX',
        merchantLabel: 'Netflix',
        frequency: 'monthly' as const,
        occurrences: 6,
        activeMonths: 6,
        monthsObserved: 6,
        medianAmountCents: 16_400,
        latestAmountCents: 17_900,
        latestDate: '2026-06-25',
        comparisonMedianCents: 14_900,
        deltaFromMedianCents: 3_000,
        deltaPercent: 20.13,
        hasRelevantPriceChange: true,
        hasStablePriceHistory: true,
        amountStabilityRatio: 0.83,
        intervalRegularityRatio: 1,
        estimatedAnnualCostCents: 196_800,
        confidence: 'high' as const,
        firstSeen: '2026-01-25',
        lastSeen: '2026-06-25',
        occurrenceHistory: [],
      };
      const trend = {
        merchantKey: 'NETFLIX',
        merchantLabel: 'Netflix',
        frequency: 'monthly' as const,
        firstPeriodMedianCents: 14_900,
        recentPeriodMedianCents: 17_900,
        deltaCents: 3_000,
        deltaPercent: 20.13,
        trend: 'increasing' as const,
        observations: 6,
        monthsSpanned: 6,
        amountStabilityRatio: 0.83,
        directionConsistencyRatio: 0.6,
        confidence: 'high' as const,
        firstPeriodLabel: 'Första 2 betalningarna',
        recentPeriodLabel: 'Senaste 2 betalningarna',
        annualizedImpactCents: 36_000,
      };
      const result = buildFinancialHealthSummary({
        ...baseInput(),
        recurringInsights: { status: 'available', observedMonthCount: 6, insights: [recurring] },
        costTrends: {
          status: 'available',
          trends: [trend],
          increasing: [trend],
          decreasing: [],
        },
      });

      expect(result.insights.filter((insight) => insight.title === 'Netflix')).toHaveLength(1);
      expect(result.insights[0]).toMatchObject({
        type: 'long-term-cost-increase',
        source: 'cost-trend',
      });
    });

    it('keeps a latest-price signal when no long-term trend exists', () => {
      const recurring = {
        merchantKey: 'NETFLIX',
        merchantLabel: 'Netflix',
        frequency: 'monthly' as const,
        occurrences: 5,
        activeMonths: 5,
        monthsObserved: 5,
        medianAmountCents: 14_900,
        latestAmountCents: 17_900,
        latestDate: '2026-05-25',
        comparisonMedianCents: 14_900,
        deltaFromMedianCents: 3_000,
        deltaPercent: 20.13,
        hasRelevantPriceChange: true,
        hasStablePriceHistory: true,
        amountStabilityRatio: 0.8,
        intervalRegularityRatio: 1,
        estimatedAnnualCostCents: 178_800,
        confidence: 'high' as const,
        firstSeen: '2026-01-25',
        lastSeen: '2026-05-25',
        occurrenceHistory: [],
      };
      const result = buildFinancialHealthSummary({
        ...baseInput(),
        recurringInsights: { status: 'available', observedMonthCount: 5, insights: [recurring] },
      });

      expect(result.insights[0]).toMatchObject({
        type: 'latest-price-increase',
        source: 'recurring',
      });
    });

    it('combines matching budget and monthly category evidence into one card', () => {
      const monthlyChange = {
        category: 'Mat',
        currentCents: 650_000,
        baselineCents: 500_000,
        deltaCents: 150_000,
        deltaPercent: 30,
      };
      const result = buildFinancialHealthSummary({
        ...baseInput(),
        consumptionBudgetRows: [budgetRow('Mat', 500_000, 650_000)],
        monthlyInsights: {
          status: 'available',
          baselineKind: 'historical-average',
          baselineLabel: 'Jämfört med snitt',
          baselineMonthCount: 3,
          currentTotalCents: 650_000,
          baselineTotalCents: 500_000,
          totalDeltaCents: 150_000,
          categoryChanges: [monthlyChange],
          biggestIncreases: [monthlyChange],
          biggestDecreases: [],
          unusualTransactions: [],
          topMerchants: [],
        },
      });

      const categoryInsights = result.insights.filter((insight) => insight.title === 'Mat');
      expect(categoryInsights).toHaveLength(1);
      expect(categoryInsights[0]).toMatchObject({
        source: 'budget',
        supportingDetail: '1 500,00 kr högre än normal nivå',
      });
    });

    it('uses documented unclassified severity thresholds', () => {
      const summaryWithCount = (count: number) => buildFinancialHealthSummary({
        ...baseInput(),
        financialSummary: {
          ...calculateFinancialSummary([]),
          unclassifiedCount: count,
        },
      });

      expect(summaryWithCount(0).insights).toEqual([]);
      expect(summaryWithCount(1).insights[0].severity).toBe('info');
      expect(summaryWithCount(2).insights[0].severity).toBe('info');
      expect(summaryWithCount(3).insights[0].severity).toBe('attention');
      expect(summaryWithCount(10).insights[0].severity).toBe('important');
    });

    it('creates positive and attention signals from saving goals', () => {
      const positive = buildFinancialHealthSummary({
        ...baseInput(),
        savingBudgetRows: [budgetRow('Sparande', 200_000, 380_000)],
      });
      const attention = buildFinancialHealthSummary({
        ...baseInput(),
        savingBudgetRows: [budgetRow('Sparande', 300_000, 180_000)],
      });

      expect(positive.insights[0]).toMatchObject({
        severity: 'positive',
        title: 'Sparmål',
        amountCents: 180_000,
        source: 'savings',
      });
      expect(attention.insights[0]).toMatchObject({
        severity: 'attention',
        title: 'Sparmål',
        amountCents: 120_000,
        source: 'savings',
      });
    });

    it('excludes full-month changes in the current month while retaining current-safe signals', () => {
      const result = buildFinancialHealthSummary({
        ...baseInput(),
        periodStatus: 'current',
        financialSummary: {
          ...calculateFinancialSummary([]),
          unclassifiedCount: 3,
        },
        savingBudgetRows: [budgetRow('Sparande', 300_000, 180_000)],
        monthlyInsights: {
          status: 'incomplete-month',
          baselineKind: null,
          baselineLabel: null,
          baselineMonthCount: 0,
          currentTotalCents: 100_000,
          baselineTotalCents: 0,
          totalDeltaCents: 0,
          categoryChanges: [],
          biggestIncreases: [],
          biggestDecreases: [],
          unusualTransactions: [],
          topMerchants: [],
        },
      });

      expect(result.insights.some((insight) => insight.source === 'monthly-change')).toBe(false);
      expect(result.insights.map((insight) => insight.type)).toEqual(expect.arrayContaining([
        'goal-under',
        'unclassified',
      ]));
    });

    it('limits output deterministically without positives displacing attention', () => {
      const monthlyChanges = Array.from({ length: 8 }, (_, index) => ({
        category: `Kategori ${index}`,
        currentCents: 200_000 + index * 10_000,
        baselineCents: 100_000,
        deltaCents: 100_000 + index * 10_000,
        deltaPercent: 100 + index * 10,
      }));
      const input = {
        ...baseInput(),
        consumptionBudgetRows: [
          budgetRow('Positiv 1', 500_000, 300_000),
          budgetRow('Positiv 2', 500_000, 300_000),
          budgetRow('Positiv 3', 500_000, 300_000),
        ],
        monthlyInsights: {
          status: 'available' as const,
          baselineKind: 'historical-average' as const,
          baselineLabel: 'Jämfört med snitt',
          baselineMonthCount: 3,
          currentTotalCents: 2_000_000,
          baselineTotalCents: 1_000_000,
          totalDeltaCents: 1_000_000,
          categoryChanges: monthlyChanges,
          biggestIncreases: monthlyChanges,
          biggestDecreases: [],
          unusualTransactions: [],
          topMerchants: [],
        },
      };

      const first = buildFinancialHealthSummary(input);
      const second = buildFinancialHealthSummary(input);
      expect(first.insights).toHaveLength(6);
      expect(first.insights.slice(0, 4).every((insight) =>
        insight.severity === 'important' || insight.severity === 'attention'
      )).toBe(true);
      expect(first.insights).toEqual(second.insights);
      expect(first.status).toBe(second.status);
    });
  });

  it('detects a clear sustained monthly increase from period medians', () => {
    const result = buildRecurringCostTrendInsights([
      cost(1, '2026-01-25', 14_900),
      cost(2, '2026-02-25', 14_900),
      cost(3, '2026-03-25', 15_900),
      cost(4, '2026-04-25', 16_900),
      cost(5, '2026-05-25', 17_900),
      cost(6, '2026-06-25', 17_900),
    ], 2026, 6, today);

    expect(result.trends[0]).toMatchObject({
      firstPeriodMedianCents: 14_900,
      recentPeriodMedianCents: 17_900,
      deltaCents: 3_000,
      trend: 'increasing',
      confidence: 'high',
      firstPeriodLabel: 'Första 2 betalningarna',
      recentPeriodLabel: 'Senaste 2 betalningarna',
      annualizedImpactCents: 36_000,
    });
    expect(result.trends[0].deltaPercent).toBeCloseTo(20.134, 2);
  });

  it('classifies stable and decreasing monthly levels', () => {
    const result = buildRecurringCostTrendInsights([
      cost(1, '2026-01-25', 14_900, 'STABIL'),
      cost(2, '2026-02-25', 14_900, 'STABIL'),
      cost(3, '2026-03-25', 14_900, 'STABIL'),
      cost(4, '2026-04-25', 14_900, 'STABIL'),
      cost(5, '2026-05-25', 14_900, 'STABIL'),
      cost(6, '2026-06-25', 14_900, 'STABIL'),
      cost(7, '2026-01-20', 19_900, 'MINSKANDE'),
      cost(8, '2026-02-20', 19_900, 'MINSKANDE'),
      cost(9, '2026-03-20', 18_900, 'MINSKANDE'),
      cost(10, '2026-04-20', 17_900, 'MINSKANDE'),
      cost(11, '2026-05-20', 16_900, 'MINSKANDE'),
      cost(12, '2026-06-20', 16_900, 'MINSKANDE'),
    ], 2026, 6, today);
    const byMerchant = new Map(result.trends.map((trend) => [trend.merchantLabel, trend]));

    expect(byMerchant.get('STABIL')?.trend).toBe('stable');
    expect(byMerchant.get('MINSKANDE')).toMatchObject({
      trend: 'decreasing',
      deltaCents: -3_000,
      confidence: 'high',
    });
  });

  it('does not give noisy variable costs a high-confidence increase', () => {
    const amounts = [10_000, 25_000, 12_000, 30_000, 9_000, 28_000];
    const result = buildRecurringCostTrendInsights(
      amounts.map((amount, index) =>
        cost(index + 1, `2026-${String(index + 1).padStart(2, '0')}-20`, amount, 'ELBOLAG')
      ),
      2026,
      6,
      today
    );

    expect(result.increasing).toEqual([]);
    expect(result.trends[0]?.confidence).not.toBe('high');
  });

  it('supports 5, 12, missed-month, and day-varying monthly histories', () => {
    const series = [
      ['FEM', ['2026-01-25', '2026-02-27', '2026-03-24', '2026-04-26', '2026-05-25']],
      ['TOLV', Array.from({ length: 12 }, (_, index) =>
        `${index < 4 ? 2025 : 2026}-${String((index + 8) % 12 + 1).padStart(2, '0')}-25`
      )],
      ['MISSAD', ['2026-01-25', '2026-02-25', '2026-04-25', '2026-05-25', '2026-06-25']],
    ] as const;
    const transactions: MonthlyInsightTransaction[] = [];
    let id = 1;
    for (const [merchant, dates] of series) {
      dates.forEach((date, index) => {
        transactions.push(cost(id++, date, index < 2 ? 10_000 : 12_000, merchant));
      });
    }

    const result = buildRecurringCostTrendInsights(transactions, 2026, 8, today);
    const byMerchant = new Map(result.trends.map((trend) => [trend.merchantLabel, trend]));
    expect([...byMerchant.keys()]).toEqual(expect.arrayContaining(['FEM', 'TOLV', 'MISSAD']));
    expect(byMerchant.get('FEM')).toMatchObject({ observations: 5, frequency: 'monthly' });
    expect(byMerchant.get('TOLV')).toMatchObject({
      observations: 12,
      frequency: 'monthly',
      firstPeriodLabel: 'Första 4 betalningarna',
      recentPeriodLabel: 'Senaste 4 betalningarna',
    });
    expect(byMerchant.get('MISSAD')).toMatchObject({ observations: 5, frequency: 'monthly' });
  });

  it('detects a quarterly trend with enough history', () => {
    const result = buildRecurringCostTrendInsights([
      cost(1, '2025-01-15', 100_000, 'KVARTAL'),
      cost(2, '2025-04-16', 100_000, 'KVARTAL'),
      cost(3, '2025-07-14', 110_000, 'KVARTAL'),
      cost(4, '2025-10-17', 120_000, 'KVARTAL'),
      cost(5, '2026-01-15', 120_000, 'KVARTAL'),
    ], 2026, 1, today);

    expect(result.trends[0]).toMatchObject({
      frequency: 'quarterly',
      trend: 'increasing',
      firstPeriodMedianCents: 100_000,
      recentPeriodMedianCents: 120_000,
      annualizedImpactCents: 80_000,
    });
  });

  it('requires three annual observations before showing an annual trend', () => {
    const two = buildRecurringCostTrendInsights([
      cost(1, '2025-01-15', 300_000, 'ÅRSAVGIFT'),
      cost(2, '2026-01-15', 350_000, 'ÅRSAVGIFT'),
    ], 2026, 1, today);
    const three = buildRecurringCostTrendInsights([
      cost(1, '2024-01-15', 300_000, 'ÅRSAVGIFT'),
      cost(2, '2025-01-15', 320_000, 'ÅRSAVGIFT'),
      cost(3, '2026-01-15', 350_000, 'ÅRSAVGIFT'),
    ], 2026, 1, today);

    expect(two.trends).toEqual([]);
    expect(three.trends[0]).toMatchObject({
      frequency: 'annual',
      trend: 'increasing',
      confidence: 'medium',
      firstPeriodMedianCents: 310_000,
      recentPeriodMedianCents: 335_000,
      annualizedImpactCents: 25_000,
    });
  });

  it('does not analyze irregular recurring candidates', () => {
    const result = buildRecurringCostTrendInsights([
      cost(1, '2025-10-10', 20_000, 'OREGELBUNDEN'),
      cost(2, '2025-11-10', 20_000, 'OREGELBUNDEN'),
      cost(3, '2026-04-10', 22_000, 'OREGELBUNDEN'),
      cost(4, '2026-09-10', 22_000, 'OREGELBUNDEN'),
      cost(5, '2026-10-05', 22_000, 'OREGELBUNDEN'),
    ], 2026, 10, today);

    expect(result.trends).toEqual([]);
  });

  it('keeps excluded transaction types out of the trend', () => {
    const types: MonthlyInsightTransaction['transactionType'][] = [
      'refund', 'saving', 'amortization', 'transfer', 'income', 'unclassified',
    ];
    const transactions = types.flatMap((type, typeIndex) =>
      Array.from({ length: 6 }, (_, monthIndex) =>
        cost(
          typeIndex * 10 + monthIndex,
          `2026-${String(monthIndex + 1).padStart(2, '0')}-10`,
          10_000 + monthIndex * 1_000,
          type.toUpperCase(),
          type
        )
      )
    );

    expect(buildRecurringCostTrendInsights(transactions, 2026, 6, today).trends).toEqual([]);
  });

  it('keeps conservatively normalized merchants separate', () => {
    const transactions: MonthlyInsightTransaction[] = [];
    for (let month = 1; month <= 6; month += 1) {
      const date = `2026-${String(month).padStart(2, '0')}-10`;
      transactions.push(cost(month, date, month < 3 ? 20_000 : 23_000, 'ICA MAXI*12344'));
      transactions.push(cost(month + 10, date, month < 3 ? 30_000 : 34_000, 'ICA Banken'));
    }
    const result = buildRecurringCostTrendInsights(transactions, 2026, 6, today);

    expect(result.trends.map((trend) => trend.merchantLabel).sort()).toEqual([
      'ICA Banken',
      'ICA MAXI',
    ]);
  });
});
