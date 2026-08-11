-- TTLI — 004_reclassify_history. Ручная категория переживает автоматический replay правил.

ALTER TABLE segments
ADD COLUMN manual_category INTEGER NOT NULL DEFAULT 0 CHECK (manual_category IN (0, 1));
