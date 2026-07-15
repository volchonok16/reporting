# Глоссарий базы данных reporting

Описание **всех таблиц**, **полей** и **представлений** единой PostgreSQL-базы. Имена полей одинаковы для задач из Jira, TFS, Trello и прочих систем; сырые значения источника хранятся отдельно там, где это указано.

**Связанные документы:** [teams.md](teams.md) · [database-overview.md](database-overview.md) · [data-dictionary.md](data-dictionary.md) · [documentation-gaps.md](documentation-gaps.md) · DDL: [../db/schema.sql](../db/schema.sql)

---

## Термины

| Термин | Значение |
|--------|----------|
| **Каноническое поле** | Поле в нашей БД с фиксированным именем (`start_date`, `title`, `team_id` и т.д.) |
| **Поле источника** | Имя поля в Jira/TFS/Trello; задаётся в `field_mapping.source_field_path` |
| **Канонический статус** | Единый статус из справочника `canonical_status` |
| **Каноническая команда** | Запись в справочнике `team`; код задаёт ETL, без seed в схеме |
| **Сырой статус** | Статус как в источнике (`task.source_status`, список Trello, State в TFS) |
| **Сырая команда** | Значение до нормализации (`task.source_team`: доска, тег, area) |
| **Категория статуса** | Группа для отчётов: `backlog`, `active`, `waiting`, `done`, `cancelled` |
| **Внешний ID** | Идентификатор задачи/комментария в исходной системе |
| **ЗНИ** | Запрос на изменение (TFS: `Запрос на изменение`); в БД `task_type = change_request` |
| **Ошибка** | Дефект TFS (`Ошибка`); в БД `task_type = error`, связь с ЗНИ через `parent_task_id` |
| **ETL / синхронизация** | Выгрузка из TFS в `task`; аудит в `sync_run` |

---

## Команды — краткий обзор

Подробно: **[teams.md](teams.md)**.

| Сущность | Назначение |
|----------|------------|
| `team` | Справочник команд (пустой до ETL) |
| `task.team_id` | **Главное поле** для фильтрации в отчётах |
| `task.source_team` | Сырое значение из API |
| `project.team_id` | Команда по умолчанию для доски/проекта |
| `source_team_mapping` | Правила: доска / тег / area → `team_id` |

Одна каноническая команда может объединять задачи из Jira и TFS. Записи в `team` создаёт ETL; правила — в `source_team_mapping` (доска, тег и т.д.).

**Миграции схемы** выполняются от пользователя `reporting` (владелец таблиц), не от `alex`/`ivan`. После миграций или DDL от backend — `bash scripts/grant-db-users.sh` (права alex/ivan на все таблицы). См. [docker.md](docker.md).

---

## source_system — внешние системы

Реестр систем, из которых загружаются задачи.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | smallserial | Первичный ключ |
| `code` | varchar(32) | Уникальный код системы: `jira`, `tfs`, `trello`, `other` |
| `name` | varchar(128) | Человекочитаемое название («Atlassian Jira») |
| `base_url` | text | Базовый URL инстанса (для ссылок и ETL) |
| `is_active` | boolean | Участвует ли система в синхронизации |
| `created_at` | timestamptz | Дата добавления записи в справочник |

---

## canonical_status — единые статусы

Нормализованные статусы для отчётов и расчёта времени. Все источники приводятся сюда через `source_status_mapping`.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | serial | Первичный ключ |
| `code` | varchar(64) | Уникальный код: `backlog`, `in_progress`, `done` и т.д. |
| `name` | varchar(128) | Отображаемое имя («В работе», «Готово») |
| `category` | varchar(32) | Категория для аналитики: `backlog` — время в бэклоге; `active` — в работе; `waiting` — ожидание/блок; `done` / `cancelled` — завершение |
| `sort_order` | int | Порядок на диаграммах и в отчётах |
| `is_terminal` | boolean | `true` — задача считается завершённой (не попадает в «открытые») |

**Предзаполненные коды:** `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`.

---

## source_status_mapping — маппинг статусов источника

Соответствие названия статуса в Jira/TFS/Trello нашему `canonical_status`.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | serial | Первичный ключ |
| `source_system_id` | smallint | Ссылка на `source_system` |
| `source_status_name` | varchar(255) | Имя статуса в источнике (например «In Progress», имя списка Trello) |
| `canonical_status_id` | int | Целевой канонический статус |
| `project_external_key` | varchar(64) | Ключ проекта, если маппинг только для него; `NULL` — для всей системы |

---

## field_mapping — маппинг полей источника

Правила преобразования полей внешней системы в канонические поля `task` и связанных сущностей. Заполняется на этапе интеграции.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | serial | Первичный ключ |
| `source_system_id` | smallint | Система-источник |
| `source_entity` | varchar(64) | Тип сущности в API: `issue`, `work_item`, `card`, `comment` |
| `source_field_path` | varchar(255) | Путь к полю в ответе API (например `fields.customfield_10001`, `System.State`) |
| `canonical_field` | varchar(128) | Имя целевого поля у нас: `title`, `start_date`, `story_points` |
| `transform_rule` | text | Опциональное правило преобразования (формула, справочник, формат даты) |
| `is_required` | boolean | Обязательно ли поле при загрузке |
| `notes` | text | Комментарий для администратора / аналитика |

---

## team — команда (каноническая)

Единый справочник команд для фильтрации в отчётах. **Без начальных данных** — команды добавляет ETL/скрипт.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `code` | varchar(64) | Уникальный slug; задаёт скрипт загрузки |
| `name` | varchar(255) | Отображаемое имя |
| `is_active` | boolean | Учитывается в отчётах |
| `created_at` | timestamptz | Дата создания записи |

---

## source_team_mapping — определение команды из источника

Правила для ETL: по какому признаку в Jira/TFS/Trello назначить `team_id`. Заполняется позже (доска, тег, area path и т.д.).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | serial | Первичный ключ |
| `source_system_id` | smallint | Источник |
| `team_id` | bigint | Целевая команда |
| `match_type` | varchar(32) | Тип признака: `board_name`, `tag`, `label`, `iteration_path`, `area_path`, `project_key`, `component` |
| `match_value` | varchar(500) | Значение или шаблон |
| `is_regex` | boolean | `match_value` — регулярное выражение |
| `project_external_key` | varchar(64) | Ограничение правила проектом; `NULL` — глобально |
| `priority` | int | Приоритет при нескольких совпадениях (больше = важнее) |
| `is_active` | boolean | Правило активно |
| `notes` | text | Комментарий |

Правила в `source_team_mapping` заполняются вместе со скриптом ETL (доска, тег, area path).

---

## person — человек (исполнитель, автор)

Единый профиль человека независимо от учёток в Jira/TFS/Trello.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `email` | varchar(255) | Email (уникальный, если задан) |
| `display_name` | varchar(255) | Отображаемое имя |
| `is_active` | boolean | Учитывается ли в отчётах |
| `created_at` | timestamptz | Дата появления в БД |

---

## person_external — учётка во внешней системе

Связь одного `person` с ID пользователя в конкретной системе (для маппинга assignee/reporter при ETL).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `person_id` | bigint | Ссылка на `person` |
| `source_system_id` | smallint | Система, где существует учётка |
| `external_user_id` | varchar(255) | ID пользователя в API источника |
| `external_username` | varchar(255) | Логин или имя в источнике |

---

## project — проект / пространство / доска

