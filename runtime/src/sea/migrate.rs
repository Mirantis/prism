//! The migration runner the binary uses at boot, with no Prisma CLI.
//!
//! It replays the committed migration SQL against the SQLite file and records each
//! applied migration in `_prisma_migrations` as `prisma migrate deploy` records it:
//! the same table, a sha256 checksum of the script, epoch-millisecond times and one
//! applied step. The Prisma CLI pointed at the same file later sees no drift, and
//! this runner skips what the CLI applied.
//!
//! The binary carries the migration list (`crate::db::MIGRATIONS`, read in at build
//! time); callers pass it in, so this stays testable.

use std::collections::HashMap;

use anyhow::bail;
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_types::{BigInt, Text};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Migration<'a> {
    /// Directory name, e.g. `20260427123025_init` — also the ordering key.
    pub name: &'a str,
    /// Contents of that migration's `migration.sql`.
    pub sql: &'a str,
}

/// The bookkeeping table, worded as the Prisma schema engine creates it, so the
/// stored definition is the same whichever tool made it.
const CREATE_MIGRATIONS_TABLE: &str = r#"CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)"#;

#[derive(QueryableByName)]
struct AppliedMigration {
    #[diesel(sql_type = Text)]
    migration_name: String,
    #[diesel(sql_type = Text)]
    checksum: String,
}

#[derive(QueryableByName)]
struct ForeignKeys {
    #[diesel(sql_type = BigInt)]
    foreign_keys: i64,
}

/// The checksum `prisma migrate deploy` records: the sha256 of the script, as hex.
pub fn checksum(sql: &str) -> String {
    hex::encode(Sha256::digest(sql.as_bytes()))
}

