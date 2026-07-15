# Пробелы в документации

> Аудит: июль 2026. Сравнение кода (`db/`, `backend/`, `frontend/`, `scripts/`, `deploy/`) с файлами в `docs/` и `README.md`.
>
> **Цель:** зафиксировать, чего не хватает, что устарело и что писать в первую очередь. Этот файл — backlog для документации, не замена глоссария.

| Документ | Статус |
|----------|--------|
| [glossary.md](glossary.md) | Хорошо по БД и TFS; устарели REST API и права |
| [database-overview.md](database-overview.md) | Обзор таблиц OK; REST и счётчик таблиц — неверны |
| [data-dictionary.md](data-dictionary.md) | Краткая выжимка; нет org/B2B/Roadmap полей |
| [docker.md](docker.md) | Dev/prod/MinIO OK; не все env и скрипты |
| [teams.md](teams.md) | Актуален |
| [diagrams.md](diagrams.md) | Обновлено: architecture / use case / ER включают Staffing, YouJail, B2B+PPTX, Планы, Диаграммы |
| [README.md](../README.md) | Обновлено: полный workbook |

---

## Что документировано хорошо

- **Ядро задач** — `task`, команды, статусы, views `v_*`, синхронизация TFS, маппинг полей ЗНИ → `extra_json`: [glossary.md](glossary.md).
- **Доски и метрики ЗНИ** — `boards.py`, `board_metrics.py`, фильтры `tag_group`: glossary + [database-overview.md](database-overview.md).
- **Org-модуль (БД)** — таблицы `org_user` … `workspace_booking`, `org_chart_layout`, `business_trip`: glossary (по отдельным разделам).
- **Docker / production** — [docker.md](docker.md), [deploy/DEPLOY.md](../deploy/DEPLOY.md).
- **Команды (концепция ETL)** — [teams.md](teams.md).

---

## Critical — исправить в первую очередь

### 1. README / диаграммы — ранее устаревшие, обновлены

Workbook (ЗНИ, B2B, Планы, Доска, Staffing, Диаграммы) отражён в [README.md](../README.md) и [diagrams.md](diagrams.md). Осталось: полный каталог API (`docs/api.md`), матрица ролей.

~~**Действие:** переписать разделы «Текущий этап», «Возможности»~~ — **сделано** (июль 2026). Остаточное: личный кабинет и роли — см. п. 3.

---

### 2. Неверные пути REST API

| В документации | Факт в коде | Где ошибка |
|----------------|-------------|------------|
| `GET /api/export/csv` | `GET /api/export` | glossary § REST API, database-overview § REST |
| `GET /api/sync/status` | `GET /api/sync/{sync_id}` | glossary § REST API, database-overview § REST |
| `POST /api/auth/login` — только PAT | также логин/пароль приложения и `org_user` | database-overview, glossary § auth |

**Действие:** исправить таблицы API в glossary и database-overview; завести полный каталог в `docs/api.md` (см. ниже).

---

### 3. Права доступа и синхронизация TFS — docs ≠ code

**В glossary написано:**

- `APP_AUTH_*` синхронизируют через `TFS_SYNC_PAT`.
- `APP_AUTH_ROADMAP_USERS` — только вкладка «Планы».

**Фактический код** (`backend/app/main.py`, `_can_sync_tfs`):

- Кнопка «Обновить из TFS» (`canSyncTfs`) — только при `auth_mode=pat` **или** `org_user.role=admin` (100).
- Обычные `org_user` (role=10) и пользователи `APP_AUTH_*` **не** получают `canSyncTfs`, хотя PAT на сервере может быть.
- Роль `roadmap` видит вкладки **Планы + Staffing**, не только Планы (`WorkbookApp.tsx`).

**Действие:** новый файл `docs/auth-and-roles.md` — матрица ролей, `canSyncTfs`, `canManageOrg`, `require_full_app_access`; исправить glossary § `APP_AUTH_ROADMAP_USERS`.

---

### 4. REST API: ~50 endpoint'ов не описаны

Группы без документации (код: `backend/app/main.py`, `org_routes.py`):

