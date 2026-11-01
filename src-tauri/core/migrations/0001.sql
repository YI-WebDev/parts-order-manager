CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE TABLE materials (
  id TEXT PRIMARY KEY NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, model TEXT NOT NULL, manufacturer TEXT NOT NULL, quantity TEXT NOT NULL, remarks TEXT NOT NULL, unit_price TEXT NOT NULL,
  search_text TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), revision INTEGER NOT NULL CHECK(revision > 0),
  last_source_item_id TEXT REFERENCES import_items(id) ON DELETE RESTRICT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, header TEXT NOT NULL CHECK(json_valid(header)),
  revision INTEGER NOT NULL CHECK(revision > 0), template_version TEXT NOT NULL,
  duplicated_from_id TEXT REFERENCES documents(id) ON DELETE RESTRICT, archived INTEGER NOT NULL CHECK(archived IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE document_lines (
  id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position >= 0), material_id TEXT REFERENCES materials(id) ON DELETE RESTRICT,
  source_item_id TEXT REFERENCES import_items(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, model TEXT NOT NULL, manufacturer TEXT NOT NULL, quantity TEXT NOT NULL, remarks TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('unknown','material_only','slip_only','both')),
  mark_output TEXT NOT NULL CHECK(mark_output IN ('unresolved','blank','filled_circle','open_circle','both_mark')),
  observed_mark TEXT, rule_version TEXT NOT NULL, UNIQUE(document_id, position)
);
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY NOT NULL, source_series_id TEXT NOT NULL, previous_batch_id TEXT REFERENCES import_batches(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('initial','reimport','resolution')), file_sha256 TEXT NOT NULL CHECK(length(file_sha256)=64),
  display_name TEXT NOT NULL, rule_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preview','applied','cancelled')),
  target_item_ids TEXT NOT NULL CHECK(json_valid(target_item_ids)), counts TEXT NOT NULL CHECK(json_valid(counts)),
  target_revisions TEXT NOT NULL CHECK(json_valid(target_revisions)), created_at TEXT NOT NULL
);
CREATE TABLE import_items (
  id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('row','supplement')), sheet_name TEXT NOT NULL, sheet_order INTEGER NOT NULL CHECK(sheet_order>=0),
  row_index INTEGER NOT NULL CHECK(row_index>0), block TEXT NOT NULL, cell_address TEXT,
  raw_cells TEXT NOT NULL CHECK(json_valid(raw_cells)), classification TEXT NOT NULL, fingerprint TEXT NOT NULL
);
CREATE TABLE import_decisions (
  id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES import_items(id) ON DELETE RESTRICT,
  material_id TEXT REFERENCES materials(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('new','apply','keep','hold','non_material','link_supplement')),
  selected_fields TEXT NOT NULL CHECK(json_valid(selected_fields)), reason TEXT NOT NULL, created_at TEXT NOT NULL,
  applied_batch_id TEXT REFERENCES import_batches(id) ON DELETE RESTRICT
);
CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL CHECK(key IN ('last_category_id')), value TEXT NOT NULL);
CREATE INDEX materials_category ON materials(category_id, active, id);
CREATE INDEX document_lines_material ON document_lines(material_id);
CREATE INDEX import_items_batch ON import_items(batch_id);
CREATE INDEX import_decisions_item ON import_decisions(item_id);
CREATE TRIGGER import_items_immutable_update BEFORE UPDATE ON import_items BEGIN SELECT RAISE(ABORT, 'immutable import item'); END;
CREATE TRIGGER import_items_immutable_delete BEFORE DELETE ON import_items BEGIN SELECT RAISE(ABORT, 'immutable import item'); END;
CREATE TRIGGER import_decisions_immutable_update BEFORE UPDATE ON import_decisions BEGIN SELECT RAISE(ABORT, 'append-only import decision'); END;
CREATE TRIGGER import_decisions_immutable_delete BEFORE DELETE ON import_decisions BEGIN SELECT RAISE(ABORT, 'append-only import decision'); END;
