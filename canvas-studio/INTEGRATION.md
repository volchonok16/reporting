# Симметрика (canvas-studio) в reporting

Каталог `canvas-studio/` — платформа совместного дизайна интерфейсов («Симметрика»).
Встроена во вкладку **Симметрика** workbook как iframe (по образцу Voice).

Auth/ACL reporting: [docs/auth-and-roles.md](../docs/auth-and-roles.md).

## Почему отдельный origin

У Симметрики свой HTTP-сервер и API на `/api/*` (файлы, live).  
У reporting тоже `/api/*`. Слить в один origin нельзя без глубокой переделки путей.

Поэтому:

| Компонент | Где |
|-----------|-----|
| UI + API Симметрики | контейнер `canvas-studio` (`:8080`) |
| Вкладка reporting | `frontend` → iframe → URL Симметрики |
| Данные макетов | PostgreSQL `simmetrika_*` (`CS_DATABASE_URL`) |
| Кэш шрифтов | том `canvas-studio/data` → `/data` |

## Auth (только reporting)

Отдельный логин/регистрация Симметрики **отключены**.

1. Пользователь уже вошёл в reporting и имеет page ACL `canvas-studio`.
2. Вкладка запрашивает `POST /api/canvas-studio/sso-token` (проверка `ensure_page_access`).
3. Iframe открывается с `?embed=1&theme=…` — **без** SSO-токена в URL.
4. Родитель шлёт токен через `postMessage` (`reporting-sso`); Симметрика → `POST /api/auth/reporting-sso` → cookie-сессия.
5. При `canvas-auth-required` родитель снова выдаёт токен (с проверкой `origin` / `source` iframe).
6. Тема reporting → `reporting-theme` / `?theme=`.

Общий секрет:

| reporting | canvas-studio |
|-----------|---------------|
| `CANVAS_STUDIO_SSO_SECRET` | `CS_REPORTING_SSO_SECRET` |

Флаги Симметрики: `CS_REPORTING_AUTH_ONLY=1`, `CS_OPEN_REGISTRATION=0`.  
За HTTPS: `CS_SECURE=1` (cookie `Secure`).  
В `APP_ENV=production` дефолтные/короткие SSO-секреты запрещены на старте backend.

Claim `admin` из reporting сохраняется у пользователя Симметрики как `reportingAdmin` (отдаётся в `publicUser.admin`).

## Embed

- `CS_FRAME_ANCESTORS` — список origin'ов reporting для CSP `frame-ancestors`.
- Маркер: `GET /apps/web/reporting-canvas.txt` → `canvas-ok`
- Dev: тот же hostname, что у reporting (`localhost` ≠ `127.0.0.1` — cookie SSO). Подмена hostname в `VITE_CANVAS_STUDIO_URL` — **только** для пары localhost/127.0.0.1; в staging/prod URL из env не переписывается.
- Service worker в embed **не** регистрируется (не мешает SSO).

## Хранилище (PostgreSQL)

При `CS_DATABASE_URL` (в compose по умолчанию включён) Симметрика пишет в таблицы reporting:

| Таблица | Содержимое |
|--------|------------|
| `simmetrika_kv` | users, sessions, files-meta, projects, teams, codes |
| `simmetrika_blob` | snapshot, картинки, thumbnail, comments, versions |
| `simmetrika_secret` | серверный секрет (бывший `data/secret`) |

Миграции: `097_simmetrika_storage.sql`, `098_simmetrika_indexes.sql` (также при старте backend; canvas при старте делает `CREATE IF NOT EXISTS`).  
Индексы: уникальный email пользователей, sessions по `userId`.  
Health: `GET /api/health` → `{ ok, storage: "postgres"|"disk" }` (compose healthcheck бьёт в `/api/health`).  
Версии макетов при PG не завязаны на свободное место тома `/data`.  
Без `CS_DATABASE_URL` — JSON-файлы в `CS_DATA`.

## Docker

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build canvas-studio backend
```

Прямой UI: http://127.0.0.1:8080 (без SSO reporting — вход закрыт). Dev-порт canvas слушает `127.0.0.1`.
