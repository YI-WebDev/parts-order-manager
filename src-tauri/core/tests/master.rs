//! tests/unit/master.test.ts の移植（材料の手動管理と作成要求の受領記録）。

mod import_support;

use import_support::{assert_throws, count, open, reopen, seed_categories, temp_root, thrown};
use pom_core::materials;
use pom_core::reimport::MasterService;
use serde_json::{json, Value};

/// `{ ...base, ...changes }`
fn with(base: &Value, changes: Value) -> Value {
    let mut merged = base.as_object().expect("object").clone();
    for (key, value) in changes.as_object().expect("object") { merged.insert(key.clone(), value.clone()); }
    Value::Object(merged)
}

/// `{ ...value, [key]: undefined }`（undefined のキーは JSON に現れない）。
fn without(value: Value, key: &str) -> Value {
    let mut map = value.as_object().expect("object").clone();
    map.remove(key);
    Value::Object(map)
}

#[test]
fn creates_manual_material_trims_edge_spaces_and_rejects_stale_edits_without_changing_identity() {
    let root = temp_root("step10-master-");
    let store = open(&root.path().join("db"));
    let mut api = MasterService::default();
    let category = materials::create_category(&store, "架空", 0).unwrap();
    let token = api.get(&store, None).unwrap().create_request_id.expect("token");
    let input = json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": category, "newCategoryName": "", "active": true, "values": { "name": " 架空 ", "model": "001-A", "manufacturer": "", "quantity": "02 本", "remarks": "行1\n行2", "unitPrice": "\u{3000}000.00\t" } });
    let first = api.save(&store, &input).unwrap();
    assert!(first.source.is_none());
    // 前後の空白（全角・半角）は除いて登録し、文中の空白・改行はそのまま（利用者の指示、2026年10月15日）。
    let mut expected = input["values"].clone();
    expected["name"] = json!("架空");
    expected["unitPrice"] = json!("000.00");
    assert_eq!(serde_json::to_value(&first.values).unwrap(), expected);
    assert_eq!(serde_json::to_value(&api.get(&store, Some(&first.id)).unwrap().material.expect("material").values).unwrap(), expected);
    let second = api.save(&store, &without(with(&input, json!({ "id": first.id, "expectedRevision": 1, "active": false })), "createRequestId")).unwrap();
    assert_eq!(second.id, first.id);
    assert!(!second.active);
    thrown(api.save(&store, &with(&input, json!({ "id": first.id, "expectedRevision": 1 }))));
    assert_eq!(api.get(&store, Some(&first.id)).unwrap().material.expect("material").revision, 2);
}

fn deduplicates_repeated_manual_creation(new_category: bool) {
    let root = temp_root("step10-master-");
    let store = open(root.path());
    let mut api = MasterService::default();
    let category = if new_category { None } else { Some(materials::create_category(&store, "既存架空", 0).unwrap()) };
    let token = api.get(&store, None).unwrap().create_request_id.expect("token");
    let new_category_name = if new_category { "新架空" } else { "" };
    let remarks = ["行1", "行2"].join("\n");
    let request = json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": category, "newCategoryName": new_category_name, "active": true, "values": { "name": " 架空 ", "model": "001", "manufacturer": "", "quantity": "02 本", "remarks": remarks, "unitPrice": "0" } });
    let first = api.save(&store, &request).unwrap();
    let again = api.save(&store, &request).unwrap();
    assert_eq!(again, first);
    assert_eq!(count(&store, "categories"), 1);
}

#[test]
fn deduplicates_repeated_manual_creation_with_new_category_true() { deduplicates_repeated_manual_creation(true); }

#[test]
fn deduplicates_repeated_manual_creation_with_new_category_false() { deduplicates_repeated_manual_creation(false); }

