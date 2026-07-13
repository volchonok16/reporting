ALTER TABLE youjail_card ADD COLUMN IF NOT EXISTS card_number INTEGER;

UPDATE youjail_card c
SET card_number = sub.rn
FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY id) AS rn
    FROM youjail_card
) sub
WHERE c.id = sub.id AND c.card_number IS NULL;

ALTER TABLE youjail_card ALTER COLUMN card_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ix_youjail_card_board_number
    ON youjail_card (board_id, card_number);

COMMENT ON COLUMN youjail_card.card_number IS 'Порядковый номер карточки внутри доски (ключ вида SLUG-N)';
