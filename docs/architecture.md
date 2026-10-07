# Arkitektur

## Slutlig tech stack
- Tauri 2
- React 19
- TypeScript
- SQLite via local Rust database layer
- Vitest for unit and regression tests
- GitHub Actions for CI
- No Azure infrastructure in v1 because the app is intentionally local-first and cost-sensitive.

## Desktop architecture
The desktop app runs as a local Tauri shell with a React UI and a Rust-backed SQLite datastore. The data lives in the OS app data directory, which keeps costs near zero and avoids cloud dependencies.

The overview has four presentation modes derived without changing financial calculations: `first-run`, `month`, `year`, and `future-month`. An initialized database with no transactions shows only a local-first import introduction. Month views prioritize financial health, core totals, budgets, and review work; detailed monthly change, recurring-cost, and trend views are grouped in a keyboard-accessible collapsed `details` section. Year views omit that month-analysis group, and future months retain budget planning while suppressing outcome presentation.

Previous and next month controls use calendar month boundaries and complement the existing selectors. Navigation may enter future months because they are valid planning periods; the central period status keeps them visibly marked as planning and prevents outcome semantics.

## Database design
A local SQLite database stores transaction history, import batches, categories, learned merchant rules, and monthly category budgets. `PRAGMA user_version` identifies the supported schema. Ordered migrations run in SQLite transactions, newer unknown schema versions are rejected, and foreign keys are enabled for every application connection. Schema version 3 adds a required `transaction_type` with a database `CHECK` constraint for `income`, `expense`, `saving`, `amortization`, `transfer`, `refund`, and `unclassified`.

Schema version 4 replaces active `REAL` money storage with `transactions.amount_cents INTEGER NOT NULL` and `budgets.amount_cents INTEGER NOT NULL`. The migration rebuilds both tables, preserves transaction IDs, import-batch foreign keys, provenance, categories, transaction types, review state, and budget identities, then verifies row counts, metadata, cent totals, and `PRAGMA foreign_key_check` before commit. There is no permanent dual-write model.

Schema version 5 adds `learned_transaction_type_rules`, keyed by the exact normalized merchant key with the same constrained transaction-type values as transactions. Type rules are separate from category rules because they control financial semantics, not what a purchase concerns.

Before a database below schema 4 with an existing transaction table is migrated, SQLite's backup API creates a local sibling file named like `budgetapp.pre-schema-4-<timestamp>.sqlite`. A failed migration leaves both the original schema and the backup intact, and the initialization error reports the backup path.

Legacy `REAL` values are multiplied by 100 in Rust and compared with the nearest integer. Conversion is accepted only when the difference is at most `1e-7` cents and the result is within JavaScript's safe-integer range. Rust's round-to-nearest, half-away-from-zero rule is explicit, although a genuine half-cent is rejected by the precision check rather than rounded. This accepts representational noise such as `10.099999999999` but blocks real extra precision such as `10.123`.

The schema is intentionally simple and deterministic so that the app can be audited and data can be exported or repaired without a cloud service.

## Excel import architecture
The import pipeline is deterministic and conservative:
1. load selected `.xlsx` files locally
2. find a worksheet header row with date and amount columns
3. map common Swedish and English bank headers
4. normalize dates, amounts, and merchant descriptions
5. apply previously learned merchant rules first, then built-in deterministic rules
6. flag uncertain merchants or invalid dates for manual review
7. preview parsed transactions before confirmation
8. flag possible duplicates matching date, merchant, and amount without suppressing any row
9. calculate a local SHA-256 hash from the exact file bytes and block files that already have an import batch
10. persist the import batch and all accepted transactions atomically with source file, worksheet, and Excel row provenance

Import analysis uses a latest-run token. Hashing, duplicate checks, workbook loading, parsing, and validation keep the file controls disabled, and only the latest active run may publish preview state. Multi-file persistence remains atomic per file rather than across the entire selection. Files are processed in order; if one fails, earlier successful files remain committed and are reported explicitly, the failed file is reported as not saved, and later files are marked as skipped. Exact-file SHA-256 protection makes retrying the selection safe.

Tracked imports are listed from SQL aggregates rather than duplicated counters. Deleting an import batch uses the transaction foreign key with `ON DELETE CASCADE`, so its transactions are removed atomically while legacy transactions, other batches, and learned rules remain untouched. Existing transactions created before import batches keep nullable provenance and are not assigned fabricated batches.

The dashboard filters persisted rows by year and month. It compares the selected period with the same month or year from a separately selected comparison year. Monthly budgets are editable per category and stored in SQLite; annual budget totals sum that year's monthly budgets. The review view allows changing the category, changing the economic type of only the selected transaction, or explicitly deleting a selected transaction. Invalid imported dates are blocking validation errors and are not persisted.

