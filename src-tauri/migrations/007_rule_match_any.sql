-- TTLI v0.2.17 — match_type 'any' (Anywhere, v0.2.15) не проходил CHECK IN ('exe','title','domain').
-- SQLite не умеет менять CHECK на месте — пересоздаём таблицу rules с сохранением данных и индексов.

ALTER TABLE rules RENAME TO rules_legacy;

CREATE TABLE rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    match_type  TEXT    NOT NULL CHECK (match_type IN ('exe','title','domain','any')),
    pattern     TEXT    NOT NULL,              -- exe: точное/префикс; title/domain: contains; lowercase
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority    INTEGER NOT NULL DEFAULT 0,    -- выше = раньше; при равном: domain > title > exe
    created_at  INTEGER NOT NULL,
    match_mode  TEXT    NOT NULL DEFAULT 'legacy' CHECK (match_mode IN ('legacy', 'regex')),
    case_insensitive INTEGER NOT NULL DEFAULT 1 CHECK (case_insensitive IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_rules_lookup ON rules(match_type, priority DESC);

INSERT INTO rules (id, match_type, pattern, category_id, priority, created_at, match_mode, case_insensitive)
    SELECT id, match_type, pattern, category_id, priority, created_at, match_mode, case_insensitive
    FROM rules_legacy;

DROP TABLE rules_legacy;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique_signature
ON rules(category_id, match_type, match_mode, pattern, case_insensitive);

PRAGMA user_version=7;
