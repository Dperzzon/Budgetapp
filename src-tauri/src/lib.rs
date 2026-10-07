use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ValueRef};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const CURRENT_SCHEMA_VERSION: i64 = 5;
const CENTS_EPSILON: f64 = 1e-7;
const MAX_SAFE_CENTS: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum TransactionType {
    Income,
    Expense,
    Saving,
    Amortization,
    Transfer,
    Refund,
    Unclassified,
}

impl TransactionType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Income => "income",
            Self::Expense => "expense",
            Self::Saving => "saving",
            Self::Amortization => "amortization",
            Self::Transfer => "transfer",
            Self::Refund => "refund",
            Self::Unclassified => "unclassified",
        }
    }
}

impl FromSql for TransactionType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "income" => Ok(Self::Income),
            "expense" => Ok(Self::Expense),
            "saving" => Ok(Self::Saving),
            "amortization" => Ok(Self::Amortization),
            "transfer" => Ok(Self::Transfer),
            "refund" => Ok(Self::Refund),
            "unclassified" => Ok(Self::Unclassified),
            value => Err(FromSqlError::Other(
                format!("Okänd transaktionstyp: {value}").into(),
            )),
        }
    }
}

#[derive(serde::Deserialize)]
struct ImportedTransaction {
    merchant: String,
    amount_cents: i64,
    category: String,
    transaction_type: TransactionType,
    date: String,
    source_file: String,
    needs_review: bool,
    imported_sheet: String,
    imported_row: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredTransaction {
    id: i64,
    merchant: String,
    amount_cents: i64,
    category: String,
    transaction_type: TransactionType,
    date: String,
    source_file: String,
    needs_review: bool,
    category_decided: bool,
    import_batch_id: Option<i64>,
    imported_sheet: Option<String>,
    imported_row: Option<i64>,
}

#[derive(serde::Serialize)]
struct CategoryBudget {
    category: String,
    amount_cents: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LearnedRule {
    merchant_key: String,
    category: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LearnedTransactionTypeRule {
    merchant_key: String,
    transaction_type: TransactionType,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportBatchSummary {
    id: i64,
    file_name: String,
    imported_at: String,
    transaction_count: i64,
    earliest_date: Option<String>,
    latest_date: Option<String>,
    needs_review_count: i64,
    positive_total_cents: i64,
    negative_total_cents: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportBatchDetail {
    summary: ImportBatchSummary,
    transactions: Vec<StoredTransaction>,
}

fn app_db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_dir).map_err(|error| error.to_string())?;
    Ok(app_dir.join("budgetapp.sqlite"))
}

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|error| error.to_string())
}

fn schema_version(conn: &Connection) -> Result<i64, String> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn ensure_transaction_column(
    conn: &Transaction<'_>,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let mut statement = conn.prepare("PRAGMA table_info(transactions)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;

    if !columns.iter().any(|existing| existing == column) {
        conn.execute(
            &format!("ALTER TABLE transactions ADD COLUMN {column} {definition}"),
            (),
        )?;
    }
    Ok(())
}

fn migrate_ikea_barkarby_categories(conn: &Transaction<'_>) -> rusqlite::Result<()> {
    let already_applied: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM app_migrations WHERE migration_key = 'ikea-barkarby-if-hf-categories'",
            (),
            |row| row.get(0),
        )
        .optional()?;
    if already_applied.is_some() {
        return Ok(());
    }

    conn.execute(
        "UPDATE transactions
         SET category = 'Boende / Projekt', needs_review = 0, category_decided = 1
         WHERE merchant LIKE '%IKEA%BARKARBY%HF%' COLLATE NOCASE",
        (),
    )?;
    conn.execute(
        "UPDATE transactions
         SET category = 'Restaurang / Café', needs_review = 0, category_decided = 1
         WHERE merchant LIKE '%IKEA%BARKARBY%IF%' COLLATE NOCASE",
        (),
    )?;
    conn.execute(
        "INSERT INTO learned_rules (merchant_key, category) VALUES
            ('IKEA BARKARBY HF', 'Boende / Projekt'),
            ('IKEA BARKARBY IF', 'Restaurang / Café')
         ON CONFLICT(merchant_key) DO UPDATE SET
            category = excluded.category,
            updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')",
        (),
    )?;
    conn.execute(
        "INSERT INTO app_migrations (migration_key) VALUES ('ikea-barkarby-if-hf-categories')",
        (),
    )?;
    Ok(())
}

fn migration_0_to_1(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            merchant TEXT NOT NULL,
            amount REAL NOT NULL,
            category TEXT,
            date TEXT,
            source_file TEXT,
            needs_review INTEGER NOT NULL DEFAULT 1,
            category_decided INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )?;

    for (column, definition) in [
        ("date", "TEXT"),
        ("source_file", "TEXT"),
        ("needs_review", "INTEGER NOT NULL DEFAULT 1"),
        ("category_decided", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT"),
    ] {
        ensure_transaction_column(tx, column, definition)?;
    }
    tx.execute(
        "UPDATE transactions SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL",
        (),
    )?;

    tx.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )?;

    tx.execute(
        "INSERT OR IGNORE INTO categories (name) VALUES
            ('Mat / Dagligvaror'), ('Restaurang / Café'), ('Takeaway'),
            ('Boende / Hyra'), ('Boende / El'), ('Boende / Vatten & avfall'),
            ('Boende / Försäkring'), ('Boende / Underhåll'), ('Boende / Ränta'), ('Boende / Projekt'),
            ('Bil / Bränsle'), ('Bil / Parkering'), ('Bil / Service'),
            ('Bil / Försäkring'), ('Bil / Skatt'), ('Bil / Avgifter'), ('Kollektivtrafik'),
            ('Kläder & skor'), ('Hälsa / Vård'), ('Hälsa / Apotek'),
            ('Abonnemang'), ('Prenumerationer'), ('Nöje'), ('Resor'), ('Barn'), ('Skatt / moms'),
            ('Hushåll'), ('Elektronik'), ('Utbildning'), ('Bankavgifter'),
            ('Gåvor'), ('Personförsäkring'), ('Sparande'), ('Sparande / Amortering'), ('Boende / Wi-Fi'),
            ('Lön'), ('Bidrag'), ('Uthyrning'), ('Överföring mellan konto'), ('Övrigt'), ('Okategoriserat')",
        (),
    )?;
    tx.execute("DELETE FROM categories WHERE name = 'Husdjur'", ())?;

    tx.execute(
        "CREATE TABLE IF NOT EXISTS learned_rules (
            merchant_key TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )?;
    tx.execute(
        "CREATE TABLE IF NOT EXISTS app_migrations (
            migration_key TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )?;
    migrate_ikea_barkarby_categories(tx)?;

    tx.execute(
        "UPDATE transactions
         SET category = 'Överföring mellan konto', needs_review = 0
            WHERE (merchant LIKE '%Överföring via internet%' COLLATE NOCASE
                 OR merchant LIKE '%överföring via internet%' COLLATE NOCASE)
             AND (category IS NOT 'Överföring mellan konto' OR needs_review <> 0)",
        (),
    )?;

    tx.execute(
        "CREATE TABLE IF NOT EXISTS budgets (
            year INTEGER NOT NULL,
            month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
            category TEXT NOT NULL,
            amount REAL NOT NULL,
            PRIMARY KEY (year, month, category)
        )",
        (),
    )?;
    Ok(())
}

fn migration_1_to_2(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "CREATE TABLE import_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            file_sha256 TEXT NOT NULL UNIQUE,
            imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )?;
    ensure_transaction_column(
        tx,
        "import_batch_id",
        "INTEGER REFERENCES import_batches(id) ON DELETE CASCADE",
    )?;
    ensure_transaction_column(tx, "imported_sheet", "TEXT")?;
    ensure_transaction_column(tx, "imported_row", "INTEGER")?;
    tx.execute(
        "CREATE INDEX idx_transactions_import_batch_id ON transactions(import_batch_id)",
        (),
    )?;
    Ok(())
}

fn migration_2_to_3(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    ensure_transaction_column(
        tx,
        "transaction_type",
        "TEXT NOT NULL DEFAULT 'unclassified'
         CHECK(transaction_type IN (
            'income', 'expense', 'saving', 'amortization',
            'transfer', 'refund', 'unclassified'
         ))",
    )?;
    tx.execute(
        "UPDATE transactions
         SET transaction_type = CASE
            WHEN category = 'Överföring mellan konto' THEN 'transfer'
            WHEN category = 'Sparande' THEN 'saving'
            WHEN category = 'Sparande / Amortering' THEN 'amortization'
            WHEN amount > 0 AND category IN ('Lön', 'Bidrag', 'Uthyrning') THEN 'income'
            WHEN amount < 0 THEN 'expense'
            ELSE 'unclassified'
         END",
        (),
    )?;
    Ok(())
}