The annual overview shows average monthly consumption across completed months with relevant expense data. Its monthly comparison chart is placed directly after the financial summary and before the detailed budget tables.

Changing a category affects only the selected transaction by default. The user can explicitly choose an exact normalized-merchant bulk update or save an exact learned rule for future imports; neither happens implicitly. Historical bulk changes require confirmation with the affected count. Remembering a category atomically updates the selected transaction and upserts the future rule in one SQLite transaction. Category describes what a transaction concerns, while `transaction_type` independently controls its financial effect.

Changing an economic type also starts as an unsaved draft. The user must explicitly choose `Endast denna`, `Ändra liknande`, or `Kom ihåg framåt`. Exact bulk updates are atomic and affect only rows with the same normalized merchant key and the same amount direction; positive and negative rows can never be changed together. Remembering a type atomically updates the selected row and stores a direction-specific rule for future imports, so a refund rule cannot reclassify later purchases from the same merchant. It never rewrites historical matches and never changes category. Swish normalization is direction-aware: received and sent Swish use different keys while phone-number variants within the same direction can share a rule.

Legacy rows are mapped deterministically during the version 2 to 3 migration: `Överföring mellan konto` becomes `transfer`, `Sparande` becomes `saving`, `Sparande / Amortering` becomes `amortization`, positive `Lön`, `Bidrag`, and `Uthyrning` become `income`, and other negative values become `expense`. Other positive and zero values become `unclassified`; migration never rewrites categories. New imports use the same conservative mapping, so a positive refund or transfer is not guessed to be income.

Negative `LANDSHYPOTEK` payments above 35,000 SEK are split atomically in the database. The original row is reduced by 35,000 SEK and stored as `Boende / Ränta` with type `expense`; a second row of 35,000 SEK is stored as `Sparande / Amortering` with type `amortization`. Schema migration 5 to 6 applies the same split once to historical rows, while all later imports use the same backend rule.

Financial calculations live in `finance.ts` and are shared by dashboard, monthly comparison, category outcomes, and budgets. All values below are integer cents and conversion to kronor happens only in the central presentation formatter:
- income = sum of `income` amounts
- consumption expenses = negative sum of `expense` and `refund` amounts
- direct savings = negative sum of `saving` amounts
- amortization = negative sum of `amortization` amounts
- total wealth building = direct savings + amortization
- remaining after spending and saving = income - consumption expenses - direct savings - amortization

Only `expense` and `refund` affect consumption-category budget outcomes. Transfers and unclassified rows affect none of the main financial totals, and unclassified rows remain visible in the review queue.

`getPeriodStatus` is the shared definition of `past`, `current`, and `future` for selected months. Future months remain editable for budget planning, but the UI suppresses period outcomes, under-budget and under-goal assessments, monthly changes, recurring-cost results, cost trends, and financial-health conclusions until the period starts.

## Monthly change insights
Monthly insights are derived in memory by `buildMonthlyInsights` in `finance.ts`; no insight data is persisted. Full analysis is available only for a selected completed month. The year view asks the user to select a month, and the current or a future month states that analysis will be available after the month closes.

The baseline uses all earlier completed months that contain `expense` or `refund` data. With at least two such months, each category baseline and the total baseline are the rounded monthly averages across the same month set, including zero for months where a category was absent. With exactly one historical month, comparison is allowed only when it is the immediately previous calendar month. Older isolated history separated by a gap is not presented as the previous-month fallback. With no valid baseline, no synthetic change is shown.

Category consumption follows the existing financial semantics:

```text
actual = -sum(expense and refund amounts)
delta = current actual - baseline actual
percent = delta / baseline * 100, only when baseline > 0
```

A category is displayed as a meaningful change when its absolute delta is at least 200 kr, or when its absolute delta is at least 100 kr and its absolute percentage change is at least 20 percent. This prevents tiny amounts with dramatic percentages from dominating.

Unusual purchases consider only negative `expense` transactions in the selected month. At least five historical expense transactions from the baseline months are required. The threshold is the larger of 1,000 kr and three times the historical median expense size. A merchant with at least two prior exact-normalized purchases is suppressed when the current amount is no more than 1.5 times that merchant's historical median, avoiding a simple form of false positive without introducing recurring-expense detection.

Top merchants use the existing conservative normalized merchant key. `expense` and `refund` amounts for the same exact key are netted, merchants with non-positive net spend are omitted, and broad merchant-family or fuzzy matching is not used.