Контейнер задач в источнике. Один проект принадлежит одной `source_system`.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `source_system_id` | smallint | Откуда загружен проект |
| `external_key` | varchar(64) | Ключ в источнике: Jira project key, id доски Trello, имя проекта TFS |
| `name` | varchar(255) | Название проекта |
| `team_id` | bigint | Команда по умолчанию для проекта; fallback, если у задачи не задан `task.team_id` |
| `is_active` | boolean | Участвует в синхронизации |
| `created_at` | timestamptz | Дата первой загрузки |

**Соответствие:** Jira — Project; TFS — Team Project; Trello — Board.

Если все задачи доски относятся к одной команде — достаточно `project.team_id`. Если команда различается по задачам — ETL заполняет `task.team_id` по `source_team_mapping`.

---

## release — релиз / версия

Версия продукта или целевая дата отгрузки для группировки задач в отчётах.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `project_id` | bigint | Проект, к которому относится релиз |
| `external_id` | varchar(255) | ID версии в источнике (если есть) |
| `name` | varchar(255) | Название релиза / Fix Version / milestone |
| `version` | varchar(64) | Номер версии (1.2.0) |
| `planned_release_date` | date | Плановая дата релиза |
| `actual_release_date` | date | Фактическая дата выхода |
| `status` | varchar(32) | Состояние релиза: `planned`, `released`, `cancelled` |
| `created_at` | timestamptz | Дата создания записи в БД |

---

## task — задача (единая модель)

Центральная сущность: карточка, work item, issue. Уникальность: пара (`source_system_id`, `external_id`).

### Идентификация и связи

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Внутренний первичный ключ |
| `uuid` | uuid | Стабильный UUID для внешних интеграций и ссылок |
| `source_system_id` | smallint | Система-источник |
| `external_id` | varchar(255) | ID или ключ задачи в источнике |
| `external_url` | text | Прямая ссылка на задачу в веб-интерфейсе источника |
| `project_id` | bigint | Проект / доска |
| `team_id` | bigint | Каноническая команда (FK → `team`) — основное поле для фильтрации |
| `parent_task_id` | bigint | Родительская задача (ЗНИ → Ошибка, epic → story) |

### Содержание

| Поле | Тип | Описание |
|------|-----|----------|
| `title` | varchar(1000) | Заголовок задачи |
| `description` | text | Полное описание |
| `task_type` | varchar(64) | Тип: `change_request` (ЗНИ), `error` (Ошибка), `story`, `bug`, `epic`, `task`, `feature` |
| `priority` | varchar(32) | Приоритет: `critical`, `high`, `medium`, `low` (единая шкала) |

### Статус

| Поле | Тип | Описание |
|------|-----|----------|
| `canonical_status_id` | int | Текущий канонический статус (для отчётов и фильтров) |
| `source_status` | varchar(255) | Статус в терминах источника (колонка, список, State) |
| `source_team` | varchar(255) | Команда как пришла из источника (до маппинга в `team_id`) |

### Участники

| Поле | Тип | Описание |
|------|-----|----------|
| `assignee_id` | bigint | Текущий исполнитель (`person`) |
| `reporter_id` | bigint | Автор / создатель с точки зрения бизнеса (`person`) |

### Даты жизненного цикла

| Поле | Тип | Описание |
|------|-----|----------|
| `created_at` | timestamptz | Когда задача создана в источнике |
| `updated_at` | timestamptz | Последнее изменение в источнике |
| `start_date` | date | Дата начала работ (план или факт) |
| `due_date` | date | Срок исполнения / дедлайн |
| `release_date` | date | Целевая дата попадания в релиз |
| `resolved_at` | timestamptz | Когда задача переведена в «решена» |
| `closed_at` | timestamptz | Когда задача закрыта окончательно |

### Оценки трудозатрат

| Поле | Тип | Описание |
|------|-----|----------|
| `story_points` | numeric(10,2) | Story points или аналог оценки объёма |
| `original_estimate_hours` | numeric(10,2) | Первоначальная оценка в часах |
| `remaining_hours` | numeric(10,2) | Оставшиеся часы |
| `completed_hours` | numeric(10,2) | Затраченные часы |

### Релиз и итерация

| Поле | Тип | Описание |
|------|-----|----------|
| `release_id` | bigint | Основной релиз задачи |
| `sprint_name` | varchar(255) | Имя спринта (Jira Sprint и аналоги) |
| `iteration_path` | varchar(500) | Путь итерации в TFS (`Area\Iteration`) |

### Метки и сырьё

| Поле | Тип | Описание |
|------|-----|----------|
| `labels` | text[] | Метки / теги |
| `components` | text[] | Компоненты продукта (Jira components и аналоги) |
| `extra_json` | jsonb | Поля источника, ещё не перенесённые в канонические колонки |

### Служебные

| Поле | Тип | Описание |
|------|-----|----------|
| `first_synced_at` | timestamptz | Первая загрузка в нашу БД |
| `last_synced_at` | timestamptz | Последнее обновление при синхронизации |

---

## task_release — задача в нескольких релизах

Связь многие-ко-многим, если в источнике у задачи несколько Fix Versions / релизов.

| Поле | Тип | Описание |
|------|-----|----------|
| `task_id` | bigint | Задача (часть PK) |
| `release_id` | bigint | Релиз (часть PK) |

---

## task_comment — комментарий к задаче

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `task_id` | bigint | Задача |
| `source_system_id` | smallint | Система, откуда взят комментарий |
| `external_comment_id` | varchar(255) | ID комментария в источнике (уникален в рамках системы) |
| `author_id` | bigint | Автор (`person`) |
| `body` | text | Текст комментария |
| `is_internal` | boolean | Внутренний комментарий (виден не всем), типично для Jira |
| `created_at` | timestamptz | Время создания в источнике |
| `updated_at` | timestamptz | Время последнего редактирования |
| `synced_at` | timestamptz | Время загрузки в нашу БД |

---

## task_status_history — история смены статусов

Каждая запись — одно событие смены статуса (changelog Jira, revision TFS, перемещение карточки между списками Trello).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `task_id` | bigint | Задача |
| `from_canonical_status_id` | int | Статус до смены (может быть `NULL` при создании) |
| `to_canonical_status_id` | int | Статус после смены |
| `from_source_status` | varchar(255) | Сырой статус до смены |
| `to_source_status` | varchar(255) | Сырой статус после смены |
| `changed_at` | timestamptz | Момент смены |
| `changed_by_id` | bigint | Кто изменил (`person`) |
| `source_event_id` | varchar(255) | ID события в источнике (дедупликация ETL) |
| `synced_at` | timestamptz | Когда событие записано у нас |

---

## task_status_duration — время нахождения в статусе

Интервал пребывания задачи в одном каноническом статусе. Основа для метрик «сколько в бэклоге» и «сколько в In Progress».

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `task_id` | bigint | Задача |
| `canonical_status_id` | int | Статус, в котором измеряется интервал |
| `entered_at` | timestamptz | Вход в статус |
| `left_at` | timestamptz | Выход из статуса; `NULL` — задача ещё в этом статусе |
| `duration_seconds` | bigint | Длительность в секундах (пересчитывается триггером при заполнении `left_at`) |
| `is_current` | boolean | `true` — текущий открытый интервал для этой задачи |
| `source_status` | varchar(255) | Сырой статус источника на момент интервала |

**Время в бэклоге:** сумма `duration_seconds` по строкам, где у статуса `canonical_status.category = 'backlog'`.

