# Docker: reporting (PostgreSQL + FastAPI + Vite)

## Локально (один скрипт)

```bash
cp .env.example .env
bash scripts/dev.sh
```

Вкладка **Симметрика** (`canvas-studio/`): контейнер `reporting-canvas-studio` на `:8080`, iframe из workbook. Данные макетов — в PostgreSQL (`simmetrika_*`, миграция `097`, `CS_DATABASE_URL`). Том `canvas-studio/data` — кэш шрифтов Google. Шрифты айдентики T2 Rooftop и T2 Halvar Breit лежат в образе (`apps/web/fonts/t2`) и подключаются в браузере, без установки на компьютер. Подробнее: [canvas-studio/INTEGRATION.md](../canvas-studio/INTEGRATION.md).

**Безопасность:** см. [auth-and-roles.md](auth-and-roles.md). Операции админа (что/куда): [admin-guide.md](admin-guide.md). Кратко:

- Dev-порты (`docker-compose.dev.yml`): `127.0.0.1` для backend, frontend, canvas-studio, voice-web, MinIO.
- MinIO `photos` / `product-status`: без anonymous download; фото — `GET /api/org/photos/…` с сессией.
- `APP_ENV=production` — запрет дефолтных/коротких `VOICE_SSO_SECRET` и `CANVAS_STUDIO_SSO_SECRET`.
- Сессии reporting: `SESSION_TTL_HOURS` (по умолчанию 72); за HTTPS у Симметрики — `CS_SECURE=1`.

## Production (nginx + certbot)

```bash
cp .env.production.example .env
sudo bash scripts/production.sh
```

Скрипт поднимает Docker, nginx и при необходимости certbot. См. [deploy/DEPLOY.md](../deploy/DEPLOY.md).

## Закрытый сервер (без Docker Hub)

На корпоративных VPS исходящий доступ к `registry-1.docker.io` часто закрыт (`i/o timeout` при `docker pull`). VPN на Mac **не помогает** — интернет нужен самому серверу.

**Сборка bundle** (Mac/CI с интернетом и Docker):

```bash
bash scripts/offline-bundle.sh
# явная платформа для x86-сервера:
bash scripts/offline-bundle.sh dist/reporting-offline.tar linux/amd64
```

Создаёт `dist/reporting-offline.tar` (образы `reporting/*`) и manifest. Архив **не коммитят** — копируют на сервер:

```bash
scp dist/reporting-offline.tar root@SERVER:/tmp/
```

**Деплой на сервере** (после `git pull` и `.env`) — одной командой:

```bash
# Ветка dev / тест: my-testing.ru (или APP_DOMAIN в .env)
cp .env.example .env   # один раз; задайте APP_DOMAIN=my-testing.ru
sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --tunnel

# Любой Host/IP (без привязки к DNS-имени):
sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --any-host --tunnel

# Явный домен:
sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --domain=example.com --tunnel

# Прод HTTP без сертификата (t2product.ru):
sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --t2product --tunnel

# Прод HTTPS: pem на сервере (не в tar), затем:
# sudo mkdir -p /etc/letsencrypt/live/t2product
# sudo cp fullchain.pem privkey.pem /etc/letsencrypt/live/t2product/
sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-ssl --t2product --tunnel
```

Поднимает offline-образы, Voice, HTTP nginx и Postgres на `127.0.0.1:5432` (SSH → DBeaver).

Другие варианты:

```bash
# только контейнеры (без nginx):
bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --tunnel

# nginx + SSL (corp-сертификат или Let's Encrypt):
sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-ssl --tunnel
```

`--with-nginx` (dev) → `deploy/nginx/dev-http.conf.template` с `APP_DOMAIN` / `my-testing.ru` (www, api, minio + `/voice/`).  
`--with-nginx --any-host` → `deploy/nginx/dev-any-host.conf` (любой Host/IP).  
`--with-nginx --domain=X` → тот же шаблон под домен `X`.  
`--with-nginx --t2product` → `deploy/nginx/t2product-http.conf` (прод HTTP).  
`--with-ssl --t2product` → HTTPS из pem в `/etc/letsencrypt/live/t2product/` (без certbot).  
`--with-ssl` без `--t2product` → corp `taskatestovaya.ru`.

