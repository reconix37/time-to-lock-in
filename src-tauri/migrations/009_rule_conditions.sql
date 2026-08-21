-- TTLI — 009_rule_conditions: ordered AND conditions per rule
-- FIX (v0.2.39): migration 007 does `ALTER TABLE rules RENAME TO rules_legacy`.
-- On an old DB (user_version<=6), 001_init.sql has already created rule_conditions
--   with FK REFERENCES rules(id); SQLite's RENAME rewrites that FK to `rules_legacy`,
--   which 007 then DROPs -> dangling FK. The backfill INSERT below failed with
--   "no such table: main.rules_legacy" -> initialize() Err -> app silently died at
--   startup on any pre-0.2.27 DB that had rules (Eduard on v0.2.7/DB v4).
-- SQLite can't alter a column's FK, so we recreate rule_conditions AFTER 007 has
--   rebuilt `rules` (it's the real table again), then backfill. The table is
--   guaranteed empty here (001 created it, nothing wrote to it before this migration).
DROP TABLE IF EXISTS rule_conditions;
CREATE TABLE rule_conditions (
    rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    match_type TEXT NOT NULL CHECK (match_type IN ('exe','title','domain')),
    pattern TEXT NOT NULL,
    match_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (match_mode IN ('legacy','regex')),
    case_insensitive INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (rule_id, ordinal)
);
INSERT INTO rule_conditions (rule_id, ordinal, match_type, pattern, match_mode, case_insensitive)
SELECT id, 0, match_type, pattern, match_mode, case_insensitive
FROM rules
WHERE match_type <> 'any';
-- Условия являются полным уникальным ключом; legacy-индекс больше не подходит для AND-правил.
DROP INDEX IF EXISTS idx_rules_unique_signature;
PRAGMA user_version = 9;