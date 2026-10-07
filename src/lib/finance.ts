export type Currency = 'SEK';

export function formatCurrencyFromCents(amountCents: number): string {
  return `${(amountCents / 100).toLocaleString('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} kr`;
}

export const transactionTypes = [
  'income',
  'expense',
  'saving',
  'amortization',
  'transfer',
  'refund',
  'unclassified',
] as const;

export type TransactionType = typeof transactionTypes[number];

export type FinancialTransaction = {
  amountCents: number;
  category: string;
  transactionType: TransactionType;
};

export type FinancialSummary = {
  incomeCents: number;
  consumptionExpensesCents: number;
  directSavingsCents: number;
  amortizationCents: number;
  totalWealthBuildingCents: number;
  remainingAfterSpendingAndSavingCents: number;
  unclassifiedCount: number;
};

export type MonthlyInsightTransaction = {
  id: string | number;
  date: string;
  merchant: string;
  category: string;
  amountCents: number;
  transactionType: TransactionType;
};

export type MonthlyChangeInsight = {
  category: string;
  currentCents: number;
  baselineCents: number;
  deltaCents: number;
  deltaPercent: number | null;
};

export type MerchantInsight = {
  merchant: string;
  spendCents: number;
  transactionCount: number;
};

export type MonthlyInsights = {
  status: 'available' | 'incomplete-month' | 'insufficient-history';
  baselineKind: 'historical-average' | 'previous-month' | null;
  baselineLabel: string | null;
  baselineMonthCount: number;
  currentTotalCents: number;
  baselineTotalCents: number;
  totalDeltaCents: number;
  categoryChanges: MonthlyChangeInsight[];
  biggestIncreases: MonthlyChangeInsight[];
  biggestDecreases: MonthlyChangeInsight[];
  unusualTransactions: MonthlyInsightTransaction[];
  topMerchants: MerchantInsight[];
};

export type RecurringFrequency = 'monthly' | 'quarterly' | 'annual' | 'irregular';
export type RecurringConfidence = 'low' | 'medium' | 'high';

export type RecurringExpenseInsight = {
  merchantKey: string;
  merchantLabel: string;
  frequency: RecurringFrequency;
  occurrences: number;
  activeMonths: number;
  monthsObserved: number;
  medianAmountCents: number;
  latestAmountCents: number;
  latestDate: string;
  comparisonMedianCents: number;
  deltaFromMedianCents: number;
  deltaPercent: number | null;
  hasRelevantPriceChange: boolean;
  hasStablePriceHistory: boolean;
  amountStabilityRatio: number;
  intervalRegularityRatio: number;
  estimatedAnnualCostCents: number | null;
  confidence: RecurringConfidence;
  firstSeen: string;
  lastSeen: string;
  occurrenceHistory: Array<{ date: string; amountCents: number }>;
};

export type RecurringExpenseAnalysis = {
  status: 'available' | 'insufficient-history' | 'no-candidates';
  observedMonthCount: number;
  insights: RecurringExpenseInsight[];
};

export type RecurringCostTrend = 'increasing' | 'decreasing' | 'stable';

export type RecurringCostTrendInsight = {
  merchantKey: string;
  merchantLabel: string;
  frequency: Exclude<RecurringFrequency, 'irregular'>;
  firstPeriodMedianCents: number;
  recentPeriodMedianCents: number;
  deltaCents: number;
  deltaPercent: number | null;
  trend: RecurringCostTrend;
  observations: number;
  monthsSpanned: number;
  amountStabilityRatio: number;
  directionConsistencyRatio: number;
  confidence: RecurringConfidence;
  firstPeriodLabel: string;
  recentPeriodLabel: string;
  annualizedImpactCents: number;
};

export type RecurringCostTrendAnalysis = {
  status: 'available' | 'insufficient-history';
  trends: RecurringCostTrendInsight[];
  increasing: RecurringCostTrendInsight[];
  decreasing: RecurringCostTrendInsight[];
};

export type FinancialHealthSeverity = 'positive' | 'info' | 'attention' | 'important';
export type FinancialHealthSource =
  | 'budget'
  | 'monthly-change'
  | 'recurring'
  | 'cost-trend'
  | 'classification'
  | 'savings'
  | 'financial-summary';

export type FinancialHealthInsight = {
  id: string;
  severity: FinancialHealthSeverity;
  type: string;
  title: string;
  summary: string;
  supportingDetail?: string;
  amountCents?: number;
  percent?: number | null;
  source: FinancialHealthSource;
  priorityScore: number;
};

export type FinancialHealthSummary = {
  status: 'good' | 'attention' | 'needs-review';
  headline: string;
  supportingText: string;
  insights: FinancialHealthInsight[];
  importantCount: number;
  attentionCount: number;
  positiveCount: number;
  hiddenCount: number;
};

const incomeCategories = new Set(['Lön', 'Bidrag', 'Uthyrning']);

export function inferTransactionType(
  category: string,
  amountCents: number
): TransactionType {
  if (category === 'Överföring mellan konto') return 'transfer';
  if (category === 'Sparande') return 'saving';
  if (category === 'Sparande / Amortering') return 'amortization';
  if (amountCents > 0 && incomeCategories.has(category)) return 'income';
  if (amountCents < 0) return 'expense';
  return 'unclassified';
}

export function calculateFinancialSummary(
  transactions: Array<Pick<FinancialTransaction, 'amountCents' | 'transactionType'>>
): FinancialSummary {
  let incomeCents = 0;
  let consumptionExpensesCents = 0;
  let directSavingsCents = 0;
  let amortizationCents = 0;
  let unclassifiedCount = 0;

  for (const transaction of transactions) {
    switch (transaction.transactionType) {
      case 'income':
        incomeCents += transaction.amountCents;
        break;
      case 'expense':
      case 'refund':
        consumptionExpensesCents -= transaction.amountCents;
        break;
      case 'saving':
        directSavingsCents -= transaction.amountCents;
        break;
      case 'amortization':
        amortizationCents -= transaction.amountCents;
        break;
      case 'unclassified':
        unclassifiedCount += 1;
        break;
      case 'transfer':
        break;
    }
  }

  const totalWealthBuildingCents = directSavingsCents + amortizationCents;
  return {
    incomeCents,
    consumptionExpensesCents,
    directSavingsCents,
    amortizationCents,
    totalWealthBuildingCents,
    remainingAfterSpendingAndSavingCents:
      incomeCents - consumptionExpensesCents - directSavingsCents - amortizationCents,
    unclassifiedCount,
  };
}

export function calculateCategoryTotals(
  transactions: FinancialTransaction[],
  types: TransactionType[]
): Map<string, number> {
  const includedTypes = new Set(types);
  const totals = new Map<string, number>();
  for (const transaction of transactions) {
    if (!includedTypes.has(transaction.transactionType)) continue;
    const contribution = transaction.transactionType === 'income'
      ? transaction.amountCents
      : -transaction.amountCents;
    totals.set(transaction.category, (totals.get(transaction.category) ?? 0) + contribution);
  }
  return totals;
}

export type BudgetKind = 'consumption' | 'income' | 'saving' | 'amortization';

export type BudgetRow = {
  category: string;
  hasBudget: boolean;
  budgetCents: number;
  actualCents: number;
  remainingCents: number;
  percentUsed: number | null;
  historicalMonthlyAverageCents: number | null;
  forecastAnnualCents: number | null;
};

export type BudgetAnalysis = {
  rows: BudgetRow[];
  coveredMonths: string[];
};

const budgetTypes: Record<BudgetKind, TransactionType[]> = {
  consumption: ['expense', 'refund'],
  income: ['income'],
  saving: ['saving'],
  amortization: ['amortization'],
};