## Recurring expense insights
Recurring insights are derived in memory by `buildRecurringExpenseInsights`; no recurring flags, frequencies, confidence levels, or normal amounts are persisted. Analysis uses negative `expense` transactions within the 12-month lookback ending at the selected reference month. A charge already present in the current month may be the latest occurrence, but an absent current-month charge is never treated as missing evidence.

Transactions are grouped only by the existing exact normalized merchant key. A merchant with more than 1.5 transactions per active month or more than two transactions in any analyzed month is excluded before frequency detection. This prevents frequent shops from being presented as periodic debits without a hardcoded merchant list.

Calendar-month intervals determine frequency:
- monthly: at least three occurrences and at least 60 percent of intervals are one or two calendar months
- quarterly: at least three occurrences and at least 60 percent of intervals are two through four calendar months
- annual: at least two occurrences and at least 60 percent of intervals are 11 through 13 calendar months
- irregular: at least four occurrences, no periodic match, and at least 80 percent amount stability

Monthly detection runs before quarterly detection so an occasional missed monthly charge remains monthly. Date-of-month differences do not matter. At least two completed months containing eligible expenses are required before any candidate is shown.

The normal amount is the median absolute expense amount. Amount stability is the share of occurrences within plus or minus 15 percent of that median. High confidence requires a periodic frequency, at least five occurrences, at least 80 percent matching intervals, at least 80 percent amount stability, and at least 90 percent active-month coverage. Medium confidence requires a periodic frequency with at least 60 percent interval regularity and amount stability. Other retained candidates are low confidence.

The latest amount is compared with the median of all earlier occurrences, excluding itself. A price difference is relevant when its absolute amount is at least 20 kr, or at least 10 kr together with an absolute percentage difference of at least 10 percent. Stable histories use cautious “price seems to have changed” copy; unstable histories only state that the latest amount is above or below the median.

Annualized cost uses the all-occurrence median:

```text
monthly = median * 12
quarterly = median * 4
annual = median
irregular = unavailable
```

Candidates are sorted by relevant price increase, then confidence, annualized cost, and merchant label. At most eight are shown.

## Recurring cost trends
Long-term trends reuse the same recurring candidate derivation, merchant grouping, frequency detection, amount stability, and false-positive filtering. The trend builder uses a 36-month lookback so annual costs can reach the required three observations; the ordinary recurring-cost UI remains limited to 12 months. Irregular candidates are excluded.

Monthly and quarterly candidates require at least five observations spanning at least four calendar months. Annual candidates require at least three observations, so two annual payments never create a long-term trend.

Period levels use medians rather than individual endpoint payments:
- 5–7 observations: first two payments compared with the last two
- 8 or more observations: the first `floor(count / 3)` payments compared with the last equally sized group
- three annual observations: the same first-two/last-two rule, with the middle observation shared

The formulas are:

```text
delta = recent period median - first period median
percent = delta / first period median * 100
```

A trend is increasing or decreasing only when the absolute delta is at least 20 kr and the absolute percentage is at least 5 percent. Everything else is stable. A single latest-payment spike therefore remains a Phase 2B signal but normally cannot establish a Phase 2C trend.

Trend confidence is intentionally stricter than candidate confidence:
- high: a clear trend, medium/high recurring candidate, at least six observations, at least 80 percent amount stability, and at least 60 percent successive changes in the trend direction
- medium: a clear trend, medium/high recurring candidate, and at least 60 percent amount stability
- low: other eligible evidence

Low-confidence increases are retained in the derived model but hidden from the main UI. Increasing trends are sorted by confidence, absolute delta, percentage delta, and merchant label; at most five are displayed. High-stability cards say the typical cost level increased, while more variable histories only say the recent typical level is higher.

Annualized impact reuses the recurring frequency multipliers:

```text
monthly delta * 12
quarterly delta * 4
annual delta
```

No forecasting, inflation adjustment, or trend persistence is involved.

## Financial health prioritization
`buildFinancialHealthSummary` combines existing derived outputs; it performs no new financial analysis and persists nothing. Inputs are the current financial summary, consumption/saving/amortization budget rows, monthly insights, recurring insights, and recurring cost trends.

Status is transparent:
- `needs-review` when at least one important signal exists
- `attention` when no important signal exists but at least one attention signal exists
- `good` otherwise

Positive signals never cancel negative signals. The internal priority score is used only for deterministic ordering:

```text
important base 100
attention base 70
info base 40
positive base 30

+ up to 20 points: floor(abs(amount cents) / 50,000)
+ up to 10 points: floor(abs(percent) / 10)
+ 10 points for high-confidence recurring/trend evidence
```

