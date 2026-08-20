-- TTLI — 009_rule_conditions: ordered AND conditions per rule
CREATE TABLE IF NOT EXISTS rule_conditions (
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
            
            