CREATE TABLE IF NOT EXISTS youjail_tag (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(128) NOT NULL,
    slug            VARCHAR(64) NOT NULL UNIQUE,
    color           VARCHAR(7),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_youjail_tag_name_lower
    ON youjail_tag (LOWER(name));

CREATE TABLE IF NOT EXISTS youjail_card_tag (
    id              BIGSERIAL PRIMARY KEY,
    card_id         BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    tag_id          BIGINT NOT NULL REFERENCES youjail_tag(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (card_id, tag_id)
);

CREATE INDEX IF NOT EXISTS ix_youjail_card_tag_card ON youjail_card_tag (card_id);
CREATE INDEX IF NOT EXISTS ix_youjail_card_tag_tag ON youjail_card_tag (tag_id);

COMMENT ON TABLE youjail_tag IS 'Теги карточек YouJail (как labels в Jira)';
COMMENT ON TABLE youjail_card_tag IS 'Связь карточки YouJail с тегами';
