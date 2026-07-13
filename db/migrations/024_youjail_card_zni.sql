CREATE TABLE IF NOT EXISTS youjail_card_zni (
    id              BIGSERIAL PRIMARY KEY,
    card_id         BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    task_id         BIGINT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (card_id, task_id)
);

CREATE INDEX IF NOT EXISTS ix_youjail_card_zni_card ON youjail_card_zni (card_id, sort_order, id);
CREATE INDEX IF NOT EXISTS ix_youjail_card_zni_task ON youjail_card_zni (task_id);

COMMENT ON TABLE youjail_card_zni IS 'Связь карточки YouJail с ЗНИ из task (change_request)';
