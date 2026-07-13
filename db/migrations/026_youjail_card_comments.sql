CREATE TABLE IF NOT EXISTS youjail_card_comment (
    id                  BIGSERIAL PRIMARY KEY,
    card_id             BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    body_md             TEXT NOT NULL DEFAULT '',
    author_employee_id  BIGINT REFERENCES employee(id) ON DELETE SET NULL,
    author_label        VARCHAR(255),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_youjail_card_comment_card
    ON youjail_card_comment (card_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS youjail_comment_attachment (
    id              BIGSERIAL PRIMARY KEY,
    comment_id      BIGINT NOT NULL REFERENCES youjail_card_comment(id) ON DELETE CASCADE,
    filename        VARCHAR(512) NOT NULL,
    storage_path    TEXT NOT NULL,
    content_type    VARCHAR(128),
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_youjail_comment_attachment_comment
    ON youjail_comment_attachment (comment_id);

COMMENT ON TABLE youjail_card_comment IS 'Комментарии к карточке YouJail';
COMMENT ON TABLE youjail_comment_attachment IS 'Вложения к комментариям YouJail';
