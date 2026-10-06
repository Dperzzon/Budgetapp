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
- importing one or more `.xlsx` bank files with a reviewable preview
- local SQLite storage for transactions and monthly category budgets
- automatic classification for known merchant rules and a manual review queue for uncertain rows
- learned merchant rules: changing a transaction category saves a local rule that takes priority on future imports
- `Boende / Wi-Fi` and `Sparande / Amortering`, with amortization included in the savings budget total
- dashboard filtering by year and month, with same-period comparison to a chosen year
- spending-by-month comparison, category budget-versus-actual, import source summaries, and transaction history
- possible duplicate detection by date, merchant, and amount; duplicate rows are still imported and flagged for manual review
- manual category changes and deletion for any transaction in the selected period

Bank export layouts differ. The importer detects common Swedish and English date, description, debit, credit, and amount headers; check the preview before confirming an import.
