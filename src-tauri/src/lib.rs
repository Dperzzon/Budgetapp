use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use tauri::Manager;

#[derive(serde::Deserialize)]
struct ImportedTransaction {
    merchant: String,
    amount: f64,
    category: String,
    date: String,
    source_file: String,
    needs_review: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredTransaction {
    id: i64,
    merchant: String,
    amount: f64,
    category: String,
    date: String,
    source_file: String,
    needs_review: bool,
    category_decided: bool,
}

#[derive(serde::Serialize)]
struct CategoryBudget {
    category: String,
    amount: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LearnedRule {
    merchant_key: String,
    category: String,
}

fn app_db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_dir).map_err(|error| error.to_string())?;
    Ok(app_dir.join("budgetapp.sqlite"))
}

fn ensure_transaction_column(
    conn: &Connection,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = conn
        .prepare("PRAGMA table_info(transactions)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    if !columns.iter().any(|existing| existing == column) {
        conn.execute(
            &format!("ALTER TABLE transactions ADD COLUMN {column} {definition}"),
            (),
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn migrate_ikea_barkarby_categories(conn: &mut Connection) -> Result<(), String> {
    let already_applied: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM app_migrations WHERE migration_key = 'ikea-barkarby-if-hf-categories'",
            (),
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if already_applied.is_some() {
        return Ok(());
    }

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE transactions
         SET category = 'Boende / Projekt', needs_review = 0, category_decided = 1
         WHERE merchant LIKE '%IKEA%BARKARBY%HF%' COLLATE NOCASE",
        (),
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE transactions
         SET category = 'Restaurang / Café', needs_review = 0, category_decided = 1
         WHERE merchant LIKE '%IKEA%BARKARBY%IF%' COLLATE NOCASE",
        (),
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO learned_rules (merchant_key, category) VALUES
            ('IKEA BARKARBY HF', 'Boende / Projekt'),
            ('IKEA BARKARBY IF', 'Restaurang / Café')
         ON CONFLICT(merchant_key) DO UPDATE SET
            category = excluded.category,
            updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')",
        (),
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO app_migrations (migration_key) VALUES ('ikea-barkarby-if-hf-categories')",
        (),
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn init_db(app: tauri::AppHandle) -> Result<String, String> {
    let db_path = app_db_path(&app)?;
    let mut conn = Connection::open(&db_path).map_err(|error| error.to_string())?;

    conn.execute(
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
    )
    .map_err(|error| error.to_string())?;

    for (column, definition) in [
        ("date", "TEXT"),
        ("source_file", "TEXT"),
        ("needs_review", "INTEGER NOT NULL DEFAULT 1"),
        ("category_decided", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        ensure_transaction_column(&conn, column, definition)?;
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )
    .map_err(|error| error.to_string())?;

    conn.execute(
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
    )
    .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM categories WHERE name = 'Husdjur'", ())
        .map_err(|error| error.to_string())?;
    ensure_learned_rules_table(&conn)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_migrations (
            migration_key TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )
    .map_err(|error| error.to_string())?;
    migrate_ikea_barkarby_categories(&mut conn)?;

    conn.execute(
        "UPDATE transactions
         SET category = 'Överföring mellan konto', needs_review = 0
            WHERE (merchant LIKE '%Överföring via internet%' COLLATE NOCASE
                 OR merchant LIKE '%överföring via internet%' COLLATE NOCASE)
             AND (category IS NOT 'Överföring mellan konto' OR needs_review <> 0)",
        (),
    )
    .map_err(|error| error.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS budgets (
            year INTEGER NOT NULL,
            month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
            category TEXT NOT NULL,
            amount REAL NOT NULL,
            PRIMARY KEY (year, month, category)
        )",
        (),
    )
    .map_err(|error| error.to_string())?;

    Ok(db_path.display().to_string())
}

#[tauri::command]
fn get_transaction_count(app: tauri::AppHandle) -> Result<i64, String> {
    let db_path = app_db_path(&app)?;
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM transactions", (), |row| row.get(0))
        .map_err(|error| error.to_string())?;

    Ok(count)
}

#[tauri::command]
fn get_transactions(app: tauri::AppHandle) -> Result<Vec<StoredTransaction>, String> {
    let db_path = app_db_path(&app)?;
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT id, merchant, amount, COALESCE(category, 'Okategoriserat'),
                    COALESCE(date, 'Okänt datum'), COALESCE(source_file, ''), needs_review, category_decided
             FROM transactions ORDER BY date DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(StoredTransaction {
                id: row.get(0)?,
                merchant: row.get(1)?,
                amount: row.get(2)?,
                category: row.get(3)?,
                date: row.get(4)?,
                source_file: row.get(5)?,
                needs_review: row.get::<_, i64>(6)? != 0,
                category_decided: row.get::<_, i64>(7)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_learned_rules(app: tauri::AppHandle) -> Result<Vec<LearnedRule>, String> {
    let db_path = app_db_path(&app)?;
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT merchant_key, category FROM learned_rules ORDER BY updated_at DESC, rowid DESC")
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
fn get_budgets(
    app: tauri::AppHandle,
    year: i32,
    month: Option<i32>,
) -> Result<Vec<CategoryBudget>, String> {
    let db_path = app_db_path(&app)?;
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT category, SUM(amount) FROM budgets
             WHERE year = ?1 AND (?2 IS NULL OR month = ?2)
             GROUP BY category ORDER BY category",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![year, month], |row| {
            Ok(CategoryBudget {
                category: row.get(0)?,
                amount: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_budget(
    app: tauri::AppHandle,
    year: i32,
    month: i32,
    category: String,
    amount: f64,
) -> Result<(), String> {
    let db_path = app_db_path(&app)?;
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO budgets (year, month, category, amount) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(year, month, category) DO UPDATE SET amount = excluded.amount",
        params![year, month, category, amount],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_transactions(app: tauri::AppHandle, transactions: Vec<ImportedTransaction>) -> Result<i64, String> {
    let db_path = app_db_path(&app)?;
    let mut conn = Connection::open(&db_path).map_err(|error| error.to_string())?;

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut inserted = 0;
    {
        let mut statement = tx
            .prepare(
                "INSERT INTO transactions (merchant, amount, category, date, source_file, needs_review, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
            )
            .map_err(|error| error.to_string())?;
        for item in transactions {
            inserted += statement
                .execute(params![
                    item.merchant,
                    item.amount,
                    item.category,
                    item.date,
                    item.source_file,
                    item.needs_review
                ])
                .map_err(|error| error.to_string())? as i64;
        }
    }

    tx.commit().map_err(|error| error.to_string())?;
    Ok(inserted)
}

#[tauri::command]
fn update_transaction_category(
    app: tauri::AppHandle,
    ids: Vec<i64>,
    category: String,
    merchant_key: String,
) -> Result<i64, String> {
    let db_path = app_db_path(&app)?;
    let mut conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
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
    if !merchant_key.trim().is_empty() {
        tx.execute(
            "INSERT INTO learned_rules (merchant_key, category) VALUES (?1, ?2)
             ON CONFLICT(merchant_key) DO UPDATE SET
                category = excluded.category,
                updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')",
            params![merchant_key, category],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
fn reject_transaction_category(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let db_path = app_db_path(&app)?;
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE transactions SET category = 'Okategoriserat', needs_review = 1, category_decided = 0 WHERE id = ?1",
        params![id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_learned_rules_table(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS learned_rules (
            merchant_key TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_transaction(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let db_path = app_db_path(&app)?;
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
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
            save_transactions,
            get_budgets,
                save_budget,
                update_transaction_category,
                reject_transaction_category,
                delete_transaction
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
