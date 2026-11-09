# Руководство администратора reporting

Кратко: **что** нужно настроить и **куда** вносить изменения (UI / `.env` / SQL / файлы).  
Детали ролей и ACL API: [auth-and-roles.md](auth-and-roles.md). Деплой: [docker.md](docker.md), [deploy/DEPLOY.md](../deploy/DEPLOY.md).

Легенда мест:

| Место | Где |
|-------|-----|
| **UI** | Workbook после входа под админом (`canManageOrg`) или суперадмином |
| **`.env`** | Корень репозитория / сервера (не коммитить). Шаблон: `.env.example` |
| **SQL** | PostgreSQL (`docker compose exec postgres psql -U alex -d reporting` или клиент) |
| **Файлы** | Репозиторий / volume на хосте |
| **Compose** | `docker-compose.yml` + `docker-compose.dev.yml` / `docker-compose.prod.yml` |

---

## 1. Кто чем управляет

| Роль | Как получить | Куда править |
|------|--------------|--------------|
| Обычный пользователь | Staffing → карточка → учётка `org_user`, `role=10` | **UI** Staffing |
| Администратор (`canManageOrg`) | `org_user.role = 100` | **UI** Staffing (роль «Администратор») **или** SQL |
| Суперадминистратор | `org_user.role = 1000` | **только SQL** (через UI выдать нельзя) |
| Legacy полный доступ | строка в `APP_AUTH_USERS` без связанного `org_user` | **`.env`** |
| Roadmap (только Планы) | `APP_AUTH_ROADMAP_USERS` | **`.env`** |
| Voice only | галочка «Voice сервисы» / `voice_only` | **UI** Staffing |
| Администратор Voice | галочка «Администратор Voice» / `voice_admin` | **UI** Staffing (нужен reporting-админ) |

```sql
-- Назначить суперадмина
UPDATE org_user SET role = 1000 WHERE email = 'user@t2.ru';

-- Снять до обычного админа / пользователя
UPDATE org_user SET role = 100 WHERE email = '…';  -- admin
UPDATE org_user SET role = 10  WHERE email = '…';  -- user
```

Матрица возможностей API — [auth-and-roles.md](auth-and-roles.md). Этот документ — операционный: куда кликать и что править в конфиге.

---

## 2. Пользователи и доступ к вкладкам

| Задача | Куда |
|--------|------|
| Создать сотрудника + учётку (email/пароль) | **UI** Staffing → сотрудники / карточка |
| Сменить пароль себе | **UI** Профиль |
| Сбросить пароль другому | **UI** Staffing (админ) или пользователь сам через форму сброса на логине |
| Самостоятельный сброс (SMTP) | **`.env`**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, … |
| Обязательная смена пароля | поле `must_change_password` (ставится при создании/сбросе; сброс — в Профиле) |
| Деактивировать вход | **UI** / SQL: `org_user.is_active = false` (сессии отзываются при обращении) |
| Доступ к **Планированию** | **UI** карточка → галочка «Планирование» → `org_user_page_access.planning` |
| «Другие пользователи» + список вкладок | **UI** карточка → `hide_from_pyramid` + `allowedPageKeys` |
| Справочник ключей вкладок | таблица `app_page` (синк из кода при старте backend) |

Ключи вкладок (`page_key`): `zni`, `products`, `product-status-b2b`, `gov-initiatives`, `departments`, `planning`, `canvas-studio`, `voice`, …

Админы (`canManageOrg`) видят Планирование без отдельного гранта. Суперадмин — все вкладки.

---

## 3. Режим обслуживания и сессии

| Задача | Куда |
|--------|------|
| Включить/выключить обслуживание, текст сообщения | **UI** шапка → **Обслуживание** (`app_maintenance`) |
| Разрешить вход только админам при обслуживании | там же / поле `allow_admin` |
| Массовый logout | **UI** Обслуживание → revoke sessions **или** API `POST /api/admin/sessions/revoke-all` |
| Срок жизни сессии | **`.env`**: `SESSION_TTL_HOURS` (по умолчанию 720, 30 суток с последней активности) |
| Окружение (проверка SSO-секретов) | **`.env`**: `APP_ENV=production` \| `development` |

Нужен `canManageOrg`.

---

