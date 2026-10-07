import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { amountForCategoryFlow, availableConsumptionBudgetCategories, buildBudgetAnalysis, buildFinancialHealthSummary, buildMonthlyInsights, buildRecurringCostTrendInsights, buildRecurringExpenseInsights, calculateFinancialSummary, createTransactionClassifier, expectedTransactionTypeForCategory, filterTransactionsByDirection, findExactMerchantTransactionIds, findExactMerchantTransactionIdsForType, findLearnedTransactionType, findPotentialDuplicateIds, formatCurrencyFromCents, getPeriodStatus, ikeaBarkarbyRules, internalTransferRule, isCategoryTransactionTypeConsistent, isIncludedInOverview, needsCategoryDecision, normalizedMerchantKey, sortCategoriesByUsage, sumCategoryFlow, transactionTypeRuleKey, transactionsForCategoryFlow, transactionTypes, type BudgetRow, type RecurringExpenseInsight, type TransactionDirectionFilter, type TransactionType } from './lib/finance';
import { parseMoneyToCents, parseWorkbookSheets, sha256Hex, unwrapExcelCellValue, type ImportIssue, type ImportResult, type ImportedBankTransaction } from './lib/bankImport';
import { buildBulkConfirmation, buildRememberForwardConfirmation, createLatestRunGuard, getUserFacingError, importAnalysisPhaseText, importControlsDisabled, runConfirmedAction, runDatabaseInitialization, runSequentialFileImports, type ErrorContext, type FileImportOutcome } from './lib/releaseSafety';
import { deepAnalysisInitiallyOpen, firstRunCopy, getDashboardMode, getDashboardSections, shiftMonth } from './lib/dashboardPresentation';

type Tab = 'overview' | 'import' | 'review';
type ReviewFilter = 'all' | 'pending' | 'checked';
type ReviewControlFilter =
  | 'all'
  | 'duplicate'
  | 'category-approved'
  | 'unclassified'
  | 'conflict'
  | 'uncertain'
  | 'checked';

const REVIEW_PAGE_SIZE = 100;

type Transaction = ImportedBankTransaction;

type Budget = { category: string; amountCents: number };
type LearnedMerchantRule = { merchantKey: string; category: string };
type LearnedTransactionTypeRule = { merchantKey: string; transactionType: TransactionType };
type ImportBatchSummary = {
  id: number;
  fileName: string;
  importedAt: string;
  transactionCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  needsReviewCount: number;
  positiveTotalCents: number;
  negativeTotalCents: number;
};
type ImportBatchDetail = {
  summary: ImportBatchSummary;
  transactions: Transaction[];
};
type PendingImport = {
  fileName: string;
  fileSha256: string;
  result: ImportResult;
};
type ExistingImportMatch = {
  selectedFileName: string;
  batch: ImportBatchSummary;
};
type CategoryPickerProps = {
  value: string;
  categories: string[];
  label: string;
  onChange: (category: string) => void;
};

