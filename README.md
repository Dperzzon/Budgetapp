# BudgetApp

BudgetApp is a local-first desktop budget application for Windows. It focuses on correctness, low operational cost, and minimal manual input while keeping all transaction data stored locally in SQLite.

## Mission
- run completely on the user's machine
- store data locally in SQLite
- import .xlsx bank files
- detect duplicates and review uncertain rows
- classify transactions using deterministic rules
- explain every automatic decision
- avoid guessing when confidence is low

## Local-first architecture
This project uses:
- Tauri for desktop packaging
- React + TypeScript for the UI
- SQLite via the Rust backend for local persistence

This intentionally avoids cloud databases and keeps Azure optional and minimal.

## Project structure

- src/ — React application
- src/lib/ — finance logic and tests
- src-tauri/ — Tauri + Rust backend and local SQLite layer
- docs/ — architecture and design notes
- infra/ — optional infrastructure-as-code
- .github/workflows/ — CI and release automation

## Prerequisites
- Node.js 22+
- Rust stable toolchain
- Git

## Install

```bash
npm install
```

## Local development

```bash
npm run dev
```

For desktop mode:

```bash
npm run tauri dev
```

## Test

```bash
npm run test
```

## Lint and typecheck

```bash
npm run lint
npm run typecheck
```

## Production build

```bash
npm run build
```

Windows desktop packaging:

```bash
npm run tauri build -- --bundles nsis
```

## Environment

Copy the example file and adjust as needed:

```bash
cp .env.example .env
```

The app stores SQLite data under the operating system app-data directory. No secrets or personal financial data should be committed.

The database is created automatically on first launch and is not part of the source tree. A person who clones the repository gets a new, empty local database; they do not get the developer's transactions. The repository `.gitignore` excludes SQLite databases, journals, sidecar files, and database backups if any are accidentally copied into the project.

## GitHub strategy
- all code in GitHub
- pull requests run CI
- main branch must remain buildable
- releases are created from tags and Windows installers when appropriate

## Azure strategy
No Azure resources are required in v1 because the app is local-first and intentionally minimal-cost. If a future cloud feature is required, it should be serverless, narrow, and explicitly separated from the local-first core.

## Security and privacy
- no API keys or secrets in the repository
- no .env files committed
- no SQLite databases committed
- no imported bank files committed
- no telemetry for financial data
- strict validation for Excel import files

## Current status
The app currently supports:
- a focused first-run experience that sends an empty local database directly to the existing Excel import flow
- month navigation with explicit future-planning status while retaining year and month selectors
- importing one or more `.xlsx` bank files with a reviewable preview
- explicit per-file outcomes for multi-file imports, so successful files remain clearly identified if a later file fails
- guarded import analysis with disabled controls, visible phases, and stale-result protection
- local SQLite storage for transactions and monthly category budgets
- automatic classification for known merchant rules and a manual review queue for uncertain rows
- safe category changes: a manual change affects only the selected transaction by default; bulk updates and future learned rules require separate explicit choices
- confirmations with affected counts for historical bulk changes; remembering a category updates the selected row and its future rule atomically
- structured Excel validation that lists accepted rows, warnings, and blocking errors before import
- exact-file reimport protection using a local SHA-256 hash, with import history, per-row provenance, and atomic undo for tracked imports
- an explicit economic transaction type, separate from category, for income, expenses, saving, amortization, transfers, refunds, and unclassified rows
- conservative type assignment: known income categories and explicit saving/transfer categories are recognized, negative purchases become expenses, and uncertain positive rows require review
- shared dashboard and budget semantics where refunds reduce category spending, transfers and unclassified rows are excluded, and saving and amortization are reported separately
- safe transaction-type correction with three explicit choices: update only the selected row, update exact normalized-merchant matches, or remember the type for future imports; the safest single-row choice is the default
- direction-aware Swish matching, so received Swish transactions can share an economic type without affecting sent Swish transactions or changing their categories
- integer-cent storage and calculations for transactions, budgets, import history, duplicate keys, and dashboard totals
- a local pre-schema-4 SQLite backup before legacy `REAL` money columns are rebuilt as integer-cent columns
- budget rows built from both actuals and saved budgets, including categories with zero actual
- historical monthly averages based on relevant completed months, with clearly separate annual estimates
- consumption budgets separated from income goals, direct-saving goals, and amortization goals
- dashboard filtering by year and month, with same-period comparison to a chosen year
- centralized past/current/future period semantics; future months remain available for budget planning without outcome, health, recurring, or trend assessments
- deterministic monthly change insights showing meaningful category increases and decreases, total change, unusual purchases, and top exact-normalized merchants
- transparent comparison labels based on earlier completed consumption months, with no full-month comparison for the current month
- conservative recurring-expense insights with approximate frequency, payment evidence, median normal amount, cautious price-change signals, and annualized periodic cost
- long-term recurring-cost trends based on earlier and recent period medians, with conservative confidence and annualized impact
- a prioritized monthly financial-health summary that reuses budget, monthly-change, recurring, trend, savings, and classification signals without an opaque score
- a simplified dashboard hierarchy with health and core totals first, budgets and review actions next, and detailed monthly analyses collapsed by default
- compact primary budget tables for outcome, budget or goal, remaining amount, and percentage, with historical averages and forecasts available as secondary details
- spending-by-month comparison, category budget-versus-actual, import source summaries, and transaction history
- possible duplicate detection by date, merchant, and amount; duplicate rows are still imported and flagged for manual review
- manual category changes and deletion for any transaction in the selected period

Bank export layouts differ. The importer detects common Swedish and English date, description, debit, credit, and amount headers; check the preview before confirming an import.
