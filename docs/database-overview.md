# Обзор базы данных reporting

Документ для просмотра **структуры без тестовых данных**. DDL: `db/schema.sql`. Диаграммы: [diagrams.md](diagrams.md).

**Глоссарий:** [glossary.md](glossary.md) · **Команды:** [teams.md](teams.md)

## Источники (source_system)

| code | name |
|------|------|
| jira | Atlassian Jira |
| tfs | Azure DevOps / TFS |
| trello | Trello |
| other | Прочая система |

## Команды (team)

Единый справочник для фильтрации. **Пустой при создании БД** — команды добавляет ETL (по доске, тегу, area path и т.д.).

| Где хранится | Поле | Назначение |
|--------------|------|------------|
| Справочник | `team` | Канонические команды |
| Задача | `task.team_id` | **Основной фильтр** в FineBI |
| Задача | `task.source_team` | Сырое значение из API |
| Проект | `project.team_id` | Команда по умолчанию для доски |
| Правила ETL | `source_team_mapping` | Доска / тег / area → команда |

Подробно: [teams.md](teams.md).

## Таблицы (22) + представления (4)

### Справочники и маппинг

| Таблица | Назначение |
|---------|------------|
| `source_system` | Jira, TFS, Trello, other |
| `canonical_status` | Единые статусы |
| `source_status_mapping` | Статус источника → канонический статус |
| `source_team_mapping` | Признак источника → команда (`team_id`) |
| `field_mapping` | Поле источника → поле `task` |
| `team` | Канонические команды (заполняет ETL) |
| `person` | Человек |
| `person_external` | ID пользователя в Jira/TFS/Trello |

### Проект и релиз

| Таблица | Назначение | Trello |
|---------|------------|--------|
| `project` | Проект (+ `team_id` по умолчанию) | Board |
| `release` | Версия / релиз | — |

### Задача

| Таблица | Назначение | Trello |
|---------|------------|--------|
| `task` | Задача (+ `team_id`, `source_team`) | Card |
| `task_release` | Несколько релизов на задачу | — |
| `task_comment` | Комментарии | Comment |
| `task_assignee_history` | Смена исполнителя | Member |

### Время и статусы

| Таблица | Назначение |
|---------|------------|
| `task_status_history` | Событие смены статуса |
| `task_status_duration` | Интервал в статусе |
| `task_status_duration_agg` | Сумма по статусу |

### Синхронизация и загрузка

| Таблица | Назначение |
|---------|------------|
| `sync_run` | Запуск выгрузки |
| `sync_run_log` | Лог |
| `team_workload_snapshot` | Снимок загрузки **по команде** |

### Представления (FineBI)

| View | Назначение | Команда |
|------|------------|---------|
| `v_task_backlog_duration` | Время в бэклоге | `team_code`, `team_name` |
| `v_task_status_time` | Время в статусе | `team_code`, `team_name` |
| `v_team_open_tasks` | Открытые задачи | `team_id`, `team_code`, `team_name` |
| `v_tasks_by_release` | Задачи по релизу | `team_code`, `team_name` |

## Ключевые поля `task`

| Поле | Смысл |
|------|--------|
| `source_system_id` + `external_id` | Уникальность в источниках |
| `team_id` | Каноническая команда (фильтр отчётов) |
| `source_team` | Команда из API до маппинга |
| `title`, `description` | Текст |
| `canonical_status_id`, `source_status` | Статус |
| `start_date`, `due_date`, `release_date` | Даты |
| `story_points`, `*_hours` | Оценки |
| `assignee_id`, `reporter_id` | Люди |
| `extra_json` | Немапленные поля |

## Связи

```
team ← task.team_id
team ← project.team_id
team ← source_team_mapping.team_id
source_system → source_team_mapping
source_system → project → task
task → task_comment, task_status_*, team (через team_id)
```

## Развёртывание

```bash
docker-compose up -d          # новая БД — схема с командами сразу
# или миграция:
# psql ... -f db/migrations/002_add_team_to_task.sql
```

См. [docker.md](docker.md).