function CategoryPicker({ value, categories, label, onChange }: CategoryPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 240, maxHeight: 420 });

  useEffect(() => {
    if (!open) return;

    const placeMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const maxHeight = Math.min(420, window.innerHeight - 16);
      const width = Math.min(Math.max(bounds.width, 240), window.innerWidth - 16);
      const top = bounds.bottom + maxHeight <= window.innerHeight - 8
        ? bounds.bottom + 4
        : Math.max(8, bounds.top - maxHeight - 4);
      const left = Math.min(Math.max(8, bounds.left), window.innerWidth - width - 8);
      setPosition({ left, top, width, maxHeight });
    };

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node &&
          !triggerRef.current?.contains(target) &&
          !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    placeMenu();
  menuRef.current?.scrollTo({ top: 0 });
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const options = categories.includes(value) ? categories : [...categories, value];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="category-picker-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span>{value}</span><span aria-hidden="true">⌄</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="category-picker-menu"
          role="listbox"
          aria-label={label}
          style={position}
        >
          {options.map((category) => (
            <button
              key={category}
              type="button"
              role="option"
              aria-selected={category === value}
              className={`category-picker-option ${category === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(category);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              {category}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

const categoryNames = [
  'Mat / Dagligvaror', 'Restaurang / Café', 'Takeaway',
  'Boende / Hyra', 'Boende / El', 'Boende / Vatten & avfall', 'Boende / Försäkring', 'Boende / Underhåll',
  'Boende / Ränta', 'Boende / Projekt',
  'Bil / Bränsle', 'Bil / Parkering', 'Bil / Service', 'Bil / Försäkring', 'Bil / Skatt', 'Bil / Avgifter', 'Kollektivtrafik',
  'Kläder & skor', 'Hälsa / Vård', 'Hälsa / Apotek', 'Abonnemang', 'Prenumerationer', 'Nöje', 'Resor', 'Barn', 'Skatt / moms',
  'Hushåll', 'Elektronik', 'Utbildning', 'Bankavgifter', 'Gåvor', 'Personförsäkring', 'Sparande', 'Sparande / Amortering',
  'Boende / Wi-Fi', 'Lön', 'Bidrag', 'Uthyrning', 'Överföring mellan konto',
  'Övrigt', 'Okategoriserat',
];
const monthNames = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni', 'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'];
const transactionTypeLabels: Record<TransactionType, string> = {
  income: 'Inkomst',
  expense: 'Utgift',
  saving: 'Sparande',
  amortization: 'Amortering',
  transfer: 'Intern överföring',
  refund: 'Återbetalning',
  unclassified: 'Oklassificerad',
};
const rules = [
  { id: 'ica', match: 'ICA MAXI', category: 'Mat / Dagligvaror', priority: 100 },
  { id: 'willys', match: 'WILLYS', category: 'Mat / Dagligvaror', priority: 95 },
  { id: 'netflix', match: 'NETFLIX', category: 'Abonnemang', priority: 90 },
  { id: 'spotify', match: 'SPOTIFY', category: 'Abonnemang', priority: 88 },
  { id: 'lön', match: 'LÖN', category: 'Lön', priority: 120 },
  { id: 'salary', match: 'SALARY', category: 'Lön', priority: 115 },
  { id: 'ellevio', match: 'ELLEVIO', category: 'Boende / El', priority: 80 },
  { id: 'vattenfall', match: 'VATTENFALL', category: 'Boende / El', priority: 80 },
  { id: 'landshypotek', match: 'LANDSHYPOTEK', category: 'Boende / Ränta', priority: 130 },
  { id: 'fuel', match: 'CIRCLE K', category: 'Bil / Bränsle', priority: 80 },
  { id: 'okq8', match: 'OKQ8', category: 'Bil / Bränsle', priority: 80 },
  { id: 'preem', match: 'PREEM', category: 'Bil / Bränsle', priority: 80 },
  { id: 'parking', match: 'PARKERING', category: 'Bil / Parkering', priority: 75 },
  { id: 'amortization', match: 'AMORTERING', category: 'Sparande / Amortering', priority: 125 },
  internalTransferRule,
  ...ikeaBarkarbyRules,
];

const formatMoney = formatCurrencyFromCents;
const formatSignedMoney = (amountCents: number): string =>
  `${amountCents > 0 ? '+' : amountCents < 0 ? '−' : ''}${formatMoney(Math.abs(amountCents))}`;
const recurringFrequencyLabel = (insight: RecurringExpenseInsight): string => {
  if (insight.frequency === 'irregular') return 'Regelbundet köp';
  const label = insight.frequency === 'monthly'
    ? 'Månadsvis'
    : insight.frequency === 'quarterly'
      ? 'Kvartalsvis'
      : 'Årsvis';
  return insight.confidence === 'low' ? `Möjligen ${label.toLocaleLowerCase('sv-SE')}` : label;
};
const formatInsightDate = (date: string): string =>
  new Date(`${date}T12:00:00`).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' });

const centsToInputValue = (amountCents: number): string => {
  const sign = amountCents < 0 ? '-' : '';
  const absolute = Math.abs(amountCents);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
};

const formatImportValue = (value: unknown): string => {
  if (value instanceof Date) return value.toString();
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
};

const parseWorkbookRows = async (
  file: File,
  bytes: ArrayBuffer,
  classify: ReturnType<typeof createTransactionClassifier>
): Promise<ImportResult> => {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheets = workbook.worksheets.map((worksheet) => {
    const rows: Array<{ rowNumber: number; values: unknown[] }> = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      rows.push({
        rowNumber: row.number,
        values: (row.values as unknown[]).slice(1).map(unwrapExcelCellValue),
      });
    });
    return { name: worksheet.name, rows };
  });

  return parseWorkbookSheets(sheets, file.name, file.lastModified, classify);
};

const validDate = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date);

export default function App() {
  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('pending');
  const [reviewDirectionFilter, setReviewDirectionFilter] = useState<TransactionDirectionFilter>('all');
  const [reviewDateFilter, setReviewDateFilter] = useState('');
  const [reviewMerchantFilter, setReviewMerchantFilter] = useState('');
  const [reviewMinAmount, setReviewMinAmount] = useState('');
  const [reviewMaxAmount, setReviewMaxAmount] = useState('');
  const [reviewCategoryFilter, setReviewCategoryFilter] = useState('all');
  const [reviewTypeFilter, setReviewTypeFilter] = useState<'all' | TransactionType>('all');
  const [reviewControlFilter, setReviewControlFilter] = useState<ReviewControlFilter>('all');
  const [reviewPage, setReviewPage] = useState(1);
  const [showAllExpenseCategories, setShowAllExpenseCategories] = useState(false);
  const [showAllIncomeCategories, setShowAllIncomeCategories] = useState(false);
  const [dbStatus, setDbStatus] = useState('Ansluter till lokal databas');
  const [dbReady, setDbReady] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [learnedRules, setLearnedRules] = useState<LearnedMerchantRule[]>([]);
  const [learnedTransactionTypeRules, setLearnedTransactionTypeRules] = useState<LearnedTransactionTypeRule[]>([]);
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({});
  const [transactionTypeDrafts, setTransactionTypeDrafts] = useState<Record<string, TransactionType>>({});
  const [previewRows, setPreviewRows] = useState<Transaction[]>([]);
  const [previewFiles, setPreviewFiles] = useState<string[]>([]);
  const [importWarnings, setImportWarnings] = useState<ImportIssue[]>([]);
  const [importBlockingErrors, setImportBlockingErrors] = useState<ImportIssue[]>([]);
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([]);
  const [existingImportMatches, setExistingImportMatches] = useState<ExistingImportMatch[]>([]);
  const [importBatches, setImportBatches] = useState<ImportBatchSummary[]>([]);
  const [selectedImportBatch, setSelectedImportBatch] = useState<ImportBatchDetail | null>(null);
  const [selectedYear, setSelectedYear] = useState(String(currentYear));
  const [comparisonYear, setComparisonYear] = useState(String(currentYear - 1));
  const [selectedMonth, setSelectedMonth] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedCategoryFlow, setSelectedCategoryFlow] = useState<'expense' | 'income'>('expense');
  const [budgets, setBudgets] = useState<Record<string, number>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [pendingBudgetCategories, setPendingBudgetCategories] = useState<string[]>([]);
  const [budgetCategoryPickerOpen, setBudgetCategoryPickerOpen] = useState(false);
  const [budgetedMonthCount, setBudgetedMonthCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [errorTechnicalDetails, setErrorTechnicalDetails] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isAnalyzingImport, setIsAnalyzingImport] = useState(false);
  const [importAnalysisStatus, setImportAnalysisStatus] = useState('');
  const [importOutcomes, setImportOutcomes] = useState<FileImportOutcome[]>([]);
  const [fatalDatabaseError, setFatalDatabaseError] = useState<ReturnType<typeof getUserFacingError> | null>(null);
  const [deepAnalysisOpen, setDeepAnalysisOpen] = useState(deepAnalysisInitiallyOpen);
  const importAnalysisGuard = useRef(createLatestRunGuard());

  const classifyImportedTransaction = useMemo(() => {
    const classifyCategory = createTransactionClassifier([
      ...learnedRules.map((rule, index) => ({
        id: `learned-${index}`,
        match: rule.merchantKey,
        category: rule.category,
        priority: 10000 - index,
        matchMode: 'merchant-exact' as const,
      })),
      ...rules,
    ]);
    return (transaction: { merchant: string; amountCents: number }) => ({
      ...classifyCategory(transaction),
      transactionType: findLearnedTransactionType(
        transaction.merchant,
        transaction.amountCents,
        learnedTransactionTypeRules
      ),
    });
  }, [learnedRules, learnedTransactionTypeRules]);

  const refreshTransactions = async () => {
    const stored = await invoke<Transaction[]>('get_transactions');
    setTransactions(stored);
    return stored;
  };

  const refreshImportBatches = async () => {
    const batches = await invoke<ImportBatchSummary[]>('list_import_batches');
    setImportBatches(batches);
    return batches;
  };

  const clearError = () => {
    setErrorMessage('');
    setErrorTechnicalDetails('');
  };

  const showUserFacingError = (error: unknown, context: ErrorContext, fileName?: string) => {
    const userError = getUserFacingError(error, context, fileName);
    setErrorMessage(userError.message);
    setErrorTechnicalDetails(userError.technicalDetails);
  };

  const initializeDatabase = async () => {
    setDbReady(false);
    setFatalDatabaseError(null);
    setDbStatus('Ansluter till lokal databas');
    const result = await runDatabaseInitialization(async () => {
      const path = await invoke<string>('init_db');
      setDbStatus(path);
      const stored = await refreshTransactions();
      const savedRules = await invoke<LearnedMerchantRule[]>('get_learned_rules');
      const savedTypeRules = await invoke<LearnedTransactionTypeRule[]>('get_learned_transaction_type_rules');
      await refreshImportBatches();
      return { path, stored, savedRules, savedTypeRules };
    });
    if (result.status === 'fatal') {
      setDbStatus(result.error.dataLocation || 'Databasen kunde inte öppnas');
      setFatalDatabaseError(result.error);
      return;
    }
    setLearnedRules(result.value.savedRules);
    setLearnedTransactionTypeRules(result.value.savedTypeRules);
    const years = result.value.stored
      .filter((row) => validDate(row.date))
      .map((row) => Number(row.date.slice(0, 4)));
    const latestYear = years.length ? Math.max(...years) : currentYear;
    setSelectedYear(String(latestYear));
    setComparisonYear(String(latestYear - 1));
    setDbStatus(result.value.path);
    clearError();
    setDbReady(true);
  };

  useEffect(() => {
    void initializeDatabase();
  }, [currentYear]);

  useEffect(() => {
    if (!dbReady) return;
    setPendingBudgetCategories([]);
    setBudgetCategoryPickerOpen(false);
    let active = true;
    void Promise.all([
      invoke<Budget[]>('get_budgets', {
        year: Number(selectedYear),
        month: selectedMonth === 'all' ? null : Number(selectedMonth),
      }),
      invoke<number>('get_budget_coverage', { year: Number(selectedYear) }),
    ]).then(([result, coverage]) => {
      if (!active) return;
      const values = Object.fromEntries(result.map((item) => [item.category, item.amountCents]));
      setBudgets(values);
      setBudgetedMonthCount(coverage);
      setBudgetDrafts(Object.fromEntries(
        Object.entries(values).map(([category, amountCents]) => [category, centsToInputValue(amountCents)])
      ));
    }).catch((error) => showUserFacingError(error, 'budget-load'));
    return () => { active = false; };
  }, [dbReady, selectedYear, selectedMonth]);

  const yearOptions = useMemo(() => {
    const years = new Set(transactions.filter((row) => validDate(row.date)).map((row) => row.date.slice(0, 4)));
    years.add(String(currentYear));
    years.add(selectedYear);
    years.add(comparisonYear);
    return [...years].sort((a, b) => Number(b) - Number(a));
  }, [transactions, selectedYear, comparisonYear, currentYear]);

  const periodTransactions = useMemo(() => transactions.filter((row) =>
    validDate(row.date) && row.date.startsWith(`${selectedYear}-`) &&
    (selectedMonth === 'all' || row.date.slice(5, 7) === selectedMonth.padStart(2, '0'))
  ), [transactions, selectedYear, selectedMonth]);
  const reportTransactions = useMemo(
    () => periodTransactions.filter(isIncludedInOverview),
    [periodTransactions]
  );
  const categoryOptions = useMemo(
    () => sortCategoriesByUsage(categoryNames, transactions),
    [transactions]
  );
  const selectedCategoryTransactions = useMemo(
    () => selectedCategory
      ? transactionsForCategoryFlow(reportTransactions, selectedCategory, selectedCategoryFlow)
      : [],
    [reportTransactions, selectedCategory, selectedCategoryFlow]
  );
  const displayedCategoryTotal = selectedCategory
    ? sumCategoryFlow(selectedCategoryTransactions, selectedCategory, selectedCategoryFlow)
    : 0;

  const reviewTransactions = useMemo(() => transactions.filter((row) =>
    !validDate(row.date) || (row.date.startsWith(`${selectedYear}-`) &&
      (selectedMonth === 'all' || row.date.slice(5, 7) === selectedMonth.padStart(2, '0')))
  ), [transactions, selectedYear, selectedMonth]);
  const duplicateIds = useMemo(() => findPotentialDuplicateIds(transactions), [transactions]);
  const reviewRows = useMemo(() => reviewTransactions.map((row) => ({
    row,
    needsCheck: needsCategoryDecision(row, duplicateIds.has(String(row.id))),
  })), [reviewTransactions, duplicateIds]);
  const pendingReviewTransactions = useMemo(
    () => reviewRows.filter(({ needsCheck }) => needsCheck).map(({ row }) => row),
    [reviewRows]
  );
  const statusFilteredReviewTransactions = useMemo(() => reviewRows
    .filter(({ needsCheck }) =>
      reviewFilter === 'all' || (reviewFilter === 'pending' ? needsCheck : !needsCheck)
    )
    .map(({ row }) => row), [reviewRows, reviewFilter]);
  const incomingReviewCount = useMemo(
    () => filterTransactionsByDirection(statusFilteredReviewTransactions, 'incoming').length,
    [statusFilteredReviewTransactions]
  );
  const outgoingReviewCount = useMemo(
    () => filterTransactionsByDirection(statusFilteredReviewTransactions, 'outgoing').length,
    [statusFilteredReviewTransactions]
  );
  const directionFilteredReviewTransactions = useMemo(
    () => filterTransactionsByDirection(statusFilteredReviewTransactions, reviewDirectionFilter),
    [statusFilteredReviewTransactions, reviewDirectionFilter]
  );
  const filteredReviewTransactions = useMemo(() => {
    const merchantQuery = reviewMerchantFilter.trim().toLocaleLowerCase('sv-SE');
    const parsedMin = reviewMinAmount === ''
      ? null
      : Math.round(Number(reviewMinAmount.replace(',', '.')) * 100);
    const parsedMax = reviewMaxAmount === ''
      ? null
      : Math.round(Number(reviewMaxAmount.replace(',', '.')) * 100);

    return directionFilteredReviewTransactions.filter((row) => {
      const rowId = String(row.id);
      const category = categoryDrafts[rowId] ?? row.category;
      const transactionType = transactionTypeDrafts[rowId] ?? row.transactionType;
      const isDuplicate = duplicateIds.has(rowId);
      const expectedType = expectedTransactionTypeForCategory(category);
      const hasConflict = expectedType !== undefined && expectedType !== transactionType;
      const isChecked = !isDuplicate &&
        !row.needsReview &&
        transactionType !== 'unclassified' &&
        !hasConflict;
      const matchesControl = reviewControlFilter === 'all' ||
        (reviewControlFilter === 'duplicate' && isDuplicate) ||
        (reviewControlFilter === 'category-approved' && isDuplicate && row.categoryDecided) ||
        (reviewControlFilter === 'unclassified' && transactionType === 'unclassified') ||
        (reviewControlFilter === 'conflict' && hasConflict) ||
        (reviewControlFilter === 'uncertain' && row.needsReview) ||
        (reviewControlFilter === 'checked' && isChecked);

      return (!reviewDateFilter || row.date === reviewDateFilter) &&
        (!merchantQuery || row.merchant.toLocaleLowerCase('sv-SE').includes(merchantQuery)) &&
        (parsedMin === null || !Number.isFinite(parsedMin) || row.amountCents >= parsedMin) &&
        (parsedMax === null || !Number.isFinite(parsedMax) || row.amountCents <= parsedMax) &&
        (reviewCategoryFilter === 'all' || category === reviewCategoryFilter) &&
        (reviewTypeFilter === 'all' || transactionType === reviewTypeFilter) &&
        matchesControl;
    });
  }, [
    directionFilteredReviewTransactions,
    reviewDateFilter,
    reviewMerchantFilter,
    reviewMinAmount,
    reviewMaxAmount,
    reviewCategoryFilter,
    reviewTypeFilter,
    reviewControlFilter,
    categoryDrafts,
    transactionTypeDrafts,
    duplicateIds,
  ]);
  const reviewPageCount = Math.max(1, Math.ceil(filteredReviewTransactions.length / REVIEW_PAGE_SIZE));
  const visibleReviewTransactions = useMemo(() => {
    const start = (reviewPage - 1) * REVIEW_PAGE_SIZE;
    return filteredReviewTransactions.slice(start, start + REVIEW_PAGE_SIZE);
  }, [filteredReviewTransactions, reviewPage]);

  useEffect(() => {
    setReviewPage(1);
  }, [
    reviewFilter,
    reviewDirectionFilter,
    reviewDateFilter,
    reviewMerchantFilter,
    reviewMinAmount,
    reviewMaxAmount,
    reviewCategoryFilter,
    reviewTypeFilter,
    reviewControlFilter,
    selectedYear,
    selectedMonth,
  ]);
  useEffect(() => {
    setReviewPage((page) => Math.min(page, reviewPageCount));
  }, [reviewPageCount]);

  const clearReviewColumnFilters = () => {
    setReviewDateFilter('');
    setReviewMerchantFilter('');
    setReviewMinAmount('');
    setReviewMaxAmount('');
    setReviewCategoryFilter('all');
    setReviewTypeFilter('all');
    setReviewControlFilter('all');
  };
  const hasReviewColumnFilters = Boolean(
    reviewDateFilter ||
    reviewMerchantFilter ||
    reviewMinAmount ||
    reviewMaxAmount ||
    reviewCategoryFilter !== 'all' ||
    reviewTypeFilter !== 'all' ||
    reviewControlFilter !== 'all'
  );

  const comparisonTransactions = useMemo(() => transactions.filter((row) =>
    validDate(row.date) && row.date.startsWith(`${comparisonYear}-`) &&
    (selectedMonth === 'all' || row.date.slice(5, 7) === selectedMonth.padStart(2, '0')) &&
    isIncludedInOverview(row)
  ), [transactions, comparisonYear, selectedMonth]);

  const summary = useMemo(() => {
    return {
      current: calculateFinancialSummary(reportTransactions),
      comparison: calculateFinancialSummary(comparisonTransactions),
    };
  }, [reportTransactions, comparisonTransactions]);
  const monthlyInsights = useMemo(
    () => selectedMonth === 'all'
      ? null
      : buildMonthlyInsights(transactions, Number(selectedYear), Number(selectedMonth), today),
    [transactions, selectedYear, selectedMonth, today]
  );
  const periodStatus = useMemo(
    () => selectedMonth === 'all'
      ? null
      : getPeriodStatus(Number(selectedYear), Number(selectedMonth), today),
    [selectedYear, selectedMonth, today]
  );
  const recurringReference = useMemo(() => {
    const selectedYearNumber = Number(selectedYear);
    const referenceYear = selectedMonth === 'all'
      ? Math.min(selectedYearNumber, currentYear)
      : selectedYearNumber;
    const referenceMonth = selectedMonth === 'all'
      ? referenceYear === currentYear ? today.getMonth() + 1 : 12
      : Number(selectedMonth);
    return { year: referenceYear, month: referenceMonth };
  }, [selectedYear, selectedMonth, currentYear, today]);
  const recurringInsights = useMemo(
    () => periodStatus === 'future'
      ? null
      : buildRecurringExpenseInsights(
          transactions,
          recurringReference.year,
          recurringReference.month,
          today
        ),
    [transactions, recurringReference, periodStatus, today]
  );
  const recurringCostTrends = useMemo(
    () => periodStatus === 'future'
      ? null
      : buildRecurringCostTrendInsights(
          transactions,
          recurringReference.year,
          recurringReference.month,
          today
        ),
    [transactions, recurringReference, periodStatus, today]
  );
  const yearTransactions = useMemo(
    () => transactions.filter((row) =>
      validDate(row.date) && row.date.startsWith(`${selectedYear}-`)
    ),
    [transactions, selectedYear]
  );
  const consumptionBudget = useMemo(() => buildBudgetAnalysis({
    periodTransactions: reportTransactions,
    yearTransactions,
    budgets,
    kind: 'consumption',
    year: Number(selectedYear),
    today,
    defaultCategories: pendingBudgetCategories,
  }), [reportTransactions, yearTransactions, budgets, pendingBudgetCategories, selectedYear, today]);
  const incomeBudget = useMemo(() => buildBudgetAnalysis({
    periodTransactions: reportTransactions,
    yearTransactions,
    budgets,
    kind: 'income',
    year: Number(selectedYear),
    today,
    defaultCategories: ['Lön', 'Bidrag', 'Uthyrning'],
  }), [reportTransactions, yearTransactions, budgets, selectedYear, today]);
  const savingBudget = useMemo(() => buildBudgetAnalysis({
    periodTransactions: reportTransactions,
    yearTransactions,
    budgets,
    kind: 'saving',
    year: Number(selectedYear),
    today,
    defaultCategories: ['Sparande'],
  }), [reportTransactions, yearTransactions, budgets, selectedYear, today]);
  const amortizationBudget = useMemo(() => buildBudgetAnalysis({
    periodTransactions: reportTransactions,
    yearTransactions,
    budgets,
    kind: 'amortization',
    year: Number(selectedYear),
    today,
    defaultCategories: ['Sparande / Amortering'],
  }), [reportTransactions, yearTransactions, budgets, selectedYear, today]);
  const financialHealth = useMemo(
    () => selectedMonth === 'all' || recurringInsights == null || recurringCostTrends == null || periodStatus == null
      ? null
      : buildFinancialHealthSummary({
          financialSummary: summary.current,
          consumptionBudgetRows: consumptionBudget.rows,
          savingBudgetRows: savingBudget.rows,
          amortizationBudgetRows: amortizationBudget.rows,
          monthlyInsights,
          recurringInsights,
          costTrends: recurringCostTrends,
          periodStatus,
        }),
    [
      selectedMonth,
      selectedYear,
      summary.current,
      consumptionBudget.rows,
      savingBudget.rows,
      amortizationBudget.rows,
      monthlyInsights,
      recurringInsights,
      recurringCostTrends,
      periodStatus,
    ]
  );
  const categoryRows = consumptionBudget.rows;
  const incomeRows = incomeBudget.rows;
  const wealthGoalRows: Array<BudgetRow & { goalLabel: string }> = [
    ...savingBudget.rows.map((row) => ({ ...row, goalLabel: 'Sparmål' })),
    ...amortizationBudget.rows.map((row) => ({ ...row, goalLabel: 'Amorteringsmål' })),
  ];
  const visibleExpenseRows = showAllExpenseCategories ? categoryRows : categoryRows.slice(0, 10);
  const visibleIncomeRows = showAllIncomeCategories ? incomeRows : incomeRows.slice(0, 10);
  const availableBudgetCategories = useMemo(
    () => availableConsumptionBudgetCategories(
      categoryOptions,
      categoryRows.map((row) => row.category)
    ),
    [categoryOptions, categoryRows]
  );

  const monthlyComparison = useMemo(() => {
    const expensesByMonth = (year: string) => Array.from({ length: 12 }, (_, index) =>
      calculateFinancialSummary(transactions.filter((row) =>
        validDate(row.date) &&
        row.date.startsWith(`${year}-${String(index + 1).padStart(2, '0')}`)
      )).consumptionExpensesCents
    );
    const current = expensesByMonth(selectedYear);
    const previous = expensesByMonth(comparisonYear);
    const max = Math.max(1, ...current, ...previous);
    return current.map((amount, index) => ({ month: monthNames[index].slice(0, 3), current: amount, previous: previous[index], currentHeight: amount / max * 100, previousHeight: previous[index] / max * 100 }));
  }, [transactions, selectedYear, comparisonYear]);

  const importSources = useMemo(() => {
    const grouped = new Map<string, number>();
    reportTransactions.forEach((row) => {
      const name = row.sourceFile || 'Importerad utan filnamn';
      grouped.set(name, (grouped.get(name) ?? 0) + 1);
    });
    return [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  }, [reportTransactions]);

  const flaggedCount = useMemo(() => transactions.reduce((count, row) =>
    count + Number(needsCategoryDecision(row, duplicateIds.has(String(row.id)))), 0
  ), [transactions, duplicateIds]);
  const previewDuplicateIds = useMemo(
    () => findPotentialDuplicateIds([...transactions, ...previewRows]),
    [transactions, previewRows]
  );

  const handleFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.currentTarget.value = '';
    if (!files.length) return;
    if (isAnalyzingImport || isImporting) return;
    if (!dbReady) {
      setErrorMessage('Vänta tills den lokala databasen och tidigare kategorival har laddats.');
      setErrorTechnicalDetails('');
      return;
    }
    const invalid = files.filter((file) => !file.name.toLowerCase().endsWith('.xlsx'));
    if (invalid.length) {
      setErrorMessage('Endast .xlsx-filer stöds.');
      setErrorTechnicalDetails('');
      return;
    }

    const runId = importAnalysisGuard.current.begin();
    setIsAnalyzingImport(true);
    setImportOutcomes([]);
    try {
      setPreviewRows([]);
      setPreviewFiles([]);
      setImportWarnings([]);
      setImportBlockingErrors([]);
      setPendingImports([]);
      setExistingImportMatches([]);
      clearError();
      const hashedFiles: Array<{ file: File; bytes: ArrayBuffer; fileSha256: string }> = [];
      for (const [index, file] of files.entries()) {
        setImportAnalysisStatus(importAnalysisPhaseText('preparing', index + 1, files.length));
        const bytes = await file.arrayBuffer();
        if (!importAnalysisGuard.current.isLatest(runId)) return;
        const fileSha256 = await sha256Hex(bytes);
        if (!importAnalysisGuard.current.isLatest(runId)) return;
        hashedFiles.push({ file, bytes, fileSha256 });
      }
      const seenHashes = new Set<string>();
      const repeatedSelectionIssues: ImportIssue[] = [];
      const uniqueFiles = hashedFiles.filter(({ file, fileSha256 }) => {
        if (!seenHashes.has(fileSha256)) {
          seenHashes.add(fileSha256);
          return true;
        }
        repeatedSelectionIssues.push({
          severity: 'blocking',
          code: 'same-file-selected-twice',
          sheet: file.name,
          rowNumber: 0,
          originalValue: file.name,
          message: 'Samma fil valdes flera gånger. Välj varje fil en gång.',
        });
        return false;
      });
      const checkedFiles: Array<{
        file: File;
        fileSha256: string;
        existing: ImportBatchSummary | null;
        result: ImportResult | null;
      }> = [];
      for (const [index, { file, bytes, fileSha256 }] of uniqueFiles.entries()) {
        setImportAnalysisStatus(importAnalysisPhaseText(
          'checking-duplicate',
          index + 1,
          uniqueFiles.length
        ));
        const existing = await invoke<ImportBatchSummary | null>('find_import_batch_by_hash', { fileSha256 });
        if (!importAnalysisGuard.current.isLatest(runId)) return;
        if (existing) {
          checkedFiles.push({ file, fileSha256, existing, result: null });
          continue;
        }
        setImportAnalysisStatus(importAnalysisPhaseText('reading-workbook', index + 1, uniqueFiles.length));
        const result = await parseWorkbookRows(file, bytes, classifyImportedTransaction);
        if (!importAnalysisGuard.current.isLatest(runId)) return;
        setImportAnalysisStatus(importAnalysisPhaseText('validating', index + 1, uniqueFiles.length));
        checkedFiles.push({ file, fileSha256, existing: null, result });
      }
      if (!importAnalysisGuard.current.isLatest(runId)) return;
      const readyImports: PendingImport[] = checkedFiles
        .filter((item): item is typeof item & { result: ImportResult } => item.result !== null)
        .map(({ file, fileSha256, result }) => ({ fileName: file.name, fileSha256, result }));
      const existingMatches = checkedFiles
        .filter((item): item is typeof item & { existing: ImportBatchSummary } => item.existing !== null)
        .map(({ file, existing }) => ({ selectedFileName: file.name, batch: existing }));
      const withFileContext = (fileName: string, issue: ImportIssue): ImportIssue => ({
        ...issue,
        sheet: `${fileName} / ${issue.sheet}`,
      });
      const rows = readyImports.flatMap(({ result }) => result.acceptedRows);
      const warnings = readyImports.flatMap(({ fileName, result }) =>
        result.warnings.map((issue) => withFileContext(fileName, issue))
      );
      const blockingErrors = [
        ...repeatedSelectionIssues,
        ...readyImports.flatMap(({ fileName, result }) =>
          result.blockingErrors.map((issue) => withFileContext(fileName, issue))
        ),
      ];
      setPendingImports(readyImports);
      setExistingImportMatches(existingMatches);
      setPreviewRows(rows);
      setPreviewFiles(readyImports.map((item) => item.fileName));
      setImportWarnings(warnings);
      setImportBlockingErrors(blockingErrors);
      setStatusMessage(
        blockingErrors.length
          ? `${rows.length} godkända rader hittades, men ${blockingErrors.length} blockerande fel måste rättas.`
          : existingMatches.length
            ? `${existingMatches.length} fil(er) har redan importerats. ${rows.length} rader i nya filer kan importeras.`
            : `${rows.length} godkända rader hittades i ${readyImports.length} fil(er). Kontrollera urvalet innan import.`
      );
    } catch (error) {
      if (!importAnalysisGuard.current.isLatest(runId)) return;
      setStatusMessage('');
      setPreviewRows([]);
      setPreviewFiles([]);
      setImportWarnings([]);
      setImportBlockingErrors([]);
      setPendingImports([]);
      setExistingImportMatches([]);
      showUserFacingError(error, 'import-analysis');
    } finally {
      if (importAnalysisGuard.current.isLatest(runId)) {
        setIsAnalyzingImport(false);
        setImportAnalysisStatus('');
      }
    }
  };

  const handleImport = async () => {
    if (
      isAnalyzingImport ||
      !previewRows.length ||
      !pendingImports.length ||
      importBlockingErrors.length
    ) return;
    setIsImporting(true);
    clearError();
    setImportOutcomes([]);
    const outcomes: FileImportOutcome[] = [];
    try {
      const importResult = await runSequentialFileImports(pendingImports, async (pendingImport) => {
        return invoke<ImportBatchSummary>('import_transactions', {
            fileName: pendingImport.fileName,
            fileSha256: pendingImport.fileSha256,
            transactions: pendingImport.result.acceptedRows.map((row) => ({
              merchant: row.merchant,
              amount_cents: row.amountCents,
              category: row.category,
              transaction_type: row.transactionType,
              date: row.date,
              source_file: row.sourceFile,
              needs_review: row.needsReview,
              imported_sheet: row.importedSheet,
              imported_row: row.importedRow,
            })),
          });
      });
      outcomes.push(...importResult.outcomes);
      const insertedCount = outcomes.reduce(
        (total, outcome) => total + (outcome.status === 'imported' ? outcome.transactionCount : 0),
        0
      );
      const firstFailedIndex = importResult.firstFailedIndex;
      const stored = await refreshTransactions();
      await refreshImportBatches();
      setImportOutcomes(outcomes);
      if (firstFailedIndex < 0) {
        setStatusMessage(`${insertedCount} transaktioner importerades. Möjliga dubletter är markerade för manuell kontroll.`);
        setPreviewRows([]);
        setPreviewFiles([]);
        setImportWarnings([]);
        setImportBlockingErrors([]);
        setPendingImports([]);
        setExistingImportMatches([]);
      } else {
        const remaining = pendingImports.slice(firstFailedIndex);
        setPendingImports(remaining);
        setPreviewFiles(remaining.map((item) => item.fileName));
        setPreviewRows(remaining.flatMap((item) => item.result.acceptedRows));
        setStatusMessage(
          `${outcomes.filter((outcome) => outcome.status === 'imported').length} fil(er) importerades och finns kvar. ` +
          `${outcomes.filter((outcome) => outcome.status === 'failed').length} fil misslyckades. ` +
          'Den misslyckade filen sparades inte och kan rättas och importeras igen.'
        );
      }
      const importedYears = stored.filter((row) => validDate(row.date)).map((row) => Number(row.date.slice(0, 4)));
      if (importedYears.length) {
        setSelectedYear(String(Math.max(...importedYears)));
        setComparisonYear(String(Math.max(...importedYears) - 1));
      }
    } catch (error) {
      setImportOutcomes(outcomes);
      showUserFacingError(error, 'import-history');
    } finally {
      setIsImporting(false);
    }
  };

  const saveBudget = async (category: string) => {
    if (selectedMonth === 'all') return;
    const parsedAmount = parseMoneyToCents(budgetDrafts[category] ?? '0');
    if (parsedAmount.kind !== 'valid' || parsedAmount.value < 0) {
      setErrorMessage('Budgeten måste vara ett positivt belopp.');
      return;
    }
    const amountCents = parsedAmount.value;
    try {
      await invoke('save_budget', {
        year: Number(selectedYear),
        month: Number(selectedMonth),
        category,
        amountCents,
      });
      setBudgets((current) => ({ ...current, [category]: amountCents }));
      setPendingBudgetCategories((current) => current.filter((item) => item !== category));
      setBudgetedMonthCount(await invoke<number>('get_budget_coverage', {
        year: Number(selectedYear),
      }));
      setStatusMessage(`Budget för ${category} sparad.`);
      clearError();
    } catch (error) {
      showUserFacingError(error, 'budget-save');
    }
  };

  const addBudgetCategory = (category: string) => {
    if (selectedMonth === 'all' || !availableBudgetCategories.includes(category)) return;
    setPendingBudgetCategories((current) => [...current, category]);
    setBudgetDrafts((current) => Object.prototype.hasOwnProperty.call(current, category)
      ? current
      : { ...current, [category]: '' });
    setShowAllExpenseCategories(true);
    setBudgetCategoryPickerOpen(false);
  };

  const clearCategoryDrafts = (ids: string[]) => {
    const idSet = new Set(ids);
    setCategoryDrafts((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => !idSet.has(id))
    ));
  };

  const updateSingleCategory = async (row: Transaction, category: string) => {
    try {
      await invoke('update_transaction_category', {
        id: Number(row.id),
        category,
      });
      await refreshImportBatches();
      setTransactions((current) => current.map((item) => item.id === row.id
        ? {
            ...item,
            category,
            needsReview: item.transactionType === 'unclassified' ||
              !isCategoryTransactionTypeConsistent(category, item.transactionType),
            categoryDecided: true,
          }
        : item));
      clearCategoryDrafts([String(row.id)]);
      setStatusMessage(`${category} valdes endast för ${row.merchant}.`);
      clearError();
    } catch (error) {
      showUserFacingError(error, 'review-update');
    }
  };

  const updateExactMerchantCategories = async (row: Transaction, category: string) => {
    const transactionIds = findExactMerchantTransactionIds(transactions, row.merchant);
    if (!transactionIds.length) return;
    await runConfirmedAction(
      window.confirm,
      buildBulkConfirmation({
        kind: 'category',
        merchant: row.merchant,
        count: transactionIds.length,
        newValue: category,
      }),
      async () => {
        try {
          const updatedCount = await invoke<number>('bulk_update_transaction_categories', {
            ids: transactionIds.map(Number),
            category,
          });
          await refreshImportBatches();
          const matchingIdSet = new Set(transactionIds);
          setTransactions((current) => current.map((item) => matchingIdSet.has(String(item.id))
            ? {
                ...item,
                category,
                needsReview: item.transactionType === 'unclassified' ||
                  !isCategoryTransactionTypeConsistent(category, item.transactionType),
                categoryDecided: true,
              }
            : item));
          clearCategoryDrafts(transactionIds);
          setStatusMessage(`${category} valdes för ${updatedCount} befintliga transaktioner med samma butik/mottagare.`);
          clearError();
        } catch (error) {
          showUserFacingError(error, 'review-update');
        }
      }
    );
  };

  const rememberCategoryForFuture = async (row: Transaction, category: string) => {
    const merchantKey = normalizedMerchantKey(row.merchant);
    if (!merchantKey || merchantKey === 'OKÄND MERCHANT') {
      setErrorMessage('Det går inte att komma ihåg ett val för en okänd butik eller mottagare.');
      setErrorTechnicalDetails('');
      return;
    }
    await runConfirmedAction(
      window.confirm,
      buildRememberForwardConfirmation({
        kind: 'category',
        merchant: row.merchant,
        newValue: category,
      }),
      async () => {
        try {
          await invoke('remember_category', {
            id: Number(row.id),
            merchantKey,
            category,
          });
          await refreshImportBatches();
          setTransactions((current) => current.map((item) => item.id === row.id
            ? {
                ...item,
                category,
                needsReview: item.transactionType === 'unclassified' ||
                  !isCategoryTransactionTypeConsistent(category, item.transactionType),
                categoryDecided: true,
              }
            : item));
          clearCategoryDrafts([String(row.id)]);
          setLearnedRules((current) => [
            ...current.filter((rule) => normalizedMerchantKey(rule.merchantKey) !== merchantKey),
            { merchantKey, category },
          ]);
          setStatusMessage(`${category} valdes för denna transaktion och används även för framtida importer från samma butik/mottagare.`);
          clearError();
        } catch (error) {
          showUserFacingError(error, 'review-update');
        }
      }
    );
  };

  const selectCategory = (row: Transaction, category: string) => {
    setCategoryDrafts((current) => ({ ...current, [String(row.id)]: category }));
  };

  const updateTransactionType = async (row: Transaction, transactionType: TransactionType) => {
    try {
      await invoke('update_transaction_type', {
        id: Number(row.id),
        transactionType,
      });
      setTransactions((current) => current.map((item) => item.id === row.id
        ? {
            ...item,
            transactionType,
            needsReview: transactionType === 'unclassified' ||
              !isCategoryTransactionTypeConsistent(item.category, transactionType)
              ? true
              : item.categoryDecided
                ? false
                : item.needsReview,
          }
        : item));
      setTransactionTypeDrafts((current) => {
        const next = { ...current };
        delete next[String(row.id)];
        return next;
      });
      await refreshImportBatches();
      setStatusMessage(`${transactionTypeLabels[transactionType]} valdes endast för ${row.merchant}.`);
      clearError();
    } catch (error) {
      showUserFacingError(error, 'review-update');
    }
  };

  const updateSimilarTransactionTypes = async (row: Transaction, transactionType: TransactionType) => {
    const ids = findExactMerchantTransactionIdsForType(
      transactions,
      row.merchant,
      row.amountCents
    );
    await runConfirmedAction(
      window.confirm,
      buildBulkConfirmation({
        kind: 'transaction-type',
        merchant: row.merchant,
        count: ids.length,
        newValue: transactionTypeLabels[transactionType],
      }),
      async () => {
        try {
          const updated = await invoke<number>('bulk_update_transaction_types', {
            ids: ids.map(Number),
            transactionType,
          });
          setTransactions((current) => current.map((item) => ids.includes(String(item.id))
            ? {
                ...item,
                transactionType,
                needsReview: transactionType === 'unclassified' ||
                  !isCategoryTransactionTypeConsistent(item.category, transactionType)
                  ? true
                  : item.categoryDecided
                    ? false
                    : item.needsReview,
              }
            : item));
          setTransactionTypeDrafts((current) => {
            const next = { ...current };
            ids.forEach((id) => delete next[String(id)]);
            return next;
          });
          await refreshImportBatches();
          setStatusMessage(`${transactionTypeLabels[transactionType]} valdes för ${updated} befintliga transaktioner med samma butik/mottagare och beloppsriktning.`);
          clearError();
        } catch (error) {
          showUserFacingError(error, 'review-update');
        }
      }
    );
  };

  const rememberTransactionType = async (row: Transaction, transactionType: TransactionType) => {
    const merchantKey = transactionTypeRuleKey(row.merchant, row.amountCents);
    await runConfirmedAction(
      window.confirm,
      buildRememberForwardConfirmation({
        kind: 'transaction-type',
        merchant: row.merchant,
        newValue: transactionTypeLabels[transactionType],
      }),
      async () => {
        try {
          await invoke('remember_transaction_type', {
            id: Number(row.id),
            merchantKey,
            transactionType,
          });
          setTransactions((current) => current.map((item) => item.id === row.id
            ? {
                ...item,
                transactionType,
                needsReview: transactionType === 'unclassified' ||
                  !isCategoryTransactionTypeConsistent(item.category, transactionType)
                  ? true
                  : item.categoryDecided
                    ? false
                    : item.needsReview,
              }
            : item));
          const savedRules = await invoke<LearnedTransactionTypeRule[]>('get_learned_transaction_type_rules');
          setLearnedTransactionTypeRules(savedRules);
          setTransactionTypeDrafts((current) => {
            const next = { ...current };
            delete next[String(row.id)];
            return next;
          });
          await refreshImportBatches();
          setStatusMessage(`${transactionTypeLabels[transactionType]} valdes för denna transaktion och används även för framtida importer från samma butik/mottagare med samma beloppsriktning.`);
          clearError();
        } catch (error) {
          showUserFacingError(error, 'review-update');
        }
      }
    );
  };

  const rejectCategory = async (row: Transaction) => {
    try {
      await invoke('reject_transaction_category', { id: Number(row.id) });
      await refreshImportBatches();
      setTransactions((current) => current.map((item) => item.id === row.id
        ? { ...item, category: 'Okategoriserat', needsReview: true, categoryDecided: false }
        : item));
      setCategoryDrafts((current) => {
        const next = { ...current };
        delete next[String(row.id)];
        return next;
      });
      setStatusMessage(`Kategorin nekades för ${row.merchant}. Posten ligger kvar för manuell granskning.`);
    } catch (error) {
      showUserFacingError(error, 'review-update');
    }
  };

  const deleteTransaction = async (row: Transaction) => {
    if (!window.confirm(`Ta bort transaktionen ${row.merchant} (${formatMoney(row.amountCents)})?`)) return;
    try {
      await invoke('delete_transaction', { id: Number(row.id) });
      setTransactions((current) => current.filter((item) => item.id !== row.id));
      await refreshImportBatches();
      setStatusMessage(`${row.merchant} togs bort.`);
    } catch (error) {
      showUserFacingError(error, 'transaction-delete');
    }
  };

  const openImportBatch = async (id: number) => {
    try {
      const detail = await invoke<ImportBatchDetail>('get_import_batch', { id });
      setSelectedImportBatch(detail);
      setActiveTab('import');
      clearError();
    } catch (error) {
      showUserFacingError(error, 'import-history');
    }
  };

  const undoImportBatch = async (batch: ImportBatchSummary) => {
    const period = batch.earliestDate && batch.latestDate
      ? `${batch.earliestDate} – ${batch.latestDate}`
      : 'Okänd period';
    const confirmed = window.confirm(
      `Du håller på att ångra importen ${batch.fileName} från ${batch.importedAt}.\n\n` +
      `${batch.transactionCount} transaktioner kommer att tas bort.\n` +
      `Period: ${period}.\n` +
      `Positiva belopp: ${formatMoney(batch.positiveTotalCents)}.\n` +
      `Negativa belopp: ${formatMoney(batch.negativeTotalCents)}.\n\n` +
      'Åtgärden tar även bort manuella kategoriändringar på dessa transaktioner. ' +
      'Sparade regler för framtida importer lämnas kvar.'
    );
    if (!confirmed) return;

    try {
      const deletedCount = await invoke<number>('delete_import_batch', { id: batch.id });
      await refreshTransactions();
      await refreshImportBatches();
      setExistingImportMatches((current) => current.filter((match) => match.batch.id !== batch.id));
      setSelectedImportBatch(null);
      setStatusMessage(`${batch.fileName} ångrades och ${deletedCount} transaktioner togs bort.`);
      clearError();
    } catch (error) {
      showUserFacingError(error, 'import-undo');
    }
  };

  const periodLabel = selectedMonth === 'all' ? selectedYear : `${monthNames[Number(selectedMonth) - 1]} ${selectedYear}`;
  const comparisonLabel = selectedMonth === 'all' ? comparisonYear : `${monthNames[Number(selectedMonth) - 1]} ${comparisonYear}`;
  const dashboardMode = getDashboardMode({
    transactionCount: transactions.length,
    selectedMonth,
    periodStatus,
  });
  const dashboardSections = getDashboardSections(dashboardMode);
  const navigateMonth = (direction: -1 | 1) => {
    if (selectedMonth === 'all') return;
    const next = shiftMonth(Number(selectedYear), Number(selectedMonth), direction);
    setSelectedYear(String(next.year));
    setSelectedMonth(String(next.month));
    setSelectedCategory(null);
  };
  const legacyTransactionCount = transactions.filter((row) => row.importBatchId == null).length;
  const categoryDecisionActions = (row: Transaction, category: string, isDuplicate: boolean) => {
    const exactMatchCount = findExactMerchantTransactionIds(transactions, row.merchant).length;
    return (
      <div className="category-decision-actions">
        <button
          className="approve-category-btn"
          disabled={category === 'Okategoriserat'}
          onClick={() => void updateSingleCategory(row, category)}
        >
          Ändra bara den här
        </button>
        <button
          className="bulk-category-btn"
          disabled={category === 'Okategoriserat' || exactMatchCount < 2}
          onClick={() => void updateExactMerchantCategories(row, category)}
        >
          Ändra {exactMatchCount} befintliga med samma butik/mottagare
        </button>
        <button
          className="remember-category-btn"
          disabled={category === 'Okategoriserat' || normalizedMerchantKey(row.merchant) === 'OKÄND MERCHANT'}
          onClick={() => void rememberCategoryForFuture(row, category)}
        >
          Använd även för framtida importer
        </button>
        {isDuplicate && (
          <button
            className="reject-category-btn"
            disabled={category === 'Okategoriserat'}
            onClick={() => void rejectCategory(row)}
          >
            Neka
          </button>
        )}
      </div>
    );
  };
  const importIssueTable = (title: string, issues: ImportIssue[], className: string) => (
    issues.length > 0 && (
      <section className={`import-issues ${className}`}>
        <h4>{title} ({issues.length})</h4>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Blad</th><th>Rad</th><th>Fält</th><th>Originalvärde</th><th>Problem</th></tr></thead>
            <tbody>
              {issues.map((issue, index) => (
                <tr key={`${issue.sheet}-${issue.rowNumber}-${issue.code}-${index}`}>
                  <td>{issue.sheet}</td>
                  <td>{issue.rowNumber || '—'}</td>
                  <td>{issue.field || '—'}</td>
                  <td className="import-original-value">{formatImportValue(issue.originalValue) || '—'}</td>
                  <td>{issue.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    )
  );

  if (fatalDatabaseError) {
    return (
      <main className="app-shell">
        <aside className="sidebar">
          <div className="brand-block">
            <div className="brand-mark">B</div>
            <div><p className="eyebrow">Lokal ekonomi</p><h1>BudgetApp</h1></div>
          </div>
          <div className="db-box">
            <span>LOKAL SQLITE</span>
            <strong>Databasen är inte tillgänglig</strong>
            <small>{dbStatus}</small>
          </div>
        </aside>
        <section className="content fatal-database-state" role="alert">
          <article className="panel">
            <p className="eyebrow">Databasen kunde inte öppnas</p>
            <h2>BudgetApp kunde inte öppna databasen</h2>
            <p>{fatalDatabaseError.message}</p>
            <p>Normal översikt visas inte förrän databasen kan läsas säkert.</p>
            {fatalDatabaseError.dataLocation && (
              <p>Den lokala databasen finns här: <code>{fatalDatabaseError.dataLocation}</code></p>
            )}
            <button className="primary-btn" onClick={() => void initializeDatabase()}>
              Försök igen
            </button>
            <details>
              <summary>Visa teknisk information</summary>
              <pre>{fatalDatabaseError.technicalDetails}</pre>
            </details>
          </article>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">B</div>
          <div><p className="eyebrow">Lokal ekonomi</p><h1>BudgetApp</h1></div>
        </div>
        <nav className="nav" aria-label="Huvudmeny">
          <button className={`nav-item ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => { setActiveTab('overview'); setSelectedCategory(null); }}>Översikt</button>
          <button className={`nav-item ${activeTab === 'review' ? 'active' : ''}`} onClick={() => setActiveTab('review')}>Granska poster <span className="nav-count">{flaggedCount}</span></button>
          <button className={`nav-item ${activeTab === 'import' ? 'active' : ''}`} onClick={() => setActiveTab('import')}>Importera</button>
        </nav>
        <div className="db-box"><span>LOKAL SQLITE</span><strong>{transactions.length.toLocaleString('sv-SE')} transaktioner</strong><small title={dbStatus}>{dbReady ? 'Data stannar på den här datorn' : dbStatus}</small></div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div><p className="eyebrow">{selectedCategory && activeTab === 'overview' ? `${selectedCategory} / ${periodLabel}` : `Transaktioner / ${periodLabel}`}</p><h2>{activeTab === 'overview' ? selectedCategory ? `${selectedCategoryFlow === 'income' ? 'Inkomster' : 'Utgifter'} · ${selectedCategory}` : 'Ekonomisk översikt' : activeTab === 'import' ? 'Importera bankfiler' : 'Transaktioner att granska'}</h2></div>
          {activeTab === 'overview' && selectedCategory && <button className="text-button" onClick={() => setSelectedCategory(null)}>Tillbaka till översikt</button>}
          {!(activeTab === 'overview' && dashboardMode === 'first-run') && (
            <button className="primary-btn" disabled={!dbReady || isAnalyzingImport || isImporting} onClick={() => setActiveTab('import')}>+ Importera Excel</button>
          )}
        </header>

        {statusMessage && <p className="status-message" role="status">{statusMessage}</p>}
        {errorMessage && (
          <div className="error-message" role="alert">
            <p>{errorMessage}</p>
            {errorTechnicalDetails && (
              <details>
                <summary>Visa teknisk information</summary>
                <pre>{errorTechnicalDetails}</pre>
              </details>
            )}
          </div>
        )}

        {transactions.length > 0 && (
          <div className="filter-bar">
            <label>År<select value={selectedYear} onChange={(event) => setSelectedYear(event.target.value)}>{yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
            <label>Månad<select value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}><option value="all">Hela året</option>{monthNames.map((month, index) => <option key={month} value={String(index + 1)}>{month}</option>)}</select></label>
            {selectedMonth !== 'all' && (
              <div className="period-navigation" aria-label="Månadsnavigation">
                <button type="button" aria-label="Föregående månad" onClick={() => navigateMonth(-1)}>←</button>
                <strong>{periodLabel}</strong>
                {periodStatus === 'future' && <span>Planering</span>}
                <button type="button" aria-label="Nästa månad" onClick={() => navigateMonth(1)}>→</button>
              </div>
            )}
            <label>Jämför med<select value={comparisonYear} onChange={(event) => setComparisonYear(event.target.value)}>{yearOptions.filter((year) => year !== selectedYear).map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
            <span className="period-count">{reportTransactions.length.toLocaleString('sv-SE')} transaktioner i perioden</span>
          </div>
        )}

        {dbReady && activeTab === 'overview' && !selectedCategory && dashboardMode === 'first-run' && (
          <section className="first-run" aria-labelledby="first-run-title">
            <div className="first-run-mark" aria-hidden="true">B</div>
            <p className="eyebrow">Din ekonomi, lokalt</p>
            <h2 id="first-run-title">{firstRunCopy.title}</h2>
            <p className="first-run-description">{firstRunCopy.description}</p>
            <p className="first-run-privacy">{firstRunCopy.privacy}</p>
            <button className="primary-btn" type="button" onClick={() => setActiveTab('import')}>
              {firstRunCopy.action}
            </button>
            <small>{firstRunCopy.fileHelp}</small>
          </section>
        )}

        {activeTab === 'overview' && !selectedCategory && dashboardMode !== 'first-run' && (
          <div className="overview-sections">
            <article className={`panel health-panel ${financialHealth?.status ?? 'year-view'}`}>
              <div className="panel-header">
                <div>
                  <h3>Din ekonomi</h3>
                  <span>{periodLabel}</span>
                </div>
              </div>
              {periodStatus === 'future' ? (
                <p className="empty-state">Den här perioden har inte börjat ännu. Budgeten kan planeras, men utfall och ekonomiska bedömningar visas först när perioden börjar.</p>
              ) : financialHealth == null ? (
                <p className="empty-state">Välj en månad för prioriterade ekonomiska insikter.</p>
              ) : (
                <>
                  <div className="health-heading">
                    <strong>{financialHealth.headline}</strong>
                    <span>{financialHealth.supportingText}</span>
                  </div>
                  {financialHealth.insights.length > 0 && (
                    <div className="health-grid">
                      {financialHealth.insights.map((insight) => (
                        <section className={`health-card ${insight.severity}`} key={insight.id}>
                          <span className="health-severity">
                            {insight.severity === 'important'
                              ? 'Behöver uppmärksamhet'
                              : insight.severity === 'attention'
                                ? 'Att se över'
                                : insight.severity === 'positive'
                                  ? 'Positivt'
                                  : 'Information'}
                          </span>
                          <strong>{insight.title}</strong>
                          <p>{insight.summary}</p>
                          {insight.supportingDetail && <small>{insight.supportingDetail}</small>}
                        </section>
                      ))}
                    </div>
                  )}
                  {financialHealth.hiddenCount > 0 && (
                    <p className="health-more">+{financialHealth.hiddenCount} fler insikter finns under Fördjupad analys.</p>
                  )}
                </>
              )}
            </article>

            {dashboardSections.includes('summary') && <div className="stats-grid">
              <article className="stat-card expense"><span>Konsumtionsutgifter</span><strong>{formatMoney(summary.current.consumptionExpensesCents)}</strong><small>{formatMoney(summary.current.consumptionExpensesCents - summary.comparison.consumptionExpensesCents)} mot {comparisonLabel}</small></article>
              <article className="stat-card income"><span>Inkomster</span><strong>{formatMoney(summary.current.incomeCents)}</strong><small>{formatMoney(summary.current.incomeCents - summary.comparison.incomeCents)} mot {comparisonLabel}</small></article>
              <article className="stat-card save"><span>Sparande</span><strong>{formatMoney(summary.current.directSavingsCents)}</strong><small>direkt sparande</small></article>
              <article className="stat-card save"><span>Amortering</span><strong>{formatMoney(summary.current.amortizationCents)}</strong><small>{formatMoney(summary.current.totalWealthBuildingCents)} totalt inkl. amortering</small></article>
              <article className="stat-card neutral"><span>Kvar efter utgifter &amp; sparande</span><strong>{formatMoney(summary.current.remainingAfterSpendingAndSavingCents)}</strong><small>{formatMoney(summary.current.remainingAfterSpendingAndSavingCents - summary.comparison.remainingAfterSpendingAndSavingCents)} mot {comparisonLabel}</small></article>
            </div>}

            {dashboardSections.includes('review') && pendingReviewTransactions.length > 0 && (
              <section className="review-callout" aria-label="Transaktioner som behöver granskas">
                <div>
                  <strong>
                    {pendingReviewTransactions.length === 1
                      ? '1 transaktion behöver granskas'
                      : `${pendingReviewTransactions.length} transaktioner behöver granskas`}
                  </strong>
                  <span>Kontrollera osäkra kategorier, ekonomisk typ och möjliga dubletter.</span>
                </div>
                <button type="button" onClick={() => setActiveTab('review')}>Granska</button>
              </section>
            )}

            {dashboardSections.includes('deep-analysis') && (
            <details
              className="deep-analysis"
              open={deepAnalysisOpen}
              onToggle={(event) => setDeepAnalysisOpen(event.currentTarget.open)}
            >
              <summary>
                <span>Fördjupad analys</span>
                <small>Förändringar, återkommande kostnader och långsiktiga trender</small>
              </summary>
              <div className="deep-analysis-content">
            <article className="panel insights-panel">
              <div className="panel-header">
                <div>
                  <h3>Vad förändrades?</h3>
                  <span>{monthlyInsights?.baselineLabel ?? 'Månadsanalys av konsumtionsutgifter'}</span>
                </div>
              </div>
              {periodStatus === 'future' ? (
                <p className="empty-state">Den här perioden har inte börjat ännu.</p>
              ) : selectedMonth === 'all' ? (
                <p className="empty-state">Välj en avslutad månad för att se förändringsanalysen.</p>
              ) : monthlyInsights?.status === 'incomplete-month' ? (
                <p className="empty-state">Förändringsanalys visas när månaden är avslutad.</p>
              ) : monthlyInsights?.status === 'insufficient-history' ? (
                <p className="empty-state">Mer historik behövs för att visa förändringar.</p>
              ) : monthlyInsights ? (
                <>
                  <p className="insight-summary">
                    {monthlyInsights.totalDeltaCents > 0
                      ? `Utgifterna var ${formatMoney(monthlyInsights.totalDeltaCents)} högre än normalt.`
                      : monthlyInsights.totalDeltaCents < 0
                        ? `Utgifterna var ${formatMoney(Math.abs(monthlyInsights.totalDeltaCents))} lägre än normalt.`
                        : 'Utgifterna låg på samma nivå som normalt.'}
                  </p>
                  {monthlyInsights.biggestIncreases.length === 0 &&
                    monthlyInsights.biggestDecreases.length === 0 && (
                      <p className="budget-hint">Inga större förändringar jämfört med din normala nivå.</p>
                    )}
                  <div className="insights-grid">
                    <section>
                      <h4>Största ökningar</h4>
                      {monthlyInsights.biggestIncreases.length > 0 ? (
                        <ul className="insight-list">
                          {monthlyInsights.biggestIncreases.map((change) => (
                            <li key={change.category}>
                              <span>{change.category}</span>
                              <strong>{formatSignedMoney(change.deltaCents)}</strong>
                              <small>{change.deltaPercent == null ? '' : `+${change.deltaPercent.toLocaleString('sv-SE', { maximumFractionDigits: 0 })} %`}</small>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="empty-state">Inga större ökningar.</p>}
                    </section>
                    <section>
                      <h4>Största minskningar</h4>
                      {monthlyInsights.biggestDecreases.length > 0 ? (
                        <ul className="insight-list">
                          {monthlyInsights.biggestDecreases.map((change) => (
                            <li key={change.category}>
                              <span>{change.category}</span>
                              <strong className="insight-decrease">{formatSignedMoney(change.deltaCents)}</strong>
                              <small>{change.deltaPercent == null ? '' : `${change.deltaPercent.toLocaleString('sv-SE', { maximumFractionDigits: 0 })} %`}</small>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="empty-state">Inga större minskningar.</p>}
                    </section>
                    <section>
                      <h4>Ovanligt stora köp</h4>
                      {monthlyInsights.unusualTransactions.length > 0 ? (
                        <ul className="insight-list">
                          {monthlyInsights.unusualTransactions.map((transaction) => (
                            <li key={transaction.id}>
                              <span>{transaction.merchant}</span>
                              <strong>{formatMoney(Math.abs(transaction.amountCents))}</strong>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="empty-state">Inga tydligt ovanliga köp.</p>}
                    </section>
                    <section>
                      <h4>Mest spenderat hos</h4>
                      {monthlyInsights.topMerchants.length > 0 ? (
                        <ul className="insight-list">
                          {monthlyInsights.topMerchants.map((merchant) => (
                            <li key={merchant.merchant}>
                              <span>{merchant.merchant}</span>
                              <strong>{formatMoney(merchant.spendCents)}</strong>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="empty-state">Inga konsumtionsköp i perioden.</p>}
                    </section>
                  </div>
                </>
              ) : null}
            </article>

            <article className="panel recurring-panel">
              <div className="panel-header">
                <div>
                  <h3>Återkommande kostnader</h3>
                  <span>Beräknat lokalt från upp till 12 månaders utgifter</span>
                </div>
              </div>
              {periodStatus === 'future' || recurringInsights == null ? (
                <p className="empty-state">Den här perioden har inte börjat ännu.</p>
              ) : recurringInsights.status === 'insufficient-history' ? (
                <p className="empty-state">Mer historik behövs för att identifiera återkommande kostnader.</p>
              ) : recurringInsights.status === 'no-candidates' ? (
                <p className="empty-state">Inga tydligt återkommande kostnader hittades ännu.</p>
              ) : (
                <div className="recurring-grid">
                  {recurringInsights.insights.map((insight) => {
                    const cautiousPriceCopy = insight.hasStablePriceHistory
                      ? insight.deltaFromMedianCents > 0 ? 'Pris verkar ha ökat' : 'Pris verkar ha minskat'
                      : insight.deltaFromMedianCents > 0
                        ? 'Senaste beloppet är högre än medianen'
                        : 'Senaste beloppet är lägre än medianen';
                    return (
                      <section className="recurring-card" key={insight.merchantKey}>
                        <div className="recurring-title">
                          <strong>{insight.merchantLabel}</strong>
                          <span>{recurringFrequencyLabel(insight)}</span>
                        </div>
                        <dl>
                          <div><dt>Senast</dt><dd>{formatMoney(insight.latestAmountCents)} · {formatInsightDate(insight.latestDate)}</dd></div>
                          <div><dt>Normalt</dt><dd>{formatMoney(insight.medianAmountCents)}</dd></div>
                          {insight.hasRelevantPriceChange && (
                            <div className={insight.deltaFromMedianCents > 0 ? 'price-increase' : 'price-decrease'}>
                              <dt>{cautiousPriceCopy}</dt>
                              <dd>
                                {formatSignedMoney(insight.deltaFromMedianCents)}
                                {insight.deltaPercent == null ? '' : ` (${insight.deltaPercent > 0 ? '+' : ''}${insight.deltaPercent.toLocaleString('sv-SE', { maximumFractionDigits: 1 })} %)`}
                              </dd>
                            </div>
                          )}
                          {insight.estimatedAnnualCostCents != null && (
                            <div><dt>Årskostnad</dt><dd>≈ {formatMoney(insight.estimatedAnnualCostCents)}/år</dd></div>
                          )}
                        </dl>
                        <p className="recurring-evidence">
                          {insight.frequency === 'monthly'
                            ? `${insight.activeMonths} av ${insight.monthsObserved} månader`
                            : `${insight.occurrences} betalningar under ${insight.monthsObserved} månader`}
                        </p>
                      </section>
                    );
                  })}
                </div>
              )}
            </article>

            <article className="panel trend-panel">
              <div className="panel-header">
                <div>
                  <h3>Kostnader som ökar</h3>
                  <span>Jämför robusta medianer från tidigare och senaste betalningar</span>
                </div>
              </div>
              {periodStatus === 'future' || recurringCostTrends == null ? (
                <p className="empty-state">Den här perioden har inte börjat ännu.</p>
              ) : recurringCostTrends.status === 'insufficient-history' ? (
                <p className="empty-state">Mer historik behövs för att analysera kostnadstrender.</p>
              ) : recurringCostTrends.increasing.length === 0 ? (
                <p className="empty-state">Inga tydliga långsiktiga kostnadsökningar hittades.</p>
              ) : (
                <div className="trend-grid">
                  {recurringCostTrends.increasing.map((trend) => (
                    <section className="trend-card" key={trend.merchantKey}>
                      <strong>{trend.merchantLabel}</strong>
                      <div className="trend-levels">
                        <div>
                          <span>{trend.firstPeriodLabel}</span>
                          <b>{formatMoney(trend.firstPeriodMedianCents)}</b>
                        </div>
                        <span aria-hidden="true">→</span>
                        <div>
                          <span>{trend.recentPeriodLabel}</span>
                          <b>{formatMoney(trend.recentPeriodMedianCents)}</b>
                        </div>
                      </div>
                      <p className="trend-change">
                        {formatSignedMoney(trend.deltaCents)}
                        {trend.deltaPercent == null ? '' : ` · +${trend.deltaPercent.toLocaleString('sv-SE', { maximumFractionDigits: 1 })} %`}
                      </p>
                      <p className="trend-copy">
                        {trend.amountStabilityRatio >= 0.8
                          ? `Den typiska kostnadsnivån har ökat över ${trend.monthsSpanned} månader.`
                          : `Den senaste typiska kostnadsnivån är högre än under den tidigare perioden.`}
                      </p>
                      <small>Ungefär {formatSignedMoney(trend.annualizedImpactCents)}/år i förändrad årstakt</small>
                    </section>
                  ))}
                </div>
              )}
            </article>
              </div>
            </details>
            )}

            <div className="dashboard-grid">
              <article className="panel chart-panel">
                <div className="panel-header"><div><h3>Utgifter över året</h3><span>Jämförelse per månad</span></div><div className="chart-legend"><span><i className="legend-current" />{selectedYear}</span><span><i className="legend-previous" />{comparisonYear}</span></div></div>
                <div className="monthly-chart" role="img" aria-label={`Månadsutgifter ${selectedYear} jämfört med ${comparisonYear}`}>
                  {monthlyComparison.map((item) => <div className="month-column" key={item.month} title={`${item.month}: ${formatMoney(item.current)} / ${formatMoney(item.previous)}`}><div className="bar-pair"><span className="month-bar previous-bar" style={{ height: `${Math.max(item.previousHeight, item.previous ? 2 : 0)}%` }} /><span className="month-bar current-bar" style={{ height: `${Math.max(item.currentHeight, item.current ? 2 : 0)}%` }} /></div><small>{item.month}</small></div>)}
                </div>
              </article>

              <article className="panel imports-panel">
                <div className="panel-header"><div><h3>Importöversikt</h3><span>{periodLabel}</span></div><button className="text-button" onClick={() => setActiveTab('import')}>Visa import</button></div>
                {importSources.length ? <ul className="source-list">{importSources.slice(0, 6).map(([source, total]) => <li key={source}><span title={source}>{source}</span><strong>{total}</strong></li>)}</ul> : <p className="empty-state">Inga importer i den här perioden ännu.</p>}
              </article>
            </div>

            <article className="panel budget-panel">
              <div className="panel-header"><div><h3>Konsumtionsbudget mot utfall</h3><span>{selectedMonth === 'all' ? `Årsbudget ${selectedYear} · Du har angett månadsbudget för ${budgetedMonthCount} av årets 12 månader.` : `Månadsbudget · ${periodLabel}`}</span></div>{categoryRows.length > 10 && <button className="text-button" onClick={() => setShowAllExpenseCategories((show) => !show)}>{showAllExpenseCategories ? 'Visa färre' : `Visa alla ${categoryRows.length}`}</button>}</div>
              {selectedMonth === 'all' && <p className="budget-hint">Välj en månad för att ändra budget. Saknade budgetmånader fylls inte automatiskt med 0 kr.</p>}
              {selectedMonth !== 'all' && availableBudgetCategories.length > 0 && (
                <div className="budget-category-action">
                  <button
                    className="text-button"
                    type="button"
                    aria-expanded={budgetCategoryPickerOpen}
                    onClick={() => setBudgetCategoryPickerOpen((open) => !open)}
                  >
                    + Lägg till budgetkategori
                  </button>
                  {budgetCategoryPickerOpen && (
                    <select
                      aria-label="Välj budgetkategori"
                      defaultValue=""
                      onChange={(event) => addBudgetCategory(event.target.value)}
                    >
                      <option value="" disabled>Välj kategori</option>
                      {availableBudgetCategories.map((category) => (
                        <option key={category} value={category}>{category}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <div className="category-table-wrap"><table className="category-table"><thead><tr><th>Kategori</th><th>Utfall</th><th>Budget</th><th>Kvar / över</th><th>Använt</th><th>Ändra budget</th></tr></thead><tbody>
                {visibleExpenseRows.map((item) => <tr key={item.category}><td><button className="category-link" onClick={() => { setSelectedCategoryFlow('expense'); setSelectedCategory(item.category); }}>{item.category}</button></td><td>{periodStatus === 'future' ? '—' : formatMoney(item.actualCents)}</td><td>{item.hasBudget ? formatMoney(item.budgetCents) : 'Ej angiven'}</td><td className={periodStatus !== 'future' && item.hasBudget && item.actualCents > item.budgetCents ? 'over-budget' : ''}>{periodStatus !== 'future' && item.hasBudget ? formatMoney(item.remainingCents) : '—'}</td><td>{periodStatus === 'future' || item.percentUsed == null ? '—' : `${item.percentUsed.toLocaleString('sv-SE', { maximumFractionDigits: 1 })} %`}</td><td><div className="budget-editor"><input aria-label={`Budget ${item.category}`} type="number" min="0" step="100" disabled={selectedMonth === 'all'} value={budgetDrafts[item.category] ?? ''} placeholder="0" onChange={(event) => setBudgetDrafts((current) => ({ ...current, [item.category]: event.target.value }))} /><button disabled={selectedMonth === 'all'} onClick={() => void saveBudget(item.category)}>Spara</button></div></td></tr>)}
              </tbody></table></div>
              <details className="budget-context">
                <summary>Visa historiska snitt och prognoser</summary>
                <p>Historiskt snitt baseras på {consumptionBudget.coveredMonths.length} avslutade konsumtionsmånader. Prognos kräver minst 2 avslutade månader.</p>
                <div className="table-wrap"><table><thead><tr><th>Kategori</th><th>Historiskt snitt</th><th>Prognos</th></tr></thead><tbody>
                  {visibleExpenseRows.map((item) => <tr key={item.category}><td>{item.category}</td><td>{item.historicalMonthlyAverageCents == null ? '—' : `${formatMoney(item.historicalMonthlyAverageCents)}/mån`}</td><td>{item.forecastAnnualCents == null ? 'Otillräcklig data' : `${formatMoney(item.forecastAnnualCents)}/år uppskattning`}</td></tr>)}
                </tbody></table></div>
              </details>
            </article>

            <article className="panel budget-panel income-budget-panel">
              <div className="panel-header"><div><h3>Inkomster mot mål</h3><span>Mål och utfall för vald period</span></div>{incomeRows.length > 10 && <button className="text-button" onClick={() => setShowAllIncomeCategories((show) => !show)}>{showAllIncomeCategories ? 'Visa färre' : `Visa alla ${incomeRows.length}`}</button>}</div>
              <div className="category-table-wrap"><table className="category-table"><thead><tr><th>Kategori</th><th>Utfall</th><th>Mål</th><th>Över / under</th><th>Ändra mål</th></tr></thead><tbody>
                {visibleIncomeRows.map((item) => <tr key={item.category}><td><button className="category-link" onClick={() => { setSelectedCategoryFlow('income'); setSelectedCategory(item.category); }}>{item.category}</button></td><td>{periodStatus === 'future' ? '—' : formatMoney(item.actualCents)}</td><td>{item.hasBudget ? formatMoney(item.budgetCents) : 'Ej angivet'}</td><td className={periodStatus !== 'future' && item.hasBudget ? (item.actualCents >= item.budgetCents ? 'income-on-target' : 'income-under-target') : ''}>{periodStatus !== 'future' && item.hasBudget ? formatMoney(item.actualCents - item.budgetCents) : '—'}</td><td><div className="budget-editor"><input aria-label={`Månadsbudget för inkomst ${item.category}`} type="number" min="0" step="100" disabled={selectedMonth === 'all'} value={budgetDrafts[item.category] ?? ''} placeholder="0" onChange={(event) => setBudgetDrafts((current) => ({ ...current, [item.category]: event.target.value }))} /><button disabled={selectedMonth === 'all'} onClick={() => void saveBudget(item.category)}>Spara</button></div></td></tr>)}
              </tbody></table></div>
              <details className="budget-context">
                <summary>Visa historiska snitt och prognoser</summary>
                <p>Historiskt snitt baseras på {incomeBudget.coveredMonths.length} avslutade inkomstmånader.</p>
                <div className="table-wrap"><table><thead><tr><th>Kategori</th><th>Historiskt snitt</th><th>Prognos</th></tr></thead><tbody>
                  {visibleIncomeRows.map((item) => <tr key={item.category}><td>{item.category}</td><td>{item.historicalMonthlyAverageCents == null ? '—' : `${formatMoney(item.historicalMonthlyAverageCents)}/mån`}</td><td>{item.forecastAnnualCents == null ? 'Otillräcklig data' : `${formatMoney(item.forecastAnnualCents)}/år uppskattning`}</td></tr>)}
                </tbody></table></div>
              </details>
            </article>

            <article className="panel budget-panel income-budget-panel">
              <div className="panel-header"><div><h3>Sparmål och amorteringsmål</h3><span>{periodStatus === 'future' ? 'Planering för en framtida period' : `Totalt förmögenhetsbyggande i perioden: ${formatMoney(summary.current.totalWealthBuildingCents)}`}</span></div></div>
              {wealthGoalRows.length ? <>
                <div className="category-table-wrap"><table className="category-table"><thead><tr><th>Måltyp</th><th>Kategori</th><th>Utfall</th><th>Mål</th><th>Kvar till mål</th><th>Ändra mål</th></tr></thead><tbody>
                  {wealthGoalRows.map((item) => <tr key={`${item.goalLabel}-${item.category}`}><td>{item.goalLabel}</td><td><button className="category-link" onClick={() => { setSelectedCategoryFlow('income'); setSelectedCategory(item.category); }}>{item.category}</button></td><td>{periodStatus === 'future' ? '—' : formatMoney(item.actualCents)}</td><td>{item.hasBudget ? formatMoney(item.budgetCents) : 'Ej angivet'}</td><td>{periodStatus !== 'future' && item.hasBudget ? formatMoney(item.remainingCents) : '—'}</td><td><div className="budget-editor"><input aria-label={`${item.goalLabel} ${item.category}`} type="number" min="0" step="100" disabled={selectedMonth === 'all'} value={budgetDrafts[item.category] ?? ''} placeholder="0" onChange={(event) => setBudgetDrafts((current) => ({ ...current, [item.category]: event.target.value }))} /><button disabled={selectedMonth === 'all'} onClick={() => void saveBudget(item.category)}>Spara</button></div></td></tr>)}
                </tbody></table></div>
                <details className="budget-context">
                  <summary>Visa historiska snitt och prognoser</summary>
                  <div className="table-wrap"><table><thead><tr><th>Måltyp</th><th>Kategori</th><th>Historiskt snitt</th><th>Prognos</th></tr></thead><tbody>
                    {wealthGoalRows.map((item) => <tr key={`${item.goalLabel}-${item.category}`}><td>{item.goalLabel}</td><td>{item.category}</td><td>{item.historicalMonthlyAverageCents == null ? '—' : `${formatMoney(item.historicalMonthlyAverageCents)}/mån`}</td><td>{item.forecastAnnualCents == null ? 'Otillräcklig data' : `${formatMoney(item.forecastAnnualCents)}/år uppskattning`}</td></tr>)}
                  </tbody></table></div>
                </details>
              </> : <p className="empty-state">Inga spar- eller amorteringsmål för vald period.</p>}
            </article>

            <article className="panel transactions-panel">
              <div className="panel-header"><div><h3>Transaktioner</h3><span>{reportTransactions.length.toLocaleString('sv-SE')} poster i rapporten</span></div><button className="text-button" onClick={() => setActiveTab('review')}>Granska alla</button></div>
              {reportTransactions.length ? <div className="table-wrap"><table><thead><tr><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th><th>Typ</th></tr></thead><tbody>{reportTransactions.slice(0, 20).map((row) => <tr key={row.id}><td>{row.date}</td><td>{row.merchant}</td><td className={row.amountCents < 0 ? 'amount-expense' : 'amount-income'}>{formatMoney(row.amountCents)}</td><td>{row.category}{row.needsReview && <span className="review-tag">Granska</span>}</td><td>{transactionTypeLabels[row.transactionType]}{row.transactionType === 'unclassified' && <span className="review-tag">Klassificera</span>}</td></tr>)}</tbody></table></div> : <p className="empty-state">Ingen data för perioden. Importera en eller flera bankfiler för att börja bygga din översikt.</p>}
            </article>
          </div>
        )}

        {activeTab === 'overview' && selectedCategory && <article className="panel category-detail"><div className="panel-header"><div><h3>{selectedCategoryFlow === 'income' ? 'Inkomster och sparande i' : 'Utgifter i'} {selectedCategory}</h3><span>{periodLabel} · {selectedCategoryTransactions.length} poster</span></div><strong className="category-detail-total">{formatMoney(displayedCategoryTotal)}</strong></div>{selectedCategoryTransactions.length ? <div className="table-wrap"><table><thead><tr><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th><th>Importerad från</th></tr></thead><tbody>{selectedCategoryTransactions.map((row) => { const rowId = String(row.id); const isDuplicate = duplicateIds.has(rowId); const rowCategory = categoryDrafts[rowId] ?? row.category; const showCategoryDecision = (!row.categoryDecided && isDuplicate) || rowCategory !== row.category; const displayedAmount = amountForCategoryFlow(row, selectedCategory, selectedCategoryFlow); return <tr key={row.id}><td>{row.date}</td><td>{row.merchant}</td><td className={displayedAmount < 0 ? 'amount-expense' : 'amount-income'}>{formatMoney(displayedAmount)}</td><td><CategoryPicker label={`Kategori för ${row.merchant}`} value={rowCategory} categories={categoryOptions} onChange={(category) => selectCategory(row, category)} />{showCategoryDecision && categoryDecisionActions(row, rowCategory, isDuplicate)}</td><td>{row.sourceFile || '—'}</td></tr>;})}</tbody></table></div> : <p className="empty-state">Inga poster i kategorin för vald period.</p>}</article>}

        {activeTab === 'review' && (
          <article className="panel review-panel">
            <div className="panel-header">
              <div>
                <h3>Alla transaktioner</h3>
                <span>{periodLabel} · {filteredReviewTransactions.length} matchar · {visibleReviewTransactions.length} visas · {pendingReviewTransactions.length} behöver kontrolleras</span>
              </div>
              <div className="review-filters">
                <label className="review-filter">
                  Status
                  <select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}>
                    <option value="pending">Behöver kontrolleras ({pendingReviewTransactions.length})</option>
                    <option value="checked">Kontrollerade ({reviewTransactions.length - pendingReviewTransactions.length})</option>
                    <option value="all">Alla ({reviewTransactions.length})</option>
                  </select>
                </label>
                <label className="review-filter">
                  Flöde
                  <select value={reviewDirectionFilter} onChange={(event) => setReviewDirectionFilter(event.target.value as TransactionDirectionFilter)}>
                    <option value="all">Alla ({statusFilteredReviewTransactions.length})</option>
                    <option value="incoming">Intäkter / återbetalningar ({incomingReviewCount})</option>
                    <option value="outgoing">Utgifter ({outgoingReviewCount})</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="review-explanation">
              <p><strong>Kategori</strong> beskriver vad köpet gäller, till exempel Mat eller Boende.</p>
              <p><strong>Ekonomisk typ</strong> bestämmer hur transaktionen påverkar Inkomster, Utgifter, Sparande och övriga beräkningar.</p>
            </div>
            {directionFilteredReviewTransactions.length || hasReviewColumnFilters ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th><th>Ekonomisk typ</th><th>Kontroll</th><th>Åtgärd</th></tr>
                    <tr className="table-filter-row">
                      <th>
                        <input aria-label="Filtrera på datum" type="date" value={reviewDateFilter} onChange={(event) => setReviewDateFilter(event.target.value)} />
                      </th>
                      <th>
                        <input aria-label="Filtrera på beskrivning" type="search" placeholder="Sök beskrivning" value={reviewMerchantFilter} onChange={(event) => setReviewMerchantFilter(event.target.value)} />
                      </th>
                      <th>
                        <div className="amount-filter">
                          <input aria-label="Minsta belopp" type="number" step="0.01" placeholder="Min" value={reviewMinAmount} onChange={(event) => setReviewMinAmount(event.target.value)} />
                          <input aria-label="Högsta belopp" type="number" step="0.01" placeholder="Max" value={reviewMaxAmount} onChange={(event) => setReviewMaxAmount(event.target.value)} />
                        </div>
                      </th>
                      <th>
                        <select aria-label="Filtrera på kategori" value={reviewCategoryFilter} onChange={(event) => setReviewCategoryFilter(event.target.value)}>
                          <option value="all">Alla kategorier</option>
                          {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
                        </select>
                      </th>
                      <th>
                        <select aria-label="Filtrera på ekonomisk typ" value={reviewTypeFilter} onChange={(event) => setReviewTypeFilter(event.target.value as 'all' | TransactionType)}>
                          <option value="all">Alla typer</option>
                          {transactionTypes.map((type) => <option key={type} value={type}>{transactionTypeLabels[type]}</option>)}
                        </select>
                      </th>
                      <th>
                        <select aria-label="Filtrera på kontrollstatus" value={reviewControlFilter} onChange={(event) => setReviewControlFilter(event.target.value as ReviewControlFilter)}>
                          <option value="all">Alla kontroller</option>
                          <option value="duplicate">Möjlig dublett</option>
                          <option value="category-approved">Kategori godkänd</option>
                          <option value="unclassified">Oklassificerad typ</option>
                          <option value="conflict">Kategori och typ stämmer inte</option>
                          <option value="uncertain">Osäker kategori</option>
                          <option value="checked">Kontrollerad</option>
                        </select>
                      </th>
                      <th>
                        <button className="clear-filter-btn" disabled={!hasReviewColumnFilters} onClick={clearReviewColumnFilters}>Rensa</button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleReviewTransactions.map((row) => {
                      const rowId = String(row.id);
                      const isDuplicate = duplicateIds.has(rowId);
                      const selectedCategory = categoryDrafts[rowId] ?? row.category;
                      const showCategoryDecision = (!row.categoryDecided && isDuplicate) || selectedCategory !== row.category;
                      const selectedTransactionType = transactionTypeDrafts[rowId] ?? row.transactionType;
                      const showTransactionTypeDecision = selectedTransactionType !== row.transactionType;
                      const expectedTransactionType = expectedTransactionTypeForCategory(selectedCategory);
                      const hasSemanticConflict = expectedTransactionType !== undefined &&
                        expectedTransactionType !== selectedTransactionType;
                      const similarTransactionCount = findExactMerchantTransactionIdsForType(
                        transactions,
                        row.merchant,
                        row.amountCents
                      ).length;
                      return (
                        <tr key={row.id}>
                          <td>{row.date}</td>
                          <td>{row.merchant}</td>
                          <td>{formatMoney(row.amountCents)}</td>
                          <td>
                            <CategoryPicker label={`Kategori för ${row.merchant}`} value={selectedCategory} categories={categoryOptions} onChange={(category) => selectCategory(row, category)} />
                            {showCategoryDecision && categoryDecisionActions(row, selectedCategory, isDuplicate)}
                          </td>
                          <td>
                            <select aria-label={`Ekonomisk typ för ${row.merchant}`} value={selectedTransactionType} onChange={(event) => setTransactionTypeDrafts((current) => ({ ...current, [rowId]: event.target.value as TransactionType }))}>
                              {transactionTypes.map((type) => <option key={type} value={type}>{transactionTypeLabels[type]}</option>)}
                            </select>
                            {hasSemanticConflict && (
                              <small className="review-guidance">
                                Den här kategorin brukar vara {transactionTypeLabels[expectedTransactionType].toLocaleLowerCase('sv-SE')}. Välj ekonomisk typ för att slutföra granskningen.
                              </small>
                            )}
                            {showTransactionTypeDecision && (
                              <div className="category-decision-actions">
                                <button onClick={() => void updateTransactionType(row, selectedTransactionType)}>Ändra bara den här</button>
                                <button onClick={() => void updateSimilarTransactionTypes(row, selectedTransactionType)}>Ändra {similarTransactionCount} befintliga med samma butik/mottagare och beloppsriktning</button>
                                <button onClick={() => void rememberTransactionType(row, selectedTransactionType)}>Använd även för framtida importer</button>
                              </div>
                            )}
                          </td>
                          <td>
                            {isDuplicate && <span className="duplicate-tag">Möjlig dublett</span>}
                            {isDuplicate && row.categoryDecided && <span className="clear-tag">Kategori godkänd</span>}
                            {hasSemanticConflict
                              ? <span className="review-tag">Kategori och typ stämmer inte</span>
                              : row.needsReview && <span className="review-tag">Osäker kategori</span>}
                            {row.transactionType === 'unclassified' && <span className="review-tag">Oklassificerad typ</span>}
                            {!isDuplicate && !row.needsReview && row.transactionType !== 'unclassified' && !hasSemanticConflict && <span className="clear-tag">Kontrollerad</span>}
                          </td>
                          <td><button className="delete-btn" onClick={() => void deleteTransaction(row)}>Ta bort</button></td>
                        </tr>
                      );
                    })}
                    {!filteredReviewTransactions.length && (
                      <tr>
                        <td className="table-empty-filter" colSpan={7}>
                          <span>Inga transaktioner matchar kolumnfiltren.</span>
                          <button onClick={clearReviewColumnFilters}>Rensa kolumnfilter</button>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {filteredReviewTransactions.length > REVIEW_PAGE_SIZE && (
                  <div className="table-pagination">
                    <button disabled={reviewPage === 1} onClick={() => setReviewPage((page) => Math.max(1, page - 1))}>Föregående</button>
                    <span>Sida {reviewPage} av {reviewPageCount}</span>
                    <button disabled={reviewPage === reviewPageCount} onClick={() => setReviewPage((page) => Math.min(reviewPageCount, page + 1))}>Nästa</button>
                  </div>
                )}
              </div>
            ) : (
              <p className="empty-state">
                {reviewDirectionFilter !== 'all'
                  ? `Inga ${reviewDirectionFilter === 'incoming' ? 'intäkter eller återbetalningar' : 'utgifter'} matchar det valda statusfiltret.`
                  : reviewFilter === 'pending'
                  ? 'Inga poster behöver kontrolleras i den här perioden.'
                  : reviewFilter === 'checked'
                    ? 'Inga kontrollerade poster i den här perioden.'
                    : 'Inga transaktioner i den här perioden.'}
              </p>
            )}
          </article>
        )}

        {activeTab === 'import' && (
          <article className="panel import-panel">
            <div className="panel-header">
              <div><h3>Importera bankfiler</h3><span>Excel .xlsx · välj flera filer samtidigt</span></div>
            </div>
            <label className="file-upload">
              <input
                type="file"
                accept=".xlsx"
                multiple
                disabled={importControlsDisabled({ dbReady, isAnalyzingImport, isImporting })}
                onChange={handleFiles}
              />
              <span>
                {isAnalyzingImport
                  ? 'Analyserar valda filer...'
                  : dbReady
                    ? 'Välj en eller flera Excel-filer'
                    : 'Läser in lokala kategoriregler...'}
              </span>
            </label>
            {isAnalyzingImport && (
              <p className="import-busy" role="status">
                <span className="spinner" aria-hidden="true" />
                {importAnalysisStatus}
              </p>
            )}
            <section className="import-legend" aria-label="Förklaring av importstatus">
              <div><strong>Blockerande fel</strong><span>Måste rättas innan filen kan importeras.</span></div>
              <div><strong>Varning</strong><span>Raden kan importeras men bör kontrolleras.</span></div>
              <div><strong>Möjlig dublett</strong><span>Raden liknar en tidigare transaktion men tas inte bort automatiskt.</span></div>
              <div><strong>Redan importerad fil</strong><span>Samma fil har redan lagts in tidigare.</span></div>
            </section>
            {importOutcomes.length > 0 && (
              <section className="import-results" aria-label="Resultat för valda filer">
                <h4>Importresultat</h4>
                <ul>
                  {importOutcomes.map((outcome) => (
                    <li className={outcome.status} key={`${outcome.status}-${outcome.fileName}`}>
                      <strong>
                        {outcome.status === 'imported' ? '✓' : outcome.status === 'failed' ? '✕' : '–'}
                        {' '}{outcome.fileName}
                      </strong>
                      <span>
                        {outcome.status === 'imported'
                          ? `${outcome.transactionCount} transaktioner importerades och finns kvar.`
                          : outcome.status === 'failed'
                            ? outcome.message
                            : outcome.reason}
                      </span>
                      {outcome.status === 'failed' && outcome.technicalDetails && (
                        <details>
                          <summary>Visa teknisk information</summary>
                          <pre>{outcome.technicalDetails}</pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {existingImportMatches.map(({ selectedFileName, batch }) => (
              <div className="existing-import-notice" key={`${selectedFileName}-${batch.id}`}>
                <div>
                  <strong>Den här filen har redan importerats</strong>
                  <span>
                    {selectedFileName} matchar importen {batch.fileName} från {batch.importedAt}
                    {' '}med {batch.transactionCount} transaktioner.
                  </span>
                </div>
                <button className="text-button" onClick={() => void openImportBatch(batch.id)}>Visa import</button>
              </div>
            ))}
            {previewFiles.length > 0 && (
              <div className="import-meta">
                <strong>{previewFiles.join(', ')}</strong>
                <span>
                  {previewRows.length.toLocaleString('sv-SE')} godkända rader, {importWarnings.length} varningar
                  och {importBlockingErrors.length} blockerande fel.
                </span>
              </div>
            )}
            {importIssueTable('Blockerande fel', importBlockingErrors, 'blocking')}
            {importIssueTable('Varningar och exkluderade rader', importWarnings, 'warning')}
            {previewRows.length > 0 && (
              <>
                <div className="preview-summary">
                  <span>{previewRows.length.toLocaleString('sv-SE')} godkända transaktioner</span>
                  <span>{previewRows.filter((row) => row.needsReview).length} osäkra kategorier</span>
                  <span>{previewRows.filter((row) => row.transactionType === 'unclassified').length} oklassificerade typer</span>
                  <span>{previewRows.filter((row) => previewDuplicateIds.has(String(row.id))).length} möjliga dubletter</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th><th>Typ</th><th>Kontroll</th></tr></thead>
                    <tbody>
                      {previewRows.slice(0, 100).map((row) => (
                        <tr key={row.id}>
                          <td>{row.date}</td>
                          <td>{row.merchant}</td>
                          <td>{formatMoney(row.amountCents)}</td>
                          <td>{row.category}</td>
                          <td>{transactionTypeLabels[row.transactionType]}</td>
                          <td>
                            {previewDuplicateIds.has(String(row.id)) && <span className="duplicate-tag">Möjlig dublett</span>}
                            {row.needsReview && <span className="review-tag">Osäker kategori</span>}
                            {row.transactionType === 'unclassified' && <span className="review-tag">Oklassificerad typ</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {previewRows.length > 100 && (
                    <p className="table-note">
                      Visar de första 100 godkända raderna av {previewRows.length.toLocaleString('sv-SE')}.
                      Alla varningar och blockerande fel visas ovan.
                    </p>
                  )}
                </div>
                <div className="import-actions">
                  <button
                    className="primary-btn"
                    disabled={isAnalyzingImport || isImporting || importBlockingErrors.length > 0}
                    onClick={() => void handleImport()}
                  >
                    {isAnalyzingImport
                      ? 'Analyserar filer...'
                      : isImporting
                      ? 'Importerar...'
                      : importBlockingErrors.length
                        ? 'Rätta blockerande fel före import'
                        : `Importera ${previewRows.length.toLocaleString('sv-SE')} rader`}
                  </button>
                </div>
              </>
            )}
            <details className="import-history" open={importBatches.length === 0 || undefined}>
              <summary>Importhistorik ({importBatches.length})</summary>
              <div className="import-history-content">
              {legacyTransactionCount > 0 && (
                <p className="budget-hint">
                  {legacyTransactionCount.toLocaleString('sv-SE')} äldre transaktioner saknar detaljerad importhistorik.
                </p>
              )}
              {importBatches.length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Fil</th><th>Importerad</th><th>Transaktioner</th><th>Period</th><th>Granska</th><th>Åtgärd</th></tr>
                    </thead>
                    <tbody>
                      {importBatches.map((batch) => (
                        <tr key={batch.id}>
                          <td>{batch.fileName}</td>
                          <td>{batch.importedAt}</td>
                          <td>{batch.transactionCount}</td>
                          <td>{batch.earliestDate && batch.latestDate ? `${batch.earliestDate} – ${batch.latestDate}` : '—'}</td>
                          <td>{batch.needsReviewCount}</td>
                          <td className="import-history-actions">
                            <button className="text-button" onClick={() => void openImportBatch(batch.id)}>Visa</button>
                            <button className="delete-btn" onClick={() => void undoImportBatch(batch)}>Ångra import</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="empty-state">Ingen spårbar import har genomförts ännu.</p>
              )}
              </div>
            </details>
            {selectedImportBatch && (
              <section className="import-batch-detail">
                <div className="panel-header">
                  <div>
                    <h3>{selectedImportBatch.summary.fileName}</h3>
                    <span>
                      Importerad {selectedImportBatch.summary.importedAt} · {selectedImportBatch.summary.transactionCount} transaktioner
                    </span>
                  </div>
                  <button className="text-button" onClick={() => setSelectedImportBatch(null)}>Stäng</button>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Blad</th><th>Rad</th><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th><th>Typ</th></tr></thead>
                    <tbody>
                      {selectedImportBatch.transactions.map((row) => (
                        <tr key={row.id}>
                          <td>{row.importedSheet || '—'}</td>
                          <td>{row.importedRow || '—'}</td>
                          <td>{row.date}</td>
                          <td>{row.merchant}</td>
                          <td>{formatMoney(row.amountCents)}</td>
                          <td>{row.category}</td>
                          <td>{transactionTypeLabels[row.transactionType]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="import-actions">
                  <button className="delete-btn" onClick={() => void undoImportBatch(selectedImportBatch.summary)}>
                    Ångra hela importen
                  </button>
                </div>
              </section>
            )}
          </article>
        )}
      </section>
    </main>
  );
}
