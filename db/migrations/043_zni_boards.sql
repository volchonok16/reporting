-- Конфиг досок ЗНИ (названия, алиасы, area, теги) — вне кода
-- ./scripts/migrate.sh db/migrations/043_zni_boards.sql

CREATE TABLE IF NOT EXISTS zni_board (
    code                            VARCHAR(64)  PRIMARY KEY,
    alias                           VARCHAR(255) NOT NULL,
    board_name                      VARCHAR(255) NOT NULL,
    area_path                       VARCHAR(500) NOT NULL,
    sync_tags                       TEXT         NOT NULL DEFAULT '',
    other_tags                      TEXT         NOT NULL DEFAULT '',
    exclude_sync_tags               TEXT         NOT NULL DEFAULT '',
    exclude_sync_states             TEXT         NOT NULL DEFAULT '',
    error_sync_tags                 TEXT         NOT NULL DEFAULT '',
    project                         VARCHAR(128) NOT NULL,
    project_id                      VARCHAR(64)  NOT NULL,
    team_id                         VARCHAR(64)  NOT NULL,
    launching_soon_states           TEXT         NOT NULL DEFAULT '',
    launching_soon_triage_values    TEXT         NOT NULL DEFAULT '',
    launched_states                 TEXT         NOT NULL DEFAULT '',
    in_progress_states              TEXT         NOT NULL DEFAULT 'Development',
    incident_error_area_path        VARCHAR(500),
    incident_error_sync_tags        TEXT         NOT NULL DEFAULT '',
    sort_order                      INT          NOT NULL DEFAULT 0,
    is_active                       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE zni_board IS 'Конфиг досок ЗНИ для синка TFS и UI (алиасы, area, теги)';
COMMENT ON COLUMN zni_board.code IS 'Стабильный ключ доски (digital_streams_b2b, …)';
COMMENT ON COLUMN zni_board.alias IS 'Короткое имя в UI: Digital, CORE, Bercut…';
COMMENT ON COLUMN zni_board.board_name IS 'Имя доски / task.source_team';
COMMENT ON COLUMN zni_board.area_path IS 'System.AreaPath для WIQL';
COMMENT ON COLUMN zni_board.sync_tags IS 'Теги синка ЗНИ через запятую';
COMMENT ON COLUMN zni_board.other_tags IS 'Другие теги (алиасы тегов) через запятую';
COMMENT ON COLUMN zni_board.exclude_sync_tags IS 'Исключающие теги через запятую';
COMMENT ON COLUMN zni_board.exclude_sync_states IS 'Исключающие статусы через запятую';
COMMENT ON COLUMN zni_board.error_sync_tags IS 'Теги ошибок через запятую';
COMMENT ON COLUMN zni_board.sort_order IS 'Порядок в селекте досок';

INSERT INTO zni_board (
    code, alias, board_name, area_path,
    sync_tags, other_tags, exclude_sync_tags, exclude_sync_states, error_sync_tags,
    project, project_id, team_id,
    launching_soon_states, launching_soon_triage_values, launched_states, in_progress_states,
    incident_error_area_path, incident_error_sync_tags, sort_order
)
VALUES
(
    'digital_streams_b2b', 'Digital', 'Digital Streams B2b', E'Tele2\\Digital\\Streams\\B2b',
    '', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 10
),
(
    'tele2_products', 'Продукты', 'Продукты', E'Tele2\\Продукты',
    'b2b_product', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 20
),
(
    'reports', 'Reports', 'Reports', E'Tele2\\Reports\\Team A',
    'b2b_product', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 30
),
(
    'b2b_product_core', 'CORE', 'B2B Product', E'Tele2\\B2B Product',
    '', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 40
),
(
    'b2b_product_partners', 'КАТС', 'B2B Product Partners', E'Tele2\\B2B Product Partners',
    '', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 50
),
(
    'b2b_voice_products', 'Голосовые продукты', 'B2B Voice Products', E'Tele2\\B2B Product\\B2B Voice Products',
    '', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 60
),
(
    'b2b_m2m_platform', 'М2М / IoT', 'M2M Platform', E'Tele2\\B2B Product\\M2M Platform',
    '', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 70
),
(
    'b2b_sms_target', 'SMS', 'SMS-Target', E'Tele2\\B2B Product\\SMS-Target',
    '', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 80
),
(
    'b2b_solar', 'Solar', 'Solar', E'Tele2\\B2B Product\\Solar',
    '', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 90
),
(
    'b2b_umnico', 'Umnico', 'Umnico', E'Tele2\\B2B Product\\Umnico',
    '', '', 'EFO,not_product', '', '',
    'Tele2', 'c56fb5fe-9752-462a-82ae-0b9e10364510', '95d94210-a12e-4b11-b13b-4bbbc698d30b',
    'UAT', '', 'Pilot,Пилот', 'Development',
    NULL, '', 100
),
(
    'be_t2_team', 'Bercut', 'BE Analytics', E'BE-T2\\BE Analytics',
    'b2b_product', '', '', 'Rejected', 'FE B2B,microservice',
    'BE-T2', '03cc4df6-e5d2-43a6-9f9a-024573edff5a', 'cbc10e7f-8dfa-479f-9a31-0fa6258a1f9f',
    'UAT Prod,Implementation Prod', 'в Работе', 'Closed', 'Development',
    E'BE-T2\\Incident management', 'b2b_product', 110
),
(
    'esb_analytics', 'ESB', 'ESB Analytics', E'BE-T2\\ESB\\ESB Analytics',
    'b2b_product', '', '', 'Rejected', 'FE B2B,microservice',
    'BE-T2', '03cc4df6-e5d2-43a6-9f9a-024573edff5a', '69adf97c-07fc-4f05-98ad-3fa9c77b56d0',
    'UAT Prod,Implementation Prod', 'в Работе', 'Closed', 'Development',
    NULL, '', 120
)
ON CONFLICT (code) DO NOTHING;
