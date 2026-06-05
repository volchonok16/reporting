# Команды (team): модель и маппинг

Как в единой БД `reporting` хранятся команды **Digital**, **Berkhut** и другие, откуда они берутся в Jira/TFS/Trello и как по ним фильтровать в отчётах и FineBI.

**См. также:** [glossary.md](glossary.md) · [database-overview.md](database-overview.md) · DDL: [../db/schema.sql](../db/schema.sql)

---

## Зачем нужно поле команды

Из разных систем загружаются задачи **нескольких команд**. Одна и та же каноническая команда может приходить из разных источников:

| Источник | Пример |
|----------|--------|
| Jira | задачи команды Digital |
| TFS | задачи команды Digital |
| TFS | задачи команды Berkhut |
| Jira + TFS | обе системы отдают Digital — в отчёте одна команда `digital` |

В отчётах нужен **единый фильтр** по команде, независимо от того, откуда пришла задача.

---

## Три уровня хранения

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  team           │     │  task                │     │  source_team    │
│  (справочник)   │◄────│  team_id             │     │  (сырое знач.)  │
│  digital        │     │  source_team         │     │  из API         │
│  berkhut        │     └──────────────────────┘     └─────────────────┘
└─────────────────┘              ▲
         ▲                         │
         │              ┌──────────┴───────────┐
         │              │ source_team_mapping  │
         └──────────────│ правила ETL          │
                        │ доска / тег / area   │
                        └──────────────────────┘
```

| Уровень | Таблица / поле | Роль |
|---------|----------------|------|
| **Канон** | `team` | Справочник: `code` = `digital`, `berkhut` |
| **Задача** | `task.team_id` | Главное поле для фильтрации в BI |
| **Сырьё** | `task.source_team` | Что пришло из API до нормализации |
| **Правила** | `source_team_mapping` | Как ETL определяет `team_id` |
| **Проект** | `project.team_id` | Команда по умолчанию для доски/проекта (fallback) |

---

## Справочник `team`

Предзаполненные команды (можно добавлять новые):

| code | name | Описание |
|------|------|----------|
| `digital` | Digital | Команда Digital |
| `berkhut` | Berkhut | Команда Berkhut |

Добавление новой команды:

```sql
INSERT INTO team (code, name) VALUES ('nova', 'Nova Team');
```

`code` — стабильный ключ для фильтров в FineBI. `name` — отображаемое имя.

---

## Поля на задаче `task`

| Поле | Тип | Обязательность | Описание |
|------|-----|----------------|----------|
| `team_id` | bigint FK → `team` | Заполняет ETL | **Каноническая команда** — используйте в отчётах |
| `source_team` | varchar(255) | Опционально | Строка из источника: имя доски, тег, area, component |

**Логика ETL (будущий скрипт):**

1. Прочитать признаки задачи (доска, тег, area path, project key).
2. Найти правило в `source_team_mapping` (с учётом `priority`).
3. Записать `team_id` и при необходимости `source_team`.
4. Если правило не сработало — взять `project.team_id` как fallback.

**Приоритет команды на задаче:**

```
task.team_id  →  если NULL, то project.team_id
```

Так же работают views (`COALESCE(t.team_id, pr.team_id)`).

---

## Таблица `source_team_mapping`

Правила сопоставления признака источника с канонической командой. Заполняется администратором или через миграции **до/вместе с** ETL.

| Поле | Описание |
|------|----------|
| `source_system_id` | Jira / TFS / Trello / other |
| `team_id` | Целевая команда в `team` |
| `match_type` | Тип признака (см. ниже) |
| `match_value` | Значение для сравнения |
| `is_regex` | Искать по регулярному выражению |
| `project_external_key` | Ограничить правило одним проектом |
| `priority` | При нескольких совпадениях побеждает большее значение |
| `is_active` | Включено ли правило |
| `notes` | Пояснение для людей |

### Типы `match_type`

| match_type | Где встречается | Что сравнивается |
|------------|-----------------|------------------|
| `board_name` | Jira, Trello | Название доски / board |
| `project_key` | Jira | Ключ проекта (`PROJ`) |
| `tag` | Jira, TFS | Тег / Tag |
| `label` | Jira | Label |
| `component` | Jira | Component |
| `area_path` | TFS | `System.AreaPath` |
| `iteration_path` | TFS | `System.IterationPath` |

Конкретные правила и значения задаются позже в скрипте загрузки или вручную в БД.

### Пример структуры правил (шаблон, без ваших данных)

```sql
-- Jira: доска с именем, содержащим Digital → digital
INSERT INTO source_team_mapping
  (source_system_id, team_id, match_type, match_value, is_regex, priority, notes)
SELECT ss.id, t.id, 'board_name', 'Digital', FALSE, 10, 'Jira board Digital'
FROM source_system ss, team t
WHERE ss.code = 'jira' AND t.code = 'digital';

-- TFS: area path содержит Berkhut
INSERT INTO source_team_mapping
  (source_system_id, team_id, match_type, match_value, is_regex, priority, notes)
SELECT ss.id, t.id, 'area_path', 'Berkhut', FALSE, 10, 'TFS area Berkhut'
FROM source_system ss, team t
WHERE ss.code = 'tfs' AND t.code = 'berkhut';
```

---

## `project.team_id`

Команда **по умолчанию** для всех задач проекта/доски, если на уровне задачи `team_id` не определён.

| Ситуация | Что использовать |
|----------|------------------|
| Вся доска Jira = одна команда | `project.team_id` при создании проекта |
| Команда разная по задачам | `task.team_id` + `source_team_mapping` |
| Смешанный режим | ETL пишет `task.team_id`; fallback — `project.team_id` |

---

## Отчётность и FineBI

Во views уже есть поля команды:

| View | Поля команды |
|------|----------------|
| `v_team_open_tasks` | `team_id`, `team_code`, `team_name` |
| `v_task_status_time` | `team_code`, `team_name` |
| `v_task_backlog_duration` | `team_code`, `team_name` |
| `v_tasks_by_release` | `team_code`, `team_name` |

**Фильтр в FineBI:** `team_code IN ('digital', 'berkhut')` или `team_name = 'Digital'`.

**Загрузка команды:** `team_workload_snapshot.team_id` — снимки по команде (бэклог, active, отгрузка в релиз).

---

## Миграция на сервере

Если БД создана до появления полей команды:

```bash
git pull
docker-compose exec -T postgres psql -U alex -d reporting < db/migrations/002_add_team_to_task.sql
```

Проверка:

```sql
SELECT code, name FROM team;
SELECT column_name FROM information_schema.columns
WHERE table_name = 'task' AND column_name IN ('team_id', 'source_team');
```

---

## Связь с другими маппингами

| Маппинг | Аналогия |
|---------|----------|
| `source_status_mapping` | статус источника → `canonical_status` |
| `field_mapping` | поле API → колонка `task` |
| **`source_team_mapping`** | **признак источника → `team`** |

Все три настраиваются до или вместе с ETL; логика определения команды **в скрипте загрузки**, правила — в БД.
