-- TTLI — 003_day_print. Локальный челлендж привязан к дню импорта.

CREATE TABLE IF NOT EXISTS challenge_history (
    local_date       TEXT    PRIMARY KEY,
    code             TEXT    NOT NULL,
    useful_goal_min  INTEGER NOT NULL CHECK (useful_goal_min BETWEEN 0 AND 1440),
    waste_limit_min  INTEGER NOT NULL CHECK (waste_limit_min BETWEEN 0 AND 1440),
    observed_min     INTEGER NOT NULL CHECK (observed_min BETWEEN 0 AND 1440)
);
