//! Exports `OPENHUMAN_REPOSITORY_ROOT` (the vendored checkout) for
//! `tool-search-bench`, which reads openhuman's recorded Composio catalogues
//! from `tests/fixtures/` there.
use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = Path::new(&manifest).join("../vendor/openhuman");
    let root = root.canonicalize().unwrap_or(root);
    println!("cargo:rustc-env=OPENHUMAN_REPOSITORY_ROOT={}", root.display());
    println!("cargo:rerun-if-changed=build.rs");
}
