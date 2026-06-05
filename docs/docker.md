# Docker: PostgreSQL reporting

Одна команда поднимает PostgreSQL со схемой и двумя пользователями **alex** и **ivan** с полными правами на базу `reporting`. Порт **5432** проброшен наружу.

## Запуск

```bash
docker compose up -d
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

Пароли в `.env`:

```bash
copy .env.example .env
```

```env
TASKHUB_ALEX_PASSWORD=alex
TASKHUB_IVAN_PASSWORD=ivan
```

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

## Остановка

```bash
docker compose stop
docker compose down
docker compose down -v    # удалить данные и пересоздать БД
```
