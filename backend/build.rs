//! Reads the committed Prisma migrations into the binary: writes
//! `$OUT_DIR/migrations.rs`, one `Migration` per directory under
//! `prisma/sqlite/migrations` that holds a `migration.sql`, in name order. A new
//! migration needs no code change; adding its directory reruns this script.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let dir = manifest
        .join("..")
        .join("prisma")
        .join("sqlite")
        .join("migrations");
    let dir = dir
        .canonicalize()
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().join("migration.sql").is_file())
        .map(|entry| {
            entry
                .file_name()
                .into_string()
                .expect("migration directory names are UTF-8")
        })
        .collect();
    names.sort();

    let mut out = String::from("&[\n");
    for name in &names {
        let sql = dir.join(name).join("migration.sql");
        println!("cargo:rerun-if-changed={}", sql.display());
        writeln!(
            out,
            "    crate::sea::migrate::Migration {{ name: {name:?}, sql: include_str!({:?}) }},",
            sql.display().to_string()
        )
        .unwrap();
    }
    out.push(']');

    let target = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set")).join("migrations.rs");
    fs::write(&target, out).unwrap_or_else(|e| panic!("cannot write {}: {e}", target.display()));
}
