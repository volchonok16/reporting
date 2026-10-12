-- Режим сопоставления sync_tags: any (хотя бы один тег, как раньше) | all (все теги обязательны).
-- ./scripts/migrate.sh db/migrations/069_zni_board_sync_tags_match.sql

ALTER TABLE zni_board
    ADD COLUMN IF NOT EXISTS sync_tags_match TEXT NOT NULL DEFAULT 'any';

ALTER TABLE zni_board
    DROP CONSTRAINT IF EXISTS zni_board_sync_tags_match_check;

ALTER TABLE zni_board
    ADD CONSTRAINT zni_board_sync_tags_match_check
    CHECK (sync_tags_match IN ('any', 'all'));

COMMENT ON COLUMN zni_board.sync_tags_match IS
    'any — ЗНИ с любым из sync_tags; all — ЗНИ должны иметь все перечисленные sync_tags';

-- Пример для досок с обязательными несколькими тегами:
-- UPDATE zni_board
-- SET sync_tags = 'b2b_product,УКП_приоритет', sync_tags_match = 'all'
-- WHERE code IN ('tele2_products', 'reports');