Budget overruns are shown at 200 kr, or at 100 kr together with at least 10 percent over budget. They become important at 1,000 kr, or at 200 kr together with at least 25 percent over budget. Completed-month under-budget positives require at least 500 kr and 10 percent. Saving and amortization goal differences use 200 kr, or 100 kr together with 10 percent.

Monthly total increases require at least 500 kr and become important at 2,000 kr or 25 percent. Existing Phase 2A category thresholds are reused; category increases become important at 1,000 kr, or at 500 kr together with 50 percent. Unusual purchases remain neutral information unless at least 5,000 kr.

One or two unclassified transactions are informational, three through nine require attention, and ten or more are important. This severity concerns analysis completeness, not spending quality.

Deduplication is deterministic:
- a medium/high long-term merchant trend suppresses the same merchant's latest-payment increase
- a budget overrun plus a same-direction monthly category increase becomes one budget card with supporting normal-level detail
- a completed-month under-budget result plus a same-direction category decrease is combined similarly
- total monthly change remains an overview signal while category cards explain causes

At most four important/attention signals and two positive/info signals are returned. Within each group, priority score and stable ID determine order. The output reports how many additional details remain in the existing sections.

The health summary is monthly. The year view asks the user to select a month. During the current month, Phase 2A full-month changes are unavailable by construction, while budget and goals to date, actual recurring charges, long-term trends, and classification completeness remain eligible.

## Budget calculations
Derived budget rows are centralized in `finance.ts` and are never persisted. A row contains budget, actual, remaining amount, percentage used, historical monthly average, and an optional annual forecast. The row set is the union of categories with relevant actuals and categories with a saved budget, so a saved budget remains visible when actual is zero.

Budget sections have separate semantics:
- consumption: `expense` and `refund`
- income goals: `income`
- direct-saving goals: `saving`
- amortization goals: `amortization`

The existing budget table is reused without a schema change. `Sparande` identifies the direct-saving goal and `Sparande / Amortering` identifies the amortization goal; `Lön`, `Bidrag`, and `Uthyrning` remain income goals. Other saved category budgets are consumption budgets.

A covered month is a completed calendar month containing at least one transaction relevant to that budget section. For consumption this means `expense` or `refund`; months containing only transfers or unclassified rows do not count. The current calendar month is excluded, while all relevant months in a completed historical year may count.

Historical monthly average is:

```text
sum of category actuals in covered completed months / number of covered completed months
```

The numerator remains integer cents. The derived quotient may contain a fractional cent and is rounded only by the presentation formatter. An annual forecast is shown only with at least two covered completed months:

```text
historical monthly average * 12
```

It is labeled as an estimate and is separate from actual outcome. Annual budget coverage is `COUNT(DISTINCT month)` for saved rows in the selected year; missing months are reported rather than treated as automatically budgeted at zero.

Percentage used is `actual / budget * 100` only when budget is greater than zero. A zero or absent budget yields no percentage, avoiding `NaN` and infinity. Negative actuals from refunds larger than expenses are preserved without clamping.

The parser returns accepted rows, warnings, and blocking errors with sheet, row number, original value, and a clear reason. Blocking errors disable import, while excluded zero-amount rows and sheets without transaction headers remain visible as warnings instead of disappearing silently.

Imported money text is normalized directly into integer cents for the supported Swedish and international separator formats. Numeric Excel cells and cached formula results are accepted only when they are within `1e-7` cents of an integer cent; genuine precision beyond two decimals is a blocking import error.

## Classification architecture
The classification layer is rule-first and explanation-driven:
1. explicit user rule
2. merchant mapping
3. exact historical match
4. alias rule
5. safe historical match
6. conservative fuzzy match
7. manual review

No auto-classification happens when confidence is low or uncertain; the transaction goes to the review inbox.

## Rule engine
Rules are transparent and editable, with a priority field, active/inactive state, and explicit categories. Each classification result explains which rule or source was used.

## GitHub strategy
The repository is organized around a small set of domains:
- app frontend
- Tauri backend
- deterministic finance logic
- tests
- docs and CI

All standard workflows run on pull requests and main branch pushes.

## Azure architecture
Azure is intentionally not used in v1. The app is local-first and local-only, which keeps operational costs near zero. If future features require cloud integration, the preferred pattern would be serverless Azure Functions behind an explicit, minimal integration boundary.

## Security architecture
The app follows secure-by-default patterns:
- no secrets in the repository
- local SQLite storage only
- strict file validation for .xlsx imports
- input validation before persistence
- no analytics or telemetry with personal financial data
- local OS secure storage for future credentials if needed