#[test]
fn keeps_receipt_replay_stable_across_restart_and_later_edits_rejects_altered_requests_allows_explicit_new_records() {
    let root = temp_root("step10-master-");
    let store = open(root.path());
    let mut api = MasterService::default();
    let token = api.get(&store, None).unwrap().create_request_id.expect("token");
    let request = json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": null, "newCategoryName": " 架空 ", "active": true, "values": { "name": " 架空 ", "model": "001", "manufacturer": "", "quantity": "", "remarks": "", "unitPrice": "0" } });
    let first = api.save(&store, &request).unwrap();
    let values = |key: &str, value: &str| { let mut v = request["values"].clone(); v[key] = json!(value); v };
    for changed in [with(&request, json!({ "active": false })), with(&request, json!({ "newCategoryName": "架空" })), with(&request, json!({ "values": values("model", "1") })), with(&request, json!({ "values": values("quantity", "0") }))] {
        assert_throws(api.save(&store, &changed), "内容");
    }
    let mut later = first.values.clone();
    later.remarks = "後日の編集".into();
    let edited = api.save(&store, &json!({ "id": first.id, "expectedRevision": first.revision, "categoryId": first.category_id, "newCategoryName": "", "active": false, "values": later })).unwrap();
    let store = reopen(store, root.path());
    let mut reopened = MasterService::default();
    assert_eq!(reopened.save(&store, &request).unwrap(), first);
    assert_eq!(reopened.get(&store, Some(&first.id)).unwrap().material, Some(edited));
    let other_token = reopened.get(&store, None).unwrap().create_request_id.expect("token");
    let other = reopened.save(&store, &with(&request, json!({ "createRequestId": other_token, "categoryId": first.category_id, "newCategoryName": "" }))).unwrap();
    assert_ne!(other.id, first.id);
    assert_throws(reopened.save(&store, &with(&request, json!({ "createRequestId": "00000000-0000-4000-8000-000000000001" }))), "失効");
    assert_eq!(count(&store, "materials"), 2);
    assert_eq!(count(&store, "categories"), 1);
}

#[test]
fn rolls_back_category_material_receipt_together_and_retries_the_issued_request_after_a_precommit_failure() {
    let root = temp_root("step10-master-");
    let store = open(root.path());
    let mut api = MasterService::default();
    let token = api.get(&store, None).unwrap().create_request_id.expect("token");
    let request = json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": null, "newCategoryName": "架空", "active": false, "values": { "name": "架空", "model": "", "manufacturer": "", "quantity": "", "remarks": "", "unitPrice": "" } });
    store.conn().execute_batch("CREATE TRIGGER fictional_receipt_failure BEFORE INSERT ON material_create_receipts BEGIN SELECT RAISE(ABORT,'fictional'); END;").unwrap();
    thrown(api.save(&store, &request));
    for table in ["categories", "materials", "material_create_receipts"] { assert_eq!(count(&store, table), 0, "{table}"); }
    store.conn().execute_batch("DROP TRIGGER fictional_receipt_failure").unwrap();
    let saved = api.save(&store, &request).unwrap();
    assert!(!saved.active);
    assert_eq!(api.save(&store, &request).unwrap(), saved);
    for table in ["categories", "materials", "material_create_receipts"] { assert_eq!(count(&store, table), 1, "{table}"); }
}

// ---- カテゴリの総数と材料の画面（256件を超えても、新規作成・編集の画面を開いて保存できる） ----

fn manual_values(name: &str) -> Value { json!({ "name": name, "model": "C-001", "manufacturer": "架空社", "quantity": "01 個", "remarks": "", "unitPrice": "" }) }

