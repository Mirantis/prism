# Phase 1: the API skeleton

Phase 1 writes the **public API** of every module so that phase 2 engineers can port
function bodies in parallel against a stable, compiling surface.

For each TypeScript file in your assignment, read it in full and write its Rust file
with:

1. **Every exported type, complete.** Interfaces and type aliases become structs or
   enums with **all** fields, correct Rust types, and the serde attributes the wire
   format needs. Other engineers will construct and match on these, so they must be
   complete. Port non-exported types that appear in public signatures too.
2. **Every exported constant, with its value.** Long strings (prompts, descriptions)
   are copied byte for byte. Use `const` for `&str`/numbers, `LazyLock` for anything
   built at runtime.
3. **Every exported function and every public method of an exported class or
   singleton**, with its final signature and a body of `todo!()`. Choose carefully:
   - `async fn` when the TypeScript returns a `Promise` or does I/O.
   - `anyhow::Result<T>` when the TypeScript throws or rejects to its caller;
     a plain `T` when it never does.
   - `&self` methods on a singleton struct; a `pub static NAME: LazyLock<Struct>`
     for the instance. Give the struct its real fields (with interior mutability:
     `parking_lot::Mutex`, `DashMap`, atomics, `tokio::sync::Mutex`) and a real
     `new()`, since constructing empty state is trivial.
   - Traits for interfaces that classes or objects implement (see PORTING.md).
4. **Small pure functions in full.** If a function is a few lines and pure (no I/O,
   no other module's unported behavior), port its body now instead of `todo!()`.
   Same for `Display`/`as_str` helpers on enums.
5. **Doc comments** from the TypeScript on every public item, adapted only where they
   name TypeScript constructs. Phase 2 reads them as the specification.

Do **not** port the bodies of non-trivial functions in this phase. Do not port tests.

## Compiling

Your files must parse (`rustfmt --edition 2024 --check <file>`), and at the end
`cargo check --lib` should show no errors that originate in your files and are yours
to fix. Names you use from other modules follow the deterministic mapping; if the
other module is not written yet, the error resolves when it is. Near the end of your
work, re-run `cargo check` and fix every error in your files whose cause is in your
files (wrong type, wrong path, missing import, mismatched trait). If an error comes
from a signature another engineer chose differently from what you assumed, adapt to
theirs (theirs wins for their file).

`todo!()` bodies compile against any return type. `#[allow(unused)]` is already
crate-wide.

## Your report

List the files, any exported item you left out and why, and the cross-module
assumptions you were unsure of.