DNS для прода HTTP: `t2product.ru`, `www.t2product.ru`, `api.t2product.ru` → IP сервера.  
Симметрика на HTTP без сертификата — отдельный origin `http://t2product.ru:8080` (проброс в `docker-compose.prod.yml`, не через nginx). В `.env`: `CANVAS_STUDIO_PUBLIC_URL=http://t2product.ru:8080`, `CANVAS_STUDIO_FRAME_ANCESTORS=http://t2product.ru http://www.t2product.ru`, `CS_SECURE=0`. Адрес зашивается во фронтенд при `offline-bundle.sh` (`CANVAS_STUDIO_PUBLIC_URL`), поэтому смена `.env` на сервере без нового tar вкладку не переключает.  
DNS для тестового HTTP: `my-testing.ru`, `www.my-testing.ru`, `api.my-testing.ru` → IP сервера (или `--any-host`).  
UI ходит в API same-origin (`/api/…`); Voice — `/voice/` и `/voice-api/`.

Compose-файлы: `docker-compose.prod.yml` + `docker-compose.offline.yml` (+ `db-tunnel.yml` при `--tunnel`).

Обновление: `offline-bundle.sh` на Mac → `scp` tar → на сервере `git pull` + `offline-deploy.sh … --with-nginx --t2product --tunnel`.

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

### EIO / virtiofs (Docker Desktop на Mac)

Если контейнеры падают с `OSError: [Errno 5] Input/output error` на bind-mount (`./frontend`, `./backend/app`):

```bash
# 1) named volume под frontend (один раз)
docker volume create reporting_frontend_src
docker volume create reporting_voice_data

# 2) скопировать код в volume (без bind)
bash scripts/apply-frontend-local.sh

# 3) поднять стек без bind-mount исходников
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.dev.eio.yml up -d --build
```

В `docker-compose.dev.eio.yml` volumes задаются через `!override` (не `!reset`): в Compose v5 `!reset` обнуляет список volumes и не подставляет новый.

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

Переменные `B2B_PRODUCT_STATUS_*`, `B2B_NEWS_*`, `GOOGLE_SHEETS_API_KEY`, `GOOGLE_SHEETS_WORKBOOK_CACHE_TTL_SECONDS` (по умолчанию 300 с — in-memory кеш листов на backend) и `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` пробрасываются в контейнер `backend` через `docker-compose.yml`. `ZNI_ACTUAL_PERIOD_EDITABLE_STATES` (по умолчанию `UAT,Pilot,Closed`) задаёт статусы ЗНИ, в которых можно править «Фактическая дата месяц/квартал».

**Презентация B2B:** шаблон только локальный — `backend/assets/Status.pptx` (или `B2B_PRODUCT_STATUS_PRESENTATION_TEMPLATE`). Запросов к Google Slides для генерации PPTX нет. `B2B_PRODUCT_STATUS_PRESENTATION_REFERENCE_URL` — опциональная ссылка в UI, на выгрузку не влияет.

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
# Все reporting-контейнеры (в т.ч. Voice) — лучше через скрипт:
bash scripts/compose-up.sh offline
# или точечно:
docker rm -f reporting-voice-api reporting-voice-web reporting-canvas-studio reporting-backend
docker-compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.offline.yml up -d --no-build backend voice-web
```

Offline-образы app-сервисов flatten’ятся в `offline-bundle.sh` (без attestation), иначе docker-compose 1.29 падает с `ContainerConfig`.

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

Миграция `db/migrations/085_zni_board_include_in_all.sql`: колонка `zni_board.include_in_all_boards`. `false` убирает доску из вкладки «Все доски», не отключая её собственную вкладку и синк. Миграция `db/migrations/091_zni_external_plan_quarter.sql`: `zni_external_data.plan_quarter` — заявленный квартал закрытия. Миграция `db/migrations/092_b2b_product_status_office_penalty.sql`: `b2b_product_status_office.penalty_points` — баллы офиса. Миграции `092_zni_scoring.sql` / `093_zni_scoring_drop_size.sql`: скоринг ЗНИ (effect money/hours/nps). Миграция `db/migrations/094_vacation_overlap_block.sql`: запрет пересечения отпусков между парами сотрудников.

Для ручной оргсхемы добавлена миграция `db/migrations/010_org_chart_layout.sql`: таблица `org_chart_layout` хранит координаты карточек и линии вкладки «Пирамида».

Вкладки «Доска» (YouJail) и «Диаграммы» удалены из продукта. Миграция `db/migrations/095_drop_youjail.sql` снимает таблицы `youjail_*` и деактивирует page keys.

Хранилище Симметрики в PostgreSQL — `db/migrations/097_simmetrika_storage.sql`: таблицы `simmetrika_kv`, `simmetrika_blob`, `simmetrika_secret`. Индексы email/sessions + GRANT — `098_simmetrika_indexes.sql`. Контейнер `canvas-studio` подключается через `CS_DATABASE_URL` (по умолчанию `postgresql://alex:alex@postgres:5432/reporting`). Health: `GET /api/health` проверяет PostgreSQL.