fn legacy_amount_to_cents(amount: f64) -> Result<i64, String> {
    if !amount.is_finite() {
        return Err("Beloppet är inte ett ändligt tal.".to_string());
    }
    let scaled = amount * 100.0;
    if !scaled.is_finite() || scaled.abs() > MAX_SAFE_CENTS as f64 {
        return Err("Beloppet är för stort för säker lagring i heltalsöre.".to_string());
    }
    let rounded = scaled.round();
    let difference = (scaled - rounded).abs();
    if difference > CENTS_EPSILON {
        return Err(format!(
            "Beloppet {amount} har mer än två verkliga decimaler och kan inte migreras säkert."
        ));
    }
    Ok(rounded as i64)
}

fn money_migration_error(message: String) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(
        std::io::Error::new(std::io::ErrorKind::InvalidData, message).into(),
    )
}

fn migration_3_to_4(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE transactions_schema4 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            merchant TEXT NOT NULL,
            amount_cents INTEGER NOT NULL,
            category TEXT,
            date TEXT,
            source_file TEXT,
            needs_review INTEGER NOT NULL DEFAULT 1,
            category_decided INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE CASCADE,
            imported_sheet TEXT,
            imported_row INTEGER,
            transaction_type TEXT NOT NULL
                CHECK(transaction_type IN (
                    'income', 'expense', 'saving', 'amortization',
                    'transfer', 'refund', 'unclassified'
                ))
        );
        CREATE TABLE budgets_schema4 (
            year INTEGER NOT NULL,
            month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
            category TEXT NOT NULL,
            amount_cents INTEGER NOT NULL,
            PRIMARY KEY (year, month, category)
        );",
    )?;

    let legacy_transactions = {
        let mut statement = tx.prepare(
            "SELECT id, merchant, amount, category, date, source_file, needs_review,
                    category_decided, created_at, import_batch_id, imported_sheet,
                    imported_row, transaction_type
             FROM transactions ORDER BY id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                    row.get::<_, String>(12)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut legacy_transaction_total_cents = 0_i64;
    for row in &legacy_transactions {
        let amount_cents = legacy_amount_to_cents(row.2).map_err(money_migration_error)?;
        legacy_transaction_total_cents = legacy_transaction_total_cents
            .checked_add(amount_cents)
            .ok_or_else(|| {
            money_migration_error("Transaktionernas summa är för stor.".to_string())
        })?;
        tx.execute(
            "INSERT INTO transactions_schema4 (
                id, merchant, amount_cents, category, date, source_file, needs_review,
                category_decided, created_at, import_batch_id, imported_sheet,
                imported_row, transaction_type
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
             )",
            params![
                row.0,
                row.1,
                amount_cents,
                row.3,
                row.4,
                row.5,
                row.6,
                row.7,
                row.8,
                row.9,
                row.10,
                row.11,
                row.12
            ],
        )?;
    }

    let legacy_budgets = {
        let mut statement = tx.prepare(
            "SELECT year, month, category, amount FROM budgets ORDER BY year, month, category",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut legacy_budget_total_cents = 0_i64;
    for row in &legacy_budgets {
        let amount_cents = legacy_amount_to_cents(row.3).map_err(money_migration_error)?;
        legacy_budget_total_cents = legacy_budget_total_cents
            .checked_add(amount_cents)
            .ok_or_else(|| money_migration_error("Budgetarnas summa är för stor.".to_string()))?;
        tx.execute(
            "INSERT INTO budgets_schema4 (year, month, category, amount_cents)
             VALUES (?1, ?2, ?3, ?4)",
            params![row.0, row.1, row.2, amount_cents],
        )?;
    }

    let transaction_count: i64 =
        tx.query_row("SELECT COUNT(*) FROM transactions_schema4", [], |row| {
            row.get(0)
        })?;
    if transaction_count != legacy_transactions.len() as i64 {
        return Err(money_migration_error(
            "Antalet transaktioner ändrades under migreringen.".to_string(),
        ));
    }
    let budget_count: i64 =
        tx.query_row("SELECT COUNT(*) FROM budgets_schema4", [], |row| row.get(0))?;
    if budget_count != legacy_budgets.len() as i64 {
        return Err(money_migration_error(
            "Antalet budgetrader ändrades under migreringen.".to_string(),
        ));
    }

    let transaction_metadata_difference: i64 = tx.query_row(
        "SELECT COUNT(*) FROM (
            SELECT id, merchant, category, date, source_file, needs_review,
                   category_decided, created_at, import_batch_id, imported_sheet,
                   imported_row, transaction_type
            FROM transactions
            EXCEPT
            SELECT id, merchant, category, date, source_file, needs_review,
                   category_decided, created_at, import_batch_id, imported_sheet,
                   imported_row, transaction_type
            FROM transactions_schema4
            UNION ALL
            SELECT id, merchant, category, date, source_file, needs_review,
                   category_decided, created_at, import_batch_id, imported_sheet,
                   imported_row, transaction_type
            FROM transactions_schema4
            EXCEPT
            SELECT id, merchant, category, date, source_file, needs_review,
                   category_decided, created_at, import_batch_id, imported_sheet,
                   imported_row, transaction_type
            FROM transactions
         )",
        [],
        |row| row.get(0),
    )?;
    if transaction_metadata_difference != 0 {
        return Err(money_migration_error(
            "Transaktionsmetadata ändrades under migreringen.".to_string(),
        ));
    }
    let budget_metadata_difference: i64 = tx.query_row(
        "SELECT COUNT(*) FROM (
            SELECT year, month, category FROM budgets
            EXCEPT
            SELECT year, month, category FROM budgets_schema4
            UNION ALL
            SELECT year, month, category FROM budgets_schema4
            EXCEPT
            SELECT year, month, category FROM budgets
         )",
        [],
        |row| row.get(0),
    )?;
    if budget_metadata_difference != 0 {
        return Err(money_migration_error(
            "Budgetidentiteter ändrades under migreringen.".to_string(),
        ));
    }

    let migrated_transaction_total_cents = {
        let mut statement = tx.prepare("SELECT amount_cents FROM transactions_schema4")?;
        let total = statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .try_fold(0_i64, |total, amount| total.checked_add(amount))
            .ok_or_else(|| {
                money_migration_error("Transaktionernas summa är för stor.".to_string())
            })?;
        total
    };
    let migrated_budget_total_cents = {
        let mut statement = tx.prepare("SELECT amount_cents FROM budgets_schema4")?;
        let total = statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .try_fold(0_i64, |total, amount| total.checked_add(amount))
            .ok_or_else(|| money_migration_error("Budgetarnas summa är för stor.".to_string()))?;
        total
    };
    if migrated_transaction_total_cents != legacy_transaction_total_cents
        || migrated_budget_total_cents != legacy_budget_total_cents
    {
        return Err(money_migration_error(
            "Ekonomiska totalsummor ändrades under migreringen.".to_string(),
        ));
    }
    if migrated_transaction_total_cents.unsigned_abs() > MAX_SAFE_CENTS as u64
        || migrated_budget_total_cents.unsigned_abs() > MAX_SAFE_CENTS as u64
    {
        return Err(money_migration_error(
            "En ekonomisk totalsumma är för stor för säker användning i gränssnittet.".to_string(),
        ));
    }

    tx.execute_batch(
        "DROP TABLE transactions;
         ALTER TABLE transactions_schema4 RENAME TO transactions;
         CREATE INDEX idx_transactions_import_batch_id ON transactions(import_batch_id);
         DROP TABLE budgets;
         ALTER TABLE budgets_schema4 RENAME TO budgets;",
    )?;

    let foreign_key_problem: Option<String> = tx
        .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
        .optional()?;
    if let Some(table) = foreign_key_problem {
        return Err(money_migration_error(format!(
            "Foreign key-verifieringen misslyckades för tabellen {table}."
        )));
    }
    Ok(())
}

fn migration_4_to_5(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "CREATE TABLE learned_transaction_type_rules (
            merchant_key TEXT PRIMARY KEY,
            transaction_type TEXT NOT NULL
                CHECK(transaction_type IN (
                    'income', 'expense', 'saving', 'amortization',
                    'transfer', 'refund', 'unclassified'
                )),
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )?;
    Ok(())
}

fn run_migration_step<F>(
    conn: &mut Connection,
    target_version: i64,
    migration: F,
) -> Result<(), String>
where
    F: FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
{
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    migration(&tx).map_err(|error| error.to_string())?;
    tx.pragma_update(None, "user_version", target_version)
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

fn migrate_database(conn: &mut Connection) -> Result<(), String> {
    let mut version = schema_version(conn)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Databasen har schemaversion {version}, men appen stöder högst version {CURRENT_SCHEMA_VERSION}."
        ));
    }

    if version == 0 {
        run_migration_step(conn, 1, migration_0_to_1)?;
        version = 1;
    }
    if version == 1 {
        run_migration_step(conn, 2, migration_1_to_2)?;
        version = 2;
    }
    if version == 2 {
        run_migration_step(conn, 3, migration_2_to_3)?;
        version = 3;
    }
    if version == 3 {
        run_migration_step(conn, 4, migration_3_to_4)?;
        version = 4;
    }
    if version == 4 {
        run_migration_step(conn, 5, migration_4_to_5)?;
    }

    let migrated_version = schema_version(conn)?;
    if migrated_version != CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Databasen kunde inte migreras till schemaversion {CURRENT_SCHEMA_VERSION}."
        ));
    }
    Ok(())
}

