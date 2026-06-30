-- Права alex/ivan на все таблицы (org, vacation и др.).
-- Применение: ./scripts/migrate.sh db/migrations/007_grant_app_users.sql
-- Содержимое дублирует db/grants-app-users.sql — при изменении прав обновляйте оба файла.

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO alex, ivan', current_database());
END $$;

GRANT USAGE, CREATE ON SCHEMA public TO alex, ivan;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO alex, ivan;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO alex, ivan;
GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO alex, ivan;

ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public
  GRANT ALL PRIVILEGES ON ROUTINES TO alex, ivan;

ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public
  GRANT ALL PRIVILEGES ON ROUTINES TO alex, ivan;
