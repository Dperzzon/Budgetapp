import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { amountForCategoryFlow, createTransactionClassifier, findPotentialDuplicateIds, findSameMerchantTransactionIds, ikeaBarkarbyRules, internalTransferRule, isExcludedFromOverview, isIncludedInOverview, needsCategoryDecision, netTransactionAmount, normalizeMerchant, sortCategoriesByUsage, sumCategoryFlow, transactionsForCategoryFlow } from './lib/finance';
import { parseWorkbookSheets, type ImportedBankTransaction } from './lib/bankImport';

type Tab = 'overview' | 'import' | 'review';
type ReviewFilter = 'all' | 'pending' | 'checked';

type Transaction = ImportedBankTransaction;

type Budget = { category: string; amount: number };
type LearnedMerchantRule = { merchantKey: string; category: string };
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
const rules = [
  { id: 'ica', match: 'ICA MAXI', category: 'Mat / Dagligvaror', priority: 100 },
  { id: 'willys', match: 'WILLYS', category: 'Mat / Dagligvaror', priority: 95 },
  { id: 'netflix', match: 'NETFLIX', category: 'Abonnemang', priority: 90 },
  { id: 'spotify', match: 'SPOTIFY', category: 'Abonnemang', priority: 88 },
  { id: 'lön', match: 'LÖN', category: 'Lön', priority: 120 },
  { id: 'salary', match: 'SALARY', category: 'Lön', priority: 115 },
  { id: 'ellevio', match: 'ELLEVIO', category: 'Boende / El', priority: 80 },
  { id: 'vattenfall', match: 'VATTENFALL', category: 'Boende / El', priority: 80 },
  { id: 'fuel', match: 'CIRCLE K', category: 'Bil / Bränsle', priority: 80 },
  { id: 'okq8', match: 'OKQ8', category: 'Bil / Bränsle', priority: 80 },
  { id: 'preem', match: 'PREEM', category: 'Bil / Bränsle', priority: 80 },
  { id: 'parking', match: 'PARKERING', category: 'Bil / Parkering', priority: 75 },
  { id: 'amortization', match: 'AMORTERING', category: 'Sparande / Amortering', priority: 125 },
  internalTransferRule,
  ...ikeaBarkarbyRules,
];

const formatMoney = (value: number): string =>
  `${value.toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr`;

const unwrapCellValue = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if ('result' in value) return value.result;
  if ('richText' in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => typeof part === 'object' && part && 'text' in part ? part.text : '').join('');
  }
  if ('text' in value) return value.text;
  return value;
};

const parseWorkbookRows = async (
  file: File,
  classify: ReturnType<typeof createTransactionClassifier>
): Promise<Transaction[]> => {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheets = workbook.worksheets.map((worksheet) => {
    const rows: unknown[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      rows.push((row.values as unknown[]).slice(1).map(unwrapCellValue));
    });
    return { name: worksheet.name, rows };
  });

  return parseWorkbookSheets(sheets, file.name, file.lastModified, classify);
};

const validDate = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date);

