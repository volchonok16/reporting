-- =============================================================================
-- Единая БД задач: Jira, TFS, Trello и прочие источники
-- PostgreSQL 14+
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- Справочники
-- -----------------------------------------------------------------------------

CREATE TABLE source_system (
    id              SMALLSERIAL PRIMARY KEY,
    code            VARCHAR(32)  NOT NULL UNIQUE,  -- jira, tfs, trello, other, ...
    name            VARCHAR(128) NOT NULL,
    base_url        TEXT,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE source_system IS 'Внешние системы учёта задач';

CREATE TABLE canonical_status (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(64)  NOT NULL UNIQUE,   -- backlog, in_progress, review, done, cancelled
    name            VARCHAR(128) NOT NULL,
    category        VARCHAR(32)  NOT NULL,          -- backlog | active | waiting | done | cancelled
    sort_order      INT          NOT NULL DEFAULT 0,
    is_terminal     BOOLEAN      NOT NULL DEFAULT FALSE
);

COMMENT ON TABLE canonical_status IS 'Единые статусы; маппинг из Jira/TFS через source_status_mapping';
COMMENT ON COLUMN canonical_status.category IS 'backlog — для метрик «время в бэклоге»';

CREATE TABLE source_status_mapping (
    id                      SERIAL PRIMARY KEY,
    source_system_id        SMALLINT     NOT NULL REFERENCES source_system(id),
    source_status_name      VARCHAR(255) NOT NULL,
    canonical_status_id     INT          NOT NULL REFERENCES canonical_status(id),
    project_external_key    VARCHAR(64)             -- NULL = глобально для системы
);

CREATE UNIQUE INDEX uq_source_status_mapping
    ON source_status_mapping (
        source_system_id,
        source_status_name,
        COALESCE(project_external_key, '')
    );

CREATE TABLE team (
    id              BIGSERIAL PRIMARY KEY,
    code            VARCHAR(64)  NOT NULL UNIQUE,   -- slug команды, задаёт ETL
    name            VARCHAR(255) NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE team IS 'Канонические команды для фильтрации; одна команда может иметь задачи из Jira, TFS, Trello';
COMMENT ON COLUMN team.code IS 'Единый код команды; записи добавляет ETL, без захардкоженного seed';

-- Правила: как определить команду из источника (доска, тег, area path — задаёт ETL)
CREATE TABLE source_team_mapping (
    id                      SERIAL PRIMARY KEY,
    source_system_id        SMALLINT     NOT NULL REFERENCES source_system(id),
    team_id                 BIGINT       NOT NULL REFERENCES team(id),
    match_type              VARCHAR(32)  NOT NULL,  -- board_name, tag, label, iteration_path, area_path, project_key, component
    match_value             VARCHAR(500) NOT NULL,
    is_regex                BOOLEAN      NOT NULL DEFAULT FALSE,
    project_external_key    VARCHAR(64),
    priority                INT          NOT NULL DEFAULT 0,
    is_active               BOOLEAN      NOT NULL DEFAULT TRUE,
    notes                   TEXT
);

CREATE UNIQUE INDEX uq_source_team_mapping
    ON source_team_mapping (
        source_system_id,
        match_type,
        match_value,
        COALESCE(project_external_key, '')
    );

COMMENT ON TABLE source_team_mapping IS 'Маппинг признака источника → команда; приоритет priority (больше = важнее)';

CREATE TABLE person (
    id              BIGSERIAL PRIMARY KEY,
    email           VARCHAR(255),
    display_name    VARCHAR(255) NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (email)
);

-- Связь человека с учёткой во внешней системе
CREATE TABLE person_external (
    id                  BIGSERIAL PRIMARY KEY,
    person_id           BIGINT       NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    source_system_id    SMALLINT     NOT NULL REFERENCES source_system(id),
    external_user_id    VARCHAR(255) NOT NULL,
    external_username   VARCHAR(255),
    UNIQUE (source_system_id, external_user_id)
);

CREATE TABLE project (
    id                  BIGSERIAL PRIMARY KEY,
    source_system_id    SMALLINT     NOT NULL REFERENCES source_system(id),
    external_key        VARCHAR(64)  NOT NULL,      -- Jira key, TFS project, Trello board id
    name                VARCHAR(255) NOT NULL,
    team_id             BIGINT       REFERENCES team(id),
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (source_system_id, external_key)
);

CREATE TABLE release (
    id                  BIGSERIAL PRIMARY KEY,
    project_id          BIGINT       NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    external_id         VARCHAR(255),
    name                VARCHAR(255) NOT NULL,
    version             VARCHAR(64),
    planned_release_date DATE,
    actual_release_date  DATE,
    status              VARCHAR(32),              -- planned, released, cancelled
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

COMMENT ON TABLE release IS 'Релиз / Fix Version / Iteration Goal — единая сущность для отчётов по отгрузке';

-- Маппинг полей источник → наша модель (заполните позже)
CREATE TABLE field_mapping (
    id                  SERIAL PRIMARY KEY,
    source_system_id    SMALLINT     NOT NULL REFERENCES source_system(id),
    source_entity       VARCHAR(64)  NOT NULL,    -- issue, work_item, card, comment
    source_field_path   VARCHAR(255) NOT NULL,      -- fields.customfield_10001, System.State
    canonical_field     VARCHAR(128) NOT NULL,      -- start_date, release_date, story_points
    transform_rule      TEXT,                       -- optional: формула, regex, lookup
    is_required         BOOLEAN      NOT NULL DEFAULT FALSE,
    notes               TEXT,
    UNIQUE (source_system_id, source_entity, source_field_path)
);

-- -----------------------------------------------------------------------------
-- Задача (единая модель)
-- -----------------------------------------------------------------------------

CREATE TABLE task (
    id                      BIGSERIAL PRIMARY KEY,
    uuid                    UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    source_system_id        SMALLINT     NOT NULL REFERENCES source_system(id),
    external_id             VARCHAR(255) NOT NULL,  -- ключ/ID карточки в источнике
    external_url            TEXT,
    project_id              BIGINT       NOT NULL REFERENCES project(id),
    team_id                 BIGINT       REFERENCES team(id),

    parent_task_id          BIGINT       REFERENCES task(id),

    -- Канонические поля (одинаковые имена для всех источников)
    title                   VARCHAR(1000) NOT NULL,
    description             TEXT,
    task_type               VARCHAR(64),           -- story, bug, epic, task, feature
    priority                VARCHAR(32),           -- critical, high, medium, low

    canonical_status_id     INT          REFERENCES canonical_status(id),
    source_status           VARCHAR(255),          -- сырой статус из Jira/TFS/Trello
    source_team             VARCHAR(255),          -- сырое значение команды из источника (до нормализации)

    assignee_id             BIGINT       REFERENCES person(id),
    reporter_id             BIGINT       REFERENCES person(id),

    created_at              TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ,
    start_date              DATE,                    -- дата начала работ
    due_date                DATE,
    release_date            DATE,                    -- целевая дата релиза
    resolved_at             TIMESTAMPTZ,
    closed_at               TIMESTAMPTZ,

    story_points            NUMERIC(10, 2),
    original_estimate_hours NUMERIC(10, 2),
    remaining_hours         NUMERIC(10, 2),
    completed_hours         NUMERIC(10, 2),

    release_id              BIGINT       REFERENCES release(id),
    sprint_name             VARCHAR(255),
    iteration_path          VARCHAR(500),            -- TFS: Area\Iteration

    labels                  TEXT[],
    components              TEXT[],

    -- Несмапленные поля источника (до настройки field_mapping)
    extra_json              JSONB,

    first_synced_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_synced_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (source_system_id, external_id)
);

CREATE INDEX idx_task_project ON task(project_id);
CREATE INDEX idx_task_team ON task(team_id);
CREATE INDEX idx_task_status ON task(canonical_status_id);
CREATE INDEX idx_task_assignee ON task(assignee_id);
CREATE INDEX idx_task_release ON task(release_id);
CREATE INDEX idx_task_release_date ON task(release_date);
CREATE INDEX idx_task_dates ON task(created_at, closed_at);
CREATE INDEX idx_task_parent ON task(parent_task_id);

COMMENT ON TABLE task IS 'Единая задача; external_id + source_system_id уникальны';
COMMENT ON COLUMN task.team_id IS 'Каноническая команда; для фильтрации в отчётах; FK → team';
COMMENT ON COLUMN task.source_team IS 'Команда как в источнике; team_id заполняет ETL по source_team_mapping';
COMMENT ON COLUMN task.extra_json IS 'Сырые поля до маппинга; для отладки ETL';

-- Связь задачи с несколькими релизами (если в источнике несколько fix versions)
CREATE TABLE task_release (
    task_id     BIGINT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    release_id  BIGINT NOT NULL REFERENCES release(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, release_id)
);

-- -----------------------------------------------------------------------------
-- Комментарии
-- -----------------------------------------------------------------------------

CREATE TABLE task_comment (
    id                  BIGSERIAL PRIMARY KEY,
    task_id             BIGINT       NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    source_system_id    SMALLINT     NOT NULL REFERENCES source_system(id),
    external_comment_id VARCHAR(255),
    author_id           BIGINT       REFERENCES person(id),
    body                TEXT         NOT NULL,
    is_internal         BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ  NOT NULL,
    updated_at          TIMESTAMPTZ,
    synced_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (source_system_id, external_comment_id)
);

CREATE INDEX idx_task_comment_task ON task_comment(task_id, created_at);

-- -----------------------------------------------------------------------------
-- История статусов и время в статусе
-- -----------------------------------------------------------------------------

CREATE TABLE task_status_history (
    id                          BIGSERIAL PRIMARY KEY,
    task_id                     BIGINT       NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    from_canonical_status_id    INT          REFERENCES canonical_status(id),
    to_canonical_status_id      INT          NOT NULL REFERENCES canonical_status(id),
    from_source_status          VARCHAR(255),
    to_source_status            VARCHAR(255),
    changed_at                  TIMESTAMPTZ  NOT NULL,
    changed_by_id               BIGINT       REFERENCES person(id),
    source_event_id             VARCHAR(255),
    synced_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_status_history_task ON task_status_history(task_id, changed_at);

COMMENT ON TABLE task_status_history IS 'События смены статуса: changelog Jira, revision TFS, перемещение списка Trello';

-- Интервалы нахождения задачи в статусе (для отчётов и FineBI)
CREATE TABLE task_status_duration (
    id                      BIGSERIAL PRIMARY KEY,
    task_id                 BIGINT       NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    canonical_status_id     INT          NOT NULL REFERENCES canonical_status(id),
    entered_at              TIMESTAMPTZ  NOT NULL,
    left_at                 TIMESTAMPTZ,             -- NULL = ещё в этом статусе
    duration_seconds        BIGINT,                  -- заполняется при left_at
    is_current              BOOLEAN      NOT NULL DEFAULT FALSE,
    source_status           VARCHAR(255),
    UNIQUE (task_id, canonical_status_id, entered_at)
);

CREATE INDEX idx_status_duration_task ON task_status_duration(task_id);
CREATE INDEX idx_status_duration_status ON task_status_duration(canonical_status_id);
CREATE INDEX idx_status_duration_current ON task_status_duration(task_id) WHERE is_current = TRUE;

COMMENT ON TABLE task_status_duration IS 'Время в бэклоге = строки с canonical_status.category = backlog';

-- Агрегат: суммарное время в статусе по задаче (опционально, для ускорения BI)
CREATE TABLE task_status_duration_agg (
    task_id                 BIGINT  NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    canonical_status_id     INT     NOT NULL REFERENCES canonical_status(id),
    total_seconds           BIGINT  NOT NULL DEFAULT 0,
    last_entered_at         TIMESTAMPTZ,
    PRIMARY KEY (task_id, canonical_status_id)
);

-- -----------------------------------------------------------------------------
-- Сессии TFS (PAT) для веб-приложения
-- -----------------------------------------------------------------------------

CREATE TABLE auth_session (
    id          VARCHAR(64)  PRIMARY KEY,
    payload     JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE auth_session IS 'Серверные сессии TFS: PAT и параметры подключения';

-- -----------------------------------------------------------------------------
-- Организационная структура (отделы, сотрудники)
-- -----------------------------------------------------------------------------

CREATE TABLE org_user (
    id              BIGSERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   TEXT         NOT NULL,
    role            SMALLINT     NOT NULL DEFAULT 10,
    status          SMALLINT     NOT NULL DEFAULT 10,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE job_position (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL UNIQUE,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE team_role (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE expertise_direction (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE employee (
    id                      BIGSERIAL PRIMARY KEY,
    user_id                 BIGINT       REFERENCES org_user(id) ON DELETE SET NULL,
    full_name               VARCHAR(255) NOT NULL,
    email                   VARCHAR(255),
    position_id             BIGINT       REFERENCES job_position(id) ON DELETE SET NULL,
    position                VARCHAR(255),
    manager_id              BIGINT       REFERENCES employee(id) ON DELETE SET NULL,
    photo_path              VARCHAR(512),
    daily_work_hours        NUMERIC(4, 2) NOT NULL DEFAULT 8,
    is_active               BOOLEAN      NOT NULL DEFAULT TRUE,
    is_organization_head    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE employee_expertise (
    id                      BIGSERIAL PRIMARY KEY,
    employee_id             BIGINT NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    expertise_direction_id  BIGINT NOT NULL REFERENCES expertise_direction(id) ON DELETE CASCADE,
    level                   VARCHAR(64),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, expertise_direction_id)
);

CREATE TABLE department (
    id                  BIGSERIAL PRIMARY KEY,
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    head_employee_id    BIGINT REFERENCES employee(id) ON DELETE SET NULL,
    sort_order          INT NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE department_member (
    id              BIGSERIAL PRIMARY KEY,
    department_id   BIGINT NOT NULL REFERENCES department(id) ON DELETE CASCADE,
    employee_id     BIGINT NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    team_role_id    BIGINT REFERENCES team_role(id) ON DELETE SET NULL,
    position        VARCHAR(255),
    manager_id      BIGINT REFERENCES employee(id) ON DELETE SET NULL,
    email           VARCHAR(255),
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (department_id, employee_id)
);

COMMENT ON TABLE org_user IS 'Учётные записи сотрудников';
COMMENT ON TABLE employee IS 'Сотрудники организации';
COMMENT ON TABLE department IS 'Отделы';
COMMENT ON TABLE department_member IS 'Состав отдела';

CREATE TABLE org_chart_layout (
    id              BIGSERIAL PRIMARY KEY,
    scope           VARCHAR(32) NOT NULL CHECK (scope IN ('company', 'department')),
    department_id   BIGINT REFERENCES department(id) ON DELETE CASCADE,
    layout_json     JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (scope, department_id),
    CHECK (
        (scope = 'company' AND department_id IS NULL)
        OR (scope = 'department' AND department_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX ux_org_chart_layout_company
    ON org_chart_layout (scope)
    WHERE scope = 'company';

COMMENT ON TABLE org_chart_layout IS 'Сохранённая ручная раскладка оргсхемы';

-- -----------------------------------------------------------------------------
-- YouJail — отдельная kanban-доска (не связана с task / ЗНИ)
-- -----------------------------------------------------------------------------

CREATE TABLE youjail_board (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(64) NOT NULL UNIQUE,
    description     TEXT NOT NULL DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE youjail_project (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(64) NOT NULL UNIQUE,
    repo_path       TEXT,
    context_md      TEXT NOT NULL DEFAULT '',
    instructions_md TEXT NOT NULL DEFAULT '',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE youjail_task_type (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(128) NOT NULL UNIQUE,
    instructions_md TEXT NOT NULL DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE youjail_column (
    id              BIGSERIAL PRIMARY KEY,
    board_id        BIGINT NOT NULL REFERENCES youjail_board(id) ON DELETE CASCADE,
    column_key      VARCHAR(32) NOT NULL,
    title           VARCHAR(128) NOT NULL,
    tone            VARCHAR(32) NOT NULL,
    sort_order      INTEGER NOT NULL
);

CREATE UNIQUE INDEX ix_youjail_column_board_key ON youjail_column (board_id, column_key);

CREATE TABLE youjail_card (
    id              BIGSERIAL PRIMARY KEY,
    board_id        BIGINT NOT NULL REFERENCES youjail_board(id) ON DELETE CASCADE,
    column_id       BIGINT NOT NULL REFERENCES youjail_column(id) ON DELETE RESTRICT,
    project_id      BIGINT REFERENCES youjail_project(id) ON DELETE SET NULL,
    task_type_id    BIGINT REFERENCES youjail_task_type(id) ON DELETE SET NULL,
    title           VARCHAR(1000) NOT NULL,
    description_md  TEXT NOT NULL DEFAULT '',
    pinned          BOOLEAN NOT NULL DEFAULT FALSE,
    archived        BOOLEAN NOT NULL DEFAULT FALSE,
    closed_at       TIMESTAMPTZ,
    scheduled_at    TIMESTAMPTZ,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    executor        VARCHAR(64) NOT NULL DEFAULT 'manual',
    worktree_path   TEXT,
    worktree_branch VARCHAR(255),
    execution_status VARCHAR(32) NOT NULL DEFAULT 'idle',
    assignee_employee_id BIGINT REFERENCES employee(id) ON DELETE SET NULL,
    created_by      VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_youjail_card_column_sort ON youjail_card (column_id, sort_order, id);
CREATE INDEX ix_youjail_card_board_column ON youjail_card (board_id, column_id, sort_order, id);
CREATE INDEX ix_youjail_card_assignee ON youjail_card (assignee_employee_id);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ix_youjail_card_title_trgm ON youjail_card USING gin (title gin_trgm_ops);
CREATE INDEX ix_youjail_card_description_trgm ON youjail_card USING gin (description_md gin_trgm_ops);

CREATE TABLE youjail_attachment (
    id              BIGSERIAL PRIMARY KEY,
    card_id         BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    filename        VARCHAR(512) NOT NULL,
    storage_path    TEXT NOT NULL,
    content_type    VARCHAR(128),
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE youjail_execution (
    id              BIGSERIAL PRIMARY KEY,
    card_id         BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    executor        VARCHAR(64) NOT NULL,
    status          VARCHAR(32) NOT NULL DEFAULT 'running',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    exit_code       INTEGER,
    error_message   TEXT,
    worktree_path   TEXT
);

CREATE INDEX ix_youjail_execution_card_started ON youjail_execution (card_id, started_at DESC);

CREATE TABLE youjail_execution_log (
    id              BIGSERIAL PRIMARY KEY,
    execution_id    BIGINT NOT NULL REFERENCES youjail_execution(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    stream          VARCHAR(16) NOT NULL DEFAULT 'stdout',
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (execution_id, seq)
);

COMMENT ON TABLE youjail_card IS 'Карточки доски YouJail';
COMMENT ON TABLE youjail_execution IS 'Запуски исполнителя по карточке YouJail';

CREATE TABLE employee_time_off_day (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    day             DATE         NOT NULL,
    kind            VARCHAR(32)  NOT NULL CHECK (kind IN ('vacation', 'dayoff', 'sick_leave', 'business_trip')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, day)
);

CREATE INDEX idx_employee_time_off_day_day ON employee_time_off_day (day);
CREATE INDEX idx_employee_time_off_day_employee_day ON employee_time_off_day (employee_id, day);

COMMENT ON TABLE employee_time_off_day IS 'График отсутствий: отпуск, отгул, больничный, командировка по дням';

CREATE TABLE workspace_place (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE employee_office_day (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    day             DATE         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, day)
);

CREATE TABLE workspace_booking (
    id              BIGSERIAL PRIMARY KEY,
    place_id        BIGINT       NOT NULL REFERENCES workspace_place(id) ON DELETE CASCADE,
    employee_id     BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    day             DATE         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (place_id, day),
    UNIQUE (employee_id, day)
);

CREATE INDEX idx_workspace_booking_day ON workspace_booking (day);
CREATE INDEX idx_workspace_booking_place_day ON workspace_booking (place_id, day);
CREATE INDEX idx_employee_office_day_day ON employee_office_day (day);
CREATE INDEX idx_employee_office_day_employee_day ON employee_office_day (employee_id, day);

COMMENT ON TABLE workspace_place IS 'Справочник рабочих мест (бронь)';
COMMENT ON TABLE workspace_booking IS 'Бронь места на календарный день; одно место — один сотрудник в день';
COMMENT ON TABLE employee_office_day IS 'Дни присутствия сотрудника в офисе без привязки к месту (самоотметка)';

-- -----------------------------------------------------------------------------
-- Синхронизация (аудит ETL)
-- -----------------------------------------------------------------------------

CREATE TABLE sync_run (
    id                  BIGSERIAL PRIMARY KEY,
    source_system_id    SMALLINT     NOT NULL REFERENCES source_system(id),
    started_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ,
    status              VARCHAR(32)  NOT NULL DEFAULT 'running',  -- running, success, failed
    records_fetched     INT,
    records_upserted    INT,
    error_message       TEXT,
    parameters_json     JSONB
);

CREATE TABLE sync_run_log (
    id              BIGSERIAL PRIMARY KEY,
    sync_run_id     BIGINT       NOT NULL REFERENCES sync_run(id) ON DELETE CASCADE,
    level           VARCHAR(16)  NOT NULL,  -- info, warn, error
    message         TEXT         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Снимки загрузки команды (для «насколько загружена команда»)
-- -----------------------------------------------------------------------------

CREATE TABLE team_workload_snapshot (
    id                      BIGSERIAL PRIMARY KEY,
    team_id                 BIGINT       NOT NULL REFERENCES team(id),
    snapshot_date           DATE         NOT NULL,
    backlog_count           INT          NOT NULL DEFAULT 0,
    active_count            INT          NOT NULL DEFAULT 0,
    waiting_count           INT          NOT NULL DEFAULT 0,
    done_count_period       INT          NOT NULL DEFAULT 0,   -- закрыто за период
    total_open_story_points NUMERIC(12, 2),
    tasks_shipped_to_release INT         NOT NULL DEFAULT 0, -- ушло в релиз на дату
    release_id              BIGINT       REFERENCES release(id),
    calculated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_team_workload_snapshot
    ON team_workload_snapshot (team_id, snapshot_date, COALESCE(release_id, 0));

COMMENT ON TABLE team_workload_snapshot IS 'Ежедневные/еженедельные метрики; строится из task + task_status_duration';

-- Назначение задачи на человека (история, если assignee менялся)
CREATE TABLE task_assignee_history (
    id              BIGSERIAL PRIMARY KEY,
    task_id         BIGINT       NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    assignee_id     BIGINT       REFERENCES person(id),
    assigned_at     TIMESTAMPTZ  NOT NULL,
    unassigned_at   TIMESTAMPTZ
);

-- -----------------------------------------------------------------------------
-- Представления для отчётности (FineBI может читать и таблицы, и views)
-- -----------------------------------------------------------------------------

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

-- -----------------------------------------------------------------------------
-- Начальные данные
-- -----------------------------------------------------------------------------

INSERT INTO source_system (code, name) VALUES
    ('jira',   'Atlassian Jira'),
    ('tfs',    'Azure DevOps / TFS'),
    ('trello', 'Trello'),
    ('other',  'Прочая система')
ON CONFLICT (code) DO NOTHING;

INSERT INTO canonical_status (code, name, category, sort_order, is_terminal) VALUES
    ('backlog',       'Бэклог',           'backlog',   10, FALSE),
    ('todo',          'К выполнению',     'backlog',   20, FALSE),
    ('in_progress',   'В работе',         'active',    30, FALSE),
    ('in_review',     'На проверке',      'waiting',   40, FALSE),
    ('blocked',       'Заблокировано',    'waiting',   50, FALSE),
    ('done',          'Готово',           'done',      90, TRUE),
    ('cancelled',     'Отменено',         'cancelled', 100, TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO youjail_board (id, name, slug, sort_order)
VALUES (1, 'Основная', 'main', 1)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO youjail_column (board_id, column_key, title, tone, sort_order)
VALUES
    (1, 'backlog', 'Backlog', 'backlog', 1),
    (1, 'in_progress', 'In Progress', 'progress', 2),
    (1, 'blocked', 'Blocked', 'blocked', 3),
    (1, 'done', 'Done', 'done', 4)
ON CONFLICT (board_id, column_key) DO NOTHING;

INSERT INTO youjail_task_type (name, instructions_md, sort_order)
VALUES
    ('feature', 'Реализовать новую функциональность.', 1),
    ('bugfix', 'Исправить ошибку и добавить регрессионную проверку.', 2),
    ('chore', 'Техническое обслуживание без изменения поведения.', 3)
ON CONFLICT (name) DO NOTHING;

-- team: без seed — команды создаёт ETL/скрипт по доскам, тегам, area path

-- -----------------------------------------------------------------------------
-- Триггер: пересчёт duration_seconds при закрытии интервала
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_task_status_duration_calc()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.left_at IS NOT NULL AND NEW.entered_at IS NOT NULL THEN
        NEW.duration_seconds := EXTRACT(EPOCH FROM (NEW.left_at - NEW.entered_at))::BIGINT;
        NEW.is_current := FALSE;
    ELSIF NEW.left_at IS NULL THEN
        NEW.is_current := TRUE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_task_status_duration_calc
    BEFORE INSERT OR UPDATE ON task_status_duration
    FOR EACH ROW EXECUTE PROCEDURE fn_task_status_duration_calc();

-- -----------------------------------------------------------------------------
-- Статус продукта B2B (таблицы в БД, без Google Sheets)
-- -----------------------------------------------------------------------------

CREATE TABLE b2b_product_status_office (
    id              BIGSERIAL PRIMARY KEY,
    gid             VARCHAR(32)  NOT NULL UNIQUE,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE b2b_product_status_office IS 'Продуктовые офисы B2B (вкладки «Офис: SMS», «Офис: CORE» и т.д.)';
COMMENT ON COLUMN b2b_product_status_office.gid IS 'Идентификатор вкладки (стабильный ключ для API и UI)';

CREATE TABLE b2b_product_status_row (
    id              BIGSERIAL PRIMARY KEY,
    office_id       BIGINT       NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    sort_order      INT          NOT NULL DEFAULT 0,
    cells           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_b2b_product_status_row_office
    ON b2b_product_status_row (office_id, sort_order);

COMMENT ON TABLE b2b_product_status_row IS 'Строка таблицы статуса продукта B2B; cells — значения колонок с rich-text разметкой';
COMMENT ON COLUMN b2b_product_status_row.cells IS 'JSON: название колонки → текст ячейки (формат product_status_rich_text)';

CREATE TABLE b2b_product_status_history (
    id              BIGSERIAL PRIMARY KEY,
    row_id          BIGINT       REFERENCES b2b_product_status_row(id) ON DELETE SET NULL,
    office_id       BIGINT       NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    office_name     VARCHAR(255) NOT NULL,
    action          VARCHAR(32)  NOT NULL,
    field_name      VARCHAR(255),
    old_value       TEXT,
    new_value       TEXT,
    changed_by      VARCHAR(255),
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_b2b_product_status_history_office
    ON b2b_product_status_history (office_id, changed_at DESC);

COMMENT ON TABLE b2b_product_status_history IS 'История изменений строк статуса продукта B2B';
COMMENT ON COLUMN b2b_product_status_history.action IS 'create | update | delete | restore';

CREATE TABLE b2b_product_status_snapshot (
    id              BIGSERIAL PRIMARY KEY,
    office_id       BIGINT       NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    rows            JSONB        NOT NULL,
    changed_by      VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_b2b_product_status_snapshot_office
    ON b2b_product_status_snapshot (office_id, created_at DESC, id DESC);

COMMENT ON TABLE b2b_product_status_snapshot IS 'Снимки строк офиса после сохранения; используются для отката к версии';
COMMENT ON COLUMN b2b_product_status_snapshot.rows IS 'JSON: {"rows": [{"cells": {...}}, ...]} — полный порядок строк офиса';

-- -----------------------------------------------------------------------------
-- Новости и запуски B2B
-- -----------------------------------------------------------------------------

CREATE TABLE b2b_news_section (
    id              BIGSERIAL PRIMARY KEY,
    gid             VARCHAR(32)  NOT NULL UNIQUE,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE b2b_news_row (
    id              BIGSERIAL PRIMARY KEY,
    section_id      BIGINT       NOT NULL REFERENCES b2b_news_section(id) ON DELETE CASCADE,
    sort_order      INT          NOT NULL DEFAULT 0,
    cells           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_b2b_news_row_section ON b2b_news_row (section_id, sort_order);

CREATE TABLE b2b_news_history (
    id              BIGSERIAL PRIMARY KEY,
    row_id          BIGINT       REFERENCES b2b_news_row(id) ON DELETE SET NULL,
    section_id      BIGINT       NOT NULL REFERENCES b2b_news_section(id) ON DELETE CASCADE,
    section_name    VARCHAR(255) NOT NULL,
    action          VARCHAR(32)  NOT NULL,
    field_name      VARCHAR(255),
    old_value       TEXT,
    new_value       TEXT,
    changed_by      VARCHAR(255),
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_b2b_news_history_section ON b2b_news_history (section_id, changed_at DESC);

CREATE TABLE b2b_news_snapshot (
    id              BIGSERIAL PRIMARY KEY,
    section_id      BIGINT       NOT NULL REFERENCES b2b_news_section(id) ON DELETE CASCADE,
    rows            JSONB        NOT NULL,
    changed_by      VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_b2b_news_snapshot_section ON b2b_news_snapshot (section_id, created_at DESC, id DESC);
