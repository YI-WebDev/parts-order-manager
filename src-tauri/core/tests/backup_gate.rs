//! tests/unit/backup-gate.test.ts の移植（バックアップ・復元との排他）。
//! 旧実装の acquire() は解放関数を、freeze() は再開関数を返す。Rust では release() / thaw() を呼ぶ。

use pom_core::backups::DatabaseGate;

#[test]
fn freeze_rejects_outstanding_work_and_sealed_admissions_release_is_idempotent() {
    let mut gate = DatabaseGate::default();
    gate.acquire().unwrap();
    assert!(gate.freeze().is_err());
    // release(); release();（同じ許可を2回返しても、使用中の数は負にならない）
    gate.release();
    gate.release();
    gate.freeze().unwrap();
    assert!(gate.acquire().is_err());
    assert!(gate.freeze().is_err());
    gate.thaw();
    // gate.acquire()();
    gate.acquire().unwrap();
    gate.release();
    gate.freeze().unwrap();
    assert!(gate.acquire().is_err());
}