/// Apply any not-yet-recorded migrations in `name` order. Idempotent: already
/// applied migrations (by `migration_name`) are skipped. Returns the names of
/// the migrations applied this run.
///
/// Each migration runs in one transaction with its record, so a migration that
/// fails leaves neither its changes nor a record behind. Foreign keys are off while
/// it runs, as they are when the Prisma CLI runs the script: a migration that
/// rebuilds a table drops the old one, and with foreign keys on that drop deletes
/// every row that references it.
pub fn apply_migrations(
    conn: &mut SqliteConnection,
    migrations: &[Migration<'_>],
) -> anyhow::Result<Vec<String>> {
    conn.batch_execute(CREATE_MIGRATIONS_TABLE)?;

    let applied: HashMap<String, String> = diesel::sql_query(
        r#"SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"#,
    )
    .load::<AppliedMigration>(conn)?
    .into_iter()
    .map(|row| (row.migration_name, row.checksum))
    .collect();

    // Names are a timestamp then snake_case, which byte order sorts as the Prisma
    // CLI does.
    let mut ordered: Vec<&Migration<'_>> = migrations.iter().collect();
    ordered.sort_by(|a, b| a.name.cmp(b.name));

    let mut done = Vec::new();
    for migration in ordered {
        let checksum = checksum(migration.sql);
        if let Some(recorded) = applied.get(migration.name) {
            // Drift detection: parity with `prisma migrate deploy` — the SQL of an
            // already-applied migration must not have changed since it ran.
            if *recorded != checksum {
                bail!(
                    "Migration \"{}\" has drifted (bundled checksum {checksum} != recorded {recorded}). Roll the change forward as a new migration instead of editing an applied one.",
                    migration.name
                );
            }
            continue;
        }
        apply_one(conn, migration, &checksum)?;
        done.push(migration.name.to_string());
    }
    Ok(done)
}

fn apply_one(
    conn: &mut SqliteConnection,
    migration: &Migration<'_>,
    checksum: &str,
) -> anyhow::Result<()> {
    let foreign_keys = diesel::sql_query("PRAGMA foreign_keys")
        .get_result::<ForeignKeys>(conn)?
        .foreign_keys
        != 0;
    if foreign_keys {
        conn.batch_execute("PRAGMA foreign_keys = OFF")?;
    }
    let started_at = crate::support::now_ms();
    let result = conn.immediate_transaction::<_, anyhow::Error, _>(|conn| {
        conn.batch_execute(migration.sql)?;
        diesel::sql_query(
            r#"INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)"#,
        )
        .bind::<Text, _>(uuid::Uuid::new_v4().to_string())
        .bind::<Text, _>(checksum)
        .bind::<BigInt, _>(crate::support::now_ms())
        .bind::<Text, _>(migration.name)
        .bind::<BigInt, _>(started_at)
        .execute(conn)?;
        Ok(())
    });
    if foreign_keys {
        conn.batch_execute("PRAGMA foreign_keys = ON")?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::sql_types::BigInt;

    #[derive(QueryableByName)]
    struct Name {
        #[diesel(sql_type = Text)]
        name: String,
    }

    #[derive(QueryableByName)]
    struct Count {
        #[diesel(sql_type = BigInt)]
        c: i64,
    }

    fn memory() -> SqliteConnection {
        crate::db::open_connection(":memory:").unwrap()
    }

    fn names(conn: &mut SqliteConnection, sql: &str) -> Vec<String> {
        diesel::sql_query(sql)
            .load::<Name>(conn)
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect()
    }

    fn count(conn: &mut SqliteConnection, sql: &str) -> i64 {
        diesel::sql_query(sql).get_result::<Count>(conn).unwrap().c
    }

    #[test]
    fn applies_migrations_in_name_order_records_them_and_is_idempotent() {
        let mut db = memory();
        let migrations = [
            Migration {
                name: "002_second",
                sql: "CREATE TABLE b (id INTEGER);",
            },
            Migration {
                name: "001_first",
                sql: "CREATE TABLE a (id INTEGER);",
            },
        ];

        let applied = apply_migrations(&mut db, &migrations).unwrap();
        assert_eq!(applied, vec!["001_first", "002_second"]);

        let tables = names(&mut db, "SELECT name FROM sqlite_master WHERE type='table'");
        assert!(tables.contains(&"a".to_string()));
        assert!(tables.contains(&"b".to_string()));

        let recorded = names(
            &mut db,
            r#"SELECT migration_name AS name FROM "_prisma_migrations" ORDER BY migration_name"#,
        );
        assert_eq!(recorded, vec!["001_first", "002_second"]);

        // Re-running applies nothing.
        assert!(apply_migrations(&mut db, &migrations).unwrap().is_empty());
    }

    #[test]
    fn throws_when_an_already_applied_migration_has_drifted_on_disk() {
        let mut db = memory();
        apply_migrations(
            &mut db,
            &[Migration {
                name: "001_init",
                sql: "CREATE TABLE a (id INTEGER);",
            }],
        )
        .unwrap();
        // Same name, different SQL → simulates an edit-after-deploy.
        let err = apply_migrations(
            &mut db,
            &[Migration {
                name: "001_init",
                sql: "CREATE TABLE a (id INTEGER, extra TEXT);",
            }],
        )
        .unwrap_err();
        assert!(err.to_string().contains("drifted"), "{err}");
        assert_eq!(
            err.to_string(),
            format!(
                "Migration \"001_init\" has drifted (bundled checksum {} != recorded {}). Roll the change forward as a new migration instead of editing an applied one.",
                checksum("CREATE TABLE a (id INTEGER, extra TEXT);"),
                checksum("CREATE TABLE a (id INTEGER);"),
            )
        );
    }

    #[test]
    fn rolls_back_a_failing_migration_and_records_nothing_for_it() {
        let mut db = memory();
        assert!(
            apply_migrations(
                &mut db,
                &[Migration {
                    name: "001_bad",
                    sql: "CREATE TABLE x (id INTEGER); INVALID SQL;"
                }]
            )
            .is_err()
        );

        assert_eq!(
            count(&mut db, r#"SELECT count(*) AS c FROM "_prisma_migrations""#),
            0
        );
        assert_eq!(
            count(
                &mut db,
                "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='x'"
            ),
            0
        );
    }

    #[test]
    fn records_a_migration_as_the_prisma_cli_does() {
        #[derive(QueryableByName)]
        struct Row {
            #[diesel(sql_type = Text)]
            id: String,
            #[diesel(sql_type = Text)]
            checksum: String,
            #[diesel(sql_type = Text)]
            started_type: String,
            #[diesel(sql_type = Text)]
            finished_type: String,
            #[diesel(sql_type = BigInt)]
            elapsed: i64,
            #[diesel(sql_type = BigInt)]
            applied_steps_count: i64,
            #[diesel(sql_type = BigInt)]
            empty: i64,
        }
        let mut db = memory();
        let sql = "CREATE TABLE a (id INTEGER);\n";
        apply_migrations(
            &mut db,
            &[Migration {
                name: "001_first",
                sql,
            }],
        )
        .unwrap();
        let row = diesel::sql_query(
            r#"SELECT id, checksum, typeof(started_at) AS started_type, typeof(finished_at) AS finished_type,
                      finished_at - started_at AS elapsed, applied_steps_count,
                      (logs IS NULL AND rolled_back_at IS NULL) AS empty
                 FROM "_prisma_migrations""#,
        )
        .get_result::<Row>(&mut db)
        .unwrap();
        assert_eq!(row.checksum, checksum(sql));
        assert_eq!(uuid::Uuid::parse_str(&row.id).unwrap().get_version_num(), 4);
        assert_eq!(row.started_type, "integer");
        assert_eq!(row.finished_type, "integer");
        assert!(row.elapsed >= 0);
        assert_eq!(row.applied_steps_count, 1);
        assert_eq!(row.empty, 1);
    }

    #[test]
    fn writes_the_bookkeeping_table_as_the_prisma_cli_does() {
        let mut db = memory();
        apply_migrations(&mut db, &[]).unwrap();
        let sql = names(
            &mut db,
            "SELECT sql AS name FROM sqlite_master WHERE name = '_prisma_migrations'",
        );
        assert_eq!(
            sql,
            vec![CREATE_MIGRATIONS_TABLE.replace("IF NOT EXISTS ", "")]
        );
    }

    #[test]
    fn computes_the_checksum_as_sha256_hex() {
        assert_eq!(
            checksum(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
