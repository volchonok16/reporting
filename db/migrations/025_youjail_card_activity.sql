CREATE TABLE IF NOT EXISTS youjail_card_event (
    id                  BIGSERIAL PRIMARY KEY,
    card_id             BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    event_type          VARCHAR(64) NOT NULL,
    actor_employee_id   BIGINT REFERENCES employee(id) ON DELETE SET NULL,
    actor_label         VARCHAR(255),
    payload             JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_youjail_card_event_card
    ON youjail_card_event (card_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS youjail_card_link (
    id                  BIGSERIAL PRIMARY KEY,
    card_id             BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    related_card_id     BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (card_id, related_card_id),
    CHECK (card_id <> related_card_id)
);

CREATE INDEX IF NOT EXISTS ix_youjail_card_link_card ON youjail_card_link (card_id);
CREATE INDEX IF NOT EXISTS ix_youjail_card_link_related ON youjail_card_link (related_card_id);

COMMENT ON TABLE youjail_card_event IS 'История изменений карточки YouJail';
COMMENT ON TABLE youjail_card_link IS 'Связи карточек YouJail на одной доске';
