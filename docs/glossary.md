# Глоссарий базы данных reporting

Описание **всех таблиц**, **полей** и **представлений** единой PostgreSQL-базы. Имена полей одинаковы для задач из Jira, TFS, Trello и прочих систем; сырые значения источника хранятся отдельно там, где это указано.

**Связанные документы:** [teams.md](teams.md) · [database-overview.md](database-overview.md) · [data-dictionary.md](data-dictionary.md) · DDL: [../db/schema.sql](../db/schema.sql)

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

**Миграции схемы** выполняются от пользователя `reporting` (владелец таблиц), не от `alex`/`ivan`. См. [docker.md](docker.md).

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

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | varchar(64) | Идентификатор сессии |
| `payload` | jsonb | `base_url`, `project`, `pat` и др. (не отдаётся в API) |
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

**Планируемая дата** — из листа `System.IterationPath`: `2026.08.11.0-R` → `2026-08-11`; если в пути есть **TBD** — в UI выводится `TBD`. **План квартала** — `Q3 2026` или `TBD`; фильтр `quarter` в API (`TBD`, `2026-Q3`, …). **Плановый релиз** — из `Logrocon.FoundinRelease` или `Logrocon.Release`, если поле проставлено или релиз привязан; колонка «План. релиз» в дашборде и CSV.

**Доски приложения:** Digital Streams B2b (`Tele2\Digital\Streams\B2b`, ЗНИ/ошибки с тегом `EFO` не выгружаются, ошибки с `FE B2B` или `microservice`); BE Analytics (`BE-T2\BE Analytics`, ЗНИ с `b2b_product`, ошибки с `FE B2B` или `microservice`, статус `Rejected` не выгружается).

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

Дашборд ЗНИ: FastAPI + Vite, домен production — **pallink.fun**.

| Компонент | Путь / URL | Назначение |
|-----------|------------|------------|
| Frontend | `frontend/`, `https://pallink.fun` | React UI: вход (логин/PAT), дашборд, экспорт |
| Backend | `backend/`, `https://api.pallink.fun` | REST API, TFS sync, сессии |
| nginx | `deploy/nginx/` | HTTPS, reverse proxy на :5173 и :8000 |
| certbot | `scripts/production.sh` | Let's Encrypt для pallink.fun |

Аутентификация: `POST /api/auth/login` — **PAT** (свой токен) или **логин/пароль** приложения (`APP_AUTH_USERS`, выгрузка через `TFS_SYNC_PAT`) → `auth_session` → `X-Session-Id`. Секреты TFS не отдаются клиенту.

### Метрики дашборда

| Метрика | Условие подсчёта |
|---------|------------------|
| **Всего задач** | `task_type = change_request`, фильтр по доске (`extra_json.area_path` / `team_id`) |
| **Скоро запуск** | Digital Streams B2b: статус workflow `UAT`; BE Analytics: `release_date` (`TargetDate`) в окне `LAUNCHING_SOON_DAYS` |
| **Запущено** | Digital Streams B2b: статус `Pilot` / `Пилот`; BE Analytics: переход в пилот в выбранном периоде дат (`extra_json.pilot_transitions`) |
| **Ошибок** | `task_type = error`, `parent_task_id` → ЗНИ той же доски |

### Синхронизация TFS (оптимизация)

| Параметр `.env` | По умолчанию | Назначение |
|-----------------|--------------|------------|
| `TFS_FETCH_ALL_FIELDS` | `false` | Не запрашивать все поля |
| `TFS_FETCH_RELATIONS` | `false` | Не использовать `$expand` Relations на ЗНИ |
| `TFS_BATCH_SIZE` | `200` | Размер batch workItems |
| `TFS_LINKED_BATCH_SIZE` | `200` | Порция ошибок (лимит TFS workItemsBatch = 200) |
| `TFS_EXCLUDE_CLOSED_OLDER_THAN_DAYS` | `365` | Пропуск Closed ЗНИ старше N дней |
| `TFS_CLOSED_STATE_VALUES` | `Closed` | Статусы для фильтра |

Алгоритм: WIQL по AreaPath → `workItemsBatch` (поля) → WIQL `WorkItemLinks` (ЗНИ→Ошибка) → batch ошибок → upsert в `task`.

### REST API

| Endpoint | Описание |
|----------|----------|
| `POST /api/auth/login` | `{ pat, base_url?, project? }` → `{ sessionId }` |
| `GET /api/dashboard?board=` | Метрики + список ЗНИ |
| `POST /api/sync` | Синхронизация; body `{ board }` |
| `GET /api/sync/status` | Статус и прогресс |
| `GET /api/export/csv?board=` | CSV: ЗНИ + ошибки |

Диаграммы: [diagrams.md](diagrams.md) · Production: [deploy/DEPLOY.md](../deploy/DEPLOY.md).
