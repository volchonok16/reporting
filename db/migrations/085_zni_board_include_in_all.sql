-- Какие доски входят во вкладку «Все доски». Своя вкладка и синк не зависят от флага.
-- ./scripts/migrate.sh db/migrations/085_zni_board_include_in_all.sql

ALTER TABLE zni_board
    ADD COLUMN IF NOT EXISTS include_in_all_boards BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN zni_board.include_in_all_boards IS
    'true — доска входит во вкладку «Все доски»; своя вкладка и синк не зависят от флага';
