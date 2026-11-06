//! The runtime's database handle, under the name the rest of the runtime knew it by.
//! `crate::db` holds the schema, the models and the pool; [`prisma`] is the one
//! database every query goes to, opened from `DATABASE_URL` on first use.

pub use crate::db::{Database, database as prisma, read, read_sync, run, run_sync};
