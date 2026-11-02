-- Скоринг ЗНИ: профили/вилки (настройки) + effect money/hours/nps.
-- ./scripts/migrate.sh db/migrations/092_zni_scoring.sql

CREATE TABLE IF NOT EXISTS zni_scoring_profile (
    id               BIGSERIAL PRIMARY KEY,
    code             VARCHAR(32)  NOT NULL,
    name             VARCHAR(128) NOT NULL,
    weight_value     NUMERIC(6, 4) NOT NULL DEFAULT 0.5,
    weight_urgency   NUMERIC(6, 4) NOT NULL DEFAULT 0.5,
    is_out_of_queue  BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order       INT NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT zni_scoring_profile_code_uq UNIQUE (code),
    CONSTRAINT zni_scoring_profile_weights_check
      CHECK (is_out_of_queue OR (weight_value >= 0 AND weight_urgency >= 0
             AND abs(weight_value + weight_urgency - 1.0) < 0.0001))
);

COMMENT ON TABLE zni_scoring_profile IS 'Профиль скоринга ЗНИ: веса Value/Urgency; вне очереди без формулы';
COMMENT ON COLUMN zni_scoring_profile.code IS 'Код: commercial / quality / launch_support / out_of_queue / …';
COMMENT ON COLUMN zni_scoring_profile.weight_value IS 'Вес ценности (max band money/hours/nps)';
COMMENT ON COLUMN zni_scoring_profile.weight_urgency IS 'Вес срочности';
COMMENT ON COLUMN zni_scoring_profile.is_out_of_queue IS 'true — score не считается';

CREATE TABLE IF NOT EXISTS zni_scoring_band (
    id          BIGSERIAL PRIMARY KEY,
    metric      VARCHAR(16) NOT NULL,
    min_value   NUMERIC(14, 4),
    max_value   NUMERIC(14, 4),
    score       SMALLINT NOT NULL,
    label       VARCHAR(128),
    sort_order  INT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT zni_scoring_band_metric_check
      CHECK (metric IN ('money', 'hours', 'nps')),
    CONSTRAINT zni_scoring_band_score_check
      CHECK (score IN (0, 1, 3, 5)),
    CONSTRAINT zni_scoring_band_range_check
      CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
);

CREATE INDEX IF NOT EXISTS idx_zni_scoring_band_metric
    ON zni_scoring_band (metric, sort_order);

COMMENT ON TABLE zni_scoring_band IS 'Вилки метрик эффекта → балл 0/1/3/5 (настраивается без релиза)';
COMMENT ON COLUMN zni_scoring_band.metric IS 'money (млн ₽/год) | hours (ч/ч) | nps (п.п.)';
COMMENT ON COLUMN zni_scoring_band.min_value IS 'Нижняя граница включительно; NULL = −∞';
COMMENT ON COLUMN zni_scoring_band.max_value IS 'Верхняя граница исключительно; NULL = +∞';
COMMENT ON COLUMN zni_scoring_band.score IS 'Дискретный балл 0/1/3/5';

ALTER TABLE zni_category
    ADD COLUMN IF NOT EXISTS scoring_profile_id BIGINT
        REFERENCES zni_scoring_profile(id) ON DELETE SET NULL;

COMMENT ON COLUMN zni_category.scoring_profile_id IS 'Профиль скоринга для категории';

ALTER TABLE zni_external_data
    ADD COLUMN IF NOT EXISTS effect_money NUMERIC(14, 4),
    ADD COLUMN IF NOT EXISTS effect_hours NUMERIC(14, 4),
    ADD COLUMN IF NOT EXISTS effect_nps   NUMERIC(14, 4);

ALTER TABLE zni_external_data DROP CONSTRAINT IF EXISTS zni_external_data_effect_money_check;
ALTER TABLE zni_external_data
    ADD CONSTRAINT zni_external_data_effect_money_check
    CHECK (effect_money IS NULL OR effect_money >= 0);

ALTER TABLE zni_external_data DROP CONSTRAINT IF EXISTS zni_external_data_effect_hours_check;
ALTER TABLE zni_external_data
    ADD CONSTRAINT zni_external_data_effect_hours_check
    CHECK (effect_hours IS NULL OR effect_hours >= 0);

