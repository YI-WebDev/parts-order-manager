//! 同梱する SQLite のビルド設定（`.cargo/config.toml` の `LIBSQLITE3_FLAGS`）が実際に効いていることを確かめる（TD-02）。
//! リポジトリ直下・`src-tauri` のどちらから cargo を呼んでも同じ設定になる必要がある。

use rusqlite::Connection;

#[test]
fn bundled_sqlite_has_the_expected_compile_options() {
    let connection = Connection::open_in_memory().unwrap();
    let mut statement = connection.prepare("PRAGMA compile_options").unwrap();
    let options: Vec<String> = statement.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
    for expected in ["DQS=0", "DEFAULT_FOREIGN_KEYS", "DEFAULT_WAL_SYNCHRONOUS=1", "DEFAULT_MEMSTATUS=0", "LIKE_DOESNT_MATCH_BLOBS", "DEFAULT_CACHE_SIZE=-16000"] {
        assert!(options.iter().any(|option| option == expected), "SQLite のビルド設定に {expected} がありません: {options:?}");
    }
}