fn open_configured_connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    configure_connection(&conn)?;
    Ok(conn)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
         )",
        params![table],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn create_pre_schema_four_backup(
    conn: &Connection,
    database_path: &Path,
) -> Result<std::path::PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let stem = database_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("budgetapp");
    let backup_path =
        database_path.with_file_name(format!("{stem}.pre-schema-4-{timestamp}.sqlite"));
    let mut destination = Connection::open(&backup_path).map_err(|error| error.to_string())?;
    let backup =
        rusqlite::backup::Backup::new(conn, &mut destination).map_err(|error| error.to_string())?;
    backup
        .run_to_completion(5, Duration::from_millis(50), None)
        .map_err(|error| error.to_string())?;
    drop(backup);
    drop(destination);
    Ok(backup_path)
}

fn initialize_database(path: &Path) -> Result<Connection, String> {
    let mut conn = open_configured_connection(path)?;
    let version = schema_version(&conn)?;
    let backup_path = if version < 4 && table_exists(&conn, "transactions")? {
        Some(create_pre_schema_four_backup(&conn, path).map_err(|error| {
            format!("Kunde inte skapa säkerhetskopia före cents-migreringen: {error}")
        })?)
    } else {
        None
    };
    if let Err(error) = migrate_database(&mut conn) {
        return Err(match backup_path {
            Some(path) => format!("{error} Säkerhetskopian finns kvar på {}.", path.display()),
            None => error,
        });
    }
    Ok(conn)
}

fn open_app_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = app_db_path(app)?;
    let conn = open_configured_connection(&db_path)?;
    let version = schema_version(&conn)?;
    if version != CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Databasen har schemaversion {version}; initiering krävs för version {CURRENT_SCHEMA_VERSION}."
        ));
    }
    Ok(conn)
}

#[tauri::command]
fn init_db(app: tauri::AppHandle) -> Result<String, String> {
    let db_path = app_db_path(&app)?;
    initialize_database(&db_path)?;
    Ok(db_path.display().to_string())
}

#[tauri::command]
fn get_transaction_count(app: tauri::AppHandle) -> Result<i64, String> {
    let conn = open_app_connection(&app)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM transactions", (), |row| row.get(0))
        .map_err(|error| error.to_string())?;

    Ok(count)
}

fn stored_transaction_from_row(row: &Row<'_>) -> rusqlite::Result<StoredTransaction> {
    Ok(StoredTransaction {
        id: row.get(0)?,
        merchant: row.get(1)?,
        amount_cents: row.get(2)?,
        category: row.get(3)?,
        transaction_type: row.get(4)?,
        date: row.get(5)?,
        source_file: row.get(6)?,
        needs_review: row.get::<_, i64>(7)? != 0,
        category_decided: row.get::<_, i64>(8)? != 0,
        import_batch_id: row.get(9)?,
        imported_sheet: row.get(10)?,
        imported_row: row.get(11)?,
    })
}