## 4. Синхронизация TFS и доски ЗНИ

| Задача | Куда |
|--------|------|
| PAT для выгрузки из TFS | **`.env`**: `TFS_SYNC_PAT` (клиентский PAT на вход **не** принимается) |
| URL / таймауты / фильтры Closed | **`.env`**: `TFS_*`, `TFS_EXCLUDE_CLOSED_OLDER_THAN_DAYS` |
| Кнопка «Обновить из TFS» | доступна admin / superadmin (и legacy PAT-сессия); обычный user — нет |
| Roadmap: sync только Digital | учётки из `APP_AUTH_ROADMAP_USERS` → доска `digital_streams_b2b` |
| Список досок UI/синка | **SQL** таблица `zni_board` (не хардкод). Seed: `db/migrations/043_zni_boards.sql` |
| Убрать доску из «Все доски» | SQL: `UPDATE zni_board SET include_in_all_boards = false WHERE code = '…';` |
| Статусы, где правится «Фактическая дата» | **`.env`**: `ZNI_ACTUAL_PERIOD_EDITABLE_STATES` |

После правок `zni_board` обычно нужен **рестарт backend** (кэш `load_boards`).

---

## 5. Staffing (оргструктура, отпуска, офис)

| Задача | Куда |
|--------|------|
| Отделы, сотрудники, должности, фото | **UI** Staffing |
| Фото (хранилище) | MinIO bucket `photos` (**Compose** + **`.env`** `MINIO_*`); отдача только `/api/org/photos/…` |
| Не пересекать отпуска A↔B | **UI** карточка → «Не пересекать отпуск с» |
| Unlock планирования отпуска на следующий год | **UI** суперадмин → «Планирование отпуска» |
| Бронь мест / офисные дни | **UI** Staffing |