Дополнительные рабочие места для брони — `db/migrations/012_workspace_places_99_106.sql`: в справочник `workspace_place` добавляются места **99–106** (без дубликатов, если номер уже есть).

Статус продукта B2B в PostgreSQL — `db/migrations/013_b2b_product_status.sql`: таблицы `b2b_product_status_office`, `b2b_product_status_row`, `b2b_product_status_history` и seed вкладок офисов; `db/migrations/014_b2b_product_status_snapshots.sql` — снимки версий для отката; `db/migrations/015_b2b_news.sql` — «Новости и запуски» в БД; `db/migrations/016_b2b_product_status_merge_why_columns.sql` — объединение двух столбцов «Зачем» в один; `db/migrations/030_b2b_product_status_offices_analytics_projects.sql` — вкладка «Офис: Проекты (Саша и Ваня)» (и исторически «Офис: Аналитики»); `db/migrations/044_b2b_product_status_analytics_split.sql` — вместо «Аналитики»: «Офис: Аналитики: планирование» и «Офис: Аналитики: бизнес-анализа»; `db/migrations/047_b2b_product_status_projects.sql` — справочник `b2b_product_status_project` (проекты координации по офисам); `db/migrations/070_b2b_product_status_attachments.sql` — вложения строк (`b2b_product_status_attachment`, MinIO bucket `product-status`); `db/migrations/071`–`073` — диапазоны приоритетов проектов координации (одно число из диапазона в ячейке); `db/migrations/062_b2b_product_status_office_editing_lock.sql` — блокировка редактирования по офисам (`b2b_product_status_office.editing_locked`); `db/migrations/031_revenue_activities.sql` — «Активности по выручкам» (`revenue_activity_*`); `032`–`035` — колонки/единицы (идемпотентно); `036_revenue_activities_base_revenue_sections.sql` — вкладки «Влияние по базе» (`base`) и «Влияние по выручке» (`revenue`), копирование строк из `main`, деактивация `main`; `037_revenue_activities_margin_column.sql` — исторически колонка «Маржа»; `038_revenue_activities_drop_margin.sql` — «Маржа» убрана из UI/колонок; `039_planning.sql` — планирование ресурсов (`planning_project`, `planning_allocation`, `production_calendar_day` и др.); `040_planning_project_executors.sql` — исполнители проекта (`planning_project_executor`); `041_planning_project_status.sql` — статус проекта (`planning_project.status`); `066_planning_project_cancelled_frozen.sql` — статусы «Отменен»/`cancelled` и «Заморожен»/`frozen` (`cancelled_at`, `freeze_until_date`); `042_planning_customer_department.sql` — справочник департаментов заказчика (`planning_customer_department`); `043_zni_boards.sql` — конфиг досок ЗНИ (`zni_board`: alias, area, теги, TFS GUID); `048_zni_external_data.sql` — внешние поля ЗНИ (`zni_external_data`); `059_zni_external_data_comment.sql` — колонка «Комментарий» в доп. полях ЗНИ; `063_zni_category.sql` — справочник категорий ЗНИ (`zni_category`) и `zni_external_data.category_id`; `064_zni_drop_desired_quarter.sql` — удаление колонки `desired_quarter`; `065_task_iteration_path_backfill.sql` — заполнение `task.iteration_path` из `extra_json`; `db/migrations/060_app_pages.sql` — справочник вкладок `app_page` и доступ `org_user_page_access` для «других пользователей»; `061_app_notification_delivery.sql` — тип доставки уведомления (`app_notification.delivery`: `inbox` / `popup`); `049_app_notifications.sql` — уведомления (`app_notification`, `app_notification_recipient`); `045_org_user_voice_only.sql` — флаг `org_user.voice_only` (доступ только к вкладке Voice); `054_org_user_voice_admin.sql` — флаг `org_user.voice_admin` (**Администратор Voice**: очистка журнала и мастер-файла); `067_gov_initiatives.sql` — вкладка «Госинициативы» (`gov_initiative_*`); `087_gov_initiatives_launch_date.sql` — колонка «Дата запуска», порядок Статус / Номер ЗнИ; `096_gov_initiatives_responsible.sql` — колонка «Ответственный»; `068_org_user_superadmin.sql` — роль суперадминистратора `org_user.role = 1000` (только через БД); `069_zni_board_sync_tags_match.sql` — `zni_board.sync_tags_match` (`any`/`all` для обязательных нескольких тегов синка); `075_org_user_must_change_password.sql` — `org_user.must_change_password` (обязательная смена пароля после сброса / временного `12345678`); `077_org_password_reset.sql` — коды самостоятельного сброса пароля (`org_password_reset`, письмо через `SMTP_*`); `076_app_maintenance.sql` — `app_maintenance` (запрет входа не-админам + сообщение о работах; массовый logout через `auth_session`); `086_vacation_planning.sql` — `employee.annual_leave_days`, `vacation_planning_unlock`, праздники 2027 в `production_calendar_day`; `000_schema_migration.sql` — журнал `schema_migration`. Миграции при старте backend (`ensure_startup_schema`) применяются **один раз** и отмечаются в `schema_migration`. Data-миграции `032`–`035`, `037`–`038` **не перезаписывают** `revenue_activity_row.cells` (только COMMENT/SELECT 1); старые ключи читаются aliases в backend.