| Группа | Примеры путей | Куда писать |
|--------|---------------|-------------|
| Auth | `/api/auth/defaults`, `/status`, `/logout` | `api.md`, glossary |
| Boards | `GET /api/boards` | `api.md` |
| Dashboard params | `search`, `sort`, `date_from/to`, `quarter`, `ect_reservation`, `linked_environment`, `metric`, `tag_group[]` | `api.md`, data-dictionary |
| Tasks | `POST /api/tasks/lookup`, PATCH `business-value`, `roadmap-priority`, `roadmap-comment`, `digital-plan-uc` | `api.md`, glossary (частично есть поля) |
| Product status B2B | `/api/product-status/b2b`, `/excel`, `/presentation`, `/save` | `product-status-b2b.md` |
| B2B news | `/api/b2b-news`, `/save` | `product-status-b2b.md` |
| Org (~40 routes) | `/api/org/employees`, `/departments`, `/vacations`, `/workspace/*`, `/org-chart*` | `org-module.md`, glossary § «Отделы» |
| Profile | `/api/profile`, `/photo`, `/password`, `/office-days` | `org-module.md`, glossary |
| Org users | `GET/POST/PATCH /api/org/users` | **нигде** — добавить в org-module + glossary |

---

### 5. Поле `extra_json.ect_acceptance` — в коде, нет в docs

| Где в коде | Docs |
|------------|------|
| `sync_service.py`, `ect_acceptance.py`, `report_service.py` | **нет** в glossary / data-dictionary |
| `TFS_ECT_ACCEPTANCE_TYPE_VALUES` в `config.py` | нет в glossary § env, не в docker-compose |

**Действие:** добавить в glossary (таблица `extra_json`) и data-dictionary.

---

### 6. Диаграммы не отражают текущий продукт

| Артефакт | Проблема |
|----------|----------|
| Mermaid ER в [diagrams.md](diagrams.md) | Нет `employee`, `workspace_*`, `org_user` и др. |
| Use case | Только ЗНИ/PAT; нет Staffing, Планов, Google Sheets, org login |
| [plan.md](plan.md) | Метрики «Скоро запуск» / «Запущено» устарели (см. `board_metrics.py`) |
| `plantuml/database-er.puml`, SVG | Без org-таблиц |

---

## Important — важные пробелы

### База данных

| Пробел | Код | Документ |
|--------|-----|----------|
| Заголовок «32 таблицы» | 34 таблицы + 4 views в `db/schema.sql` | [database-overview.md](database-overview.md) |
| `extra_json.board_code` | `sync_service.py` | glossary — текстом, нет в таблице полей |
| `employee_expertise` — поля | `schema.sql` | glossary — одна строка |
| `auth_session.payload`: `org_user_id`, `org_user_role`, `app_role` | `auth_sessions.py` | data-dictionary — неполный payload |
| data-dictionary без: `roadmap_*`, `has_uc`, `linked_environments`, `closed_transitions`, `incident_error`, `pilot_transitions` | sync/report | есть частично только в glossary |

### Frontend — вкладки без user docs

| UI | Код | Docs |
|----|-----|------|
| Вкладка **Staffing** (не «Отделы») | `WorkbookApp.tsx` | glossary: «Отделы» |
| Подвкладки: отпуска, бронь, офис, состав, пирамида, сотрудники, управление | `Departments.tsx` | glossary — частично |
| Ручная оргсхема (canvas, zoom, edges) | `OrgChartCanvas.tsx` | glossary — кратко |
| **Планы** — kanban, приоритет, UC, business value | `Roadmap.tsx` | только поля extra_json |
| **Статус продукта B2B** — inline edit, ZNI lookup, Excel/PPTX, save to Google | `ProductStatusWorkbook.tsx` | только env в docker.md |
| **Новости и запуски** | `ProductStatusB2B.tsx` | docker.md (env) |
| Переключатель темы | `ThemeToggle.tsx` | нигде |

### Backend / config (env без описания)

| Переменная | Файл |
|------------|------|
| `TFS_ECT_ACCEPTANCE_TYPE_VALUES` | `config.py` |
| `GOOGLE_SHEETS_WORKBOOK_CACHE_TTL_SECONDS` | упомянут в docker.md, не в compose |
| `SYNC_BUTTON_COOLDOWN_SECONDS`, `OUTBOUND_HTTP_PROXY` | `config.py` |
| `TFS_BATCH_SIZE`: compose default 100 vs `.env.example` 200 | расхождение не отмечено |