Смена паролей MinIO в prod: **`.env`** `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (не оставлять `minioadmin`).

---

## 6. Статус продукта B2B

| Задача | Кто | Куда |
|--------|-----|------|
| Редактирование строк офиса | участник / админ | **UI** вкладка статуса |
| Состав офиса, автоблокировка, `skip_lock_until` | **суперадмин** | **UI** «Сотрудники офиса» |
| Проекты координации + диапазоны приоритета по офису | **суперадмин** | **UI** «Проекты офиса» / `GET|PUT …/offices/{gid}/projects` |
| Расписание напоминания / lock-unlock | **суперадмин** | **UI** / таблицы `b2b_product_status_schedule`, `…_office_schedule` |
| Заблокировать офис вручную | **суперадмин** | **UI** |
| Разблокировать | суперадмин **или** admin (`role=100`) | **UI** (разблокировка admin → письмо суперадминам) |
| Lock/unlock без письма | только суперадмин | **UI** (`notify=false`) |
| Баллы / розыгрыш | суперадмин | **UI** penalty / raffle |
| Google Sheets (цвета / «Сохранить в Google») | — | **`.env`** `GOOGLE_SHEETS_*`, файл `secrets/google-sheets-sa.json` |
| Шаблон PPTX | — | `backend/assets/Status.pptx` или `B2B_PRODUCT_STATUS_PRESENTATION_TEMPLATE` |

SMTP должен работать, иначе письма по блокировкам/напоминаниям не уйдут.

---

## 7. Voice и Симметрика (iframe SSO)

| Задача | Куда |
|--------|------|
| Секрет SSO Voice | **`.env`**: `VOICE_SSO_SECRET` (≥24 символов в production) |
| URL iframe Voice | **`.env`**: `VITE_VOICE_APP_URL` (сборка frontend) |
| Очистка журнала / мастер-файла Voice | **UI** Voice + флаг `voice_admin` |
| Retention истории мастер-файла | **`.env`**: `VOICE_MASTER_HISTORY_RETENTION_DAYS` (если задано) |
| Секрет SSO Симметрики | **`.env`**: `CANVAS_STUDIO_SSO_SECRET` (= `CS_REPORTING_SSO_SECRET` в контейнере) |
| URL / CSP frame-ancestors | **`.env`**: `CANVAS_STUDIO_PUBLIC_URL`, `CANVAS_STUDIO_FRAME_ANCESTORS` |
| Secure cookie за HTTPS | **`.env` / Compose**: `CS_SECURE=1` |
| Хранилище макетов | PostgreSQL `simmetrika_*` через `CS_DATABASE_URL` |

Подробнее: [canvas-studio/INTEGRATION.md](../canvas-studio/INTEGRATION.md), [voice/docs/security.md](../voice/docs/security.md).

---

## 8. Первичный запуск и production-чеклист

### Первый подъём

1. `cp .env.example .env` — задать пароли БД, `TFS_SYNC_PAT`, SSO-секреты, SMTP.
2. `bash scripts/dev.sh` или compose up (см. [docker.md](docker.md)).
3. Создать первого админа в Staffing **или** войти через `APP_AUTH_USERS`, затем завести `org_user`.
4. При необходимости: `UPDATE org_user SET role = 1000 …` для суперадмина.

### Production (минимум)

| Параметр | Куда | Зачем |
|----------|------|-------|
| `APP_ENV=production` | `.env` | Запрет слабых SSO-секретов |
| Уникальные `VOICE_SSO_SECRET`, `CANVAS_STUDIO_SSO_SECRET` | `.env` | SSO iframe |
| `TFS_SYNC_PAT` | `.env` | Sync ЗНИ |
| `SMTP_*` | `.env` | Сброс пароля, письма статуса |
| Сменить `MINIO_ROOT_*`, `POSTGRES_*`, `TASKHUB_*` | `.env` | Не дефолтные пароли |
| `APP_PUBLIC_URL` / `API_PUBLIC_URL` / `APP_DOMAIN` | `.env` | Ссылки и nginx |
| `CS_SECURE=1`, HTTPS nginx | compose + deploy | Cookie Симметрики |
| `SESSION_TTL_HOURS` | `.env` | Политика сессий |
| Не публиковать MinIO Console наружу | prod compose | Уже `127.0.0.1` |

Запуск: `sudo bash scripts/production.sh` — [deploy/DEPLOY.md](../deploy/DEPLOY.md).

---

## 9. Быстрый указатель «хочу → место»

| Хочу… | Куда вносить |
|-------|----------------|
| Добавить сотрудника и логин | **UI** Staffing |
| Сделать админом | **UI** роль 100 **или** SQL |
| Сделать суперадмином | **SQL** `role = 1000` |
| Открыть Планирование человеку | **UI** галочка в карточке |
| Ограничить вкладки «другому пользователю» | **UI** `allowedPageKeys` |
| Дать только Voice | **UI** `voice_only` |
| Разрешить чистить мастер Voice | **UI** `voice_admin` |
| Включить обслуживание / выкинуть всех | **UI** Обслуживание |
| Чтобы работал sync TFS | **`.env`** `TFS_SYNC_PAT` + роль admin |
| Новая/правка доски ЗНИ | **SQL** `zni_board` + рестарт backend |
| Починить письма сброса пароля | **`.env`** `SMTP_*` |
| SSO Voice/Симметрика не логинит | секреты в **`.env`**, одинаковые с контейнерами; hostname localhost≠127.0.0.1 |
| Фото не отдаётся / 401 | сессия; MinIO private — смотреть `/api/org/photos/…`, не прямой URL MinIO |
| Добавить проект / приоритеты офиса статуса | **UI** суперадмин → «Проекты офиса» |
| Заблокировать офис статуса | **UI** суперадмин |
| Google-цвета / запись в Sheets | **`.env`** + `secrets/google-sheets-sa.json` |
| Срок сессии | **`.env`** `SESSION_TTL_HOURS` |

---

## 10. Связанные документы

| Документ | Содержание |
|----------|------------|
| [auth-and-roles.md](auth-and-roles.md) | Роли, page ACL, SSO, rate limit, фото |
| [glossary.md](glossary.md) | Поля таблиц, флаги `org_user`, офисы B2B |
| [docker.md](docker.md) | Compose, MinIO, env Auth/SSO |
| [database-overview.md](database-overview.md) | Список таблиц |
| [canvas-studio/INTEGRATION.md](../canvas-studio/INTEGRATION.md) | Симметрика embed |
| [voice/docs/security.md](../voice/docs/security.md) | Voice SSO |
| [documentation-gaps.md](documentation-gaps.md) | Backlog docs |
