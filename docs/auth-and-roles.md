# Auth, роли и безопасность API

Связано: [admin-guide.md](admin-guide.md) (что/куда править) · [glossary.md](glossary.md) (`auth_session`, `org_user`, `app_page`) · [docker.md](docker.md) · [canvas-studio/INTEGRATION.md](../canvas-studio/INTEGRATION.md)

## Вход и сессия

| Способ | Как | Что в `auth_session.payload` |
|--------|-----|------------------------------|
| `org_user` / `APP_AUTH_*` | `POST /api/auth/login` (логин+пароль) | `auth_mode=app_user`; **PAT не хранится** — подставляется `TFS_SYNC_PAT` с сервера при sync |
| PAT (legacy) | отключён в UI/API входа | ранее `auth_mode=pat` с PAT пользователя |

Клиент держит только `sessionId` в `localStorage` и шлёт `X-Session-Id`.

| Параметр | Назначение |
|----------|------------|
| `SESSION_TTL_HOURS` | Срок жизни сессии с последней активности (по умолчанию **720** часов, 30 суток). Просроченные строки удаляются при обращении |
| `APP_ENV` | `development` (default) / `production`. В **production** старт backend падает, если SSO-секреты дефолтные или короче 24 символов |
| `VOICE_SSO_SECRET` / `CANVAS_STUDIO_SSO_SECRET` | HMAC для iframe SSO; в dev допустимы placeholder’ы (в лог — warning) |

При каждом запросе для `org_user_id` подтягиваются роль / `voice_*` / `must_change_password`. Если учётка **не active** — сессия удаляется.

### Rate limit

| Эндпоинт | Лимит |
|----------|-------|
| `POST /api/auth/login` | 20 / 10 мин с IP; 10 / 10 мин на логин |
| password-reset request/verify/confirm | 30 / 10 мин с IP (отдельные ключи) |

### Сброс пароля

`POST /api/auth/password-reset/request` **не раскрывает**, есть ли учётка (всегда одно сообщение об отправке, если формат email валиден). Код 6 цифр, 15 минут; verify/confirm без enumeration по наличию пользователя.

### `must_change_password`

Флаг в `org_user` и в payload сессии. Пока `true`, API (кроме `/api/auth/status|logout|defaults`, `/api/profile`, `/api/profile/password`) отвечает **403** с заголовком `X-Must-Change-Password: 1`. UI показывает блокирующее окно; обход через сырой API закрыт.

## Роли и права

| Роль | Источник | Возможности |
|------|----------|-------------|
| `org_user_role=user` | `org_user.role=10` | Обычный доступ к разрешённым вкладкам; **не** admin API |
| `org_user_role=admin` | `role=100` | `canManageOrg`: Staffing admin, maintenance, sync TFS, … |
| `org_user_role=superadmin` | `role=1000` (только БД) | Все вкладки + супервозможности статуса продукта (lock, состав офиса, **проекты/приоритеты офиса**, penalty) |
| `auth_mode=pat` | PAT-сессия | Как admin для sync/org manage |
| Legacy `APP_AUTH_USERS` без `org_user` | `app_user` + `org_user_role is None` | `canManageOrg` (полный доступ) |
| `app_role=roadmap` | `APP_AUTH_ROADMAP_USERS` | Только Планы Digital + sync `digital_streams_b2b`; API page ACL ЗНИ/статуса — **403** |
| `voice_only` | `org_user.voice_only` | Только вкладка Voice (+ SSO Voice) |

**Важно:** `require_org_admin` совпадает с `can_manage_org`. Обычный `app_user` с `org_user_role=user` **не** может создавать пользователей / править org admin API.

## Page ACL (UI + API)

Справочник вкладок: `app_page` / `APP_PAGES`. Ограничения — `org_user_page_access` (и «Другие пользователи»).

Зависимость FastAPI: `require_app_page("…")` — сессия + не roadmap + `ensure_page_access` + `must_change_password`.

| Page key | Типичные API |
|----------|----------------|
| `zni` | `/api/boards`, `/api/dashboard`, `/api/tasks/*` (кроме digital-plan для roadmap), `/api/export`, `/api/zni/categories` |
| `products` | `/api/products` |
| `product-status-b2b` | `/api/product-status/b2b/*`, `/api/b2b-news/*`, `/api/revenue-activities/*` |
| `gov-initiatives` | `/api/gov-initiatives/*` |
| `departments` | `/api/org/*` (через `_load_session_meta`) |
| `planning` | `/api/planning/*` |
| `canvas-studio` | `POST /api/canvas-studio/sso-token` |
| `docplan` | `/docplan/api/*` |
| `voice` | `POST /api/voice/sso-token` |

**Планы Digital** (`/api/digital-plan`, `digital-plan-uc`, `roadmap-comment`): `require_digital_plan_access` — либо page `zni`, либо `app_role=roadmap`.

Публичные без сессии: `GET /api/health`, `GET /api/auth/defaults` (и статика).  
`GET /api/sync/{id}` — только с сессией.

## SSO во вкладки (iframe)

| Вкладка | Выдача токена | Потребление | Токен в URL |
|---------|---------------|-------------|-------------|
| Voice | `POST /api/voice/sso-token` + ACL `voice` | `postMessage` `reporting-sso` → Voice API | **Нет** (`embed=1&theme=…`) |
| Симметрика | `POST /api/canvas-studio/sso-token` + ACL `canvas-studio` | `postMessage` → `POST /api/auth/reporting-sso` | **Нет** |

Родитель проверяет `event.origin` / `event.source` iframe. Дочерний фрейм принимает сообщения только от `window.parent`. Тема: `reporting-theme`.

Секреты: см. таблицу выше; для Симметрики в контейнере ещё `CS_REPORTING_SSO_SECRET` (= `CANVAS_STUDIO_SSO_SECRET`), за HTTPS — `CS_SECURE=1`.

## Фото сотрудников

- URL в API всегда `/api/org/photos/employees/…` (не публичный MinIO).
- `GET` требует сессию: заголовок `X-Session-Id` или query `?sid=` (для `<img src>`).
- Путь строго `employees/<file>`; path traversal отклоняется.
- Bucket MinIO `photos`: **без** anonymous download (`mc anonymous set none`).

## Dev-порты

В `docker-compose.dev.yml` backend / frontend / canvas-studio / voice-web / MinIO слушают **`127.0.0.1`**, чтобы сервисы не были доступны из LAN.
