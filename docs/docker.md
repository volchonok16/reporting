# Docker: PostgreSQL reporting

Одна команда поднимает PostgreSQL со схемой и двумя пользователями **alex** и **ivan** с полными правами на базу `reporting`. Порт **5432** проброшен наружу.

## Запуск

```bash
# Docker Compose V2 (плагин)
docker compose up -d

# Если ошибка "unknown shorthand flag: 'd'" — используйте старую команду:
docker-compose up -d
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
docker-compose exec -T postgres psql -U alex -d reporting < db/migrations/002_add_team_to_task.sql
```

Добавляет: `task.team_id`, `task.source_team`, таблицу `source_team_mapping`, команды `digital`/`berkhut`, обновляет views.

Документация: [teams.md](teams.md).

## Остановка

```bash
docker compose stop
docker compose down
docker compose down -v    # удалить данные и пересоздать БД
```