---

## task_status_duration_agg — агрегат времени по статусу

Предрасчитанная сумма секунд по паре (задача, статус) для ускорения FineBI.

| Поле | Тип | Описание |
|------|-----|----------|
| `task_id` | bigint | Задача (часть PK) |
| `canonical_status_id` | int | Статус (часть PK) |
| `total_seconds` | bigint | Суммарное время в этом статусе |
| `last_entered_at` | timestamptz | Последний вход в этот статус |

---

## task_assignee_history — история исполнителя

Если assignee менялся, хранятся периоды ответственности.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `task_id` | bigint | Задача |
| `assignee_id` | bigint | Исполнитель; `NULL` — снят с задачи |
| `assigned_at` | timestamptz | Начало периода |
| `unassigned_at` | timestamptz | Конец периода; `NULL` — ещё назначен |

---

## auth_session — сессия веб-приложения

Серверное хранение учётных данных TFS для синхронизации. Клиент получает только `sessionId` (заголовок `X-Session-Id`).

| Способ входа | `auth_mode` | PAT в сессии |
|--------------|-------------|--------------|
| PAT пользователя | `pat` | PAT из формы входа |
| Логин/пароль приложения | `app_user` | `TFS_SYNC_PAT` с сервера |

Пользователи приложения задаются в `APP_AUTH_USERS` (`login:password`, по строке). Секреты — только в `.env`, не в репозитории.

Пользователи с ограниченным доступом — `APP_AUTH_ROADMAP_USERS`: только вкладка **Планы**, синхронизация TFS только по доске `digital_streams_b2b` (кнопка «Обновить из TFS»), **без редактирования** приоритета колбаски (Обязательно / Средний / Можно пропустить — `extra_json.roadmap_priority`) и ценности для бизнеса. Роль в сессии: `app_role` = `roadmap` (остальные — `full`).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | varchar(64) | Идентификатор сессии |
| `payload` | jsonb | `base_url`, `project`, `pat`, `auth_mode`, `app_login`, `app_role` и др. (не отдаётся в API) |
| `created_at` | timestamptz | Время создания сессии |

---

## Маппинг полей TFS → task (ЗНИ)

| Поле TFS | Поле `task` | Примечание |
|----------|-------------|------------|
| `System.Id` | `external_id` | Номер ЗНИ |
| `System.Title` | `title` | Название |
| `System.State` | `source_status` | Статус workflow |
| `System.WorkItemType` | `task_type` | `Запрос на изменение` → `change_request`, `Ошибка` → `error` |
| `System.CreatedDate` | `created_at` | Дата создания |
| `Microsoft.VSTS.Scheduling.StartDate` | `start_date` | Если пусто — берётся `created_at` |
| `Microsoft.VSTS.Scheduling.TargetDate` | `release_date` | Целевая дата релиза (колонка «Скоро запуск») |
| `System.AreaPath` | `extra_json.area_path` | Область доски |
| `System.BoardColumn` | `extra_json.board_column` | Колонка Kanban |
| `System.IterationPath` | `extra_json.iteration_path` | Итерация (план релиза) |
| `System.Tags` | `extra_json.tags` | Теги TFS (разделитель `;`) |
| `Logrocon.FoundinRelease` | `extra_json.planned_release` | Плановый релиз (дата `2026.06.02.0-R`) |
| `Logrocon.Release` | `extra_json.planned_release` | Привязанный релиз (имя, напр. `Bercut InVoice 4.7.90.0 (1034184)`) |
| `Logrocon.PO` | `extra_json.customer_name` | Заказчик ЗНИ (ФИО из поля TFS) |
| `System.Description` | `extra_json.business_goal` | Текст секции «Цель и бизнес-смысл доработки*» (до следующего заголовка `<b>…</b>`) |
| `Microsoft.VSTS.Common.BusinessValue` | `extra_json.business_value` | Ценность для бизнеса (целое число; колонка дашборда ЗНИ и поле на колбаске **Планы**; редактирование через `PATCH /api/tasks/{id}/business-value`, только `app_role` = `full`) |
| Планы приоритет | `extra_json.roadmap_priority` | Локальное поле (не в TFS): цвет колбаски на вкладке **Планы** — `red` / `yellow` / `green`; `PATCH /api/tasks/{id}/roadmap-priority` (только `app_role` = `full`); при синхронизации TFS сохраняется в БД |
| Планы комментарий | `extra_json.roadmap_comment` | Локальное поле (не в TFS): текст внизу колбаски на вкладке **Планы**; `PATCH /api/tasks/{id}/roadmap-comment` (любой авторизованный пользователь); при синхронизации TFS сохраняется в БД |
| Use Case | `extra_json.has_uc` | Локальное поле (не в TFS): на колбаске **Планы** — `false` по умолчанию («Нет»), `true` — «Да»; `PATCH /api/tasks/{id}/digital-plan-uc` (любой авторизованный пользователь); при синхронизации TFS сохраняется в БД |
| Related → «Бронь ресурсов» | `extra_json.ect_resource_reservation` | `true` / `false`: у ЗНИ есть Related на элемент типа «Бронь ресурсов» (колонка «Бронь ресурса ЕЦТ») |
| Related → CRM / Bercut / ESB | `extra_json.linked_environments` | Массив связанных ЗНИ в окружениях **CRM** (`Tele2\Продукты`), **Bercut** (`BE-T2\BE Analytics`) и **ESB** (`BE-T2\ESB\ESB Analytics`): `key`, `label`, `zni_id`, `status`, `board_column`, `url`. Заполняется при синхронизации доски **Digital** (WIQL Related между областями). В дашборде ЗНИ — в раскрывающейся панели строки; фильтр **«Требует доп. доработок»** (`linked_environment=yes`, только доска Digital) оставляет ЗНИ с хотя бы одной такой связью |

**Планируемая дата** — из листа `System.IterationPath`: `2026.08.11.0-R` → `2026-08-11`; если в пути есть **TBD** — в UI выводится `TBD`; если дата из итерации не определена — подставляется **Целевая дата** (`Microsoft.VSTS.Scheduling.TargetDate`, поле `task.release_date`, напр. ЗНИ 1071033 → `03.12.2025`). **План квартала** — `Q3 2026` или `TBD`; фильтр `quarter` в API (`TBD`, `2026-Q3`, …). В выпадающем списке фильтра — только кварталы **текущего года** плюс отдельные пункты TBD и «Без квартала». **Плановый релиз** — из `Logrocon.FoundinRelease` или `Logrocon.Release`, если поле проставлено или релиз привязан; колонка «План. релиз» в дашборде и CSV. **Бронь ресурса ЕЦТ** — `ДА` / `НЕТ`: прямая Related-связь ЗНИ с элементом «Бронь ресурсов» (`TFS_RESOURCE_RESERVATION_TYPE_VALUES`, по умолчанию `Бронь ресурсов`).

**Доски приложения:** Digital Streams B2b (`Tele2\Digital\Streams\B2b`, в UI — «Digital»); Продукты (`Tele2\Продукты`, в UI — «Продукты», ЗНИ с `b2b_product`, метрики как у Digital); Reports (`Tele2\Reports\Team A`, в UI — «Reports», ЗНИ с `b2b_product`, метрики как у Digital); B2B Product — CORE, КАТС, Голосовые продукты, М2М / IoT, SMS, Solar, Umnico (area path `Tele2\B2B Product…`, те же правила синка и метрик, что у Digital: исключение тегов `EFO` / `not_product`, ошибки без фильтра по тегам, «Скоро запуск» — `UAT`, «Запущено» — `Pilot`); BE Analytics (`BE-T2\BE Analytics`, ЗНИ с `b2b_product`); ESB (`BE-T2\ESB\ESB Analytics`, в UI — «ESB», те же теги и метрики, что у BE Analytics).

