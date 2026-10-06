export type Currency = 'SEK';

export type Rule = {
  id: string;
  match: string;
  category: string;
  priority: number;
  scope?: 'merchant' | 'merchantGroup' | 'exact' | 'custom';
  matchMode?: 'contains' | 'merchant-prefix' | 'merchant-similar';
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
  amount: number;
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

export function transactionsForCategoryFlow<T extends { category: string; amount: number }>(
  transactions: T[],
  category: string,
  flow: 'expense' | 'income'
): T[] {
  return transactions.filter((transaction) =>
    transaction.category === category && (
      category === 'Sparande'
        ? flow === 'income'
        : flow === 'income' ? transaction.amount > 0 : transaction.amount < 0
    )
  );
}

export function amountForCategoryFlow(
  transaction: { amount: number },
  category: string,
  flow: 'expense' | 'income'
): number {
  return category === 'Sparande' && flow === 'income'
    ? -transaction.amount
    : transaction.amount;
}

export function sumCategoryFlow(
  transactions: Array<{ amount: number }>,
  category: string,
  flow: 'expense' | 'income'
): number {
  return transactions.reduce((total, transaction) => total + amountForCategoryFlow(transaction, category, flow), 0);
}

export function categoriesWithExpenses(transactions: Array<{ category: string; amount: number }>): string[] {
  return [...new Set(transactions
    .filter((transaction) => transaction.amount < 0 && transaction.category !== 'Sparande')
    .map((transaction) => transaction.category))];
}

export function netTransactionAmount(transactions: Array<{ amount: number }>): number {
  return transactions.reduce((total, transaction) => total + transaction.amount, 0);
}

export function needsCategoryDecision(
  transaction: { needsReview: boolean; categoryDecided: boolean },
  isPossibleDuplicate: boolean
): boolean {
  return transaction.needsReview || (isPossibleDuplicate && !transaction.categoryDecided);
}

export function isExcludedFromOverview(category: string): boolean {
  return category === 'Överföring mellan konto';
}

export function isIncludedInOverview(transaction: { amount: number; category: string }): boolean {
  return transaction.amount !== 0 && !isExcludedFromOverview(transaction.category);
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

export function parseDecimal(value: string | number): number {
  if (typeof value === 'number') return Number(value);

  const sanitized = String(value).trim();
  if (!sanitized) return 0;

  const cleaned = sanitized.replace(/\s+/g, '');

  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      return Number(cleaned.replace(/\./g, '').replace(',', '.'));
    }
    return Number(cleaned.replace(/,/g, ''));
  }

  if (cleaned.includes(',')) {
    const commaParts = cleaned.split(',');
    if (commaParts.length > 1 && commaParts[commaParts.length - 1].length <= 2) {
      return Number(cleaned.replace(',', '.'));
    }
    return Number(cleaned.replace(/,/g, ''));
  }

  if (cleaned.includes('.')) {
    const dotParts = cleaned.split('.');
    if (dotParts.length > 1 && dotParts[dotParts.length - 1].length <= 2) {
      return Number(cleaned);
    }
    return Number(cleaned.replace(/\./g, ''));
  }

  return Number(cleaned);
}

export function toDuplicateKey(input: { date: string; merchant: string; amount: number }): string {
  const normalizedAmount = Number(input.amount).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  return `${input.date}|${input.merchant}|${normalizedAmount}`;
}

export function findPotentialDuplicateIds(
  transactions: Array<{ id: string | number; date: string; merchant: string; amount: number }>
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
      comparisonTokens: rule.matchMode === 'merchant-prefix' || rule.matchMode === 'merchant-similar'
        ? comparisonTokens(rule.match)
        : null,
    }));

  return (tx: TransactionInput, manualOverride?: { category: string }): ClassificationDecision => {
    const merchant = normalizeMerchant(tx.merchant).normalized.toUpperCase();
    let merchantTokens: string[] | null = null;
    const match = activeRules.find(({ normalizedMatch, comparisonTokens: ruleTokens }) => {
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