export function budgetKindForCategory(category: string): BudgetKind {
  if (category === 'Sparande') return 'saving';
  if (category === 'Sparande / Amortering') return 'amortization';
  if (incomeCategories.has(category)) return 'income';
  return 'consumption';
}

const completedMonth = (year: number, month: number, today: Date): boolean => {
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  return year < currentYear || (year === currentYear && month < currentMonth);
};

export function getCoveredMonths(
  transactions: Array<FinancialTransaction & { date: string }>,
  year: number,
  kind: BudgetKind,
  today: Date
): string[] {
  const relevantTypes = new Set(budgetTypes[kind]);
  const months = new Set<string>();
  for (const transaction of transactions) {
    const match = transaction.date.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (!match || Number(match[1]) !== year || !relevantTypes.has(transaction.transactionType)) continue;
    const month = Number(match[2]);
    if (month < 1 || month > 12 || !completedMonth(year, month, today)) continue;
    months.add(`${match[1]}-${match[2]}`);
  }
  return [...months].sort();
}

export function buildBudgetAnalysis(input: {
  periodTransactions: Array<FinancialTransaction & { date: string }>;
  yearTransactions: Array<FinancialTransaction & { date: string }>;
  budgets: Record<string, number>;
  kind: BudgetKind;
  year: number;
  today: Date;
  defaultCategories?: string[];
}): BudgetAnalysis {
  const types = budgetTypes[input.kind];
  const actualByCategory = calculateCategoryTotals(input.periodTransactions, types);
  const coveredMonths = getCoveredMonths(
    input.yearTransactions,
    input.year,
    input.kind,
    input.today
  );
  const coveredMonthSet = new Set(coveredMonths);
  const completedTransactions = input.yearTransactions.filter((transaction) =>
    coveredMonthSet.has(transaction.date.slice(0, 7))
  );
  const historicalByCategory = calculateCategoryTotals(completedTransactions, types);
  const categories = new Set([
    ...(input.defaultCategories ?? []),
    ...actualByCategory.keys(),
    ...Object.keys(input.budgets).filter((category) =>
      budgetKindForCategory(category) === input.kind
    ),
  ]);

  const rows = [...categories].map((category): BudgetRow => {
    const actualCents = actualByCategory.get(category) ?? 0;
    const hasBudget = Object.prototype.hasOwnProperty.call(input.budgets, category);
    const budgetCents = input.budgets[category] ?? 0;
    const historicalMonthlyAverageCents = coveredMonths.length
      ? (historicalByCategory.get(category) ?? 0) / coveredMonths.length
      : null;
    return {
      category,
      hasBudget,
      budgetCents,
      actualCents,
      remainingCents: budgetCents - actualCents,
      percentUsed: budgetCents > 0 ? actualCents / budgetCents * 100 : null,
      historicalMonthlyAverageCents,
      forecastAnnualCents: coveredMonths.length >= 2
        ? (historicalMonthlyAverageCents ?? 0) * 12
        : null,
    };
  }).sort((left, right) =>
    right.actualCents - left.actualCents ||
    left.category.localeCompare(right.category, 'sv')
  );

  return { rows, coveredMonths };
}

export type Rule = {
  id: string;
  match: string;
  category: string;
  priority: number;
  scope?: 'merchant' | 'merchantGroup' | 'exact' | 'custom';
  matchMode?: 'contains' | 'merchant-exact' | 'merchant-prefix' | 'merchant-similar';
  enabled?: boolean;
  description?: string;
};

export const internalTransferRule: Rule = {
  id: 'internal-transfer',
  match: 'ÖVERFÖRING VIA INTERNET',
  category: 'Överföring mellan konto',
  priority: 130,
};

export const ikeaBarkarbyRules: Rule[] = [
  { id: 'ikea-barkarby-hf', match: 'IKEA BARKARBY HF', category: 'Boende / Projekt', priority: 140 },
  { id: 'ikea-barkarby-if', match: 'IKEA BARKARBY IF', category: 'Restaurang / Café', priority: 140 },
];

export type TransactionInput = {
  merchant: string;
  amountCents: number;
  date?: string;
};

export type ClassificationDecision = {
  category: string;
  source: 'explicit-user-rule' | 'merchant-map' | 'exact-match' | 'alias-rule' | 'historical-match' | 'fuzzy-match' | 'manual';
  confidence: number;
  ruleId?: string;
  explanation: string;
  needsReview: boolean;
};

type SwishTransfer = {
  direction: 'skickat' | 'mottaget';
  phone: string;
};

const genericMerchantRoots = new Set([
  'swish', 'mottagen', 'mottaget', 'skickat', 'kort', 'kortkop',
  'betalning', 'payment', 'purchase', 'bank',
]);

function parseSwishTransfer(raw: string): SwishTransfer | null {
  const text = raw.trim()
    .replace(/\*\d+/g, '')
    .replace(/^(kortk[oö]p|kort köp|payment|purchase)\s+/i, '')
    .replace(/\s+/g, ' ');
  const action = text.match(/\b(skickat|skickad|mottagen|mottaget|till|från|fran)\b/i)?.[1];
  const rawPhone = text.match(/(?:\+|00)?46[\s().-]*(?:\(0\)[\s().-]*)?0?7(?:[\s().-]*\d){8}|0?7(?:[\s().-]*\d){8}/)?.[0];
  if (!action || !rawPhone) return null;

  let phone = rawPhone.replace(/\D/g, '');
  if (phone.startsWith('0046')) phone = phone.slice(2);
  if (phone.startsWith('4607')) phone = `46${phone.slice(3)}`;
  if (phone.startsWith('07')) phone = `46${phone.slice(1)}`;
  if (!(/^467\d{8}$/.test(phone) || /^07\d{8}$/.test(phone))) return null;

  return {
    direction: /^(skickat|skickad|till)$/i.test(action) ? 'skickat' : 'mottaget',
    phone,
  };
}

export function normalizeMerchant(raw: string): {
  raw: string;
  normalized: string;
  group: string;
} {
  const cleaned = raw.trim();
  const withoutAsterisk = cleaned
    .replace(/\*\d+/g, '')
    .replace(/^(kortk[oö]p|kort köp|payment|purchase)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const canonicalSwish = withoutAsterisk.match(/^swish\s+(skickat|mottaget)$/i);
  if (canonicalSwish) {
    const normalized = `Swish ${canonicalSwish[1].toLowerCase()}`;
    return { raw: cleaned, normalized, group: normalized };
  }
  if (/^skickat\s+swish$/i.test(withoutAsterisk)) {
    return { raw: cleaned, normalized: 'Swish skickat', group: 'Swish skickat' };
  }

  const swishTransfer = parseSwishTransfer(withoutAsterisk);
  if (swishTransfer) {
    const normalized = `Swish ${swishTransfer.direction}`;
    return { raw: cleaned, normalized, group: normalized };
  }

  const words = withoutAsterisk.split(' ').filter((word) => {
    const token = word.trim();
    if (!token) return false;
    if (/^\d+$/.test(token)) return false;
    if (/^\d{4,}$/.test(token)) return false;
    if (/^(kortk[oö]p|kort|betal|payment|purchase|swish|bankgiro|card)$/i.test(token)) return false;
    return true;
  });

  const normalized = words.join(' ').replace(/\s+/g, ' ').trim();
  const group = normalized.split(' ').slice(0, 2).join(' ').trim() || normalized;

  return {
    raw: cleaned,
    normalized: normalized || cleaned,
    group: group || cleaned,
  };
}

export function normalizedMerchantKey(raw: string): string {
  return normalizeMerchant(raw).normalized.toLocaleUpperCase('sv-SE');
}

const insightMonthNames = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
];

