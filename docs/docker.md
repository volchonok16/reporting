# Docker: reporting (PostgreSQL + FastAPI + Vite)

## Локально (один скрипт)

```bash
cp .env.example .env
bash scripts/dev.sh
```

## Production (pallink.fun)

```bash
cp .env.production.example .env
sudo bash scripts/production.sh
```

Скрипт поднимает Docker, nginx и при необходимости certbot. См. [deploy/DEPLOY.md](../deploy/DEPLOY.md).

## Полный стек вручную (dev)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

| Сервис | URL |
|--------|-----|
| UI | http://localhost:5173 |
| API | http://localhost:8000/api/health |
| PostgreSQL | `localhost:5432` |
| MinIO API | http://localhost:9000 |
| MinIO Console | http://localhost:9001 (логин из `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) |

Вход: PAT-токен TFS (Work Items Read). После входа — «Обновить из TFS» для загрузки ЗНИ и ошибок.

## Только PostgreSQL (локально)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
```

Без `docker-compose.dev.yml` порт `5432` на Mac не пробрасывается.

Проверка, что установлено:

```bash
docker compose version    # V2
docker-compose --version  # V1
```

При **первом** запуске автоматически:

1. Создаётся БД `reporting`
2. Применяется `db/schema.sql`
3. Создаются пользователи `alex` и `ivan` с полным доступом

```bash
docker compose ps
docker compose logs postgres
```

## Пользователи

| Пользователь | Пароль (по умолчанию) | Права |
|--------------|----------------------|--------|
| `alex` | `alex` | Полный доступ к `reporting` |
| `ivan` | `ivan` | Полный доступ к `reporting` |
| `reporting` | `reporting` | Служебный владелец (Docker init) |

Полный доступ: чтение, запись, изменение структуры (CREATE/ALTER/DROP в `public`), sequences, functions.

Пароли в `.env` (файл в той же папке, что `docker-compose.yml`):

```bash
cp .env.example .env
nano .env
```

```env
POSTGRES_PASSWORD=ваш_пароль
TASKHUB_ALEX_PASSWORD=пароль_alex
TASKHUB_IVAN_PASSWORD=пароль_ivan
```

Docker Compose подхватывает `.env` автоматически для подстановки `${...}`.

### Статус продукта B2B (Google Sheets)

Для цветов и выделения в ячейках (UI и презентация) в `.env` нужен `GOOGLE_SHEETS_API_KEY` — ключ Google Cloud с включённым Sheets API; таблица должна быть доступна «всем по ссылке». Без ключа backend пробует XLSX-экспорт (цвет всей ячейки), затем CSV без стилей.

Для кнопки «Сохранить в Google» на вкладке «Статус продукта B2B» положите JSON ключа в `secrets/google-sheets-sa.json` и укажите в `.env` путь `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON=/app/secrets/google-sheets-sa.json`. Email из `client_email` — с правами «Редактор» в Google Sheets. Папка `secrets/` монтируется в backend-контейнер.

Переменные `B2B_PRODUCT_STATUS_*`, `B2B_NEWS_*`, `GOOGLE_SHEETS_API_KEY`, `GOOGLE_SHEETS_WORKBOOK_CACHE_TTL_SECONDS` (по умолчанию 300 с — in-memory кеш листов на backend) и `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` пробрасываются в контейнер `backend` через `docker-compose.yml`.

Вкладка **«Новости»** читает отдельную Google Sheets-таблицу: задайте `B2B_NEWS_SPREADSHEET_ID`, `B2B_NEWS_SHEET_URL` и при необходимости `B2B_NEWS_SHEET_PUBLIC_URL`. Список листов — в `B2B_NEWS_SHEETS` (как у `B2B_PRODUCT_STATUS_SHEETS`); пусто — автоопределение.

> Init-скрипты выполняются только при **пустом** томе. Пересоздание: `docker compose down -v && docker compose up -d`

## Подключение к БД

### Локально (Mac, dev)

Порт `5432` пробрасывается через `docker-compose.dev.yml`. Docker Desktop должен быть запущен:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
```

| Параметр | Значение |
|----------|----------|
| Host | `localhost` |
| Port | `5432` |
| Database | `reporting` |
| User / Password | `alex` / `alex` (или `ivan` / `ivan`) |

JDBC (DBeaver, DataGrip): `jdbc:postgresql://localhost:5432/reporting` — вкладка **SSH не нужна**.

```bash
psql "postgresql://alex:alex@localhost:5432/reporting" -c "\dt"
```

### Production-сервер (DBeaver / DataGrip с Mac)

PostgreSQL в контейнере **не слушает интернет**. Прямое подключение к `IP_сервера:5432` не работает (`Connection reset` / `Connection refused`).

Схема: **ваш Mac → SSH → сервер → localhost:5432 → контейнер postgres**.

**1. На сервере** (после `git pull`):

```bash
cd /var/database/reporting   # путь к проекту на VPS
# на VPS с docker-compose 1.29:
echo 'COMPOSE_CMD=docker-compose' >> .env

# Полный деплой одной командой:
bash scripts/up.sh prod

# То же:
# bash scripts/prod.sh
# bash scripts/deploy-prod.sh
# git pull && bash scripts/compose-up.sh prod --build --tunnel

# Только проброс postgres (без пересборки backend/frontend):
# bash scripts/db-tunnel.sh
```

Скрипт пробрасывает `127.0.0.1:5432` на хост (только localhost, не в интернет).

Если `ContainerConfig` / `KeyError` при `up` — обход вручную (данные в томе сохраняются):

```bash
docker ps -aq --filter "name=reporting-postgres" | xargs -r docker rm -f
docker-compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.db-tunnel.yml up -d postgres
```