Вкладка **Voice** — стек в каталоге `voice/` (FastAPI + Next.js). **Voice API** встроен в **reporting backend** (`/voice-api`, код `voice/backend` в образе как `carousel/`); отдельного контейнера `voice-api` нет. UI — сервис `voice-web`. **Метаданные uploads/jobs** — PostgreSQL reporting (`051_voice_registry.sql`: `voice_uploads`, `voice_jobs`). **Auth** — только reporting SSO (без таблиц auth в Voice). **Мастер-файл** — там же (`050_voice_master.sql`, `master_*`; `053_voice_master_signature_hash.sql` — hash PK/индексы для длинных связок B; `056_voice_master_numeric_ids.sql` — PK/`import_id`/`item_id`/`record_id` как `BIGINT IDENTITY`; `057_voice_master_rollback_numeric_a_indexes.sql` — откат `a_number_key`/`055`, снова btree по TEXT `a_number`; `058_voice_master_prefix_index.sql` — partial index по `source_prefix` для фильтров; `074_voice_short_aon_format.sql` — `master_is_short_aon`; `088` — timestamps; `089` — выгрузка без `*` в теле; `090` — длина АОН 1–4→`4:2` / 11→`4:4`, `*`→`b` только при наличии `*`). `DATABASE_URL` обязателен у backend. Журнал изменений мастер-файла (`master_changes`): автоочистка записей старше `VOICE_MASTER_HISTORY_RETENTION_DAYS` (по умолчанию 14); текущая версия мастер-файла сохраняется. В проде Voice открывается **в том же приложении reporting**: `voice-web` с `VOICE_BASE_PATH=/voice`; frontend-nginx проксирует `/voice/` → `voice-web`, `/voice/assets/` → `voice-web:/assets/` (vinext отдаёт статику без basePath), `/assets/_vinext_fonts/` → voice-web, `/voice-api/` → `backend:8000/voice-api/`. Хостовый nginx (`snippets/voice-proxy.conf`) шлёт `/voice*` на `:5173` (не напрямую на `:3100`). Маркер: `GET /voice/reporting-voice.txt` → `voice-ok` (если вернулся HTML reporting — старый образ frontend). Прямой порт UI: `http://127.0.0.1:3100/voice/`. Health Voice API: `GET /voice-api/api/health`. Prod: `BACKEND_WORKERS=1` (Voice job executor). Файлы uploads — `voice/data` → `/data` в backend. Вкладка доступна всем; при флаге **Voice сервисы** (`org_user.voice_only`) — только Voice. SSO: `VOICE_SSO_SECRET`. Offline-bundle: `reporting/backend:offline` (включая Voice API), `reporting/voice-web:offline`. Миграция `046_employee_hide_from_pyramid.sql` — «Не отображать в пирамиде».