export default function App() {
  const currentYear = new Date().getFullYear();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('pending');
  const [showAllExpenseCategories, setShowAllExpenseCategories] = useState(false);
  const [showAllIncomeCategories, setShowAllIncomeCategories] = useState(false);
  const [dbStatus, setDbStatus] = useState('Ansluter till lokal databas');
  const [dbReady, setDbReady] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [learnedRules, setLearnedRules] = useState<LearnedMerchantRule[]>([]);
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({});
  const [previewRows, setPreviewRows] = useState<Transaction[]>([]);
  const [previewFiles, setPreviewFiles] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState(String(currentYear));
  const [comparisonYear, setComparisonYear] = useState(String(currentYear - 1));
  const [selectedMonth, setSelectedMonth] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedCategoryFlow, setSelectedCategoryFlow] = useState<'expense' | 'income'>('expense');
  const [budgets, setBudgets] = useState<Record<string, number>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const classifyImportedTransaction = useMemo(() => createTransactionClassifier([
    ...learnedRules.map((rule, index) => ({
      id: `learned-${index}`,
      match: rule.merchantKey,
      category: rule.category,
      priority: 10000 - index,
      matchMode: 'merchant-similar' as const,
    })),
    ...rules,
  ]), [learnedRules]);

  const refreshTransactions = async () => {
    const stored = await invoke<Transaction[]>('get_transactions');
    setTransactions(stored);
    return stored;
  };

  useEffect(() => {
    void (async () => {
      try {
        const path = await invoke<string>('init_db');
        const stored = await refreshTransactions();
        const savedRules = await invoke<LearnedMerchantRule[]>('get_learned_rules');
        setLearnedRules(savedRules);
        const years = stored.filter((row) => validDate(row.date)).map((row) => Number(row.date.slice(0, 4)));
        const latestYear = years.length ? Math.max(...years) : currentYear;
        setSelectedYear(String(latestYear));
        setComparisonYear(String(latestYear - 1));
        setDbStatus(path);
        setDbReady(true);
      } catch (error) {
        setDbStatus(`Databasfel: ${String(error)}`);
      }
    })();
  }, [currentYear]);

  useEffect(() => {
    if (!dbReady) return;
    let active = true;
    void invoke<Budget[]>('get_budgets', {
      year: Number(selectedYear),
      month: selectedMonth === 'all' ? null : Number(selectedMonth),
    }).then((result) => {
      if (!active) return;
      const values = Object.fromEntries(result.map((item) => [item.category, item.amount]));
      setBudgets(values);
      setBudgetDrafts(Object.fromEntries(Object.entries(values).map(([category, amount]) => [category, String(amount)])));
    }).catch((error) => setErrorMessage(`Kunde inte läsa budgetar: ${String(error)}`));
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
  const selectedCategoryTotal = netTransactionAmount(selectedCategoryTransactions);
  const displayedCategoryTotal = selectedCategory === 'Sparande' && selectedCategoryFlow === 'income'
    ? sumCategoryFlow(selectedCategoryTransactions, selectedCategory, selectedCategoryFlow)
    : selectedCategoryTotal;

  const reviewTransactions = useMemo(() => transactions.filter((row) =>
    !validDate(row.date) || (row.date.startsWith(`${selectedYear}-`) &&
      (selectedMonth === 'all' || row.date.slice(5, 7) === selectedMonth.padStart(2, '0')))
  ), [transactions, selectedYear, selectedMonth]);
  const duplicateIds = useMemo(() => findPotentialDuplicateIds(transactions), [transactions]);
  const pendingReviewTransactions = reviewTransactions.filter((row) =>
    needsCategoryDecision(row, duplicateIds.has(String(row.id)))
  );
  const visibleReviewTransactions = reviewTransactions.filter((row) => {
    const needsCheck = needsCategoryDecision(row, duplicateIds.has(String(row.id)));
    return reviewFilter === 'all' || (reviewFilter === 'pending' ? needsCheck : !needsCheck);
  });

  const comparisonTransactions = useMemo(() => transactions.filter((row) =>
    validDate(row.date) && row.date.startsWith(`${comparisonYear}-`) &&
    (selectedMonth === 'all' || row.date.slice(5, 7) === selectedMonth.padStart(2, '0')) &&
    isIncludedInOverview(row)
  ), [transactions, comparisonYear, selectedMonth]);

  const summary = useMemo(() => {
    const summarize = (rows: Transaction[]) => {
      let income = 0;
      let expenses = 0;
      for (const row of rows) {
        if (row.amount > 0) income += row.amount;
        if (row.amount < 0 && row.category !== 'Sparande') expenses += Math.abs(row.amount);
      }
      return { income, expenses, net: income - expenses };
    };
    return { current: summarize(reportTransactions), comparison: summarize(comparisonTransactions) };
  }, [reportTransactions, comparisonTransactions]);

  const categoryRows = useMemo(() => {
    const actualByCategory = new Map<string, number>();
    const annualByCategory = new Map<string, number>();
    for (const row of reportTransactions) {
      if (row.amount < 0 && row.category !== 'Sparande') {
        actualByCategory.set(row.category, (actualByCategory.get(row.category) ?? 0) + Math.abs(row.amount));
      }
    }
    for (const row of transactions) {
      if (validDate(row.date) && row.date.startsWith(`${selectedYear}-`) && row.amount < 0 &&
          row.category !== 'Sparande' && !isExcludedFromOverview(row.category)) {
        annualByCategory.set(row.category, (annualByCategory.get(row.category) ?? 0) + Math.abs(row.amount));
      }
    }
    return [...actualByCategory.keys()].map((category) => ({
      category,
      actual: actualByCategory.get(category) ?? 0,
      monthlyAverage: (annualByCategory.get(category) ?? 0) / 12,
      budget: budgets[category] ?? 0,
    })).sort((a, b) => b.actual - a.actual || a.category.localeCompare(b.category, 'sv'));
  }, [transactions, reportTransactions, selectedYear, budgets]);

  const incomeRows = useMemo(() => {
    const actualByCategory = new Map<string, number>();
    const annualByCategory = new Map<string, number>();
    const addIncome = (totals: Map<string, number>, row: Transaction) => {
      if (row.category === 'Sparande') {
        totals.set(row.category, (totals.get(row.category) ?? 0) - row.amount);
      } else if (row.amount > 0) {
        totals.set(row.category, (totals.get(row.category) ?? 0) + row.amount);
      }
    };
    for (const row of reportTransactions) addIncome(actualByCategory, row);
    for (const row of transactions) {
      if (validDate(row.date) && row.date.startsWith(`${selectedYear}-`) &&
          (row.amount > 0 || row.category === 'Sparande') && !isExcludedFromOverview(row.category)) {
        addIncome(annualByCategory, row);
      }
    }
    const names = new Set([
      'Lön', 'Bidrag', 'Uthyrning', 'Sparande',
      ...annualByCategory.keys(),
      ...Object.keys(budgets).filter((category) => ['Lön', 'Bidrag', 'Uthyrning', 'Sparande'].includes(category)),
    ]);

    return [...names].map((category) => ({
      category,
      actual: actualByCategory.get(category) ?? 0,
      monthlyAverage: (annualByCategory.get(category) ?? 0) / 12,
      budget: budgets[category] ?? 0,
    })).sort((a, b) => b.actual - a.actual || a.category.localeCompare(b.category, 'sv'));
  }, [transactions, reportTransactions, selectedYear, budgets]);
  const visibleExpenseRows = showAllExpenseCategories ? categoryRows : categoryRows.slice(0, 10);
  const visibleIncomeRows = showAllIncomeCategories ? incomeRows : incomeRows.slice(0, 10);

  const monthlyComparison = useMemo(() => {
    const current = Array(12).fill(0) as number[];
    const previous = Array(12).fill(0) as number[];
    transactions.forEach((row) => {
      if (row.amount >= 0 || !validDate(row.date) || isExcludedFromOverview(row.category)) return;
      const monthIndex = Number(row.date.slice(5, 7)) - 1;
      if (row.date.startsWith(`${selectedYear}-`)) current[monthIndex] += Math.abs(row.amount);
      if (row.date.startsWith(`${comparisonYear}-`)) previous[monthIndex] += Math.abs(row.amount);
    });
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
    if (!dbReady) {
      setErrorMessage('Vänta tills den lokala databasen och tidigare kategorival har laddats.');
      return;
    }
    const invalid = files.filter((file) => !file.name.toLowerCase().endsWith('.xlsx'));
    if (invalid.length) {
      setErrorMessage('Endast .xlsx-filer stöds.');
      return;
    }

    try {
      setErrorMessage('');
      setStatusMessage('Läser bankfiler...');
      const rows = (await Promise.all(files.map((file) => parseWorkbookRows(file, classifyImportedTransaction)))).flat();
      setPreviewRows(rows);
      setPreviewFiles(files.map((file) => file.name));
      setStatusMessage(`${rows.length} rader hittades i ${files.length} fil(er). Kontrollera urvalet innan import.`);
    } catch (error) {
      setStatusMessage('');
      setErrorMessage(error instanceof Error ? error.message : 'Kunde inte läsa bankfilen.');
    }
  };

  const handleImport = async () => {
    if (!previewRows.length) return;
    setIsImporting(true);
    setErrorMessage('');
    try {
      const insertedCount = await invoke<number>('save_transactions', {
        transactions: previewRows.map((row) => ({
          merchant: row.merchant,
          amount: row.amount,
          category: row.category,
          date: row.date,
          source_file: row.sourceFile,
          needs_review: row.needsReview,
        })),
      });
      const stored = await refreshTransactions();
      setStatusMessage(`${insertedCount} transaktioner importerades. Möjliga dubletter är markerade för manuell kontroll.`);
      setPreviewRows([]);
      setPreviewFiles([]);
      setActiveTab('overview');
      const importedYears = stored.filter((row) => validDate(row.date)).map((row) => Number(row.date.slice(0, 4)));
      if (importedYears.length) {
        setSelectedYear(String(Math.max(...importedYears)));
        setComparisonYear(String(Math.max(...importedYears) - 1));
      }
    } catch (error) {
      setErrorMessage(`Importen misslyckades: ${String(error)}`);
    } finally {
      setIsImporting(false);
    }
  };

  const saveBudget = async (category: string) => {
    if (selectedMonth === 'all') return;
    const amount = Number(budgetDrafts[category] ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      setErrorMessage('Budgeten måste vara ett positivt belopp.');
      return;
    }
    try {
      await invoke('save_budget', { year: Number(selectedYear), month: Number(selectedMonth), category, amount });
      setBudgets((current) => ({ ...current, [category]: amount }));
      setStatusMessage(`Budget för ${category} sparad.`);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(`Kunde inte spara budget: ${String(error)}`);
    }
  };

  const categorize = async (row: Transaction, category: string) => {
    try {
      const merchantKey = row.merchant === 'Okänd merchant'
        ? ''
        : normalizeMerchant(row.merchant).normalized;
      const matchingIds = findSameMerchantTransactionIds(transactions, row.merchant);
      const transactionIds = matchingIds.includes(String(row.id))
        ? matchingIds
        : [...matchingIds, String(row.id)];
      const updatedCount = await invoke<number>('update_transaction_category', {
        ids: transactionIds.map(Number),
        category,
        merchantKey,
      });
      const matchingIdSet = new Set(transactionIds);
      setTransactions((current) => current.map((item) => matchingIdSet.has(String(item.id))
        ? { ...item, category, needsReview: false, categoryDecided: true }
        : item));
      if (merchantKey) {
        setLearnedRules((current) => [
          ...current.filter((rule) => rule.merchantKey !== merchantKey),
          { merchantKey, category },
        ]);
      }
      setCategoryDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => !matchingIdSet.has(id))
      ));
      setStatusMessage(`${category} valdes för ${updatedCount} transaktioner med namnet ${row.merchant}. Valet sparas även för framtida importer.`);
    } catch (error) {
      setErrorMessage(`Kunde inte uppdatera kategorin: ${String(error)}`);
    }
  };

  const selectCategory = (row: Transaction, category: string) => {
    if (duplicateIds.has(String(row.id))) {
      setCategoryDrafts((current) => ({ ...current, [String(row.id)]: category }));
      return;
    }
    void categorize(row, category);
  };

  const approveCategory = (row: Transaction) => {
    const category = categoryDrafts[String(row.id)] ?? row.category;
    void categorize(row, category);
  };

  const rejectCategory = async (row: Transaction) => {
    try {
      await invoke('reject_transaction_category', { id: Number(row.id) });
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
      setErrorMessage(`Kunde inte neka kategorin: ${String(error)}`);
    }
  };

  const deleteTransaction = async (row: Transaction) => {
    if (!window.confirm(`Ta bort transaktionen ${row.merchant} (${formatMoney(row.amount)})?`)) return;
    try {
      await invoke('delete_transaction', { id: Number(row.id) });
      setTransactions((current) => current.filter((item) => item.id !== row.id));
      setStatusMessage(`${row.merchant} togs bort.`);
    } catch (error) {
      setErrorMessage(`Kunde inte ta bort transaktionen: ${String(error)}`);
    }
  };

  const periodLabel = selectedMonth === 'all' ? selectedYear : `${monthNames[Number(selectedMonth) - 1]} ${selectedYear}`;
  const comparisonLabel = selectedMonth === 'all' ? comparisonYear : `${monthNames[Number(selectedMonth) - 1]} ${comparisonYear}`;

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
          <button className="primary-btn" disabled={!dbReady} onClick={() => setActiveTab('import')}>+ Importera Excel</button>
        </header>

        {statusMessage && <p className="status-message" role="status">{statusMessage}</p>}
        {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}

        <div className="filter-bar">
          <label>År<select value={selectedYear} onChange={(event) => setSelectedYear(event.target.value)}>{yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
          <label>Månad<select value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}><option value="all">Hela året</option>{monthNames.map((month, index) => <option key={month} value={String(index + 1)}>{month}</option>)}</select></label>
          <label>Jämför med<select value={comparisonYear} onChange={(event) => setComparisonYear(event.target.value)}>{yearOptions.filter((year) => year !== selectedYear).map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
          <span className="period-count">{reportTransactions.length.toLocaleString('sv-SE')} transaktioner i perioden</span>
        </div>

        {activeTab === 'overview' && !selectedCategory && (
          <>
            <div className="stats-grid">
              <article className="stat-card expense"><span>Utgifter</span><strong>{formatMoney(summary.current.expenses)}</strong><small>{formatMoney(summary.current.expenses - summary.comparison.expenses)} mot {comparisonLabel}</small></article>
              <article className="stat-card income"><span>Inkomster</span><strong>{formatMoney(summary.current.income)}</strong><small>{formatMoney(summary.current.income - summary.comparison.income)} mot {comparisonLabel}</small></article>
              <article className="stat-card neutral"><span>Netto</span><strong>{formatMoney(summary.current.net)}</strong><small>{formatMoney(summary.current.net - summary.comparison.net)} mot {comparisonLabel}</small></article>
              <article className="stat-card save"><span>Behöver granskas</span><strong>{reportTransactions.filter((row) => needsCategoryDecision(row, duplicateIds.has(String(row.id)))).length}</strong><small>osäkra kategorier eller dubbletter utan beslut</small></article>
            </div>

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
              <div className="panel-header"><div><h3>Budget mot utfall</h3><span>{selectedMonth === 'all' ? `Årsutfall ${selectedYear}, budget summerad från årets månader` : `Månadsbudget · ${periodLabel}`}</span></div>{categoryRows.length > 10 && <button className="text-button" onClick={() => setShowAllExpenseCategories((show) => !show)}>{showAllExpenseCategories ? 'Visa färre' : `Visa alla ${categoryRows.length}`}</button>}</div>
              {selectedMonth === 'all' && <p className="budget-hint">Välj en månad för att ändra budget. Årsbudgeten summeras automatiskt från sparade månadsbudgetar.</p>}
              <div className="category-table-wrap"><table className="category-table"><thead><tr><th>Kategori</th><th>Utfall</th><th>Per månad</th><th>Budget</th><th>Kvar</th><th>Budget</th></tr></thead><tbody>
                {visibleExpenseRows.map((item) => <tr key={item.category}><td><button className="category-link" onClick={() => { setSelectedCategoryFlow('expense'); setSelectedCategory(item.category); }}>{item.category}</button></td><td>{formatMoney(item.actual)}</td><td>{formatMoney(item.monthlyAverage)}</td><td>{item.budget ? formatMoney(item.budget) : 'Ej angiven'}</td><td className={item.budget && item.actual > item.budget ? 'over-budget' : ''}>{item.budget ? formatMoney(item.budget - item.actual) : '—'}</td><td><div className="budget-editor"><input aria-label={`Budget ${item.category}`} type="number" min="0" step="100" disabled={selectedMonth === 'all'} value={budgetDrafts[item.category] ?? ''} placeholder="0" onChange={(event) => setBudgetDrafts((current) => ({ ...current, [item.category]: event.target.value }))} /><button disabled={selectedMonth === 'all'} onClick={() => void saveBudget(item.category)}>Spara</button></div></td></tr>)}
              </tbody></table></div>
            </article>

            <article className="panel budget-panel income-budget-panel">
              <div className="panel-header"><div><h3>Inkomster mot mål</h3><span>{selectedMonth === 'all' ? `Årsutfall ${selectedYear}, genomsnitt per månad` : `Periodutfall · ${periodLabel} med årets månadsgenomsnitt`}</span></div>{incomeRows.length > 10 && <button className="text-button" onClick={() => setShowAllIncomeCategories((show) => !show)}>{showAllIncomeCategories ? 'Visa färre' : `Visa alla ${incomeRows.length}`}</button>}</div>
              <div className="category-table-wrap"><table className="category-table"><thead><tr><th>Kategori</th><th>Utfall</th><th>Per månad</th><th>Mål</th><th>Över / under</th><th>Månadsbudget</th></tr></thead><tbody>
                {visibleIncomeRows.map((item) => <tr key={item.category}><td><button className="category-link" onClick={() => { setSelectedCategoryFlow('income'); setSelectedCategory(item.category); }}>{item.category}</button></td><td>{formatMoney(item.actual)}</td><td>{formatMoney(item.monthlyAverage)}</td><td>{item.budget ? formatMoney(item.budget) : 'Ej angivet'}</td><td className={item.budget ? (item.actual >= item.budget ? 'income-on-target' : 'income-under-target') : ''}>{item.budget ? formatMoney(item.actual - item.budget) : '—'}</td><td><div className="budget-editor"><input aria-label={`Månadsbudget för inkomst ${item.category}`} type="number" min="0" step="100" disabled={selectedMonth === 'all'} value={budgetDrafts[item.category] ?? ''} placeholder="0" onChange={(event) => setBudgetDrafts((current) => ({ ...current, [item.category]: event.target.value }))} /><button disabled={selectedMonth === 'all'} onClick={() => void saveBudget(item.category)}>Spara</button></div></td></tr>)}
              </tbody></table></div>
            </article>

            <article className="panel transactions-panel">
              <div className="panel-header"><div><h3>Transaktioner</h3><span>{reportTransactions.length.toLocaleString('sv-SE')} poster i rapporten</span></div><button className="text-button" onClick={() => setActiveTab('review')}>Granska alla</button></div>
              {reportTransactions.length ? <div className="table-wrap"><table><thead><tr><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th></tr></thead><tbody>{reportTransactions.slice(0, 20).map((row) => <tr key={row.id}><td>{row.date}</td><td>{row.merchant}</td><td className={row.amount < 0 ? 'amount-expense' : 'amount-income'}>{formatMoney(row.amount)}</td><td>{row.category}{row.needsReview && <span className="review-tag">Granska</span>}</td></tr>)}</tbody></table></div> : <p className="empty-state">Ingen data för perioden. Importera en eller flera bankfiler för att börja bygga din översikt.</p>}
            </article>
          </>
        )}

        {activeTab === 'overview' && selectedCategory && <article className="panel category-detail"><div className="panel-header"><div><h3>{selectedCategoryFlow === 'income' ? 'Inkomster och sparande i' : 'Utgifter i'} {selectedCategory}</h3><span>{periodLabel} · {selectedCategoryTransactions.length} poster</span></div><strong className="category-detail-total">{formatMoney(displayedCategoryTotal)}</strong></div>{selectedCategoryTransactions.length ? <div className="table-wrap"><table><thead><tr><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th><th>Importerad från</th></tr></thead><tbody>{selectedCategoryTransactions.map((row) => { const rowId = String(row.id); const isDuplicate = duplicateIds.has(rowId); const rowCategory = categoryDrafts[rowId] ?? row.category; const showCategoryDecision = isDuplicate && (!row.categoryDecided || rowCategory !== row.category); const displayedAmount = amountForCategoryFlow(row, selectedCategory, selectedCategoryFlow); return <tr key={row.id}><td>{row.date}</td><td>{row.merchant}</td><td className={displayedAmount < 0 ? 'amount-expense' : 'amount-income'}>{formatMoney(displayedAmount)}</td><td><CategoryPicker label={`Kategori för ${row.merchant}`} value={rowCategory} categories={categoryOptions} onChange={(category) => selectCategory(row, category)} />{showCategoryDecision && <div className="category-decision-actions"><button className="approve-category-btn" disabled={rowCategory === 'Okategoriserat'} onClick={() => approveCategory(row)}>Godkänn kategori</button><button className="reject-category-btn" disabled={rowCategory === 'Okategoriserat'} onClick={() => void rejectCategory(row)}>Neka</button></div>}</td><td>{row.sourceFile || '—'}</td></tr>;})}</tbody></table></div> : <p className="empty-state">Inga poster i kategorin för vald period.</p>}</article>}

        {activeTab === 'review' && <article className="panel review-panel"><div className="panel-header"><div><h3>Alla transaktioner</h3><span>{periodLabel} · {visibleReviewTransactions.length} visas · {pendingReviewTransactions.length} behöver kontrolleras</span></div><label className="review-filter">Visa<select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}><option value="pending">Behöver kontrolleras ({pendingReviewTransactions.length})</option><option value="checked">Kontrollerade ({reviewTransactions.length - pendingReviewTransactions.length})</option><option value="all">Alla ({reviewTransactions.length})</option></select></label></div>{visibleReviewTransactions.length ? <div className="table-wrap"><table><thead><tr><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th><th>Kontroll</th><th>Åtgärd</th></tr></thead><tbody>{visibleReviewTransactions.map((row) => { const rowId = String(row.id); const isDuplicate = duplicateIds.has(rowId); const selectedCategory = categoryDrafts[rowId] ?? row.category; const showCategoryDecision = isDuplicate && (!row.categoryDecided || selectedCategory !== row.category); return <tr key={row.id}><td>{row.date}</td><td>{row.merchant}</td><td>{formatMoney(row.amount)}</td><td><CategoryPicker label={`Kategori för ${row.merchant}`} value={selectedCategory} categories={categoryOptions} onChange={(category) => selectCategory(row, category)} />{showCategoryDecision && <div className="category-decision-actions"><button className="approve-category-btn" disabled={selectedCategory === 'Okategoriserat'} onClick={() => approveCategory(row)}>Godkänn kategori</button><button className="reject-category-btn" disabled={selectedCategory === 'Okategoriserat'} onClick={() => void rejectCategory(row)}>Neka</button></div>}</td><td>{isDuplicate && <span className="duplicate-tag">Möjlig dublett</span>}{isDuplicate && row.categoryDecided && <span className="clear-tag">Kategori godkänd</span>}{row.needsReview && <span className="review-tag">Osäker kategori</span>}{!isDuplicate && !row.needsReview && <span className="clear-tag">Kontrollerad</span>}</td><td><button className="delete-btn" onClick={() => void deleteTransaction(row)}>Ta bort</button></td></tr>;})}</tbody></table></div> : <p className="empty-state">{reviewFilter === 'pending' ? 'Inga poster behöver kontrolleras i den här perioden.' : reviewFilter === 'checked' ? 'Inga kontrollerade poster i den här perioden.' : 'Inga transaktioner i den här perioden.'}</p>}</article>}

        {activeTab === 'import' && <article className="panel import-panel"><div className="panel-header"><div><h3>Importera bankfiler</h3><span>Excel .xlsx · välj flera filer samtidigt</span></div></div><label className="file-upload"><input type="file" accept=".xlsx" multiple disabled={!dbReady} onChange={handleFiles} /><span>{dbReady ? 'Välj en eller flera Excel-filer' : 'Läser in lokala kategoriregler...'}</span></label>{previewFiles.length > 0 && <div className="import-meta"><strong>{previewFiles.join(', ')}</strong><span>{previewRows.length.toLocaleString('sv-SE')} rader hittades. Möjliga dubletter importeras och flaggas för manuell kontroll.</span></div>}{previewRows.length > 0 && <><div className="preview-summary"><span>{previewRows.length.toLocaleString('sv-SE')} transaktioner</span><span>{previewRows.filter((row) => row.needsReview).length} osäkra kategorier</span><span>{previewRows.filter((row) => previewDuplicateIds.has(String(row.id))).length} möjliga dubletter</span></div><div className="table-wrap"><table><thead><tr><th>Datum</th><th>Beskrivning</th><th>Belopp</th><th>Kategori</th><th>Kontroll</th></tr></thead><tbody>{previewRows.slice(0, 100).map((row) => <tr key={row.id}><td>{row.date}</td><td>{row.merchant}</td><td>{formatMoney(row.amount)}</td><td>{row.category}</td><td>{previewDuplicateIds.has(String(row.id)) && <span className="duplicate-tag">Möjlig dublett</span>}{row.needsReview && <span className="review-tag">Osäker kategori</span>}</td></tr>)}</tbody></table>{previewRows.length > 100 && <p className="table-note">Visar de första 100 raderna av {previewRows.length.toLocaleString('sv-SE')}. Alla rader importeras.</p>}</div><div className="import-actions"><button className="primary-btn" disabled={isImporting} onClick={() => void handleImport()}>{isImporting ? 'Importerar...' : `Importera ${previewRows.length.toLocaleString('sv-SE')} rader`}</button></div></>}</article>}
      </section>
    </main>
  );
}
