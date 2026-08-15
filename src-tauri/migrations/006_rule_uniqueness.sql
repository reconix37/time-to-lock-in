-- TTLI v0.2.14 — защита от дублей правил.

UPDATE rules
SET priority = (
    SELECT MAX(duplicate.priority)
    FROM rules AS duplicate
    WHERE duplicate.category_id = rules.category_id
      AND duplicate.match_type = rules.match_type
      AND duplicate.match_mode = rules.match_mode
      AND duplicate.pattern = rules.pattern
      AND duplicate.case_insensitive = rules.case_insensitive
)
WHERE id = (
    SELECT MIN(keeper.id)
    FROM rules AS keeper
    WHERE keeper.category_id = rules.category_id
      AND keeper.match_type = rules.match_type
      AND keeper.match_mode = rules.match_mode
      AND keeper.pattern = rules.pattern
      AND keeper.case_insensitive = rules.case_insensitive
);

DELETE FROM rules
WHERE id <> (
    SELECT MIN(keeper.id)
    FROM rules AS keeper
    WHERE keeper.category_id = rules.category_id
      AND keeper.match_type = rules.match_type
      AND keeper.match_mode = rules.match_mode
      AND keeper.pattern = rules.pattern
      AND keeper.case_insensitive = rules.case_insensitive
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique_signature
ON rules(category_id, match_type, match_mode, pattern, case_insensitive);

PRAGMA user_version=6;