**2. В DBeaver**

Вкладка **Главное**:

| Поле | Значение |
|------|----------|
| Host | `localhost` |
| Port | `5432` |
| Database | `reporting` |
| User | `alex` |
| Password | из `.env` на сервере (`TASKHUB_ALEX_PASSWORD`) |

Вкладка **SSH** — включить **Use SSH Tunnel**:

| Поле | Значение |
|------|----------|
| Host | IP сервера (например `45.9.13.214`) |
| Port | `22` |
| User | ваш SSH-логин на VPS |
| Auth | SSH-ключ или пароль |

Сначала **Test tunnel**, затем **Test connection**.

> Не указывайте IP сервера во вкладке «Главное» и не используйте URL вида `postgresql+psycopg://` — это формат SQLAlchemy для backend, не для JDBC.

**3. Альтернатива: туннель из терминала Mac**

```bash
ssh -N -L 5432:127.0.0.1:5432 user@45.9.13.214
```

Окно не закрывать. В клиенте: Host `localhost`, SSH в клиенте выключен.

## Обновление схемы (миграции)

Если БД уже была создана до добавления **команд** (`team_id`, `source_team_mapping`):

```bash
git pull
docker-compose exec -T postgres psql -U reporting -d reporting < db/migrations/002_add_team_to_task.sql
```

> **Не используйте `alex` для миграций** — таблицы принадлежат `reporting`. Иначе: `must be owner of table task`.  
> Для данных и DBeaver — `alex` / `ivan` как раньше.

Или: `chmod +x scripts/migrate.sh && ./scripts/migrate.sh`

После каждой миграции `migrate.sh` автоматически выдаёт **alex** и **ivan** права на все таблицы и sequences.

Для ручной оргсхемы добавлена миграция `db/migrations/010_org_chart_layout.sql`: таблица `org_chart_layout` хранит координаты карточек и линии вкладки «Пирамида».

Для вкладки **«Доска» (YouJail)** — миграция `db/migrations/011_youjail.sql`: проекты, типы, колонки, карточки, вложения, запуски и логи. Каталог worktree/вложений: `YOUJAIL_WORKSPACE_DIR` (по умолчанию `/app/youjail-workspace`).

Дополнительные рабочие места для брони — `db/migrations/012_workspace_places_99_106.sql`: в справочник `workspace_place` добавляются места **99–106** (без дубликатов, если номер уже есть).

Статус продукта B2B в PostgreSQL — `db/migrations/013_b2b_product_status.sql`: таблицы `b2b_product_status_office`, `b2b_product_status_row`, `b2b_product_status_history` и seed вкладок офисов; `db/migrations/014_b2b_product_status_snapshots.sql` — снимки версий для отката; `db/migrations/015_b2b_news.sql` — «Новости и запуски» в БД; `db/migrations/016_b2b_product_status_merge_why_columns.sql` — объединение двух столбцов «Зачем» в один. Миграции также подхватываются при старте backend (`ensure_startup_schema`).

Если права нужно обновить вручную (новые таблицы org/vacation, backend создал таблицы от alex):

```bash
bash scripts/grant-db-users.sh
# или
./scripts/migrate.sh db/migrations/007_grant_app_users.sql
```

Добавляет: `task.team_id`, `task.source_team`, таблицу `source_team_mapping`, обновляет views (без seed-команд).

Удалить примеры `digital`/`berkhut` из старой версии:

```bash
docker-compose exec -T postgres psql -U reporting -d reporting < db/migrations/003_remove_seed_teams.sql
```

Документация: [teams.md](teams.md).

Таблица сессий PAT (веб-приложение):

```bash
./scripts/migrate.sh 004_auth_sessions.sql
```

Организационная структура (отделы, сотрудники, учётные записи):

```bash
./scripts/migrate.sh 005_org_structure.sql
./scripts/migrate.sh 006_vacation_schedule.sql
./scripts/migrate.sh 008_workspace_booking.sql
./scripts/migrate.sh 009_employee_office_days.sql
./scripts/migrate.sh 011_business_trip_time_off.sql
./scripts/migrate.sh db/migrations/012_workspace_places_99_106.sql
./scripts/grant-db-users.sh
```

Права **alex** / **ivan** на новые таблицы: `db/grants-app-users.sql`, миграция `007_grant_app_users.sql`, скрипт `scripts/grant-db-users.sh`. Default privileges настроены и для роли `reporting` (миграции), и для `alex` (DDL backend при старте).

### MinIO — фото сотрудников

При `docker compose up` поднимаются сервисы `minio` и `minio-init`. Init-контейнер:

1. Создаёт bucket `photos` (или имя из `MINIO_BUCKET`)
2. Включает анонимное чтение (download) для отдачи картинок

Переменные в `.env`:

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `MINIO_ROOT_USER` | `minioadmin` | Access key |
| `MINIO_ROOT_PASSWORD` | `minioadmin` | Secret key |
| `MINIO_ENDPOINT` | `http://minio:9000` | Endpoint внутри Docker-сети |
| `MINIO_BUCKET` | `photos` | Bucket для фото |
| `MINIO_PUBLIC_URL` | `http://localhost:9000` (dev) | Прямые URL на фото; пусто — прокси через `/api/org/photos/` |
| `ORG_UPLOADS_DIR` | `/app/uploads` | Локальный fallback, если MinIO недоступен |

В production (`docker-compose.prod.yml`) MinIO слушает только `127.0.0.1:9000` / `:9001`.

## Остановка

```bash
docker compose stop
docker compose down
docker compose down -v    # удалить данные и пересоздать БД
```