COMMENT ON COLUMN zni_external_data.effect_money IS 'Эффект: млн ₽/год (для вилок money)';
COMMENT ON COLUMN zni_external_data.effect_hours IS 'Эффект: ч/ч (для вилок hours)';
COMMENT ON COLUMN zni_external_data.effect_nps IS 'Эффект: изменение NPS, п.п. (для вилок nps)';
COMMENT ON COLUMN zni_external_data.commercial_effect IS 'Коммерческий эффект: текст-пояснение; числа — в effect_*';

-- Профили
INSERT INTO zni_scoring_profile (code, name, weight_value, weight_urgency, is_out_of_queue, sort_order)
SELECT v.code, v.name, v.wv, v.wu, v.ooq, v.so
FROM (VALUES
    ('out_of_queue',   'Вне очереди',         0.0,  0.0,  TRUE,  1),
    ('commercial',     'Коммерция',           0.70, 0.30, FALSE, 2),
    ('quality',        'Качество',            0.45, 0.55, FALSE, 3),
    ('launch_support', 'Поддержка запуска',   0.35, 0.65, FALSE, 4),
    ('ops',            'Операционка',         0.40, 0.60, FALSE, 5)
) AS v(code, name, wv, wu, ooq, so)
WHERE NOT EXISTS (
    SELECT 1 FROM zni_scoring_profile p WHERE p.code = v.code
);

-- Вилки money (млн ₽/год)
INSERT INTO zni_scoring_band (metric, min_value, max_value, score, label, sort_order)
SELECT v.metric, v.min_v, v.max_v, v.score, v.label, v.so
FROM (VALUES
    ('money', 0::numeric,    0.0001::numeric, 0, 'нет / ≈0',           1),
    ('money', 0.0001,        25::numeric,     1, 'до 25 млн ₽/год',    2),
    ('money', 25::numeric,   125::numeric,    3, '25–125 млн ₽/год',   3),
    ('money', 125::numeric,  NULL,            5, 'свыше 125 млн ₽/год', 4)
) AS v(metric, min_v, max_v, score, label, so)
WHERE NOT EXISTS (
    SELECT 1 FROM zni_scoring_band b
    WHERE b.metric = v.metric AND b.sort_order = v.so AND b.is_active
);

-- Вилки hours (ч/ч)
INSERT INTO zni_scoring_band (metric, min_value, max_value, score, label, sort_order)
SELECT v.metric, v.min_v, v.max_v, v.score, v.label, v.so
FROM (VALUES
    ('hours', 0::numeric,   0.0001::numeric, 0, 'нет / ≈0',      1),
    ('hours', 0.0001,       50::numeric,     1, 'до 50 ч/ч',     2),
    ('hours', 50::numeric,  200::numeric,    3, '50–200 ч/ч',    3),
    ('hours', 200::numeric, NULL,            5, 'свыше 200 ч/ч', 4)
) AS v(metric, min_v, max_v, score, label, so)
WHERE NOT EXISTS (
    SELECT 1 FROM zni_scoring_band b
    WHERE b.metric = v.metric AND b.sort_order = v.so AND b.is_active
);

-- Вилки nps (пункты процента)
INSERT INTO zni_scoring_band (metric, min_value, max_value, score, label, sort_order)
SELECT v.metric, v.min_v, v.max_v, v.score, v.label, v.so
FROM (VALUES
    ('nps', 0::numeric,    0.0001::numeric, 0, 'нет / ≈0',           1),
    ('nps', 0.0001,        0.5::numeric,    1, 'до 0.5 п.п. NPS',    2),
    ('nps', 0.5::numeric,  2::numeric,      3, '0.5–2 п.п. NPS',     3),
    ('nps', 2::numeric,    NULL,            5, 'свыше 2 п.п. NPS',   4)
) AS v(metric, min_v, max_v, score, label, so)
WHERE NOT EXISTS (
    SELECT 1 FROM zni_scoring_band b
    WHERE b.metric = v.metric AND b.sort_order = v.so AND b.is_active
);

-- Категория → профиль
UPDATE zni_category c
SET scoring_profile_id = p.id,
    updated_at = NOW()
FROM zni_scoring_profile p
WHERE c.scoring_profile_id IS NULL
  AND (
    (lower(c.name) = 'решения руководства' AND p.code = 'out_of_queue')
    OR (lower(c.name) IN ('проект ком.эффектом', 'операционка (с деньгами)') AND p.code = 'commercial')
    OR (lower(c.name) IN ('качественные (без эффекта)', 'операционка (без денег)') AND p.code = 'quality')
    OR (lower(c.name) IN ('госинициативы', 'флайты') AND p.code = 'launch_support')
  );
