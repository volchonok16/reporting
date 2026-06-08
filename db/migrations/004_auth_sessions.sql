-- Сессии TFS (PAT) для веб-приложения отчётности
-- Выполнять от пользователя reporting: ./scripts/migrate.sh 004_auth_sessions.sql

CREATE TABLE IF NOT EXISTS auth_session (
    id          VARCHAR(64)  PRIMARY KEY,
    payload     JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE auth_session IS 'Серверные сессии TFS: PAT и параметры подключения (не отдаются клиенту)';