Обычная перенакатка: `docker compose up -d --build` **без** `-v`. Команда `docker compose down -v` удаляет том `reporting_pgdata` и все данные БД — только для полного сброса.
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

### MinIO — фото и вложения

При `docker compose up` поднимаются `minio` и `minio-init`. Init:

1. Создаёт bucket `photos` (`MINIO_BUCKET`) и `product-status` (`MINIO_ATTACHMENTS_BUCKET`)
2. Ставит **`anonymous set none`** на оба (публичного download нет)

Отдача фото сотрудников: только **`GET /api/org/photos/employees/…`** с сессией (`X-Session-Id` или `?sid=` для `<img>`). Path traversal запрещён (только `employees/<file>`). Публичные URL MinIO в API больше не формируются.

Переменные в `.env`:

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `MINIO_ROOT_USER` | `minioadmin` | Access key (в prod сменить) |
| `MINIO_ROOT_PASSWORD` | `minioadmin` | Secret key (в prod сменить) |
| `MINIO_ENDPOINT` | `http://minio:9000` | Endpoint внутри Docker-сети |
| `MINIO_BUCKET` | `photos` | Bucket для фото (private) |
| `MINIO_ATTACHMENTS_BUCKET` | `product-status` | Вложения статуса продукта (private) |
| `MINIO_PUBLIC_URL` | — | Не используется для фото сотрудников (оставлен для совместимости env) |
| `ORG_UPLOADS_DIR` | `/app/uploads` | Локальный fallback, если MinIO недоступен |
| `PRODUCT_STATUS_UPLOADS_DIR` | `/data/product-status-attachments` | Fallback вложений статуса продукта |
| `PRODUCT_STATUS_MAX_ATTACHMENT_BYTES` | `52428800` (50 МБ) | Лимит размера одного вложения |

В production (`docker-compose.prod.yml`) MinIO слушает только `127.0.0.1:9000` / `:9001`. Console не публиковать в интернет без VPN/auth.

### Auth / SSO (env)

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `APP_ENV` | `development` | В `production` — отказ старта при дефолтных/коротких SSO-секретах |
| `SESSION_TTL_HOURS` | `72` | TTL `auth_session` от `created_at` |
| `VOICE_SSO_SECRET` | (dev placeholder) | HMAC SSO Voice |
| `CANVAS_STUDIO_SSO_SECRET` | (dev placeholder) | HMAC SSO Симметрики (= `CS_REPORTING_SSO_SECRET` в canvas) |
| `CS_DATABASE_URL` | `postgresql://…@postgres:5432/reporting` | PG-хранилище Симметрики |
| `CS_SECURE` | `0` | `1` только за HTTPS. На HTTP (`t2product.ru` без сертификата) оставить `0`, иначе cookie Симметрики не сохранится |
| `CS_REPORTING_MAIL_URL` | `http://backend:8000/api/internal/canvas-mail` | Письмо «вам предоставлен доступ» уходит через SMTP reporting (`SMTP_*`), отдельный ящик Симметрики не нужен |
| `TFS_SYNC_PAT` | — | Серверный PAT для sync (клиентский PAT на вход не принимается) |

Матрица ролей и page ACL: [auth-and-roles.md](auth-and-roles.md).

## Расписание статуса продукта

Backend по московскому времени читает общее напоминание из `b2b_product_status_schedule` (по умолчанию среда с 10:00, лидам и администраторам) и автоблокировку каждого офиса из `b2b_product_status_office_schedule` (миграция `083_b2b_product_status_office_schedule.sql`, по умолчанию четверг 09:30 и 18:00). Блокируются офисы с `auto_lock_enabled`, письмо уходит сотрудникам из `b2b_product_status_office_member`. День и время меняет только суперадминистратор (`org_user.role = 1000`). Напоминание от флага офиса не зависит. Повтор в тот же день не выполняется (`app_scheduled_job_run`). Время блокировки и разблокировки каждого офиса пишется в `editing_locked_at` и `editing_unlocked_at`. Вручную блокирует офис только суперадминистратор; снять блокировку могут он и администратор (`org_user.role = 100`) на любой вкладке офиса. Разблокировка администратором шлёт письмо суперадминистраторам (`role = 1000`) с именем и названием офиса. Состав офиса, автоблокировку и её расписание задаёт суперадминистратор.

## Остановка

```bash
docker compose stop
docker compose down
docker compose down -v    # удалить данные и пересоздать БД
```
