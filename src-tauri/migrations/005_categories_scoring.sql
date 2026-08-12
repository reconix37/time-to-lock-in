-- TTLI v0.2.9 — category tree, independent score and regex rule semantics.

ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT;
ALTER TABLE categories ADD COLUMN score REAL NOT NULL DEFAULT 0 CHECK (score >= -10 AND score <= 10);
ALTER TABLE categories ADD COLUMN inherit_color INTEGER NOT NULL DEFAULT 0 CHECK (inherit_color IN (0, 1));
ALTER TABLE categories ADD COLUMN inherit_score INTEGER NOT NULL DEFAULT 0 CHECK (inherit_score IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);

UPDATE categories
SET score = CASE kind
    WHEN 'useful' THEN 10
    WHEN 'waste' THEN -10
    ELSE 0
END;

ALTER TABLE rules ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'legacy'
    CHECK (match_mode IN ('legacy', 'regex'));
ALTER TABLE rules ADD COLUMN case_insensitive INTEGER NOT NULL DEFAULT 1
    CHECK (case_insensitive IN (0, 1));

INSERT OR IGNORE INTO settings(key, value) VALUES ('rules_revision', '0');
PRAGMA user_version=5;
