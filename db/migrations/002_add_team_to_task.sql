-- Миграция для уже развёрнутой БД
-- ВАЖНО: DDL только от владельца таблиц (reporting), не от alex/ivan
--
-- docker-compose exec -T postgres psql -U reporting -d reporting < db/migrations/002_add_team_to_task.sql

CREATE TABLE IF NOT EXISTS source_team_mapping (
    id                      SERIAL PRIMARY KEY,
    source_system_id        SMALLINT     NOT NULL REFERENCES source_system(id),
    team_id                 BIGINT       NOT NULL REFERENCES team(id),
    match_type              VARCHAR(32)  NOT NULL,
    match_value             VARCHAR(500) NOT NULL,
    is_regex                BOOLEAN      NOT NULL DEFAULT FALSE,
    project_external_key    VARCHAR(64),
    priority                INT          NOT NULL DEFAULT 0,
    is_active               BOOLEAN      NOT NULL DEFAULT TRUE,
    notes                   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_source_team_mapping
    ON source_team_mapping (
        source_system_id,
        match_type,
        match_value,
        COALESCE(project_external_key, '')
    );

ALTER TABLE task ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES team(id);
ALTER TABLE task ADD COLUMN IF NOT EXISTS source_team VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_task_team ON task(team_id);

COMMENT ON COLUMN task.team_id IS 'Каноническая команда; фильтрация в FineBI';
COMMENT ON COLUMN task.source_team IS 'Сырое значение команды из источника';

-- Пересоздать views (скопировано из schema.sql)
CREATE OR REPLACE VIEW v_task_backlog_duration AS
SELECT
    t.id AS task_id,
    t.external_id,
    t.title,
    p.name AS project_name,
    ss.code AS source_system,
    tm.code AS team_code,
    tm.name AS team_name,
    SUM(tsd.duration_seconds) AS backlog_seconds,
    SUM(tsd.duration_seconds) / 86400.0 AS backlog_days
FROM task t
JOIN project p ON p.id = t.project_id
JOIN source_system ss ON ss.id = t.source_system_id
LEFT JOIN team tm ON tm.id = COALESCE(t.team_id, p.team_id)
JOIN task_status_duration tsd ON tsd.task_id = t.id
JOIN canonical_status cs ON cs.id = tsd.canonical_status_id
WHERE cs.category = 'backlog'
GROUP BY t.id, t.external_id, t.title, p.name, ss.code, tm.code, tm.name;

CREATE OR REPLACE VIEW v_task_status_time AS
SELECT
    t.id AS task_id,
    t.external_id,
    t.title,
    tm.code AS team_code,
    tm.name AS team_name,
    cs.code AS status_code,
    cs.name AS status_name,
    cs.category,
    tsd.entered_at,
    tsd.left_at,
    tsd.duration_seconds,
    tsd.duration_seconds / 86400.0 AS duration_days,
    tsd.is_current
FROM task t
JOIN project pr ON pr.id = t.project_id
LEFT JOIN team tm ON tm.id = COALESCE(t.team_id, pr.team_id)
JOIN task_status_duration tsd ON tsd.task_id = t.id
JOIN canonical_status cs ON cs.id = tsd.canonical_status_id;

CREATE OR REPLACE VIEW v_team_open_tasks AS
SELECT
    tm.id AS team_id,
    tm.code AS team_code,
    tm.name AS team_name,
    cs.category AS status_category,
    cs.code AS status_code,
    COUNT(*) AS task_count,
    SUM(t.story_points) AS story_points_sum
FROM task t
JOIN project pr ON pr.id = t.project_id
JOIN team tm ON tm.id = COALESCE(t.team_id, pr.team_id)
JOIN canonical_status cs ON cs.id = t.canonical_status_id
WHERE cs.is_terminal = FALSE
GROUP BY tm.id, tm.code, tm.name, cs.category, cs.code;

CREATE OR REPLACE VIEW v_tasks_by_release AS
SELECT
    r.id AS release_id,
    r.name AS release_name,
    r.planned_release_date,
    r.actual_release_date,
    pr.name AS project_name,
    tm.code AS team_code,
    tm.name AS team_name,
    COUNT(DISTINCT t.id) AS task_count,
    SUM(t.story_points) AS story_points_sum,
    COUNT(DISTINCT t.id) FILTER (WHERE cs.is_terminal = TRUE) AS done_task_count
FROM release r
JOIN project pr ON pr.id = r.project_id
LEFT JOIN task_release tr ON tr.release_id = r.id
LEFT JOIN task t ON t.id = tr.task_id OR t.release_id = r.id
LEFT JOIN team tm ON tm.id = COALESCE(t.team_id, pr.team_id)
LEFT JOIN canonical_status cs ON cs.id = t.canonical_status_id
GROUP BY r.id, r.name, r.planned_release_date, r.actual_release_date, pr.name, tm.code, tm.name;