#[tauri::command]
fn get_transactions(app: tauri::AppHandle) -> Result<Vec<StoredTransaction>, String> {
    let conn = open_app_connection(&app)?;
    let mut statement = conn
        .prepare(
            "SELECT id, merchant, amount_cents, COALESCE(category, 'Okategoriserat'),
                    transaction_type, COALESCE(date, 'Okänt datum'),
                    COALESCE(source_file, ''), needs_review,
                    category_decided, import_batch_id, imported_sheet, imported_row
             FROM transactions ORDER BY date DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], stored_transaction_from_row)
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_learned_rules(app: tauri::AppHandle) -> Result<Vec<LearnedRule>, String> {
    let conn = open_app_connection(&app)?;
    let mut statement = conn
        .prepare(
            "SELECT merchant_key, category FROM learned_rules ORDER BY updated_at DESC, rowid DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(LearnedRule {
                merchant_key: row.get(0)?,
                category: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_learned_transaction_type_rules(
    app: tauri::AppHandle,
) -> Result<Vec<LearnedTransactionTypeRule>, String> {
    let conn = open_app_connection(&app)?;
    let mut statement = conn
        .prepare(
            "SELECT merchant_key, transaction_type
             FROM learned_transaction_type_rules
             ORDER BY updated_at DESC, rowid DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(LearnedTransactionTypeRule {
                merchant_key: row.get(0)?,
                transaction_type: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn get_budgets_for_period(
    conn: &Connection,
    year: i32,
    month: Option<i32>,
) -> Result<Vec<CategoryBudget>, String> {
    let mut statement = conn
        .prepare(
            "SELECT category, SUM(amount_cents) FROM budgets
             WHERE year = ?1 AND (?2 IS NULL OR month = ?2)
             GROUP BY category ORDER BY category",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![year, month], |row| {
            Ok(CategoryBudget {
                category: row.get(0)?,
                amount_cents: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn count_budgeted_months(conn: &Connection, year: i32) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(DISTINCT month) FROM budgets WHERE year = ?1",
        params![year],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_budgets(
    app: tauri::AppHandle,
    year: i32,
    month: Option<i32>,
) -> Result<Vec<CategoryBudget>, String> {
    let conn = open_app_connection(&app)?;
    get_budgets_for_period(&conn, year, month)
}

#[tauri::command]
fn get_budget_coverage(app: tauri::AppHandle, year: i32) -> Result<i64, String> {
    let conn = open_app_connection(&app)?;
    count_budgeted_months(&conn, year)
}

fn save_budget_amount(
    conn: &Connection,
    year: i32,
    month: i32,
    category: &str,
    amount_cents: i64,
) -> Result<(), String> {
    if amount_cents.unsigned_abs() > MAX_SAFE_CENTS as u64 {
        return Err("Budgetbeloppet är för stort för säker lagring.".to_string());
    }
    conn.execute(
        "INSERT INTO budgets (year, month, category, amount_cents) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(year, month, category) DO UPDATE SET amount_cents = excluded.amount_cents",
        params![year, month, category, amount_cents],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_budget(
    app: tauri::AppHandle,
    year: i32,
    month: i32,
    category: String,
    amount_cents: i64,
) -> Result<(), String> {
    let conn = open_app_connection(&app)?;
    save_budget_amount(&conn, year, month, &category, amount_cents)
}

fn validate_file_hash(file_sha256: &str) -> Result<(), String> {
    if file_sha256.len() != 64
        || !file_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Filens lokala identitet är ogiltig.".to_string());
    }
    Ok(())
}

fn map_batch_summary(row: &Row<'_>) -> rusqlite::Result<ImportBatchSummary> {
    Ok(ImportBatchSummary {
        id: row.get(0)?,
        file_name: row.get(1)?,
        imported_at: row.get(2)?,
        transaction_count: row.get(3)?,
        earliest_date: row.get(4)?,
        latest_date: row.get(5)?,
        needs_review_count: row.get(6)?,
        positive_total_cents: row.get(7)?,
        negative_total_cents: row.get(8)?,
    })
}

const IMPORT_BATCH_SUMMARY_SELECT: &str = "SELECT b.id, b.file_name, b.imported_at, COUNT(t.id),
            MIN(t.date), MAX(t.date),
            COALESCE(SUM(CASE WHEN t.needs_review <> 0 OR t.transaction_type = 'unclassified'
                THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN t.amount_cents ELSE 0 END), 0)
     FROM import_batches b
     LEFT JOIN transactions t ON t.import_batch_id = b.id";

fn find_batch_by_hash(
    conn: &Connection,
    file_sha256: &str,
) -> Result<Option<ImportBatchSummary>, String> {
    validate_file_hash(file_sha256)?;
    conn.query_row(
        &format!(
            "{IMPORT_BATCH_SUMMARY_SELECT}
             WHERE b.file_sha256 = ?1
             GROUP BY b.id"
        ),
        params![file_sha256],
        map_batch_summary,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn list_batches(conn: &Connection) -> Result<Vec<ImportBatchSummary>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{IMPORT_BATCH_SUMMARY_SELECT}
             GROUP BY b.id
             ORDER BY b.imported_at DESC, b.id DESC"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], map_batch_summary)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn get_batch_detail(conn: &Connection, id: i64) -> Result<ImportBatchDetail, String> {
    let summary = conn
        .query_row(
            &format!(
                "{IMPORT_BATCH_SUMMARY_SELECT}
                 WHERE b.id = ?1
                 GROUP BY b.id"
            ),
            params![id],
            map_batch_summary,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Importen {id} hittades inte."))?;
    let mut statement = conn
        .prepare(
            "SELECT id, merchant, amount_cents, COALESCE(category, 'Okategoriserat'),
                    transaction_type, COALESCE(date, 'Okänt datum'),
                    COALESCE(source_file, ''), needs_review,
                    category_decided, import_batch_id, imported_sheet, imported_row
             FROM transactions
             WHERE import_batch_id = ?1
             ORDER BY imported_sheet, imported_row, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![id], stored_transaction_from_row)
        .map_err(|error| error.to_string())?;
    let transactions = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(ImportBatchDetail {
        summary,
        transactions,
    })
}

fn import_transactions_as_batch(
    conn: &mut Connection,
    file_name: &str,
    file_sha256: &str,
    transactions: Vec<ImportedTransaction>,
) -> Result<ImportBatchSummary, String> {
    validate_file_hash(file_sha256)?;
    if file_name.trim().is_empty() {
        return Err("Filnamn får inte vara tomt.".to_string());
    }
    if transactions.is_empty() {
        return Err("Importen innehåller inga godkända transaktioner.".to_string());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let batch_id = tx
        .execute(
            "INSERT INTO import_batches (file_name, file_sha256) VALUES (?1, ?2)",
            params![file_name, file_sha256],
        )
        .map(|_| tx.last_insert_rowid())
        .map_err(|error| {
            if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
                "Den här filen har redan importerats.".to_string()
            } else {
                error.to_string()
            }
        })?;
    {
        let mut statement = tx
            .prepare(
                "INSERT INTO transactions (
                    merchant, amount_cents, category, transaction_type, date, source_file, needs_review,
                    import_batch_id, imported_sheet, imported_row, created_at
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))",
            )
            .map_err(|error| error.to_string())?;
        for item in transactions {
            if item.imported_sheet.trim().is_empty() || item.imported_row <= 0 {
                return Err("Importerad sheet och rad måste vara giltiga.".to_string());
            }
            if item.amount_cents.unsigned_abs() > MAX_SAFE_CENTS as u64 {
                return Err("Ett importbelopp är för stort för säker lagring.".to_string());
            }
            statement
                .execute(params![
                    item.merchant,
                    item.amount_cents,
                    item.category,
                    item.transaction_type.as_str(),
                    item.date,
                    item.source_file,
                    item.needs_review,
                    batch_id,
                    item.imported_sheet,
                    item.imported_row
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    get_batch_detail(conn, batch_id).map(|detail| detail.summary)
}

fn delete_batch(conn: &mut Connection, id: i64) -> Result<i64, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let transaction_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE import_batch_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let deleted = tx
        .execute("DELETE FROM import_batches WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    if deleted != 1 {
        return Err(format!("Importen {id} hittades inte."));
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(transaction_count)
}

#[tauri::command]
fn find_import_batch_by_hash(
    app: tauri::AppHandle,
    file_sha256: String,
) -> Result<Option<ImportBatchSummary>, String> {
    let conn = open_app_connection(&app)?;
    find_batch_by_hash(&conn, &file_sha256)
}

#[tauri::command]
fn import_transactions(
    app: tauri::AppHandle,
    file_name: String,
    file_sha256: String,
    transactions: Vec<ImportedTransaction>,
) -> Result<ImportBatchSummary, String> {
    let mut conn = open_app_connection(&app)?;
    import_transactions_as_batch(&mut conn, &file_name, &file_sha256, transactions)
}

#[tauri::command]
fn list_import_batches(app: tauri::AppHandle) -> Result<Vec<ImportBatchSummary>, String> {
    let conn = open_app_connection(&app)?;
    list_batches(&conn)
}

#[tauri::command]
fn get_import_batch(app: tauri::AppHandle, id: i64) -> Result<ImportBatchDetail, String> {
    let conn = open_app_connection(&app)?;
    get_batch_detail(&conn, id)
}

#[tauri::command]
fn delete_import_batch(app: tauri::AppHandle, id: i64) -> Result<i64, String> {
    let mut conn = open_app_connection(&app)?;
    delete_batch(&mut conn, id)
}

fn update_single_category(conn: &Connection, id: i64, category: &str) -> Result<(), String> {
    if category.trim().is_empty() {
        return Err("Kategori får inte vara tom.".to_string());
    }
    let updated = conn
        .execute(
            "UPDATE transactions SET category = ?1, needs_review = 0, category_decided = 1 WHERE id = ?2",
            params![category, id],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err(format!("Transaktion {id} hittades inte."));
    }
    Ok(())
}

fn update_single_transaction_type(
    conn: &Connection,
    id: i64,
    transaction_type: TransactionType,
) -> Result<(), String> {
    let updated = conn
        .execute(
            "UPDATE transactions SET transaction_type = ?1 WHERE id = ?2",
            params![transaction_type.as_str(), id],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err(format!("Transaktion {id} hittades inte."));
    }
    Ok(())
}

fn bulk_update_types(
    conn: &mut Connection,
    ids: &[i64],
    transaction_type: TransactionType,
) -> Result<i64, String> {
    if ids.is_empty() {
        return Err("Inga transaktioner valdes för uppdatering.".to_string());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut updated = 0;
    {
        let mut statement = tx
            .prepare("UPDATE transactions SET transaction_type = ?1 WHERE id = ?2")
            .map_err(|error| error.to_string())?;
        for id in ids {
            updated += statement
                .execute(params![transaction_type.as_str(), id])
                .map_err(|error| error.to_string())? as i64;
        }
    }
    if updated != ids.len() as i64 {
        return Err("En eller flera valda transaktioner hittades inte.".to_string());
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

fn bulk_update_categories(
    conn: &mut Connection,
    ids: &[i64],
    category: &str,
) -> Result<i64, String> {
    if category.trim().is_empty() {
        return Err("Kategori får inte vara tom.".to_string());
    }
    if ids.is_empty() {
        return Err("Inga transaktioner valdes för uppdatering.".to_string());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut updated = 0;
    {
        let mut statement = tx
            .prepare(
                "UPDATE transactions SET category = ?1, needs_review = 0, category_decided = 1 WHERE id = ?2",
            )
            .map_err(|error| error.to_string())?;
        for id in ids {
            updated += statement
                .execute(params![category, id])
                .map_err(|error| error.to_string())? as i64;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

fn upsert_learned_rule(
    conn: &Connection,
    merchant_key: &str,
    category: &str,
) -> Result<(), String> {
    if merchant_key.trim().is_empty() {
        return Err("Merchant-nyckel får inte vara tom.".to_string());
    }
    if category.trim().is_empty() {
        return Err("Kategori får inte vara tom.".to_string());
    }
    conn.execute(
        "INSERT INTO learned_rules (merchant_key, category) VALUES (?1, ?2)
         ON CONFLICT(merchant_key) DO UPDATE SET
            category = excluded.category,
            updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')",
        params![merchant_key, category],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn upsert_learned_transaction_type_rule(
    conn: &Connection,
    merchant_key: &str,
    transaction_type: TransactionType,
) -> Result<(), String> {
    if merchant_key.trim().is_empty() {
        return Err("Merchant-nyckel får inte vara tom.".to_string());
    }
    conn.execute(
        "INSERT INTO learned_transaction_type_rules (merchant_key, transaction_type)
         VALUES (?1, ?2)
         ON CONFLICT(merchant_key) DO UPDATE SET
            transaction_type = excluded.transaction_type,
            updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')",
        params![merchant_key, transaction_type.as_str()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_transaction_category(
    app: tauri::AppHandle,
    id: i64,
    category: String,
) -> Result<(), String> {
    let conn = open_app_connection(&app)?;
    update_single_category(&conn, id, &category)
}

#[tauri::command]
fn update_transaction_type(
    app: tauri::AppHandle,
    id: i64,
    transaction_type: TransactionType,
) -> Result<(), String> {
    let conn = open_app_connection(&app)?;
    update_single_transaction_type(&conn, id, transaction_type)
}

#[tauri::command]
fn bulk_update_transaction_types(
    app: tauri::AppHandle,
    ids: Vec<i64>,
    transaction_type: TransactionType,
) -> Result<i64, String> {
    let mut conn = open_app_connection(&app)?;
    bulk_update_types(&mut conn, &ids, transaction_type)
}

#[tauri::command]
fn bulk_update_transaction_categories(
    app: tauri::AppHandle,
    ids: Vec<i64>,
    category: String,
) -> Result<i64, String> {
    let mut conn = open_app_connection(&app)?;
    bulk_update_categories(&mut conn, &ids, &category)
}

#[tauri::command]
fn save_learned_rule(
    app: tauri::AppHandle,
    merchant_key: String,
    category: String,
) -> Result<(), String> {
    let conn = open_app_connection(&app)?;
    upsert_learned_rule(&conn, &merchant_key, &category)
}

#[tauri::command]
fn save_learned_transaction_type_rule(
    app: tauri::AppHandle,
    merchant_key: String,
    transaction_type: TransactionType,
) -> Result<(), String> {
    let conn = open_app_connection(&app)?;
    upsert_learned_transaction_type_rule(&conn, &merchant_key, transaction_type)
}

fn remember_transaction_type_choice(
    conn: &mut Connection,
    id: i64,
    merchant_key: &str,
    transaction_type: TransactionType,
) -> Result<(), String> {
    if merchant_key.trim().is_empty() {
        return Err("Merchant-nyckel får inte vara tom.".to_string());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let updated = tx
        .execute(
            "UPDATE transactions SET transaction_type = ?1 WHERE id = ?2",
            params![transaction_type.as_str(), id],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err(format!("Transaktionen med id {id} hittades inte."));
    }
    tx.execute(
        "INSERT INTO learned_transaction_type_rules (merchant_key, transaction_type)
         VALUES (?1, ?2)
         ON CONFLICT(merchant_key) DO UPDATE SET
            transaction_type = excluded.transaction_type,
            updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')",
        params![merchant_key, transaction_type.as_str()],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn remember_transaction_type(
    app: tauri::AppHandle,
    id: i64,
    merchant_key: String,
    transaction_type: TransactionType,
) -> Result<(), String> {
    let mut conn = open_app_connection(&app)?;
    remember_transaction_type_choice(&mut conn, id, &merchant_key, transaction_type)
}

#[tauri::command]
fn reject_transaction_category(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_app_connection(&app)?;
    conn.execute(
        "UPDATE transactions SET category = 'Okategoriserat', needs_review = 1, category_decided = 0 WHERE id = ?1",
        params![id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_transaction(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_app_connection(&app)?;
    conn.execute("DELETE FROM transactions WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            init_db,
            get_transaction_count,
            get_transactions,
            get_learned_rules,
            get_learned_transaction_type_rules,
            find_import_batch_by_hash,
            import_transactions,
            list_import_batches,
            get_import_batch,
            delete_import_batch,
            get_budgets,
            get_budget_coverage,
            save_budget,
            update_transaction_category,
            update_transaction_type,
            bulk_update_transaction_types,
            bulk_update_transaction_categories,
            save_learned_rule,
            save_learned_transaction_type_rule,
            remember_transaction_type,
            reject_transaction_category,
            delete_transaction
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_database(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "budgetapp-{name}-{}-{nonce}.sqlite",
            std::process::id()
        ))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite-shm"));
        if let (Some(parent), Some(stem)) = (
            path.parent(),
            path.file_stem().and_then(|value| value.to_str()),
        ) {
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let file_name = entry.file_name();
                    if file_name
                        .to_str()
                        .is_some_and(|name| name.starts_with(&format!("{stem}.pre-schema-4-")))
                    {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    fn pre_schema_four_backups(path: &Path) -> Vec<std::path::PathBuf> {
        let Some(parent) = path.parent() else {
            return Vec::new();
        };
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            return Vec::new();
        };
        fs::read_dir(parent)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with(&format!("{stem}.pre-schema-4-")))
            })
            .collect()
    }

    fn insert_transaction(conn: &Connection, merchant: &str, category: &str) -> i64 {
        if schema_version(conn).unwrap() >= 4 {
            conn.execute(
                "INSERT INTO transactions
                    (merchant, amount_cents, category, date, source_file, needs_review,
                     category_decided, transaction_type)
                 VALUES (?1, -10000, ?2, '2026-01-01', 'test.xlsx', 1, 0, 'expense')",
                params![merchant, category],
            )
        } else {
            conn.execute(
                "INSERT INTO transactions
                    (merchant, amount, category, date, source_file, needs_review, category_decided)
                 VALUES (?1, -100, ?2, '2026-01-01', 'test.xlsx', 1, 0)",
                params![merchant, category],
            )
        }
        .expect("transaction should be inserted");
        conn.last_insert_rowid()
    }

    fn imported_transaction(
        merchant: &str,
        amount_cents: i64,
        date: &str,
        sheet: &str,
        row: i64,
    ) -> ImportedTransaction {
        ImportedTransaction {
            merchant: merchant.to_string(),
            amount_cents,
            category: "Okategoriserat".to_string(),
            transaction_type: TransactionType::Expense,
            date: date.to_string(),
            source_file: "bank.xlsx".to_string(),
            needs_review: true,
            imported_sheet: sheet.to_string(),
            imported_row: row,
        }
    }

    #[test]
    fn creates_an_empty_database_at_current_version() {
        let path = temporary_database("empty");
        let conn = initialize_database(&path).expect("empty database should initialize");

        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN (
                    'transactions', 'categories', 'learned_rules', 'budgets', 'import_batches',
                    'learned_transaction_type_rules'
                 )",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 6);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn opens_a_database_already_at_current_version_without_rerunning_migration() {
        let path = temporary_database("current");
        let conn = initialize_database(&path).unwrap();
        let id = insert_transaction(&conn, "BEFINTLIG", "Övrigt");
        drop(conn);

        let conn = initialize_database(&path).expect("current database should reopen");
        let stored: String = conn
            .query_row(
                "SELECT merchant FROM transactions WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        let migration_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_migrations", (), |row| row.get(0))
            .unwrap();
        assert_eq!(stored, "BEFINTLIG");
        assert_eq!(migration_count, 1);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn migrates_a_previous_unversioned_database() {
        let path = temporary_database("previous");
        let conn = open_configured_connection(&path).unwrap();
        conn.execute(
            "CREATE TABLE transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                merchant TEXT NOT NULL,
                amount REAL NOT NULL,
                category TEXT
            )",
            (),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transactions (merchant, amount, category) VALUES ('LEGACY', -42, 'Övrigt')",
            (),
        )
        .unwrap();
        drop(conn);

        let conn = initialize_database(&path).expect("legacy database should migrate");
        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let source_file: Option<String> = conn
            .query_row(
                "SELECT source_file FROM transactions WHERE merchant = 'LEGACY'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_file, None);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn migrates_schema_one_to_import_batches_without_fabricating_legacy_provenance() {
        let path = temporary_database("schema-one");
        let mut conn = open_configured_connection(&path).unwrap();
        run_migration_step(&mut conn, 1, migration_0_to_1).unwrap();
        let legacy_id = insert_transaction(&conn, "LEGACY", "Övrigt");
        drop(conn);

        let conn = initialize_database(&path).expect("schema one should migrate");
        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let batch_table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'import_batches'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        let provenance: (Option<i64>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT import_batch_id, imported_sheet, imported_row
                 FROM transactions WHERE id = ?1",
                params![legacy_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(batch_table_count, 1);
        assert_eq!(provenance, (None, None, None));
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn migrates_schema_two_transaction_types_conservatively_and_only_once() {
        let path = temporary_database("schema-two-types");
        let mut conn = open_configured_connection(&path).unwrap();
        run_migration_step(&mut conn, 1, migration_0_to_1).unwrap();
        run_migration_step(&mut conn, 2, migration_1_to_2).unwrap();
        for (merchant, amount, category) in [
            ("EXPENSE", -100.0, "Övrigt"),
            ("SAVING", -200.0, "Sparande"),
            ("AMORTIZATION", -300.0, "Sparande / Amortering"),
            ("TRANSFER", 400.0, "Överföring mellan konto"),
            ("SALARY", 500.0, "Lön"),
            ("BENEFIT", 600.0, "Bidrag"),
            ("RENT", 700.0, "Uthyrning"),
            ("UNCERTAIN", 800.0, "Övrigt"),
        ] {
            conn.execute(
                "INSERT INTO transactions (merchant, amount, category) VALUES (?1, ?2, ?3)",
                params![merchant, amount, category],
            )
            .unwrap();
        }
        drop(conn);

        let conn = initialize_database(&path).expect("schema two should migrate");
        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let column_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('transactions')
                 WHERE name = 'transaction_type' AND \"notnull\" = 1",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(column_count, 1);
        let mapped = [
            ("EXPENSE", "expense"),
            ("SAVING", "saving"),
            ("AMORTIZATION", "amortization"),
            ("TRANSFER", "transfer"),
            ("SALARY", "income"),
            ("BENEFIT", "income"),
            ("RENT", "income"),
            ("UNCERTAIN", "unclassified"),
        ];
        for (merchant, expected) in mapped {
            let actual: String = conn
                .query_row(
                    "SELECT transaction_type FROM transactions WHERE merchant = ?1",
                    params![merchant],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(actual, expected);
        }
        conn.execute(
            "UPDATE transactions SET transaction_type = 'refund' WHERE merchant = 'UNCERTAIN'",
            (),
        )
        .unwrap();
        drop(conn);

        let conn = initialize_database(&path).expect("current schema should reopen");
        let preserved: String = conn
            .query_row(
                "SELECT transaction_type FROM transactions WHERE merchant = 'UNCERTAIN'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, "refund");
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn rejects_transaction_types_outside_the_supported_model() {
        let path = temporary_database("type-check");
        let conn = initialize_database(&path).unwrap();
        let result = conn.execute(
            "INSERT INTO transactions (merchant, amount, category, transaction_type)
             VALUES ('INVALID', -10, 'Övrigt', 'not-a-type')",
            (),
        );

        assert!(result.is_err());
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn converts_legacy_money_only_when_it_is_exact_at_cent_precision() {
        for (amount, expected) in [
            (12.34, 1234),
            (-12.34, -1234),
            (0.0, 0),
            (0.01, 1),
            (-0.01, -1),
            (10.099999999999, 1010),
            (-10.099999999999, -1010),
        ] {
            assert_eq!(legacy_amount_to_cents(amount).unwrap(), expected);
        }
        assert!(legacy_amount_to_cents(10.123).is_err());

        let within_epsilon = (1010.0 + CENTS_EPSILON / 2.0) / 100.0;
        let outside_epsilon = (1010.0 + CENTS_EPSILON * 2.0) / 100.0;
        assert_eq!(legacy_amount_to_cents(within_epsilon).unwrap(), 1010);
        assert!(legacy_amount_to_cents(outside_epsilon).is_err());
    }

    #[test]
    fn migrates_schema_three_money_with_backup_and_preserves_all_relations() {
        let path = temporary_database("schema-three-cents");
        let mut conn = open_configured_connection(&path).unwrap();
        run_migration_step(&mut conn, 1, migration_0_to_1).unwrap();
        run_migration_step(&mut conn, 2, migration_1_to_2).unwrap();
        run_migration_step(&mut conn, 3, migration_2_to_3).unwrap();
        conn.execute(
            "INSERT INTO import_batches (id, file_name, file_sha256)
             VALUES (7, 'batch.xlsx', ?1)",
            params!["7".repeat(64)],
        )
        .unwrap();
        let rows = [
            (11, "LEGACY", 0.10, "Övrigt", "expense", None, None, None),
            (
                12,
                "INCOME",
                1000.20,
                "Lön",
                "income",
                Some(7),
                Some("Income"),
                Some(2),
            ),
            (
                13,
                "EXPENSE",
                -200.30,
                "Mat / Dagligvaror",
                "expense",
                Some(7),
                Some("Data"),
                Some(3),
            ),
            (
                14,
                "SAVING",
                -300.40,
                "Sparande",
                "saving",
                Some(7),
                Some("Data"),
                Some(4),
            ),
            (
                15,
                "AMORTIZATION",
                -400.50,
                "Sparande / Amortering",
                "amortization",
                Some(7),
                Some("Data"),
                Some(5),
            ),
            (
                16,
                "TRANSFER",
                -500.60,
                "Överföring mellan konto",
                "transfer",
                Some(7),
                Some("Data"),
                Some(6),
            ),
            (
                17,
                "REFUND",
                20.70,
                "Mat / Dagligvaror",
                "refund",
                Some(7),
                Some("Data"),
                Some(7),
            ),
            (
                18,
                "UNCLASSIFIED",
                30.80,
                "Övrigt",
                "unclassified",
                Some(7),
                Some("Data"),
                Some(8),
            ),
        ];
        for (id, merchant, amount, category, transaction_type, batch, sheet, imported_row) in rows {
            conn.execute(
                "INSERT INTO transactions (
                    id, merchant, amount, category, transaction_type, date, source_file,
                    needs_review, category_decided, import_batch_id, imported_sheet, imported_row
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, '2026-01-01', 'batch.xlsx',
                    ?6, ?7, ?8, ?9, ?10
                 )",
                params![
                    id,
                    merchant,
                    amount,
                    category,
                    transaction_type,
                    i64::from(transaction_type == "unclassified"),
                    i64::from(transaction_type != "unclassified"),
                    batch,
                    sheet,
                    imported_row
                ],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO learned_rules (merchant_key, category) VALUES ('TEST', 'Övrigt')",
            (),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO budgets (year, month, category, amount)
             VALUES (2026, 1, 'Mat / Dagligvaror', 5000.00),
                    (2026, 1, 'Sparande', 0.10)",
            (),
        )
        .unwrap();
        let categories_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        let conn = initialize_database(&path).expect("schema three should migrate to cents");
        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let backups = pre_schema_four_backups(&path);
        assert_eq!(backups.len(), 1);
        let backup = open_configured_connection(&backups[0]).unwrap();
        assert_eq!(schema_version(&backup).unwrap(), 3);
        let backup_rows: i64 = backup
            .query_row("SELECT COUNT(*) FROM transactions", [], |row| row.get(0))
            .unwrap();
        let backup_amount: f64 = backup
            .query_row("SELECT amount FROM transactions WHERE id = 12", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(backup_rows, 8);
        assert_eq!(backup_amount, 1000.20);
        drop(backup);
        let columns = {
            let mut statement = conn.prepare("PRAGMA table_info(transactions)").unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(columns.contains(&"amount_cents".to_string()));
        assert!(!columns.contains(&"amount".to_string()));
        let transaction_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions", [], |row| row.get(0))
            .unwrap();
        let ids: Vec<i64> = {
            let mut statement = conn
                .prepare("SELECT id FROM transactions ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let total_cents: i64 = conn
            .query_row("SELECT SUM(amount_cents) FROM transactions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let budget_total_cents: i64 = conn
            .query_row("SELECT SUM(amount_cents) FROM budgets", [], |row| {
                row.get(0)
            })
            .unwrap();
        let preserved_batch_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions
                 WHERE import_batch_id = 7 AND imported_sheet IS NOT NULL AND imported_row IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let preserved_types: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT transaction_type) FROM transactions",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let learned_rules: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM learned_rules WHERE merchant_key = 'TEST'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let categories_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
            .unwrap();
        let foreign_key_problems: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(transaction_count, 8);
        assert_eq!(ids, vec![11, 12, 13, 14, 15, 16, 17, 18]);
        assert_eq!(total_cents, -35_000);
        assert_eq!(budget_total_cents, 500_010);
        assert_eq!(preserved_batch_rows, 7);
        assert_eq!(preserved_types, 7);
        assert_eq!(learned_rules, 1);
        assert_eq!(categories_after, categories_before);
        assert_eq!(foreign_key_problems, 0);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn blocks_extra_precision_and_keeps_schema_three_with_backup() {
        let path = temporary_database("schema-three-invalid-money");
        let mut conn = open_configured_connection(&path).unwrap();
        run_migration_step(&mut conn, 1, migration_0_to_1).unwrap();
        run_migration_step(&mut conn, 2, migration_1_to_2).unwrap();
        run_migration_step(&mut conn, 3, migration_2_to_3).unwrap();
        conn.execute(
            "INSERT INTO transactions (merchant, amount, category, transaction_type)
             VALUES ('TOO PRECISE', 10.123, 'Övrigt', 'expense')",
            (),
        )
        .unwrap();
        drop(conn);

        let error = initialize_database(&path).expect_err("extra precision must block migration");
        assert!(error.contains("mer än två verkliga decimaler"));
        assert!(error.contains("Säkerhetskopian finns kvar"));
        assert_eq!(pre_schema_four_backups(&path).len(), 1);
        let conn = open_configured_connection(&path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 3);
        assert!(table_exists(&conn, "transactions").unwrap());
        assert!(!table_exists(&conn, "transactions_schema4").unwrap());
        let amount: f64 = conn
            .query_row(
                "SELECT amount FROM transactions WHERE merchant = 'TOO PRECISE'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(amount, 10.123);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn migration_sums_many_fractional_legacy_rows_exactly_in_cents() {
        let path = temporary_database("fractional-sum");
        let mut conn = open_configured_connection(&path).unwrap();
        run_migration_step(&mut conn, 1, migration_0_to_1).unwrap();
        run_migration_step(&mut conn, 2, migration_1_to_2).unwrap();
        run_migration_step(&mut conn, 3, migration_2_to_3).unwrap();
        for _ in 0..100 {
            for amount in [0.10, 0.20, 0.30] {
                conn.execute(
                    "INSERT INTO transactions (
                        merchant, amount, category, transaction_type
                     ) VALUES ('FRACTION', ?1, 'Övrigt', 'unclassified')",
                    params![amount],
                )
                .unwrap();
            }
        }

        run_migration_step(&mut conn, 4, migration_3_to_4).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions", [], |row| row.get(0))
            .unwrap();
        let total_cents: i64 = conn
            .query_row("SELECT SUM(amount_cents) FROM transactions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 300);
        assert_eq!(total_cents, 6_000);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn rolls_back_failed_schema_two_to_three_migration() {
        let path = temporary_database("type-migration-rollback");
        let mut conn = open_configured_connection(&path).unwrap();
        run_migration_step(&mut conn, 1, migration_0_to_1).unwrap();
        run_migration_step(&mut conn, 2, migration_1_to_2).unwrap();
        conn.execute(
            "INSERT INTO transactions (merchant, amount, category)
             VALUES ('BLOCKED', -10, 'Övrigt')",
            (),
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER block_type_migration
             BEFORE UPDATE ON transactions
             BEGIN
               SELECT RAISE(ABORT, 'test migration failure');
             END;",
        )
        .unwrap();

        assert!(run_migration_step(&mut conn, 3, migration_2_to_3).is_err());
        assert_eq!(schema_version(&conn).unwrap(), 2);
        let column_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('transactions')
                 WHERE name = 'transaction_type'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(column_count, 0);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn rolls_back_a_failed_migration_step() {
        let path = temporary_database("rollback");
        let mut conn = open_configured_connection(&path).unwrap();
        let result = run_migration_step(&mut conn, 1, |tx| {
            tx.execute("CREATE TABLE migration_marker (id INTEGER)", ())?;
            tx.execute("THIS IS NOT VALID SQL", ())?;
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(schema_version(&conn).unwrap(), 0);
        let marker_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'migration_marker'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker_count, 0);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn rejects_a_newer_unknown_schema_version() {
        let path = temporary_database("newer");
        let mut conn = open_configured_connection(&path).unwrap();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .unwrap();

        let error = migrate_database(&mut conn).expect_err("newer schema must be rejected");
        assert!(error.contains("stöder högst"));
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn enables_foreign_keys_for_configured_connections() {
        let path = temporary_database("foreign-keys");
        let conn = initialize_database(&path).unwrap();
        let enabled: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn single_category_update_changes_only_one_transaction_and_no_rule() {
        let path = temporary_database("single-category");
        let conn = initialize_database(&path).unwrap();
        let first = insert_transaction(&conn, "ICA MAXI", "Okategoriserat");
        let second = insert_transaction(&conn, "ICA MAXI", "Okategoriserat");
        let rules_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM learned_rules", (), |row| row.get(0))
            .unwrap();

        update_single_category(&conn, first, "Mat / Dagligvaror").unwrap();

        let categories: Vec<String> = conn
            .prepare("SELECT category FROM transactions ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let rule_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM learned_rules", (), |row| row.get(0))
            .unwrap();
        assert_eq!(categories, vec!["Mat / Dagligvaror", "Okategoriserat"]);
        assert_eq!(rule_count, rules_before);
        assert_ne!(first, second);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn transaction_type_update_changes_only_the_selected_transaction() {
        let path = temporary_database("single-type");
        let conn = initialize_database(&path).unwrap();
        let first = insert_transaction(&conn, "FIRST", "Övrigt");
        let second = insert_transaction(&conn, "SECOND", "Övrigt");

        update_single_transaction_type(&conn, first, TransactionType::Refund).unwrap();

        let first_type: String = conn
            .query_row(
                "SELECT transaction_type FROM transactions WHERE id = ?1",
                params![first],
                |row| row.get(0),
            )
            .unwrap();
        let second_type: String = conn
            .query_row(
                "SELECT transaction_type FROM transactions WHERE id = ?1",
                params![second],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first_type, "refund");
        assert_eq!(second_type, "expense");
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn migrates_schema_four_to_learned_transaction_type_rules() {
        let path = temporary_database("schema-four-type-rules");
        let mut conn = open_configured_connection(&path).unwrap();
        run_migration_step(&mut conn, 1, migration_0_to_1).unwrap();
        run_migration_step(&mut conn, 2, migration_1_to_2).unwrap();
        run_migration_step(&mut conn, 3, migration_2_to_3).unwrap();
        run_migration_step(&mut conn, 4, migration_3_to_4).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 4);
        drop(conn);

        let conn = initialize_database(&path).expect("schema four should migrate");
        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        upsert_learned_transaction_type_rule(&conn, "SWISH MOTTAGET", TransactionType::Income)
            .unwrap();
        let invalid = conn.execute(
            "INSERT INTO learned_transaction_type_rules (merchant_key, transaction_type)
             VALUES ('INVALID', 'not-a-type')",
            (),
        );
        assert!(invalid.is_err());
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn learned_transaction_type_rule_does_not_change_history() {
        let path = temporary_database("learned-type-rule");
        let conn = initialize_database(&path).unwrap();
        let existing = insert_transaction(&conn, "Swish mottaget", "Övrigt");

        upsert_learned_transaction_type_rule(&conn, "SWISH MOTTAGET", TransactionType::Income)
            .unwrap();

        let stored_type: String = conn
            .query_row(
                "SELECT transaction_type FROM transactions WHERE id = ?1",
                params![existing],
                |row| row.get(0),
            )
            .unwrap();
        let stored_rule: String = conn
            .query_row(
                "SELECT transaction_type FROM learned_transaction_type_rules
                 WHERE merchant_key = 'SWISH MOTTAGET'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_type, "expense");
        assert_eq!(stored_rule, "income");
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn remembering_a_type_updates_only_the_selected_row_and_future_rule_atomically() {
        let path = temporary_database("remember-type");
        let mut conn = initialize_database(&path).unwrap();
        let selected = insert_transaction(&conn, "SWISH RECEIVED", "Övrigt");
        let historical_match = insert_transaction(&conn, "SWISH RECEIVED", "Övrigt");

        remember_transaction_type_choice(
            &mut conn,
            selected,
            "SWISH MOTTAGET",
            TransactionType::Income,
        )
        .unwrap();

        let types: Vec<String> = conn
            .prepare("SELECT transaction_type FROM transactions ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let rule: String = conn
            .query_row(
                "SELECT transaction_type FROM learned_transaction_type_rules
                 WHERE merchant_key = 'SWISH MOTTAGET'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(types, vec!["income", "expense"]);
        assert_eq!(rule, "income");
        assert_ne!(selected, historical_match);

        assert!(remember_transaction_type_choice(
            &mut conn,
            i64::MAX,
            "SHOULD NOT EXIST",
            TransactionType::Refund,
        )
        .is_err());
        let failed_rule_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM learned_transaction_type_rules
                 WHERE merchant_key = 'SHOULD NOT EXIST'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(failed_rule_count, 0);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn bulk_type_update_changes_only_selected_transactions() {
        let path = temporary_database("bulk-type");
        let mut conn = initialize_database(&path).unwrap();
        let first = insert_transaction(&conn, "SWISH ONE", "Övrigt");
        let second = insert_transaction(&conn, "SWISH TWO", "Övrigt");
        let untouched = insert_transaction(&conn, "OTHER", "Övrigt");

        let updated =
            bulk_update_types(&mut conn, &[first, second], TransactionType::Income).unwrap();

        let types: Vec<String> = conn
            .prepare("SELECT transaction_type FROM transactions ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(updated, 2);
        assert_eq!(types, vec!["income", "income", "expense"]);
        assert_ne!(second, untouched);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn bulk_type_update_is_atomic_when_a_row_fails() {
        let path = temporary_database("bulk-type-atomic");
        let mut conn = initialize_database(&path).unwrap();
        let first = insert_transaction(&conn, "FIRST", "Övrigt");
        let second = insert_transaction(&conn, "SECOND", "Övrigt");
        conn.execute_batch(&format!(
            "CREATE TRIGGER block_second_type
             BEFORE UPDATE OF transaction_type ON transactions
             WHEN OLD.id = {second}
             BEGIN
               SELECT RAISE(ABORT, 'blocked');
             END;"
        ))
        .unwrap();

        assert!(bulk_update_types(&mut conn, &[first, second], TransactionType::Income).is_err());
        let changed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE transaction_type = 'income'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(changed, 0);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn saves_and_loads_budget_amounts_in_cents() {
        let path = temporary_database("budget-cents");
        let conn = initialize_database(&path).unwrap();

        save_budget_amount(&conn, 2026, 1, "Mat / Dagligvaror", 500_000).unwrap();
        save_budget_amount(&conn, 2026, 1, "Nollbudget", 0).unwrap();
        save_budget_amount(&conn, 2026, 1, "Teknisk negativ", -100).unwrap();
        save_budget_amount(&conn, 2026, 1, "Mat / Dagligvaror", 510_000).unwrap();

        let budgets = get_budgets_for_period(&conn, 2026, Some(1)).unwrap();
        let values = budgets
            .into_iter()
            .map(|budget| (budget.category, budget.amount_cents))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(values.get("Mat / Dagligvaror"), Some(&510_000));
        assert_eq!(values.get("Nollbudget"), Some(&0));
        assert_eq!(values.get("Teknisk negativ"), Some(&-100));
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn counts_distinct_budgeted_months_for_annual_coverage() {
        let path = temporary_database("budget-coverage");
        let conn = initialize_database(&path).unwrap();
        assert_eq!(count_budgeted_months(&conn, 2026).unwrap(), 0);

        save_budget_amount(&conn, 2026, 1, "Mat / Dagligvaror", 100_000).unwrap();
        save_budget_amount(&conn, 2026, 1, "Boende / El", 200_000).unwrap();
        assert_eq!(count_budgeted_months(&conn, 2026).unwrap(), 1);

        for month in 2..=8 {
            save_budget_amount(&conn, 2026, month, "Mat / Dagligvaror", 100_000).unwrap();
        }
        assert_eq!(count_budgeted_months(&conn, 2026).unwrap(), 8);

        for month in 9..=12 {
            save_budget_amount(&conn, 2026, month, "Mat / Dagligvaror", 100_000).unwrap();
        }
        assert_eq!(count_budgeted_months(&conn, 2026).unwrap(), 12);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn bulk_category_update_is_atomic_when_a_row_fails() {
        let path = temporary_database("bulk-rollback");
        let mut conn = initialize_database(&path).unwrap();
        let first = insert_transaction(&conn, "ICA MAXI", "Okategoriserat");
        let second = insert_transaction(&conn, "ICA MAXI", "Okategoriserat");
        conn.execute_batch(&format!(
            "CREATE TRIGGER fail_second_update
             BEFORE UPDATE ON transactions
             WHEN OLD.id = {second}
             BEGIN
               SELECT RAISE(ABORT, 'test failure');
             END;"
        ))
        .unwrap();

        assert!(bulk_update_categories(&mut conn, &[first, second], "Mat / Dagligvaror").is_err());
        let unchanged: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE category = 'Okategoriserat'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unchanged, 2);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn bulk_category_update_changes_only_the_selected_transactions() {
        let path = temporary_database("bulk-selected");
        let mut conn = initialize_database(&path).unwrap();
        let first = insert_transaction(&conn, "ICA MAXI", "Okategoriserat");
        let second = insert_transaction(&conn, "ICA MAXI", "Okategoriserat");
        let unrelated = insert_transaction(&conn, "ICA BANKEN", "Okategoriserat");

        let updated =
            bulk_update_categories(&mut conn, &[first, second], "Mat / Dagligvaror").unwrap();

        let unrelated_category: String = conn
            .query_row(
                "SELECT category FROM transactions WHERE id = ?1",
                params![unrelated],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(updated, 2);
        assert_eq!(unrelated_category, "Okategoriserat");
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn learned_rule_creation_does_not_change_history() {
        let path = temporary_database("future-rule");
        let conn = initialize_database(&path).unwrap();
        let id = insert_transaction(&conn, "ICA MAXI", "Okategoriserat");

        upsert_learned_rule(&conn, "ICA MAXI", "Mat / Dagligvaror").unwrap();

        let category: String = conn
            .query_row(
                "SELECT category FROM transactions WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(category, "Okategoriserat");
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn imports_a_batch_with_provenance_and_lists_derived_history() {
        let path = temporary_database("batch-history");
        let mut conn = initialize_database(&path).unwrap();
        let summary = import_transactions_as_batch(
            &mut conn,
            "bank.xlsx",
            &"a".repeat(64),
            vec![
                imported_transaction("ICA", -29_900, "2026-09-15", "Sheet1", 37),
                imported_transaction("ICA", -29_900, "2026-09-15", "Sheet1", 38),
                imported_transaction("LÖN", 2_500_000, "2026-09-25", "Income", 4),
            ],
        )
        .unwrap();

        assert_eq!(summary.transaction_count, 3);
        assert_eq!(summary.earliest_date.as_deref(), Some("2026-09-15"));
        assert_eq!(summary.latest_date.as_deref(), Some("2026-09-25"));
        assert_eq!(summary.needs_review_count, 3);
        assert_eq!(summary.positive_total_cents, 2_500_000);
        assert_eq!(summary.negative_total_cents, -59_800);
        let detail = get_batch_detail(&conn, summary.id).unwrap();
        assert_eq!(
            detail.transactions[0].imported_sheet.as_deref(),
            Some("Income")
        );
        assert_eq!(detail.transactions[1].imported_row, Some(37));
        assert_eq!(detail.transactions[2].imported_row, Some(38));
        assert_eq!(list_batches(&conn).unwrap().len(), 1);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn blocks_the_same_hash_even_with_a_new_file_name_without_partial_writes() {
        let path = temporary_database("duplicate-hash");
        let mut conn = initialize_database(&path).unwrap();
        let hash = "b".repeat(64);
        let first = import_transactions_as_batch(
            &mut conn,
            "bank.xlsx",
            &hash,
            vec![imported_transaction(
                "ICA",
                -10_000,
                "2026-01-01",
                "Data",
                2,
            )],
        )
        .unwrap();

        let error = import_transactions_as_batch(
            &mut conn,
            "bank-kopia.xlsx",
            &hash,
            vec![imported_transaction(
                "ICA",
                -10_000,
                "2026-01-01",
                "Data",
                2,
            )],
        )
        .expect_err("same bytes must be blocked");
        let existing = find_batch_by_hash(&conn, &hash).unwrap().unwrap();
        let batch_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM import_batches", (), |row| row.get(0))
            .unwrap();
        let transaction_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions", (), |row| row.get(0))
            .unwrap();
        assert!(error.contains("redan importerats"));
        assert_eq!(existing.id, first.id);
        assert_eq!(existing.file_name, "bank.xlsx");
        assert_eq!(batch_count, 1);
        assert_eq!(transaction_count, 1);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn allows_identical_economic_rows_when_file_bytes_are_different() {
        let path = temporary_database("different-files");
        let mut conn = initialize_database(&path).unwrap();
        let transaction = || imported_transaction("ICA", -29_900, "2026-09-15", "Data", 2);

        import_transactions_as_batch(
            &mut conn,
            "first.xlsx",
            &"c".repeat(64),
            vec![transaction()],
        )
        .unwrap();
        import_transactions_as_batch(
            &mut conn,
            "second.xlsx",
            &"d".repeat(64),
            vec![transaction()],
        )
        .unwrap();

        let batch_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM import_batches", (), |row| row.get(0))
            .unwrap();
        let transaction_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions", (), |row| row.get(0))
            .unwrap();
        assert_eq!(batch_count, 2);
        assert_eq!(transaction_count, 2);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn rolls_back_batch_and_rows_when_an_imported_row_fails() {
        let path = temporary_database("import-rollback");
        let mut conn = initialize_database(&path).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_import_row
             BEFORE INSERT ON transactions
             WHEN NEW.imported_row = 3
             BEGIN
               SELECT RAISE(ABORT, 'test import failure');
             END;",
        )
        .unwrap();
        let hash = "e".repeat(64);

        let result = import_transactions_as_batch(
            &mut conn,
            "broken.xlsx",
            &hash,
            vec![
                imported_transaction("FIRST", -10_000, "2026-01-01", "Data", 2),
                imported_transaction("SECOND", -20_000, "2026-01-02", "Data", 3),
            ],
        );

        assert!(result.is_err());
        assert!(find_batch_by_hash(&conn, &hash).unwrap().is_none());
        let transaction_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions", (), |row| row.get(0))
            .unwrap();
        assert_eq!(transaction_count, 0);
        conn.execute("DROP TRIGGER fail_import_row", ()).unwrap();
        let retry = import_transactions_as_batch(
            &mut conn,
            "broken.xlsx",
            &hash,
            vec![imported_transaction(
                "RETRY",
                -10_000,
                "2026-01-01",
                "Data",
                2,
            )],
        )
        .expect("the same file hash should be retryable after rollback");
        assert_eq!(retry.transaction_count, 1);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn cascade_undo_removes_only_the_selected_batch_and_keeps_legacy_and_rules() {
        let path = temporary_database("cascade-undo");
        let mut conn = initialize_database(&path).unwrap();
        let legacy_id = insert_transaction(&conn, "LEGACY", "Övrigt");
        upsert_learned_rule(&conn, "CUSTOM", "Övrigt").unwrap();
        let learned_rules_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM learned_rules", (), |row| row.get(0))
            .unwrap();
        let first = import_transactions_as_batch(
            &mut conn,
            "first.xlsx",
            &"f".repeat(64),
            vec![
                imported_transaction("FIRST", -10_000, "2026-01-01", "Data", 2),
                imported_transaction("SECOND", -20_000, "2026-01-02", "Data", 3),
            ],
        )
        .unwrap();
        let second = import_transactions_as_batch(
            &mut conn,
            "second.xlsx",
            &"1".repeat(64),
            vec![imported_transaction(
                "THIRD",
                -30_000,
                "2026-01-03",
                "Data",
                2,
            )],
        )
        .unwrap();

        assert_eq!(delete_batch(&mut conn, first.id).unwrap(), 2);
        let first_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE import_batch_id = ?1",
                params![first.id],
                |row| row.get(0),
            )
            .unwrap();
        let second_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE import_batch_id = ?1",
                params![second.id],
                |row| row.get(0),
            )
            .unwrap();
        let legacy_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE id = ?1 AND import_batch_id IS NULL",
                params![legacy_id],
                |row| row.get(0),
            )
            .unwrap();
        let learned_rules_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM learned_rules", (), |row| row.get(0))
            .unwrap();
        assert_eq!(first_rows, 0);
        assert_eq!(second_rows, 1);
        assert_eq!(legacy_exists, 1);
        assert_eq!(learned_rules_after, learned_rules_before);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn failed_cascade_undo_keeps_the_batch_and_its_transactions() {
        let path = temporary_database("undo-rollback");
        let mut conn = initialize_database(&path).unwrap();
        let batch = import_transactions_as_batch(
            &mut conn,
            "protected.xlsx",
            &"2".repeat(64),
            vec![imported_transaction(
                "KEEP",
                -10_000,
                "2026-01-01",
                "Data",
                2,
            )],
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER prevent_batch_transaction_delete
             BEFORE DELETE ON transactions
             WHEN OLD.import_batch_id IS NOT NULL
             BEGIN
               SELECT RAISE(ABORT, 'test undo failure');
             END;",
        )
        .unwrap();

        assert!(delete_batch(&mut conn, batch.id).is_err());
        assert!(get_batch_detail(&conn, batch.id).is_ok());
        drop(conn);
        cleanup(&path);
    }
}
