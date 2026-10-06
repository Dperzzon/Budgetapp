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

## Database design
A local SQLite database stores transaction history, categories, learned merchant rules, and monthly category budgets. Existing transaction databases are upgraded on startup when new columns are needed.

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
9. persist every transaction and its review status in SQLite

The dashboard filters persisted rows by year and month. It compares the selected period with the same month or year from a separately selected comparison year. Monthly budgets are editable per category and stored in SQLite; annual budget totals sum that year's monthly budgets. The review view allows changing the category or explicitly deleting a selected transaction; rows with invalid dates remain visible there regardless of period filter.

When a user changes a transaction's category, the normalized merchant and selected category are saved as a learned rule. This rule takes priority over built-in rules on later imports and remains local. Amortization is stored as `Sparande / Amortering` and included in the `Sparande` budget total; Wi-Fi is `Boende / Wi-Fi`.

The parser rejects malformed rows and surfaces them to the user instead of silently dropping them.

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
