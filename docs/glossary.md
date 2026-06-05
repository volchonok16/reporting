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
| **Каноническая команда** | Единая команда из справочника `team` (`digital`, `berkhut`) |
| **Сырой статус** | Статус как в источнике (`task.source_status`, список Trello, State в TFS) |
| **Сырая команда** | Значение до нормализации (`task.source_team`: доска, тег, area) |
| **Категория статуса** | Группа для отчётов: `backlog`, `active`, `waiting`, `done`, `cancelled` |
| **Внешний ID** | Идентификатор задачи/комментария в исходной системе |
| **ETL** | Процесс выгрузки и записи данных (будущий; аудит в `sync_run`) |

---

## Команды — краткий обзор

Подробно: **[teams.md](teams.md)**.

| Сущность | Назначение |
|----------|------------|
| `team` | Справочник команд (`digital`, `berkhut`, …) |
| `task.team_id` | **Главное поле** для фильтрации в отчётах |
| `task.source_team` | Сырое значение из API |
| `project.team_id` | Команда по умолчанию для доски/проекта |
| `source_team_mapping` | Правила: доска / тег / area → `team_id` |

Одна команда Digital может объединять задачи из Jira и TFS. Определение команды в ETL — по правилам `source_team_mapping` (доска, тег и т.д.; логика в скрипте).

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

Единый справочник команд для фильтрации в отчётах. Одна команда **Digital** может включать задачи и из Jira, и из TFS. Предзаполнены: `digital`, `berkhut`.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | bigserial | Первичный ключ |
| `code` | varchar(64) | Уникальный код: `digital`, `berkhut` |
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

**Пример (позже в ETL):** Jira + `board_name` = `Digital Board` → `digital`; TFS + `area_path` содержит `Berkhut` → `berkhut`.

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
| `team_id` | bigint | Каноническая команда (`digital`, `berkhut`) — основное поле для фильтрации |
| `parent_task_id` | bigint | Родительская задача (epic → story, подзадачи) |

### Содержание

| Поле | Тип | Описание |
|------|-----|----------|
| `title` | varchar(1000) | Заголовок задачи |
| `description` | text | Полное описание |
| `task_type` | varchar(64) | Тип: `story`, `bug`, `epic`, `task`, `feature` и т.д. (после нормализации) |
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
| `team_code` | Код канонической команды (`digital`, `berkhut`) |
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
