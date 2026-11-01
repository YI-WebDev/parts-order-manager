CREATE TABLE material_create_receipts (
  request_id TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  material_id TEXT NOT NULL UNIQUE REFERENCES materials(id),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=512000)
);
CREATE TRIGGER material_create_receipts_no_update BEFORE UPDATE ON material_create_receipts BEGIN SELECT RAISE(ABORT,'immutable creation receipt'); END;
CREATE TRIGGER material_create_receipts_no_delete BEFORE DELETE ON material_create_receipts BEGIN SELECT RAISE(ABORT,'immutable creation receipt'); END;
