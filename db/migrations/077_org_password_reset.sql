-- Коды самостоятельного сброса пароля org_user (шестизначный код на почту учётки).

CREATE TABLE IF NOT EXISTS org_password_reset (
    id           BIGSERIAL PRIMARY KEY,
    org_user_id  BIGINT NOT NULL REFERENCES org_user(id) ON DELETE CASCADE,
    code_hash    TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS org_password_reset_user_created_idx
    ON org_password_reset (org_user_id, created_at DESC);

COMMENT ON TABLE org_password_reset IS
    'Одноразовые коды сброса пароля org_user: хеш шестизначного кода, срок жизни, момент использования';