**Фильтр области (дашборд):** доска **Digital** — `newlk`, `site`, `eshop_b2b`; **остальные доски** (кроме «Все доски») — `eshop`. В UI — «Область»; query-параметр `tag_group` (можно несколько). Группы в `backend/app/tag_filters.py`:

| Ключ API | Подпись в UI | Корневой тег TFS | Доски | Подразделы (префикс) |
|----------|--------------|------------------|-------|----------------------|
| `newlk` | ЛК b2b | `LK_B2B` | Digital | `lk_*` (напр. `lk_serv`) |
| `site` | Сайт | `site_b2b` | Digital | `site_*` |
| `eshop_b2b` | EShop B2B | `EShopB2B` | Digital | — |
| `eshop` | EShop | `EShop` | остальные | — |

При выборе нескольких областей ЗНИ попадает в выборку, если совпадает хотя бы одна (логика ИЛИ). Сопоставление по `extra_json.tags` (`System.Tags` при синке).

После синхронизации доски записи `task` с тем же `board_code`, не попавшие в выгрузку, удаляются (очистка устаревших ЗНИ/ошибок).

**Фильтр синхронизации:** ЗНИ в статусе `Closed` с `ChangedDate` / `ClosedDate` старше 365 дней не загружаются (`TFS_EXCLUDE_CLOSED_OLDER_THAN_DAYS`).

---

## sync_run — запуск синхронизации (ETL)

Аудит одной выгрузки из внешней системы.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `source_system_id` | smallint | Какая система загружалась |
| `started_at` | timestamptz | Старт |
| `finished_at` | timestamptz | Окончание |
| `status` | varchar(32) | `running`, `success`, `failed` |
| `records_fetched` | int | Сколько записей получено из API |
| `records_upserted` | int | Сколько записано/обновлено в БД |
| `error_message` | text | Текст ошибки при сбое |
| `parameters_json` | jsonb | Параметры запуска (проект, дата с, фильтры) |

---

## sync_run_log — лог строки синхронизации

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `sync_run_id` | bigint | Запуск |
| `level` | varchar(16) | Уровень: `info`, `warn`, `error` |
| `message` | text | Текст сообщения |
| `created_at` | timestamptz | Время записи |

---

## team_workload_snapshot — снимок загрузки команды

Агрегат на дату (и опционально на релиз): сколько задач в бэклоге, в работе, отгружено.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `team_id` | bigint | Команда |
| `snapshot_date` | date | Дата снимка |
| `backlog_count` | int | Число задач в категории `backlog` |
| `active_count` | int | Число задач в категории `active` |
| `waiting_count` | int | Число задач в категории `waiting` |
| `done_count_period` | int | Закрыто за отчётный период |
| `total_open_story_points` | numeric(12,2) | Сумма story points по открытым задачам |
| `tasks_shipped_to_release` | int | Сколько задач привязано к релизу на эту дату |
| `release_id` | bigint | Релиз для среза (если снимок по релизу) |
| `calculated_at` | timestamptz | Когда рассчитан снимок |

---

## Представления (views) для отчётности

Логические «таблицы» только для чтения; удобны для FineBI.

### v_task_backlog_duration

| Поле | Описание |
|------|----------|
| `task_id` | ID задачи |
| `external_id` | Ключ в источнике |
| `title` | Заголовок |
| `project_name` | Название проекта |
| `source_system` | Код системы (`jira`, `tfs`, …) |
| `team_code` | Код канонической команды из `team.code` |
| `team_name` | Название команды |
| `backlog_seconds` | Суммарное время в бэклоге, секунды |
| `backlog_days` | То же в днях |

### v_task_status_time

| Поле | Описание |
|------|----------|
| `task_id` | ID задачи |
| `external_id` | Ключ в источнике |
| `title` | Заголовок |
| `team_code` | Код команды |
| `team_name` | Название команды |
| `status_code` | Код канонического статуса |
| `status_name` | Имя статуса |
| `category` | Категория статуса |
| `entered_at` | Вход в статус |
| `left_at` | Выход |
| `duration_seconds` | Длительность, сек |
| `duration_days` | Длительность, дни |
| `is_current` | Текущий ли интервал |

### v_team_open_tasks

| Поле | Описание |
|------|----------|
| `team_id` | ID команды |
| `team_code` | Код команды |
| `team_name` | Название |
| `status_category` | Категория статуса |
| `status_code` | Код статуса |
| `task_count` | Количество открытых задач |
| `story_points_sum` | Сумма story points |

### v_tasks_by_release

| Поле | Описание |
|------|----------|
| `release_id` | ID релиза |
| `release_name` | Название |
| `planned_release_date` | Плановая дата |
| `actual_release_date` | Фактическая дата |
| `project_name` | Проект |
| `team_code` | Код команды |
| `team_name` | Название команды |
| `task_count` | Всего задач в релизе |
| `story_points_sum` | Сумма оценок |
| `done_task_count` | Задач в терминальном статусе |

---

## Индекс полей canonical_field (для field_mapping)

Часто используемые целевые поля в `task`:

| canonical_field | Таблица | Назначение |
|-----------------|---------|------------|
| `title` | task | Заголовок |
| `description` | task | Описание |
| `task_type` | task | Тип |
| `priority` | task | Приоритет |
| `start_date` | task | Начало работ |
| `due_date` | task | Срок |
| `release_date` | task | Дата релиза |
| `story_points` | task | Оценка |
| `assignee_id` | task | Исполнитель (через `person_external`) |
| `reporter_id` | task | Автор |
| `source_status` | task | Сырой статус (до маппинга в canonical) |
| `team_id` | task | Каноническая команда (FK → `team`) |
| `source_team` | task | Сырая команда из источника |

