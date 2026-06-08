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

Вход: PAT-токен TFS (Work Items Read). После входа — «Обновить из TFS» для загрузки ЗНИ и ошибок.

## Только PostgreSQL

```bash
docker compose up -d postgres
```

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

> Init-скрипты выполняются только при **пустом** томе. Пересоздание: `docker compose down -v && docker compose up -d`

## Подключение снаружи

| Параметр | Значение |
|----------|----------|
| Host | `localhost` (или IP сервера) |
| Port | `5432` |
| Database | `reporting` |

**alex:**

```
postgresql://alex:alex@localhost:5432/reporting
```

**ivan:**

```
postgresql://ivan:ivan@localhost:5432/reporting
```

```bash
psql "postgresql://alex:alex@localhost:5432/reporting" -c "\dt"
```

## Обновление схемы (миграции)

Если БД уже была создана до добавления **команд** (`team_id`, `source_team_mapping`):

```bash
git pull
docker-compose exec -T postgres psql -U reporting -d reporting < db/migrations/002_add_team_to_task.sql
```

> **Не используйте `alex` для миграций** — таблицы принадлежат `reporting`. Иначе: `must be owner of table task`.  
> Для данных и DBeaver — `alex` / `ivan` как раньше.

Или: `chmod +x scripts/migrate.sh && ./scripts/migrate.sh`

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

## Остановка

```bash
docker compose stop
docker compose down
docker compose down -v    # удалить данные и пересоздать БД
```
