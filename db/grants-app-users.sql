-- Права пользователей приложения alex и ivan (DBeaver, скрипты, данные).
-- Запускать от владельца БД: reporting
--   bash scripts/grant-db-users.sh

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO alex, ivan', current_database());
END $$;

GRANT USAGE, CREATE ON SCHEMA public TO alex, ivan;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO alex, ivan;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO alex, ivan;
GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO alex, ivan;

-- Новые объекты, созданные reporting (миграции, schema.sql)
ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public
  GRANT ALL PRIVILEGES ON ROUTINES TO alex, ivan;

-- Новые объекты, созданные backend (DATABASE_URL часто = alex)
ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public
  GRANT ALL PRIVILEGES ON ROUTINES TO alex, ivan;