Полный перечень колонок `task` — в разделе [task](#task--задача-единая-модель) выше. Команды — [teams.md](teams.md).

---

## Веб-приложение reporting

Дашборд-workbook: FastAPI + Vite; production — nginx + HTTPS (хосты в `.env` / `CERTBOT_DOMAINS`, см. [deploy/DEPLOY.md](../deploy/DEPLOY.md)).

**Вкладки UI:** ЗНИ · Статус продукта B2B · Планы Digital · Доска (YouJail) · Staffing · Диаграммы (+ личный кабинет).

| Компонент | Путь / URL | Назначение |
|-----------|------------|------------|
| Frontend | `frontend/`, HTTPS UI | React workbook |
| Backend | `backend/`, HTTPS API | REST: TFS, org, youjail, B2B+PPTX |
| PostgreSQL | `postgres:5432`, volume `reporting_pgdata` | Доменные данные (в т.ч. B2B в БД) |
| MinIO | `:9000` API / `:9001` Console, volume `reporting_miniodata` | Фото (`MINIO_BUCKET=photos`) |
| minio-init | one-shot `mc` | Создание bucket + anonymous download |
| `YOUJAIL_WORKSPACE_DIR` | диск backend | Вложения / worktree доски |
| `ORG_UPLOADS_DIR` | `/app/uploads` | Fallback фото без MinIO |
| PPTX template | `assets/Status.pptx` | Генерация презентаций B2B |
| nginx | `deploy/nginx/` | HTTPS, reverse proxy на :5173 и :8000 |
| certbot | `scripts/production.sh` | Let's Encrypt (`CERTBOT_DOMAINS`) |
| FineBI | JDBC → Postgres | Views `v_*` |

Аутентификация: `POST /api/auth/login` — **PAT** (свой токен) или **логин/пароль** приложения (`APP_AUTH_USERS`, выгрузка через `TFS_SYNC_PAT`) → `auth_session` → `X-Session-Id`. Секреты TFS не отдаются клиенту.

### Метрики дашборда

| Метрика | Условие подсчёта |
|---------|------------------|
| **Всего задач** | `task_type = change_request`, фильтр по доске (`extra_json.area_path` / `team_id`) |
| **В работе** | Статус workflow / колонка доски `Development` |
| **Скоро запуск** | Digital Streams B2b и B2B Product: статус `UAT`; BE Analytics / ESB: `UAT Prod`, `Implementation Prod` или Triage `в Работе` (`extra_json.triage`) |
| **Запущено** | Digital Streams B2b и B2B Product: статус `Pilot` / `Пилот`; BE Analytics / ESB: статус `Closed` |
| **Завершенные** | ЗНИ в статусе `Closed`, переведённые в периоде «Дата начала»–«Дата конца» (по умолчанию текущий квартал, можно изменить; без дат — текущий год); учитываются только ЗНИ с заполненным `extra_json.customer_name` (`Logrocon.PO`); история переходов — `extra_json.closed_transitions` |
| **Ошибки** | ЗНИ с хотя бы одной привязанной ошибкой (`parent_task_id` у `task_type = error`), кроме ошибок в статусе Closed (`TFS_CLOSED_STATE_VALUES`); на **Bercut** (`be_t2_team`) дополнительно — отдельные ошибки из `BE-T2\Incident management` с тегом `b2b_product` без родительского ЗНИ (`extra_json.incident_error`) |

Клик по карточке метрики фильтрует таблицу (`metric=in_progress|launching_soon|launched|completed|errors`); повторный клик снимает фильтр. Период «Дата начала»–«Дата конца» по `start_date`, при отсутствии — по `created_at`. **Digital и Bercut:** период только для **«Всего задач»**; метрики **«В работе»** … **«Ошибки»** (по связанным ЗНИ) без фильтра по дате. Отдельные incident-ошибки Bercut (`BE-T2\Incident management`) дополнительно режутся по периоду. **Остальные доски:** период применяется ко всем метрикам. Закрытые ЗНИ в таблице видны при фильтрах **«Запущено»** (BE: `Closed`) и **«Завершенные»**. Закрытые ошибки не попадают в счётчик, фильтр и колонку «Ошибки» CSV-выгрузки.

### Синхронизация TFS (оптимизация)

| Параметр `.env` | По умолчанию | Назначение |
|-----------------|--------------|------------|
| `TFS_FETCH_ALL_FIELDS` | `false` | Не запрашивать все поля |
| `TFS_FETCH_RELATIONS` | `false` | Не использовать `$expand` Relations на ЗНИ |
| `TFS_BATCH_SIZE` | `200` | Размер batch workItems |
| `TFS_LINKED_BATCH_SIZE` | `200` | Порция ошибок (лимит TFS workItemsBatch = 200) |
| `TFS_EXCLUDE_CLOSED_OLDER_THAN_DAYS` | `365` | Пропуск Closed ЗНИ старше N дней |
| `TFS_CLOSED_STATE_VALUES` | `Closed` | Статусы для фильтра |
| `TFS_RESOURCE_RESERVATION_TYPE_VALUES` | `Бронь ресурсов` | Тип элемента TFS «Бронь ресурсов» для колонки «Бронь ресурса ЕЦТ» |

Алгоритм: WIQL по AreaPath → `workItemsBatch` (поля) → WIQL `WorkItemLinks` (ЗНИ→Ошибка, ЗНИ→Related «Бронь ресурсов») → batch ошибок → upsert в `task` → `prune_stale` (не попали в выгрузку) → `prune_closed_before_current_year` (Closed с `ClosedDate` / валидной `closed_transitions` до текущего календарного года).

При синхронизации Closed ЗНИ с датой закрытия в прошлом календарном году **не загружаются** (`should_skip_closed_zni`) и **удаляются из БД**, если остались от старых прогонов. Дата закрытия — `task.closed_at` (`Microsoft.VSTS.Common.ClosedDate`), при её отсутствии — первая валидная дата из `extra_json.closed_transitions` (годы 2000–2100; битые даты вроде `9999-01-01` из TFS игнорируются).

### REST API

| Endpoint | Описание |
|----------|----------|
| `POST /api/auth/login` | `{ pat, base_url?, project? }` → `{ sessionId }` |
| `GET /api/dashboard?board=` | Метрики + список ЗНИ |
| `POST /api/sync` | Синхронизация; body `{ board }` |
| `GET /api/sync/status` | Статус и прогресс |
| `GET /api/export/csv?board=` | CSV: ЗНИ + ошибки |

Диаграммы: [diagrams.md](diagrams.md) · Production: [deploy/DEPLOY.md](../deploy/DEPLOY.md).

---

## org_user — учётные записи сотрудников

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `email` | varchar(255) | Email для входа (уникальный) |
| `password_hash` | text | Хеш пароля (PBKDF2-SHA256) |
| `role` | smallint | `10` — пользователь, `100` — администратор отделов |
| `status` | smallint | `0` удалён, `9` неактивен, `10` активен |
| `created_at`, `updated_at` | timestamptz | Метки времени |

Связь: `employee.user_id` → `org_user.id`. Вход по email/паролю через `POST /api/auth/login` (режим app_user).

---

## employee — сотрудники

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `public_id` | uuid | Публичный идентификатор для ссылок и @упоминаний (не раскрывает порядковый `id`) |
| `user_id` | bigint | FK → `org_user` (учётная запись) |
| `full_name` | varchar(255) | ФИО |
| `email` | varchar(255) | Рабочий email |
| `position_id` | bigint | FK → `job_position` |
| `position` | varchar(255) | Название должности (денормализация) |
| `manager_id` | bigint | FK → `employee` (руководитель) |
| `photo_path` | varchar(512) | Ключ объекта в MinIO (`employees/…`) или путь в `ORG_UPLOADS_DIR` |
| `daily_work_hours` | numeric(4,2) | Рабочих часов в день (по умолчанию 8) |
| `is_active` | boolean | Активен |
| `is_organization_head` | boolean | Директор организации (вершина пирамиды) |

---

## department — отделы

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `name` | varchar(255) | Название |
| `description` | text | Описание |
| `head_employee_id` | bigint | FK → `employee` (руководитель отдела) |
| `sort_order` | int | Порядок отображения |
| `is_active` | boolean | Активен |

---

## department_member — состав отдела

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `department_id` | bigint | FK → `department` |
| `employee_id` | bigint | FK → `employee` (уникально в паре с отделом) |
| `team_role_id` | bigint | FK → `team_role` |
| `position` | varchar(255) | Должность в контексте отдела |
| `manager_id` | bigint | FK → `employee` (руководитель в отделе) |
| `email` | varchar(255) | Email в контексте отдела |
| `sort_order` | int | Порядок в списке |

**UI:** состав редактируется и из вкладки «Состав» отдела (добавление участника), и из карточки/формы сотрудника (поле `departmentIds` → те же строки `department_member`).

---

## org_chart_layout — ручная раскладка оргсхемы

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `scope` | varchar(32) | Область схемы: `company` — вся компания, `department` — отдельный отдел |
| `department_id` | bigint | FK → `department`; заполнено только для `scope = department` |
| `layout_json` | jsonb | Сохранённые узлы (`nodes`) с координатами и линии (`edges`) между ними |
| `created_at`, `updated_at` | timestamptz | Метки времени |

Используется вкладкой «Пирамида»: администратор вручную расставляет карточки сотрудников/рамки отделов и рисует линии; сохранённая схема показывается всем пользователям.

---

## YouJail — отдельная kanban-доска

Самостоятельный модуль на вкладке **«Доска»**. Карточки можно привязать к ЗНИ из синхронизированной таблицы `task` (по номеру, несколько через запятую). Остальное не связано с TFS-синком напрямую. Поддерживает **несколько досок**, **fuzzy-поиск** (`pg_trgm`), **PTY-терминал** в браузере (WebSocket + xterm.js) и CLI **`ty`**.

### youjail_board

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `name` | varchar(255) | Название доски |
| `slug` | varchar(64) | Уникальный код |
| `description` | text | Описание |
| `sort_order` | integer | Порядок в списке |
| `is_active` | boolean | Активна |
| `owner_employee_id` | bigint | FK → `employee`; личная доска сотрудника (`NULL` = общая/командная) |
| `canManage` | bool (API) | Управление колонками и участниками доски |

У каждой доски свой набор колонок (`youjail_column.board_id`) и карточек (`youjail_card.board_id`). Seed: доска `main` («Основная»). **Личная доска** создаётся автоматически при первом входе в YouJail: название = `employee.full_name`, slug `personal-{employee_id}`; владелец — админ доски; к командам не привязывается.

### youjail_board_member

| Поле | Тип | Описание |
|------|-----|----------|
| `board_id` | bigint | FK → `youjail_board` |
| `employee_id` | bigint | FK → `employee` |
| `role` | varchar(32) | `admin` — колонки и участники; `member` — карточки |

Прямой доступ к доске (в т.ч. к чужой личной). Владелец личной доски (`owner_employee_id`) — неявный admin. Уникальность: `(board_id, employee_id)`.

### youjail_board_pin

| Поле | Тип | Описание |
|------|-----|----------|
| `employee_id` | bigint | FK → `employee` |
| `board_id` | bigint | FK → `youjail_board` |
| `pinned_at` | timestamptz | Время закрепления (порядок в списке) |

Персональная настройка: какие доски показывать вверху переключателя. API: `pinned` в метаданных доски; `POST /api/youjail/boards/{id}/pin` — переключить закрепление.

### youjail_project

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `name` | varchar(255) | Название проекта |
| `slug` | varchar(64) | Уникальный код |
| `repo_path` | text | Путь к git-репозиторию для worktree |
| `context_md` | text | Кэш контекста проекта (markdown) |
| `instructions_md` | text | Инструкции для исполнителя |
| `is_active` | boolean | Активен |

### youjail_task_type

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | varchar(128) | Тип задачи (`feature`, `bugfix`, …) |
| `instructions_md` | text | Подсказки для агента |

### youjail_column

| Поле | Тип | Описание |
|------|-----|----------|
| `board_id` | bigint | FK → `youjail_board` |
| `column_key` | varchar(32) | Стабильный ключ (`backlog`, `in_progress`, … или пользовательский) |
| `title`, `tone`, `sort_order` | | Отображение колонки на доске |

### youjail_card

| Поле | Тип | Описание |
|------|-----|----------|
| `board_id` | bigint | FK → `youjail_board` |
| `column_id` | bigint | FK → `youjail_column` |
| `card_number` | integer | Порядковый номер на доске |
| `cardKey` | string (API) | `{SLUG_UPPER}-N`: `MAIN-1`, `PERSONAL134-2` (slug доски без дефисов + номер) |
| `cardKeyGlobal` | string (API) | То же, что `cardKey` — глобально уникальный ключ для связей между досками |
| `project_id`, `task_type_id` | bigint | Проект и тип |
| `title` | varchar(1000) | Заголовок |
| `description_md` | text | Заметки (markdown); упоминания: `@[ФИО](employee:uuid)` (`employee.public_id`); старый формат `employee:123` читается для совместимости |
| `pinned`, `archived` | boolean | Закрепление / архив |
| `closed_at`, `scheduled_at` | timestamptz | Закрытие / план |
| `executor` | varchar(64) | AI-агент: `manual`, `claude`, `codex`, … |
| `assignee_employee_id` | bigint | FK → `employee` — ответственный; при создании подставляется автор карточки |
| `worktree_path`, `worktree_branch` | text | Git worktree |
| `execution_status` | varchar(32) | `idle`, `queued`, `running`, `succeeded`, `failed` |
| `zniNumbers` | string (API) | Номера ЗНИ через запятую; в БД — `youjail_card_zni` |

### youjail_card_zni

| Поле | Тип | Описание |
|------|-----|----------|
| `card_id` | bigint | FK → `youjail_card` |
| `task_id` | bigint | FK → `task` (ЗНИ, `task_type = change_request`) |
| `sort_order` | integer | Порядок как в поле ввода |

Связь M:N. Ввод: `123456, 789012`. API: `zniNumbers`, `znis[]`; lookup: `POST /api/youjail/zni/lookup`. Несуществующий номер при сохранении → HTTP 400.

### youjail_card_event

| Поле | Тип | Описание |
|------|-----|----------|
| `card_id` | bigint | FK → `youjail_card` |
| `event_type` | varchar(64) | `created`, `moved`, `title_changed`, `zni_changed`, … |
| `actor_employee_id` | bigint | FK → `employee` |
| `payload` | jsonb | Детали изменения |
| `created_at` | timestamptz | Время |

API: `history[]` в `GET /api/youjail/cards/{id}`.

### youjail_card_link

| Поле | Тип | Описание |
|------|-----|----------|
| `card_id` | bigint | FK → `youjail_card` |
| `related_card_id` | bigint | FK → `youjail_card` (любая доступная доска) |

Связи вручную: поле `relatedCardKeys` — ключи через запятую (`MAIN-1`, `PERSONAL134-2`). Поиск по всем доступным доскам. API: `relatedCardKeys`, `relatedCards` (в т.ч. по общей ЗНИ на той же доске).

### youjail_card_comment

| Поле | Тип | Описание |
|------|-----|----------|
| `card_id` | bigint | FK → `youjail_card` |
| `body_md` | text | Текст комментария (markdown, @упоминания) |
| `author_employee_id` | bigint | FK → `employee` (автор) |
| `author_label` | varchar(255) | Имя, если сотрудник не привязан |
| `created_at`, `updated_at` | timestamptz | Время создания и обновления |

API: `comments[]` в `GET /api/youjail/cards/{id}`; создание: `POST /api/youjail/cards/{id}/comments` (multipart: `body_md`, `files[]`); редактирование: `PATCH /api/youjail/comments/{id}` (`bodyMd`, только автор или админ организации). События `comment_added`, `comment_edited` в `youjail_card_event`. В ответе комментария: `canEdit`.

### youjail_comment_attachment

| Поле | Тип | Описание |
|------|-----|----------|
| `comment_id` | bigint | FK → `youjail_card_comment` |
| `filename` | varchar(512) | Имя файла |
| `storage_path` | text | Путь на диске (`YOUJAIL_WORKSPACE_DIR`) |
| `content_type` | varchar(128) | MIME-тип |
| `size_bytes` | bigint | Размер |

Скачивание: `GET /api/youjail/comment-attachments/{id}/download`. Изображения отображаются inline в UI. При создании комментария с файлом запись также попадает в `youjail_attachment` (общие вложения карточки); при чтении карточки выполняется синхронизация пропущенных файлов.

### youjail_attachment, youjail_execution, youjail_execution_log

Вложения к карточке; запуски исполнителя и построчный лог (`stdout` / `stderr` / `system` / `pty`).

### youjail_team

| Поле | Тип | Описание |
|------|-----|----------|
| `name`, `slug` | varchar | Название и уникальный ключ команды YouJail |
| `boardIds` | int[] | В API (`detailed=true`): id досок, к которым привязана команда |
| `description` | text | Описание |
| `is_active`, `sort_order` | | Активность и порядок в списке |

### youjail_team_member

| Поле | Тип | Описание |
|------|-----|----------|
| `team_id` | bigint | FK → `youjail_team` |
| `employee_id` | bigint | FK → `employee` |
| `role` | varchar(32) | `member` (по умолчанию) |

Уникальность: `(team_id, employee_id)`.

### youjail_board_team

| Поле | Тип | Описание |
|------|-----|----------|
| `board_id` | bigint | FK → `youjail_board` |
| `team_id` | bigint | FK → `youjail_team` |

Связь M:N: доска видна участникам любой из привязанных команд. Без привязанных команд доска доступна только админам. Личные доски (`owner_employee_id IS NOT NULL`) в команды не включаются.

### youjail_tag

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `name` | varchar(128) | Отображаемое имя тега (уникально без учёта регистра) |
| `slug` | varchar(64) | Уникальный slug |
| `color` | varchar(7) | Цвет в формате `#RRGGBB` (как label в Jira) |

### youjail_card_tag

| Поле | Тип | Описание |
|------|-----|----------|
| `card_id` | bigint | FK → `youjail_card` |
| `tag_id` | bigint | FK → `youjail_tag` |

Связь M:N: у карточки может быть несколько тегов. API: `GET/POST /api/youjail/tags`, обновление карточки — поле `tagIds`.

API: префикс `/api/youjail/*`. `DELETE /api/youjail/boards/{id}`, `POST /api/youjail/boards/{id}/pin`, `POST /api/youjail/boards/{id}/columns`, `PATCH /api/youjail/columns/{id}`, `DELETE /api/youjail/columns/{id}?moveToColumnId=…`, `POST/DELETE /api/youjail/boards/{id}/members`, `POST /api/youjail/zni/lookup`, `POST /api/youjail/cards/{id}/comments`, `PATCH /api/youjail/comments/{id}`, `GET /api/youjail/comment-attachments/{id}/download`, `GET/POST/PATCH/DELETE /api/youjail/teams`, `PUT /api/youjail/teams/{id}/boards`, `PUT /api/youjail/boards/{id}/teams`, `GET/POST /api/youjail/tags`. Доступ к доске: админы организации — все; пользователи — команды, личная доска (`owner_employee_id`), прямой доступ (`youjail_board_member`). Управление колонками: глобальный админ, владелец личной доски или `youjail_board_member.role = admin`. WebSocket PTY: `GET /api/youjail/executions/{id}/terminal?X-Session-Id=…`. Fuzzy-поиск: `GET /api/youjail/board?search=…&boardId=…`. CLI: `python backend/scripts/ty.py`.

---

## job_position, team_role, expertise_direction

Справочники должностей, ролей в отделе и направлений экспертизы. Поля: `name`, `sort_order`, `is_active`, timestamps. Таблица `employee_expertise` связывает сотрудника с направлением и уровнем (`level`).

---

## employee_time_off_day — график отпусков

Один день — одна запись. График всей компании видят все авторизованные пользователи; редактирование — только своей строки (админы — любой строки). Вкладка «График отпусков».

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `employee_id` | bigint | FK → `employee` |
| `day` | date | Календарный день |
| `kind` | varchar(32) | `vacation` — отпуск, `dayoff` — отгул, `sick_leave` — больничный, `business_trip` — командировка |

Уникальность: `(employee_id, day)`.

Права редактирования: свой график (`employee_id` = карточка пользователя); админ отделов / PAT / legacy full — любой сотрудник. Просмотр — все активные сотрудники компании.

---

## workspace_place — справочник рабочих мест

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigint | PK |
| `name` | varchar(255) | Название (`Место 23`, `Место 99`, …) |
| `sort_order` | int | Порядок в сетке; номер места |
| `is_active` | boolean | Показывать в брони |

**Начальное наполнение:** миграция `008_workspace_booking.sql` — места **23–53**. Дополнительно миграция `012_workspace_places_99_106.sql` — места **99–106** (идемпотентная вставка по `sort_order`).

См. также [database-overview.md](database-overview.md), [data-dictionary.md](data-dictionary.md).

---

## workspace_booking — бронь места на день

| Поле | Тип | Описание |
|------|-----|----------|
| `place_id` | bigint | FK → `workspace_place` |
| `employee_id` | bigint | FK → `employee` |
| `day` | date | Календарный день |

Уникальность: `(place_id, day)` и `(employee_id, day)` — одно место в день, один сотрудник — одно место в день.

Права: админ / PAT / legacy full — бронь за любого; пользователь — только за себя. Просмотр занятости — все авторизованные.

---

## employee_office_day — дни «в офисе» без места

Самоотметка сотрудника в личном кабинете на случай, когда он работает в офисе, но не бронирует конкретное место (например, сотрудник другого филиала).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `employee_id` | bigint | FK → `employee` |
| `day` | date | Календарный день присутствия в офисе |

Уникальность: `(employee_id, day)`.

Используется вместе с `workspace_booking` во вкладке «Сотрудники в офисе»: если есть бронь — показывается место, если только самоотметка — «в офисе (без места)».

---

## b2b_product_status_office — продуктовые офисы B2B

Вкладки экрана «Статус продукта B2B» (SMS, VOICE, CORE, Аналитики, Проекты и т.д.). Данные таблицы хранятся в PostgreSQL, без Google Sheets.

Seed: миграция `013_b2b_product_status.sql` — SMS, VOICE, Перспективные продукты, M2M / IoT, Продуктовый маркетинг, CORE, CORE (операционка); `030_b2b_product_status_offices_analytics_projects.sql` — Аналитики (`gid=analytics`), Проекты (Саша и Ваня) (`gid=projects`).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `gid` | varchar(32) | Стабильный идентификатор вкладки для API/UI |
| `name` | varchar(255) | Подпись вкладки, напр. «Офис: SMS» |
| `sort_order` | int | Порядок вкладок |
| `is_active` | boolean | Скрыть офис без удаления |

---

## b2b_product_status_row — строка статуса продукта

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `office_id` | bigint | FK → `b2b_product_status_office` |
| `sort_order` | int | Порядок строк на вкладке |
| `cells` | jsonb | Значения колонок (rich-text разметка `product_status_rich_text`) |

Фиксированные ключи в `cells`: «Дата запуска», «Проект координация» (редактируют только админы), «Полное Описание проекта и статус», «Для презентации Описание проекта и статус», «Зачем и для чего делаем» (текст на слайде презентации), «ЗНИ» (несколько номеров через запятую с пробелом, напр. `123456, 789012`), «Идет в презентацию», «Обратить внимание», «Комментарий» (служебный, не в презентацию). Легаси-ключи «Зачем и для чего делаем полное описание» / «…для презентации» при чтении сливаются в «Зачем и для чего делаем» (миграция `016_b2b_product_status_merge_why_columns.sql`).

---

## b2b_product_status_history — история правок статуса продукта

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `row_id` | bigint | FK → `b2b_product_status_row` (nullable после удаления строки) |
| `office_id` | bigint | FK → `b2b_product_status_office` |
| `office_name` | varchar(255) | Снимок названия офиса |
| `action` | varchar(32) | `create`, `update`, `delete`, `restore` |
| `field_name` | varchar(255) | Колонка при `update` |
| `old_value` / `new_value` | text | Значения до/после |
| `changed_by` | varchar(255) | Логин пользователя |
| `changed_at` | timestamptz | Время изменения |

API: `GET /api/product-status/b2b/history?gid=`, `GET /api/product-status/b2b/snapshots?gid=`, `POST /api/product-status/b2b/snapshots/{id}/restore?gid=` — **только админы** (PAT, legacy `app_user` без org, `org_user.role=admin`); сохранение — `POST /api/product-status/b2b/save` (все пользователи с полным доступом), удаление строки — через `deletedRows` в save или `DELETE /api/product-status/b2b/rows/{row_id}?gid=`.

---

## b2b_product_status_snapshot — снимки версий статуса продукта

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `office_id` | bigint | FK → `b2b_product_status_office` |
| `rows` | jsonb | Полный снимок строк офиса: `{"rows": [{"cells": {...}}, ...]}` |
| `changed_by` | varchar(255) | Логин пользователя при сохранении/восстановлении |
| `created_at` | timestamptz | Время снимка |

Снимок создаётся после каждого успешного «Сохранить» и после восстановления версии. В UI вкладки «История» — блок «Версии сохранений» с кнопкой «Восстановить» (кроме текущей версии).

Записи `b2b_product_status_history` и `b2b_product_status_snapshot` старше **28 дней** (настройка `B2B_AUDIT_RETENTION_DAYS`) удаляются при старте backend; строки `b2b_product_status_row` не затрагиваются.

---

## b2b_news_section — вкладки «Новости и запуски»

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `gid` | varchar(32) | Стабильный ключ вкладки (`news`, `launches`) |
| `name` | varchar(255) | Название вкладки («Новости», «Запуски») |
| `sort_order` | int | Порядок вкладок в UI |
| `is_active` | boolean | Активна ли вкладка |

Seed: `news` → «Новости», `launches` → «Запуски».

---

## b2b_news_row — строка новостей или запусков

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `section_id` | bigint | FK → `b2b_news_section` |
| `sort_order` | int | Порядок строки |
| `cells` | jsonb | Значения колонок с rich-text |

Колонки **«Новости»** (`gid=news`): «Дата», «Новость», «Описание».  
Колонки **«Запуски»** (`gid=launches`): «Дата», «Продукт», «Описание».

---

## b2b_news_history / b2b_news_snapshot

Аналогично `b2b_product_status_history` / `b2b_product_status_snapshot`, но для вкладок новостей (`section_id`, `section_name`).

API: `GET /api/b2b-news`, `POST /api/b2b-news/save`, `GET /api/b2b-news/history?gid=`, `GET /api/b2b-news/snapshots?gid=`, `POST /api/b2b-news/snapshots/{id}/restore?gid=`, удаление строки — через `deletedRows` в save.

Данные для слайда «Новости рынка» в презентации берутся из вкладки `gid=news` в БД.

История и снимки версий (`b2b_news_history`, `b2b_news_snapshot`) старше 28 дней удаляются автоматически (см. `B2B_AUDIT_RETENTION_DAYS`); строки `b2b_news_row` не удаляются.

---

## revenue_activity_section — вкладка «Активности по выручкам»

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `gid` | varchar(32) | Стабильный ключ вкладки (`main`) |
| `name` | varchar(255) | Название вкладки |
| `sort_order` | int | Порядок вкладок в UI |
| `is_active` | boolean | Активна ли вкладка |

Seed: `main` → «Активности по выручкам».

---

## revenue_activity_row — строка активностей по выручкам

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | PK |
| `section_id` | bigint | FK → `revenue_activity_section` |
| `sort_order` | int | Порядок строки |
| `cells` | jsonb | Значения колонок с rich-text |

Колонки (`gid=main`): «Активность», «Влияние на базу», «Влияние на выручку», «Влияние на gmc» (числовые), «Комментарий», «Результат» (только чтение — сумма трёх влияний; текстовые значения в числовых колонках в сумму не входят).  
Внизу таблицы — строка **Итого** (суммы по числовым колонкам и Результату).  
Экспорт: `GET/POST /api/revenue-activities/excel` — .xlsx, числовые колонки как числа, строка «Итого».  
Логика редактирования, цветов ячеек, сохранения и отмены — как у «Статус продукта B2B» (`ProductStatusWorkbook`), без офисов, новостей и презентации.

---

## revenue_activity_history / revenue_activity_snapshot

Аналогично `b2b_product_status_history` / `b2b_product_status_snapshot`, но для активностей по выручкам (`section_id`, `section_name`).

API: `GET /api/revenue-activities`, `POST /api/revenue-activities/save`, `GET /api/revenue-activities/history?gid=`, `GET /api/revenue-activities/snapshots?gid=`, `POST /api/revenue-activities/snapshots/{id}/restore?gid=` — история и снимки **только админы**; удаление строки — через `deletedRows` в save или `DELETE /api/revenue-activities/rows/{row_id}?gid=`.

История и снимки (`revenue_activity_history`, `revenue_activity_snapshot`) старше 28 дней удаляются автоматически (см. `B2B_AUDIT_RETENTION_DAYS`); строки `revenue_activity_row` не удаляются.

---

## Вкладка «Отделы» (UI)

| Раздел | API |
|--------|-----|
| Состав | `GET /api/org/departments/{id}/members` |
| Пирамида | `GET /api/org/org-chart?department_id=` — данные сотрудников/отделов; `GET/PUT /api/org/org-chart-layout?scope=company&department_id=` — сохранённая ручная раскладка (PUT только админ); для одного отдела — дерево по составу |
| Сотрудники | `GET/POST/PATCH /api/org/employees`; в пути и @упоминаниях — `public_id` (UUID), числовой `id` в API пока тоже принимается |
| График отпусков | `GET /api/org/vacations?year=&department_id=`, `PUT /api/org/vacations/range` |
| Бронь мест | вкладка «Бронь мест»; `GET /api/org/workspace/bookings?year=&month=`, `PUT /api/org/workspace/bookings/toggle`; справочник: `GET/POST/PATCH/DELETE /api/org/workspace/places` (изменение — админ) |
| Сотрудники в офисе | `GET /api/org/workspace/presence?year=&month=`; учитывает `workspace_booking`, `employee_office_day` и `employee_time_off_day` |
| Личный кабинет | `GET/PATCH /api/profile`, `POST /api/profile/password` |
| Личный кабинет — дни в офисе | `GET /api/profile/office-days?year=&month=`, `PUT /api/profile/office-days/range` (только для привязанного сотрудника) |