const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

function previousMonthKey(year: number, month: number): string {
  return month === 1 ? monthKey(year - 1, 12) : monthKey(year, month - 1);
}

function transactionMonthKey(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${match[2]}` : null;
}

function consumptionAmount(transaction: Pick<MonthlyInsightTransaction, 'amountCents' | 'transactionType'>): number {
  return transaction.transactionType === 'expense' || transaction.transactionType === 'refund'
    ? -transaction.amountCents
    : 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function monthSerial(date: string): number | null {
  const key = transactionMonthKey(date);
  if (key == null) return null;
  const [year, month] = key.split('-').map(Number);
  return year * 12 + month - 1;
}

function frequencyAnnualMultiplier(frequency: RecurringFrequency): number | null {
  if (frequency === 'monthly') return 12;
  if (frequency === 'quarterly') return 4;
  if (frequency === 'annual') return 1;
  return null;
}

function relevantRecurringPriceChange(deltaCents: number, deltaPercent: number | null): boolean {
  const absoluteDelta = Math.abs(deltaCents);
  return absoluteDelta >= 2_000 ||
    (absoluteDelta >= 1_000 && deltaPercent != null && Math.abs(deltaPercent) >= 10);
}

function recurringConfidenceRank(confidence: RecurringConfidence): number {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  return 1;
}

function deriveRecurringExpenseInsights(
  transactions: MonthlyInsightTransaction[],
  referenceYear: number,
  referenceMonth: number,
  today: Date,
  resultLimit: number | null,
  lookbackMonths: number
): RecurringExpenseAnalysis {
  const referenceSerial = referenceYear * 12 + referenceMonth - 1;
  const currentSerial = today.getFullYear() * 12 + today.getMonth();
  const effectiveReferenceSerial = Math.min(referenceSerial, currentSerial);
  const windowStartSerial = effectiveReferenceSerial - lookbackMonths;
  const eligible = transactions
    .filter((transaction) =>
      transaction.transactionType === 'expense' &&
      transaction.amountCents < 0
    )
    .filter((transaction) => {
      const serial = monthSerial(transaction.date);
      return serial != null && serial >= windowStartSerial && serial <= effectiveReferenceSerial;
    });
  const completedMonthKeys = new Set(
    eligible
      .filter((transaction) => (monthSerial(transaction.date) ?? currentSerial) < currentSerial)
      .map((transaction) => transactionMonthKey(transaction.date))
      .filter((key): key is string => key != null)
  );
  if (completedMonthKeys.size < 2) {
    return {
      status: 'insufficient-history',
      observedMonthCount: completedMonthKeys.size,
      insights: [],
    };
  }

  const byMerchant = new Map<string, MonthlyInsightTransaction[]>();
  for (const transaction of eligible) {
    const key = normalizedMerchantKey(transaction.merchant);
    if (!key || key === 'OKÄND MERCHANT') continue;
    byMerchant.set(key, [...(byMerchant.get(key) ?? []), transaction]);
  }

  const insights: RecurringExpenseInsight[] = [];
  for (const [merchantKey, merchantTransactions] of byMerchant) {
    const occurrences = [...merchantTransactions].sort((left, right) =>
      left.date.localeCompare(right.date) || String(left.id).localeCompare(String(right.id))
    );
    if (occurrences.length < 2) continue;
    const monthCounts = new Map<number, number>();
    for (const occurrence of occurrences) {
      const serial = monthSerial(occurrence.date);
      if (serial != null) monthCounts.set(serial, (monthCounts.get(serial) ?? 0) + 1);
    }
    const activeMonths = monthCounts.size;
    const averagePerActiveMonth = occurrences.length / activeMonths;
    const maxInMonth = Math.max(...monthCounts.values());
    if (averagePerActiveMonth > 1.5 || maxInMonth > 2) continue;

    const intervals = occurrences.slice(1).map((occurrence, index) =>
      (monthSerial(occurrence.date) ?? 0) - (monthSerial(occurrences[index].date) ?? 0)
    );
    const matchingRatio = (minimum: number, maximum: number) =>
      intervals.length === 0
        ? 0
        : intervals.filter((interval) => interval >= minimum && interval <= maximum).length /
          intervals.length;
    const monthlyRatio = matchingRatio(1, 2);
    const quarterlyRatio = matchingRatio(2, 4);
    const annualRatio = matchingRatio(11, 13);
    let frequency: RecurringFrequency = 'irregular';
    let intervalRegularityRatio = Math.max(monthlyRatio, quarterlyRatio, annualRatio);
    if (occurrences.length >= 3 && monthlyRatio >= 0.6) {
      frequency = 'monthly';
      intervalRegularityRatio = monthlyRatio;
    } else if (occurrences.length >= 3 && quarterlyRatio >= 0.6) {
      frequency = 'quarterly';
      intervalRegularityRatio = quarterlyRatio;
    } else if (occurrences.length >= 2 && annualRatio >= 0.6) {
      frequency = 'annual';
      intervalRegularityRatio = annualRatio;
    } else if (occurrences.length < 3) {
      continue;
    }

    const amounts = occurrences.map((transaction) => Math.abs(transaction.amountCents));
    const medianAmountCents = Math.round(median(amounts));
    const stableAmounts = amounts.filter((amount) =>
      medianAmountCents > 0 && Math.abs(amount - medianAmountCents) / medianAmountCents <= 0.15
    ).length;
    const amountStabilityRatio = stableAmounts / amounts.length;
    if (frequency === 'irregular' && (occurrences.length < 4 || amountStabilityRatio < 0.8)) {
      continue;
    }

    const firstSerial = monthSerial(occurrences[0].date) ?? effectiveReferenceSerial;
    const latestSerial = monthSerial(occurrences[occurrences.length - 1].date) ?? effectiveReferenceSerial;
    const observationEndSerial =
      effectiveReferenceSerial === currentSerial && latestSerial < currentSerial
        ? currentSerial - 1
        : effectiveReferenceSerial;
    const monthsObserved = Math.max(1, observationEndSerial - firstSerial + 1);
    const coverageRatio = activeMonths / monthsObserved;
    const latest = occurrences[occurrences.length - 1];
    const earlierAmounts = amounts.slice(0, -1);
    const comparisonMedianCents = Math.round(median(earlierAmounts));
    const latestAmountCents = Math.abs(latest.amountCents);
    const deltaFromMedianCents = latestAmountCents - comparisonMedianCents;
    const deltaPercent = comparisonMedianCents > 0
      ? deltaFromMedianCents / comparisonMedianCents * 100
      : null;
    const isPeriodic = frequency !== 'irregular';
    let confidence: RecurringConfidence = 'low';
    if (
      isPeriodic &&
      occurrences.length >= 5 &&
      intervalRegularityRatio >= 0.8 &&
      amountStabilityRatio >= 0.8 &&
      coverageRatio >= 0.9
    ) {
      confidence = 'high';
    } else if (
      isPeriodic &&
      intervalRegularityRatio >= 0.6 &&
      amountStabilityRatio >= 0.6
    ) {
      confidence = 'medium';
    }

    const annualMultiplier = frequencyAnnualMultiplier(frequency);
    insights.push({
      merchantKey,
      merchantLabel: normalizeMerchant(latest.merchant).normalized,
      frequency,
      occurrences: occurrences.length,
      activeMonths,
      monthsObserved,
      medianAmountCents,
      latestAmountCents,
      latestDate: latest.date,
      comparisonMedianCents,
      deltaFromMedianCents,
      deltaPercent,
      hasRelevantPriceChange: relevantRecurringPriceChange(deltaFromMedianCents, deltaPercent),
      hasStablePriceHistory: amountStabilityRatio >= 0.6,
      amountStabilityRatio,
      intervalRegularityRatio,
      estimatedAnnualCostCents: annualMultiplier == null
        ? null
        : medianAmountCents * annualMultiplier,
      confidence,
      firstSeen: occurrences[0].date,
      lastSeen: latest.date,
      occurrenceHistory: occurrences.map((occurrence) => ({
        date: occurrence.date,
        amountCents: Math.abs(occurrence.amountCents),
      })),
    });
  }

  insights.sort((left, right) => {
    const leftIncrease = Number(left.hasRelevantPriceChange && left.deltaFromMedianCents > 0);
    const rightIncrease = Number(right.hasRelevantPriceChange && right.deltaFromMedianCents > 0);
    return rightIncrease - leftIncrease ||
      recurringConfidenceRank(right.confidence) - recurringConfidenceRank(left.confidence) ||
      (right.estimatedAnnualCostCents ?? 0) - (left.estimatedAnnualCostCents ?? 0) ||
      left.merchantLabel.localeCompare(right.merchantLabel, 'sv-SE');
  });

  return {
    status: insights.length > 0 ? 'available' : 'no-candidates',
    observedMonthCount: completedMonthKeys.size,
    insights: resultLimit == null ? insights : insights.slice(0, resultLimit),
  };
}

export function buildRecurringExpenseInsights(
  transactions: MonthlyInsightTransaction[],
  referenceYear: number,
  referenceMonth: number,
  today: Date = new Date()
): RecurringExpenseAnalysis {
  return deriveRecurringExpenseInsights(transactions, referenceYear, referenceMonth, today, 8, 12);
}

export function buildRecurringCostTrendInsights(
  transactions: MonthlyInsightTransaction[],
  referenceYear: number,
  referenceMonth: number,
  today: Date = new Date()
): RecurringCostTrendAnalysis {
  const recurring = deriveRecurringExpenseInsights(
    transactions,
    referenceYear,
    referenceMonth,
    today,
    null,
    36
  );
  if (recurring.status === 'insufficient-history') {
    return { status: 'insufficient-history', trends: [], increasing: [], decreasing: [] };
  }

  const trends: RecurringCostTrendInsight[] = [];
  let eligibleCandidates = 0;
  for (const candidate of recurring.insights) {
    if (candidate.frequency === 'irregular') continue;
    const observations = candidate.occurrenceHistory;
    const minimumObservations = candidate.frequency === 'annual' ? 3 : 5;
    if (observations.length < minimumObservations) continue;
    const firstSerial = monthSerial(observations[0].date);
    const lastSerial = monthSerial(observations[observations.length - 1].date);
    if (firstSerial == null || lastSerial == null) continue;
    const monthsSpanned = lastSerial - firstSerial + 1;
    if (candidate.frequency !== 'annual' && monthsSpanned < 4) continue;
    eligibleCandidates += 1;

    const periodSize = observations.length >= 8
      ? Math.max(2, Math.floor(observations.length / 3))
      : 2;
    const firstPeriod = observations.slice(0, periodSize);
    const recentPeriod = observations.slice(-periodSize);
    const firstPeriodMedianCents = Math.round(median(
      firstPeriod.map((occurrence) => occurrence.amountCents)
    ));
    const recentPeriodMedianCents = Math.round(median(
      recentPeriod.map((occurrence) => occurrence.amountCents)
    ));
    const deltaCents = recentPeriodMedianCents - firstPeriodMedianCents;
    const deltaPercent = firstPeriodMedianCents > 0
      ? deltaCents / firstPeriodMedianCents * 100
      : null;
    const isClearChange = Math.abs(deltaCents) >= 2_000 &&
      deltaPercent != null &&
      Math.abs(deltaPercent) >= 5;
    const trend: RecurringCostTrend = !isClearChange
      ? 'stable'
      : deltaCents > 0 ? 'increasing' : 'decreasing';
    const changes = observations.slice(1).map((occurrence, index) =>
      Math.sign(occurrence.amountCents - observations[index].amountCents)
    );
    const expectedDirection = trend === 'increasing' ? 1 : trend === 'decreasing' ? -1 : 0;
    const directionConsistencyRatio = expectedDirection === 0
      ? changes.filter((direction) => direction === 0).length / changes.length
      : changes.filter((direction) => direction === expectedDirection).length / changes.length;
    let confidence: RecurringConfidence = 'low';
    if (
      trend !== 'stable' &&
      candidate.confidence !== 'low' &&
      observations.length >= 6 &&
      candidate.amountStabilityRatio >= 0.8 &&
      directionConsistencyRatio >= 0.6
    ) {
      confidence = 'high';
    } else if (
      trend !== 'stable' &&
      candidate.confidence !== 'low' &&
      candidate.amountStabilityRatio >= 0.6
    ) {
      confidence = 'medium';
    }
    const multiplier = frequencyAnnualMultiplier(candidate.frequency) ?? 0;
    trends.push({
      merchantKey: candidate.merchantKey,
      merchantLabel: candidate.merchantLabel,
      frequency: candidate.frequency,
      firstPeriodMedianCents,
      recentPeriodMedianCents,
      deltaCents,
      deltaPercent,
      trend,
      observations: observations.length,
      monthsSpanned,
      amountStabilityRatio: candidate.amountStabilityRatio,
      directionConsistencyRatio,
      confidence,
      firstPeriodLabel: `Första ${periodSize} betalningarna`,
      recentPeriodLabel: `Senaste ${periodSize} betalningarna`,
      annualizedImpactCents: deltaCents * multiplier,
    });
  }

  const confidenceSort = (left: RecurringCostTrendInsight, right: RecurringCostTrendInsight) =>
    recurringConfidenceRank(right.confidence) - recurringConfidenceRank(left.confidence) ||
    Math.abs(right.deltaCents) - Math.abs(left.deltaCents) ||
    Math.abs(right.deltaPercent ?? 0) - Math.abs(left.deltaPercent ?? 0) ||
    left.merchantLabel.localeCompare(right.merchantLabel, 'sv-SE');
  const increasing = trends
    .filter((trend) => trend.trend === 'increasing' && trend.confidence !== 'low')
    .sort(confidenceSort)
    .slice(0, 5);
  const decreasing = trends
    .filter((trend) => trend.trend === 'decreasing' && trend.confidence !== 'low')
    .sort(confidenceSort);

  return {
    status: eligibleCandidates > 0 ? 'available' : 'insufficient-history',
    trends,
    increasing,
    decreasing,
  };
}

function healthPriority(
  severity: FinancialHealthSeverity,
  amountCents = 0,
  percent: number | null = null,
  highConfidence = false
): number {
  const base = severity === 'important'
    ? 100
    : severity === 'attention'
      ? 70
      : severity === 'info'
        ? 40
        : 30;
  const amountPoints = Math.min(20, Math.floor(Math.abs(amountCents) / 50_000));
  const percentPoints = percent == null
    ? 0
    : Math.min(10, Math.floor(Math.abs(percent) / 10));
  return base + amountPoints + percentPoints + (highConfidence ? 10 : 0);
}

export function buildFinancialHealthSummary(input: {
  financialSummary: FinancialSummary;
  consumptionBudgetRows: BudgetRow[];
  savingBudgetRows: BudgetRow[];
  amortizationBudgetRows: BudgetRow[];
  monthlyInsights: MonthlyInsights | null;
  recurringInsights: RecurringExpenseAnalysis;
  costTrends: RecurringCostTrendAnalysis;
  isCurrentMonth: boolean;
}): FinancialHealthSummary {
  const candidates: FinancialHealthInsight[] = [];
  const monthlyByCategory = new Map(
    input.monthlyInsights?.status === 'available'
      ? input.monthlyInsights.categoryChanges.map((change) => [change.category, change])
      : []
  );
  const handledMonthlyCategories = new Set<string>();

  for (const row of input.consumptionBudgetRows) {
    if (!row.hasBudget || row.budgetCents <= 0) continue;
    const differenceCents = row.actualCents - row.budgetCents;
    const differencePercent = differenceCents / row.budgetCents * 100;
    const monthly = monthlyByCategory.get(row.category);
    if (
      differenceCents >= 20_000 ||
      (differenceCents >= 10_000 && differencePercent >= 10)
    ) {
      const severity: FinancialHealthSeverity =
        differenceCents >= 100_000 ||
        (differenceCents >= 20_000 && differencePercent >= 25)
          ? 'important'
          : 'attention';
      const supportingDetail = monthly != null && monthly.deltaCents >= 20_000
        ? `${formatCurrencyFromCents(monthly.deltaCents)} högre än normal nivå`
        : undefined;
      if (supportingDetail) handledMonthlyCategories.add(row.category);
      candidates.push({
        id: `budget-over-${row.category}`,
        severity,
        type: 'budget-overrun',
        title: row.category,
        summary: `${formatCurrencyFromCents(differenceCents)} över budget`,
        supportingDetail,
        amountCents: differenceCents,
        percent: differencePercent,
        source: 'budget',
        priorityScore: healthPriority(severity, differenceCents, differencePercent),
      });
    } else if (
      !input.isCurrentMonth &&
      differenceCents <= -50_000 &&
      Math.abs(differencePercent) >= 10
    ) {
      const supportingDetail = monthly != null && monthly.deltaCents <= -20_000
        ? `${formatCurrencyFromCents(Math.abs(monthly.deltaCents))} lägre än normal nivå`
        : undefined;
      if (supportingDetail) handledMonthlyCategories.add(row.category);
      candidates.push({
        id: `budget-under-${row.category}`,
        severity: 'positive',
        type: 'budget-under',
        title: row.category,
        summary: `${formatCurrencyFromCents(Math.abs(differenceCents))} under budget`,
        supportingDetail,
        amountCents: Math.abs(differenceCents),
        percent: Math.abs(differencePercent),
        source: 'budget',
        priorityScore: healthPriority('positive', differenceCents, differencePercent),
      });
    }
  }

  if (input.monthlyInsights?.status === 'available') {
    const monthly = input.monthlyInsights;
    if (monthly.totalDeltaCents >= 50_000) {
      const percent = monthly.baselineTotalCents > 0
        ? monthly.totalDeltaCents / monthly.baselineTotalCents * 100
        : null;
      const severity: FinancialHealthSeverity =
        monthly.totalDeltaCents >= 200_000 || (percent != null && percent >= 25)
          ? 'important'
          : 'attention';
      candidates.push({
        id: 'monthly-total-increase',
        severity,
        type: 'total-consumption-increase',
        title: 'Konsumtionsutgifter',
        summary: `${formatCurrencyFromCents(monthly.totalDeltaCents)} högre än normalt`,
        amountCents: monthly.totalDeltaCents,
        percent,
        source: 'financial-summary',
        priorityScore: healthPriority(severity, monthly.totalDeltaCents, percent),
      });
    } else if (monthly.totalDeltaCents <= -50_000) {
      candidates.push({
        id: 'monthly-total-decrease',
        severity: 'positive',
        type: 'total-consumption-decrease',
        title: 'Konsumtionsutgifter',
        summary: `${formatCurrencyFromCents(Math.abs(monthly.totalDeltaCents))} lägre än normalt`,
        amountCents: Math.abs(monthly.totalDeltaCents),
        percent: monthly.baselineTotalCents > 0
          ? Math.abs(monthly.totalDeltaCents / monthly.baselineTotalCents * 100)
          : null,
        source: 'financial-summary',
        priorityScore: healthPriority('positive', monthly.totalDeltaCents),
      });
    }
    for (const change of monthly.biggestIncreases.slice(0, 3)) {
      if (handledMonthlyCategories.has(change.category)) continue;
      const severity: FinancialHealthSeverity =
        change.deltaCents >= 100_000 ||
        (change.deltaPercent != null && change.deltaPercent >= 50 && change.deltaCents >= 50_000)
          ? 'important'
          : 'attention';
      candidates.push({
        id: `monthly-increase-${change.category}`,
        severity,
        type: 'category-increase',
        title: change.category,
        summary: `${formatCurrencyFromCents(change.deltaCents)} högre än normal nivå`,
        amountCents: change.deltaCents,
        percent: change.deltaPercent,
        source: 'monthly-change',
        priorityScore: healthPriority(severity, change.deltaCents, change.deltaPercent),
      });
    }
    for (const change of monthly.biggestDecreases.slice(0, 2)) {
      if (handledMonthlyCategories.has(change.category)) continue;
      candidates.push({
        id: `monthly-decrease-${change.category}`,
        severity: 'positive',
        type: 'category-decrease',
        title: change.category,
        summary: `${formatCurrencyFromCents(Math.abs(change.deltaCents))} lägre än normal nivå`,
        amountCents: Math.abs(change.deltaCents),
        percent: change.deltaPercent == null ? null : Math.abs(change.deltaPercent),
        source: 'monthly-change',
        priorityScore: healthPriority('positive', change.deltaCents, change.deltaPercent),
      });
    }
    for (const transaction of monthly.unusualTransactions.slice(0, 2)) {
      candidates.push({
        id: `unusual-${transaction.id}`,
        severity: Math.abs(transaction.amountCents) >= 500_000 ? 'attention' : 'info',
        type: 'unusual-purchase',
        title: 'Ovanligt stort köp',
        summary: `${transaction.merchant} · ${formatCurrencyFromCents(Math.abs(transaction.amountCents))}`,
        amountCents: Math.abs(transaction.amountCents),
        source: 'monthly-change',
        priorityScore: healthPriority(
          Math.abs(transaction.amountCents) >= 500_000 ? 'attention' : 'info',
          transaction.amountCents
        ),
      });
    }
  }

  const addGoalInsights = (rows: BudgetRow[], title: string, source: FinancialHealthSource) => {
    for (const row of rows) {
      if (!row.hasBudget || row.budgetCents <= 0) continue;
      const differenceCents = row.actualCents - row.budgetCents;
      const differencePercent = differenceCents / row.budgetCents * 100;
      if (
        differenceCents >= 20_000 ||
        (differenceCents >= 10_000 && differencePercent >= 10)
      ) {
        candidates.push({
          id: `goal-over-${row.category}`,
          severity: 'positive',
          type: 'goal-over',
          title,
          summary: `${formatCurrencyFromCents(differenceCents)} över målet${input.isCurrentMonth ? ' hittills' : ''}`,
          amountCents: differenceCents,
          percent: differencePercent,
          source,
          priorityScore: healthPriority('positive', differenceCents, differencePercent),
        });
      } else if (
        differenceCents <= -20_000 ||
        (differenceCents <= -10_000 && differencePercent <= -10)
      ) {
        candidates.push({
          id: `goal-under-${row.category}`,
          severity: 'attention',
          type: 'goal-under',
          title,
          summary: `${formatCurrencyFromCents(Math.abs(differenceCents))} under målet${input.isCurrentMonth ? ' hittills' : ''}`,
          amountCents: Math.abs(differenceCents),
          percent: Math.abs(differencePercent),
          source,
          priorityScore: healthPriority('attention', differenceCents, differencePercent),
        });
      }
    }
  };
  addGoalInsights(input.savingBudgetRows, 'Sparmål', 'savings');
  addGoalInsights(input.amortizationBudgetRows, 'Amorteringsmål', 'savings');

  const trendMerchantKeys = new Set<string>();
  for (const trend of input.costTrends.increasing) {
    trendMerchantKeys.add(trend.merchantKey);
    const severity: FinancialHealthSeverity =
      trend.confidence === 'high' && trend.annualizedImpactCents >= 100_000
        ? 'important'
        : 'attention';
    candidates.push({
      id: `trend-${trend.merchantKey}`,
      severity,
      type: 'long-term-cost-increase',
      title: trend.merchantLabel,
      summary: `Typisk kostnadsnivå ${trend.deltaPercent?.toLocaleString('sv-SE', { maximumFractionDigits: 1 }) ?? '—'} % högre`,
      supportingDetail: `Cirka ${formatCurrencyFromCents(trend.annualizedImpactCents)} mer per år`,
      amountCents: trend.annualizedImpactCents,
      percent: trend.deltaPercent,
      source: 'cost-trend',
      priorityScore: healthPriority(
        severity,
        trend.annualizedImpactCents,
        trend.deltaPercent,
        trend.confidence === 'high'
      ),
    });
  }
  for (const recurring of input.recurringInsights.insights) {
    if (
      trendMerchantKeys.has(recurring.merchantKey) ||
      !recurring.hasRelevantPriceChange ||
      recurring.deltaFromMedianCents <= 0
    ) {
      continue;
    }
    candidates.push({
      id: `recurring-${recurring.merchantKey}`,
      severity: recurring.confidence === 'low' ? 'info' : 'attention',
      type: 'latest-price-increase',
      title: recurring.merchantLabel,
      summary: `Senaste betalningen är ${formatCurrencyFromCents(recurring.deltaFromMedianCents)} högre än tidigare normalnivå`,
      amountCents: recurring.deltaFromMedianCents,
      percent: recurring.deltaPercent,
      source: 'recurring',
      priorityScore: healthPriority(
        recurring.confidence === 'low' ? 'info' : 'attention',
        recurring.deltaFromMedianCents,
        recurring.deltaPercent,
        recurring.confidence === 'high'
      ),
    });
  }

  if (input.financialSummary.unclassifiedCount > 0) {
    const count = input.financialSummary.unclassifiedCount;
    const severity: FinancialHealthSeverity =
      count >= 10 ? 'important' : count >= 3 ? 'attention' : 'info';
    candidates.push({
      id: 'unclassified',
      severity,
      type: 'unclassified',
      title: `${count} transaktion${count === 1 ? '' : 'er'} behöver klassificeras`,
      summary: 'Analysen blir mer komplett när ekonomisk typ har valts.',
      source: 'classification',
      priorityScore: healthPriority(severity) + Math.min(10, count),
    });
  }

  const sorted = [...candidates].sort((left, right) =>
    right.priorityScore - left.priorityScore || left.id.localeCompare(right.id, 'sv-SE')
  );
  const priorityInsights = sorted
    .filter((insight) => insight.severity === 'important' || insight.severity === 'attention')
    .slice(0, 4);
  const supportingInsights = sorted
    .filter((insight) => insight.severity === 'positive' || insight.severity === 'info')
    .slice(0, 2);
  const insights = [...priorityInsights, ...supportingInsights];
  const importantCount = candidates.filter((insight) => insight.severity === 'important').length;
  const attentionCount = candidates.filter((insight) => insight.severity === 'attention').length;
  const positiveCount = candidates.filter((insight) => insight.severity === 'positive').length;
  const status = importantCount > 0
    ? 'needs-review'
    : attentionCount > 0
      ? 'attention'
      : 'good';

  return {
    status,
    headline: status === 'needs-review'
      ? 'Flera tydliga förändringar behöver uppmärksamhet'
      : status === 'attention'
        ? 'Några saker att se över'
        : 'Ekonomin ser stabil ut',
    supportingText: status === 'good'
      ? 'Inga större avvikelser hittades i den här perioden.'
      : 'Prioriterat från budget, förändringar och återkommande kostnader.',
    insights,
    importantCount,
    attentionCount,
    positiveCount,
    hiddenCount: Math.max(0, candidates.length - insights.length),
  };
}

export function isRelevantMonthlyChange(change: MonthlyChangeInsight): boolean {
  const absoluteDelta = Math.abs(change.deltaCents);
  return absoluteDelta >= 20_000 ||
    (absoluteDelta >= 10_000 && change.deltaPercent != null && Math.abs(change.deltaPercent) >= 20);
}

export function buildMonthlyInsights(
  transactions: MonthlyInsightTransaction[],
  year: number,
  month: number,
  today: Date = new Date()
): MonthlyInsights {
  const emptyResult = (
    status: MonthlyInsights['status'],
    currentTotalCents = 0,
    topMerchants: MerchantInsight[] = []
  ): MonthlyInsights => ({
    status,
    baselineKind: null,
    baselineLabel: null,
    baselineMonthCount: 0,
    currentTotalCents,
    baselineTotalCents: 0,
    totalDeltaCents: 0,
    categoryChanges: [],
    biggestIncreases: [],
    biggestDecreases: [],
    unusualTransactions: [],
    topMerchants,
  });

  const targetKey = monthKey(year, month);
  const currentKey = monthKey(today.getFullYear(), today.getMonth() + 1);
  const currentTransactions = transactions.filter((transaction) =>
    transactionMonthKey(transaction.date) === targetKey
  );
  const currentTotalCents = currentTransactions.reduce(
    (sum, transaction) => sum + consumptionAmount(transaction),
    0
  );
  const merchantTotals = new Map<string, MerchantInsight>();
  for (const transaction of currentTransactions) {
    const amount = consumptionAmount(transaction);
    if (amount === 0) continue;
    const merchant = normalizeMerchant(transaction.merchant).normalized;
    const key = normalizedMerchantKey(transaction.merchant);
    if (!key || key === 'OKÄND MERCHANT') continue;
    const existing = merchantTotals.get(key);
    merchantTotals.set(key, {
      merchant,
      spendCents: (existing?.spendCents ?? 0) + amount,
      transactionCount: (existing?.transactionCount ?? 0) + 1,
    });
  }
  const topMerchants = [...merchantTotals.values()]
    .filter((merchant) => merchant.spendCents > 0)
    .sort((left, right) =>
      right.spendCents - left.spendCents || left.merchant.localeCompare(right.merchant, 'sv-SE')
    )
    .slice(0, 5);

  if (targetKey >= currentKey) {
    return emptyResult('incomplete-month', currentTotalCents, topMerchants);
  }

  const historicalByMonth = new Map<string, MonthlyInsightTransaction[]>();
  for (const transaction of transactions) {
    const key = transactionMonthKey(transaction.date);
    if (
      key == null ||
      key >= targetKey ||
      key >= currentKey ||
      (transaction.transactionType !== 'expense' && transaction.transactionType !== 'refund')
    ) {
      continue;
    }
    historicalByMonth.set(key, [...(historicalByMonth.get(key) ?? []), transaction]);
  }
  const historicalMonths = [...historicalByMonth.keys()].sort();
  let baselineMonths: string[] = [];
  let baselineKind: MonthlyInsights['baselineKind'] = null;
  if (historicalMonths.length >= 2) {
    baselineMonths = historicalMonths;
    baselineKind = 'historical-average';
  } else if (
    historicalMonths.length === 1 &&
    historicalMonths[0] === previousMonthKey(year, month)
  ) {
    baselineMonths = historicalMonths;
    baselineKind = 'previous-month';
  }
  if (baselineKind == null) {
    return emptyResult('insufficient-history', currentTotalCents, topMerchants);
  }

  const baselineTransactions = baselineMonths.flatMap((key) => historicalByMonth.get(key) ?? []);
  const baselineTotalCents = Math.round(
    baselineTransactions.reduce((sum, transaction) => sum + consumptionAmount(transaction), 0) /
    baselineMonths.length
  );
  const categories = new Set<string>();
  currentTransactions.forEach((transaction) => {
    if (consumptionAmount(transaction) !== 0) categories.add(transaction.category);
  });
  baselineTransactions.forEach((transaction) => categories.add(transaction.category));
  const categoryChanges = [...categories].map((category) => {
    const currentCents = currentTransactions
      .filter((transaction) => transaction.category === category)
      .reduce((sum, transaction) => sum + consumptionAmount(transaction), 0);
    const baselineCents = Math.round(
      baselineTransactions
        .filter((transaction) => transaction.category === category)
        .reduce((sum, transaction) => sum + consumptionAmount(transaction), 0) /
      baselineMonths.length
    );
    const deltaCents = currentCents - baselineCents;
    return {
      category,
      currentCents,
      baselineCents,
      deltaCents,
      deltaPercent: baselineCents > 0 ? deltaCents / baselineCents * 100 : null,
    };
  }).sort((left, right) => left.category.localeCompare(right.category, 'sv-SE'));
  const relevantChanges = categoryChanges.filter(isRelevantMonthlyChange);
  const biggestIncreases = relevantChanges
    .filter((change) => change.deltaCents > 0)
    .sort((left, right) =>
      right.deltaCents - left.deltaCents || left.category.localeCompare(right.category, 'sv-SE')
    )
    .slice(0, 5);
  const biggestDecreases = relevantChanges
    .filter((change) => change.deltaCents < 0)
    .sort((left, right) =>
      left.deltaCents - right.deltaCents || left.category.localeCompare(right.category, 'sv-SE')
    )
    .slice(0, 5);

  const historicalExpenses = baselineTransactions.filter((transaction) =>
    transaction.transactionType === 'expense' && transaction.amountCents < 0
  );
  let unusualTransactions: MonthlyInsightTransaction[] = [];
  if (historicalExpenses.length >= 5) {
    const normalExpenseCents = median(historicalExpenses.map((transaction) =>
      Math.abs(transaction.amountCents)
    ));
    const thresholdCents = Math.max(3 * normalExpenseCents, 100_000);
    unusualTransactions = currentTransactions
      .filter((transaction) =>
        transaction.transactionType === 'expense' &&
        transaction.amountCents < 0 &&
        Math.abs(transaction.amountCents) >= thresholdCents
      )
      .filter((transaction) => {
        const key = normalizedMerchantKey(transaction.merchant);
        const previousMerchantAmounts = historicalExpenses
          .filter((historical) => normalizedMerchantKey(historical.merchant) === key)
          .map((historical) => Math.abs(historical.amountCents));
        return previousMerchantAmounts.length < 2 ||
          Math.abs(transaction.amountCents) > 1.5 * median(previousMerchantAmounts);
      })
      .sort((left, right) =>
        Math.abs(right.amountCents) - Math.abs(left.amountCents) ||
        left.merchant.localeCompare(right.merchant, 'sv-SE')
      )
      .slice(0, 5);
  }

  const baselineLabel = baselineKind === 'historical-average'
    ? `Jämfört med snittet för ${baselineMonths.length} avslutade månader`
    : `Jämfört med ${insightMonthNames[month === 1 ? 11 : month - 2]} ${month === 1 ? year - 1 : year}`;

  return {
    status: 'available',
    baselineKind,
    baselineLabel,
    baselineMonthCount: baselineMonths.length,
    currentTotalCents,
    baselineTotalCents,
    totalDeltaCents: currentTotalCents - baselineTotalCents,
    categoryChanges,
    biggestIncreases,
    biggestDecreases,
    unusualTransactions,
    topMerchants,
  };
}

export function findLearnedTransactionType(
  merchant: string,
  rules: Array<{ merchantKey: string; transactionType: TransactionType }>
): TransactionType | undefined {
  const target = normalizedMerchantKey(merchant);
  if (!target || target === 'OKÄND MERCHANT') return undefined;
  return rules.find((rule) => normalizedMerchantKey(rule.merchantKey) === target)?.transactionType;
}

export function findExactMerchantTransactionIds(
  transactions: Array<{ id: string | number; merchant: string }>,
  merchant: string
): string[] {
  const target = normalizedMerchantKey(merchant);
  if (!target || target === 'OKÄND MERCHANT') return [];
  return transactions
    .filter((transaction) => normalizedMerchantKey(transaction.merchant) === target)
    .map((transaction) => String(transaction.id));
}

function comparisonTokens(raw: string): string[] {
  return normalizeMerchant(raw).normalized
    .toLocaleLowerCase('sv-SE')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
}

function merchantTokensAreSimilar(leftTokens: string[], rightTokens: string[]): boolean {
  if (!leftTokens.length || !rightTokens.length) return false;
  const isIkeaBarkarby = (tokens: string[]) => tokens[0] === 'ikea' && tokens[1] === 'barkarby';
  const leftIsIkeaBarkarby = isIkeaBarkarby(leftTokens);
  const rightIsIkeaBarkarby = isIkeaBarkarby(rightTokens);
  if (leftIsIkeaBarkarby || rightIsIkeaBarkarby) {
    if (!leftIsIkeaBarkarby || !rightIsIkeaBarkarby) return false;
    const leftType = ['if', 'hf'].includes(leftTokens[2]) ? leftTokens[2] : null;
    const rightType = ['if', 'hf'].includes(rightTokens[2]) ? rightTokens[2] : null;
    if (leftType !== rightType) return false;
  }
  const isPrefix = (prefix: string[], value: string[]) =>
    prefix.length <= value.length && prefix.every((token, index) => token === value[index]);
  if (isPrefix(leftTokens, rightTokens) || isPrefix(rightTokens, leftTokens)) return true;

  const leftRoot = leftTokens[0];
  const rightRoot = rightTokens[0];
  if (leftRoot === rightRoot && leftRoot.length >= 3 && !genericMerchantRoots.has(leftRoot)) return true;
  if (leftRoot.length >= 5 && rightRoot.length >= 5 &&
      !genericMerchantRoots.has(leftRoot) && !genericMerchantRoots.has(rightRoot) &&
      editDistance(leftRoot, rightRoot) <= 1) return true;

  const leftCompact = leftTokens.join('');
  const rightCompact = rightTokens.join('');
  const longest = Math.max(leftCompact.length, rightCompact.length);
  return longest >= 8 && 1 - editDistance(leftCompact, rightCompact) / longest >= 0.88;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function findSameMerchantTransactionIds(
  transactions: Array<{ id: string | number; merchant: string }>,
  merchant: string
): string[] {
  const target = normalizeMerchant(merchant).normalized.toLocaleLowerCase('sv-SE');
  if (!target || target === 'okänd merchant') return [];
  const targetTokens = comparisonTokens(target);
  return transactions
    .filter((transaction) =>
      merchantTokensAreSimilar(comparisonTokens(transaction.merchant), targetTokens)
    )
    .map((transaction) => String(transaction.id));
}

export function sortCategoriesByUsage(
  categories: string[],
  transactions: Array<{ category: string }>
): string[] {
  const usageCounts = new Map<string, number>();
  const categoryOrder = new Map(categories.map((category, index) => [category, index]));
  for (const transaction of transactions) {
    usageCounts.set(transaction.category, (usageCounts.get(transaction.category) ?? 0) + 1);
  }

  return [...categories].sort((left, right) =>
    (usageCounts.get(right) ?? 0) - (usageCounts.get(left) ?? 0) ||
    (categoryOrder.get(left) ?? 0) - (categoryOrder.get(right) ?? 0)
  );
}

export function transactionsForCategory<T extends { category: string }>(
  transactions: T[],
  category: string
): T[] {
  return transactions.filter((transaction) => transaction.category === category);
}

export function transactionsForCategoryFlow<T extends FinancialTransaction>(
  transactions: T[],
  category: string,
  flow: 'expense' | 'income'
): T[] {
  const types: TransactionType[] = flow === 'expense'
    ? ['expense', 'refund']
    : ['income', 'saving', 'amortization'];
  return transactions.filter((transaction) =>
    transaction.category === category && types.includes(transaction.transactionType)
  );
}

export function amountForCategoryFlow(
  transaction: Pick<FinancialTransaction, 'amountCents' | 'transactionType'>,
  _category: string,
  _flow: 'expense' | 'income'
): number {
  return transaction.transactionType === 'income'
    ? transaction.amountCents
    : -transaction.amountCents;
}

export function sumCategoryFlow(
  transactions: Array<Pick<FinancialTransaction, 'amountCents' | 'transactionType'>>,
  category: string,
  flow: 'expense' | 'income'
): number {
  return transactions.reduce((total, transaction) => total + amountForCategoryFlow(transaction, category, flow), 0);
}

export function categoriesWithExpenses(transactions: FinancialTransaction[]): string[] {
  return [...new Set(transactions
    .filter((transaction) =>
      transaction.amountCents !== 0 &&
      (transaction.transactionType === 'expense' || transaction.transactionType === 'refund')
    )
    .map((transaction) => transaction.category))];
}

export function netTransactionAmount(transactions: Array<{ amountCents: number }>): number {
  return transactions.reduce((total, transaction) => total + transaction.amountCents, 0);
}

export function needsCategoryDecision(
  transaction: {
    needsReview: boolean;
    categoryDecided: boolean;
    transactionType?: TransactionType;
  },
  isPossibleDuplicate: boolean
): boolean {
  return transaction.needsReview ||
    transaction.transactionType === 'unclassified' ||
    (isPossibleDuplicate && !transaction.categoryDecided);
}

export function isExcludedFromOverview(category: string): boolean {
  return category === 'Överföring mellan konto';
}

export function isIncludedInOverview(
  transaction: Pick<FinancialTransaction, 'amountCents' | 'transactionType'>
): boolean {
  return transaction.amountCents !== 0 && transaction.transactionType !== 'transfer';
}

export function parseExcelDate(value: number | string): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? trimmed
      : null;
    if (iso) return new Date(`${iso}T00:00:00`);

    const variants = [
      /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/,
      /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/,
    ];
    if (variants.some((pattern) => pattern.test(trimmed))) {
      const normalized = trimmed.replace('.', '-').replace('/', '-');
      const date = new Date(normalized);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  return null;
}

export function hasBankTransactionHeaders(values: unknown[]): boolean {
  const normalizeHeader = (value: unknown) =>
    String(value ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  const headers = values.map(normalizeHeader);
  const hasDate = headers.some((header) =>
    ['datum', 'date', 'bokforingsdatum', 'bokforingsdag', 'transaktionsdatum', 'transactiondate']
      .some((term) => header.includes(term))
  );
  const hasAmount = headers.some((header) =>
    ['belopp', 'amount', 'debet', 'debit', 'kredit', 'credit', 'summa']
      .some((term) => header.includes(term))
  );
  return hasDate && hasAmount;
}

export function toDuplicateKey(input: { date: string; merchant: string; amountCents: number }): string {
  return `${input.date}|${input.merchant}|${input.amountCents}`;
}

export function findPotentialDuplicateIds(
  transactions: Array<{ id: string | number; date: string; merchant: string; amountCents: number }>
): Set<string> {
  const firstIds = new Map<string, string>();
  const duplicateIds = new Set<string>();
  for (const transaction of transactions) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction.date)) continue;
    const swishTransfer = parseSwishTransfer(transaction.merchant);
    const normalized = normalizeMerchant(transaction.merchant).normalized;
    if (!swishTransfer && /^Swish (skickat|mottaget)$/i.test(normalized)) continue;
    const merchant = swishTransfer
      ? `SWISH ${swishTransfer.direction.toLocaleUpperCase('sv-SE')} ${swishTransfer.phone}`
      : normalized.toLocaleUpperCase('sv-SE');
    const key = toDuplicateKey({ ...transaction, merchant });
    const id = String(transaction.id);
    const firstId = firstIds.get(key);
    if (firstId === undefined) {
      firstIds.set(key, id);
    } else {
      duplicateIds.add(firstId);
      duplicateIds.add(id);
    }
  }

  return duplicateIds;
}

export function createTransactionClassifier(rules: Rule[]) {
  const activeRules = rules
    .filter((rule) => rule.enabled !== false)
    .sort((a, b) => b.priority - a.priority)
    .map((rule) => ({
      rule,
      normalizedMatch: rule.match.toUpperCase(),
      exactMerchantKey: rule.matchMode === 'merchant-exact'
        ? normalizedMerchantKey(rule.match)
        : null,
      comparisonTokens: rule.matchMode === 'merchant-prefix' || rule.matchMode === 'merchant-similar'
        ? comparisonTokens(rule.match)
        : null,
    }));

  return (tx: TransactionInput, manualOverride?: { category: string }): ClassificationDecision => {
    const merchant = normalizeMerchant(tx.merchant).normalized.toUpperCase();
    let merchantTokens: string[] | null = null;
    const match = activeRules.find(({ normalizedMatch, exactMerchantKey, comparisonTokens: ruleTokens }) => {
      if (exactMerchantKey) return normalizedMerchantKey(tx.merchant) === exactMerchantKey;
      if (ruleTokens) {
        merchantTokens ??= comparisonTokens(merchant);
        return merchantTokensAreSimilar(merchantTokens, ruleTokens);
      }
      return merchant.includes(normalizedMatch);
    });
    const explicit = match?.rule;

    if (explicit) {
      return {
        category: explicit.category,
        source: 'explicit-user-rule',
        confidence: 0.99,
        ruleId: explicit.id,
        explanation: `Regeln "${explicit.match}" matchade transaktionen.`,
        needsReview: false,
      };
    }

    if (manualOverride?.category) {
      return {
        category: manualOverride.category,
        source: 'manual',
        confidence: 1,
        explanation: 'Användaren överstyrde kategorin manuellt.',
        needsReview: false,
      };
    }

    return {
      category: 'Okategoriserat',
      source: 'manual',
      confidence: 0.1,
      explanation: 'Ingen säker regel matchade transaktionen, så den kräver granskning.',
      needsReview: true,
    };
  };
}

export function classifyTransaction(
  tx: TransactionInput,
  rules: Rule[],
  manualOverride?: { category: string }
): ClassificationDecision {
  return createTransactionClassifier(rules)(tx, manualOverride);
}

export function buildImportSummary(input: {
  totalFound: number;
  newTransactions: number;
  alreadyImported: number;
  autoCategorized: number;
  viaRules: number;
  needsReview: number;
  duplicateImports: number;
}) {
  return {
    totalFound: input.totalFound,
    newTransactions: input.newTransactions,
    alreadyImported: input.alreadyImported,
    autoCategorized: input.autoCategorized,
    viaRules: input.viaRules,
    reviewCount: input.needsReview,
    duplicateImports: input.duplicateImports,
  };
}
