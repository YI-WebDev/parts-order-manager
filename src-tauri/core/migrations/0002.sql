CREATE TABLE import_batches_v2 (
  id TEXT PRIMARY KEY NOT NULL, source_series_id TEXT NOT NULL, previous_batch_id TEXT REFERENCES import_batches(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('initial','reimport','resolution')), file_sha256 TEXT NOT NULL CHECK(length(file_sha256)=64),
  display_name TEXT NOT NULL, rule_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preview','applied','cancelled','failed')),
  target_item_ids TEXT NOT NULL CHECK(json_valid(target_item_ids)), counts TEXT NOT NULL CHECK(json_valid(counts)),
  target_revisions TEXT NOT NULL CHECK(json_valid(target_revisions)), created_at TEXT NOT NULL
);
INSERT INTO import_batches_v2 (id, source_series_id, previous_batch_id, kind, file_sha256, display_name, rule_version, status, target_item_ids, counts, target_revisions, created_at)
SELECT id, source_series_id, previous_batch_id, kind, file_sha256, display_name, rule_version, status, target_item_ids, counts, target_revisions, created_at FROM import_batches;
DROP TABLE import_batches;
ALTER TABLE import_batches_v2 RENAME TO import_batches;