#[test]
fn keeps_new_and_existing_material_forms_working_after_the_257th_category_is_created() {
    let root = temp_root("master-categories-");
    let store = open(root.path());
    let mut api = MasterService::default();
    seed_categories(&store, 256);
    let token = api.get(&store, None).unwrap().create_request_id.expect("token");
    // 新しいカテゴリ名で保存すると257件目のカテゴリができる（作成側には上限がない）。
    let created = api.save(&store, &json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": null, "newCategoryName": "架空257件目", "active": true, "values": manual_values("架空材料257") })).unwrap();
    assert_eq!(count(&store, "categories"), 257);
    // その後も新規画面と既存材料の編集画面を開け、編集を保存できる。
    assert!(api.get(&store, None).unwrap().create_request_id.is_some());
    let material = api.get(&store, Some(&created.id)).unwrap().material.expect("material");
    assert_eq!((material.category_id.as_str(), material.category_name.as_str()), (created.category_id.as_str(), "架空257件目"));
    let mut values = manual_values("架空材料257");
    values["remarks"] = json!("257件目の後の架空編集");
    let edited = api.save(&store, &json!({ "id": material.id, "expectedRevision": material.revision, "categoryId": material.category_id, "newCategoryName": "", "active": true, "values": values })).unwrap();
    assert_eq!(api.get(&store, Some(&created.id)).unwrap().material, Some(edited));
}

#[test]
fn opens_and_saves_materials_in_the_last_category_with_1000_and_1001_categories() {
    for total in [1000, 1001] {
        let root = temp_root("master-categories-");
        let store = open(root.path());
        let mut api = MasterService::default();
        let last = seed_categories(&store, total).pop().expect("last category");
        let id = materials::create(&store, &last, &materials::MaterialValues { name: "架空末尾材料".into(), ..Default::default() }).unwrap();
        // 最後に作ったカテゴリの材料を開き、カテゴリを変えずに保存できる。
        let material = api.get(&store, Some(&id)).unwrap_or_else(|e| panic!("{total}: {e}")).material.expect("material");
        assert_eq!((material.category_id.as_str(), material.category_name.as_str()), (last.as_str(), format!("架空分類{:04}", total - 1).as_str()), "{total}");
        let saved = api.save(&store, &json!({ "id": id, "expectedRevision": material.revision, "categoryId": last, "newCategoryName": "", "active": false, "values": manual_values("架空末尾材料") })).unwrap();
        assert_eq!((saved.category_id.as_str(), saved.revision, saved.active), (last.as_str(), 2, false), "{total}");
        // 新規作成でも、最後のカテゴリを選んで保存できる。
        let token = api.get(&store, None).unwrap_or_else(|e| panic!("{total}: {e}")).create_request_id.expect("token");
        let created = api.save(&store, &json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": last, "newCategoryName": "", "active": true, "values": manual_values("架空末尾の新規") })).unwrap();
        assert_eq!(created.category_id, last, "{total}");
        assert_eq!(count(&store, "categories"), total as i64);
    }
}

/// 品名は必須（手動の追加・編集とも。画面だけでなく本体でも拒否する。TD-23）。空白だけの品名も空として扱う。
#[test]
fn rejects_an_empty_item_name_on_create_and_edit() {
    let root = temp_root("step10-master-");
    let store = open(&root.path().join("db"));
    let mut api = MasterService::default();
    let category = materials::create_category(&store, "架空", 0).unwrap();
    let values = |name: &str| json!({ "name": name, "model": "001-A", "manufacturer": "", "quantity": "", "remarks": "", "unitPrice": "" });
    let create = |token: &str, name: &str| json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": category, "newCategoryName": "", "active": true, "values": values(name) });
    for name in ["", " ", "\u{3000}\t\n"] {
        let token = api.get(&store, None).unwrap().create_request_id.expect("token");
        assert_throws(api.save(&store, &create(&token, name)), "品名を入力してください。");
        assert_eq!(count(&store, "materials"), 0);
    }
    let token = api.get(&store, None).unwrap().create_request_id.expect("token");
    let saved = api.save(&store, &create(&token, "架空")).unwrap();
    let edit = |name: &str| json!({ "id": saved.id, "expectedRevision": saved.revision, "categoryId": category, "newCategoryName": "", "active": true, "values": values(name) });
    assert_throws(api.save(&store, &edit("\u{3000}")), "品名を入力してください。");
    let current = api.get(&store, Some(&saved.id)).unwrap().material.expect("material");
    assert_eq!((current.values.name.as_str(), current.revision), ("架空", saved.revision));
}