### Deployment / scripts

Не описаны в README / docker.md:

- `scripts/clean-sync-data.sh`, `rebuild-frontend.sh`, `compose-up.sh`, `resolve-compose.sh`, `apply-schema.ps1`
- `backend/scripts/build_b2b_product_status_template.py`
- `docker-compose.dev.yml` — hot reload, bind-mount (частично в docker.md)

---

## Nice to have

| Пробел | Комментарий |
|--------|-------------|
| `GET /api/digital-plan` | Backend endpoint без потребителя во frontend — пометить deprecated или описать |
| `uiState.ts` | Persistence вкладок, quarter roadmap, B2B gid — `docs/frontend.md` |
| [uml-diagram.md](uml-diagram.md) | Классы без Org/ProductStatus |
| Терминология | API `/api/org`, UI «Staffing», docs «Отделы» — унифицировать |
| PlantUML SVG | Перегенерировать после обновления `.puml` |

---

## Конкретные устаревшие утверждения

| Утверждение | Где | Факт |
|-------------|-----|------|
| «Frontend: дашборд ЗНИ» | README | Workbook: 4 вкладки + личный кабинет |
| `GET /api/export/csv` | glossary, database-overview | `GET /api/export` |
| `GET /api/sync/status` | glossary, database-overview | `GET /api/sync/{sync_id}` |
| «32 таблицы» | database-overview | 34 таблицы |
| «Скоро запуск — release_date» | plan.md | UAT / UAT Prod / Triage (`board_metrics.py`) |
| «Запущено — переход в Пилот за период» | plan.md | Pilot/Closed по доске |
| `APP_AUTH_*` могут синхронизировать TFS | glossary | UI sync: PAT или org admin |
| `APP_AUTH_ROADMAP_USERS` — только Планы | glossary | + Staffing |
| Use case: только вход по PAT | use-case-diagram.md | также login/password |

---

## Рекомендуемые новые файлы

| Файл | Содержание | Приоритет |
|------|------------|-----------|
| **`docs/api.md`** | Полный REST: auth, dashboard params, sync, export, tasks, product-status, b2b-news, org, profile | Critical |
| **`docs/auth-and-roles.md`** | PAT / APP_AUTH / org_user / admin; `canSyncTfs`, `canManageOrg`, `app_role` | Critical |
| **`docs/org-module.md`** | Staffing (7 подвкладок), права, MinIO фото, оргсхема, отпуска/бронь/присутствие | Important |
| **`docs/product-status-b2b.md`** | UI, Google Sheets, Excel/PPTX, env, кеш | Important |
| **`docs/roadmap.md`** | Вкладка Планы: kanban, локальные поля, ограничения roadmap-role | Important |

---

## Чеклист исправлений (backlog)

### Быстрые правки (1–2 часа)

- [ ] README: актуальные вкладки, auth, MinIO, ссылка на этот файл
- [ ] glossary + database-overview: `/api/export`, `/api/sync/{sync_id}`, login/password
- [ ] database-overview: «34 таблицы + 4 views»
- [ ] glossary: исправить § `APP_AUTH_ROADMAP_USERS` и sync-права
- [ ] glossary + data-dictionary: `ect_acceptance`, `TFS_ECT_ACCEPTANCE_TYPE_VALUES`

### Средний объём (полдня)

- [ ] `docs/api.md` — каталог endpoint'ов
- [ ] `docs/auth-and-roles.md`
- [ ] data-dictionary: ключи `extra_json`, auth payload, org-таблицы
- [ ] diagrams.md + plantuml: org-таблицы в ER

### Крупные разделы (1+ день)

- [ ] `docs/org-module.md`
- [ ] `docs/product-status-b2b.md`
- [ ] `docs/roadmap.md`
- [ ] Обновить use case и architecture diagrams
- [ ] Синхронизировать или архивировать [plan.md](plan.md)

---

## Связанные документы

- [glossary.md](glossary.md) — основной справочник по БД
- [database-overview.md](database-overview.md) — обзор таблиц и связей
- [data-dictionary.md](data-dictionary.md) — краткая выжимка полей
- [docker.md](docker.md) — миграции и деплой
