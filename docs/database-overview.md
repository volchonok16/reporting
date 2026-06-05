# Обзор базы данных reporting

Документ для просмотра **структуры без тестовых данных**. DDL: `db/schema.sql`. Диаграммы PlantUML: `plantuml/`.

**Глоссарий (описание каждой таблицы и поля):** [glossary.md](glossary.md)

## Источники (source_system)

| code | name |
|------|------|
| jira | Atlassian Jira |
| tfs | Azure DevOps / TFS |
| trello | Trello |
| other | Прочая система |

Новый источник добавляется строкой в `source_system`, схему менять не нужно.

## Таблицы (21) + представления (4)

### Справочники и маппинг

| Таблица | Назначение |
|---------|------------|
| `source_system` | Jira, TFS, Trello, other |
| `canonical_status` | Единые статусы (backlog, in_progress, done, …) |
| `source_status_mapping` | Статус источника → канонический статус |
| `field_mapping` | Поле источника → поле `task` (заполните позже) |
| `team` | Команда |
| `person` | Человек |
| `person_external` | ID пользователя в Jira/TFS/Trello |

### Проект и релиз

| Таблица | Назначение | Trello |
|---------|------------|--------|
| `project` | Проект в источнике | Board |
| `release` | Версия / релиз / milestone | — (по маппингу) |

### Задача

| Таблица | Назначение | Trello |
|---------|------------|--------|
| `task` | Единая карточка/задача (+ `team_id`) | Card |
| `source_team_mapping` | Правила: доска/тег → команда | — |
| `task_release` | Задача в нескольких релизах | — |
| `task_comment` | Комментарии | Comment |
| `task_assignee_history` | Смена исполнителя | Member |

### Время и статусы

| Таблица | Назначение |
|---------|------------|
| `task_status_history` | Событие смены статуса |
| `task_status_duration` | Интервал в статусе (секунды) |
| `task_status_duration_agg` | Сумма по статусу на задачу |

**Бэклог:** интервалы, где `canonical_status.category = 'backlog'`.

### Синхронизация и загрузка команды

| Таблица | Назначение |
|---------|------------|
| `sync_run` | Запуск выгрузки |
| `sync_run_log` | Лог запуска |
| `team_workload_snapshot` | Снимок: бэклог, active, отгрузка в релиз |

### Представления (FineBI)

| View | Назначение |
|------|------------|
| `v_task_backlog_duration` | Сколько в бэклоге |
| `v_task_status_time` | Сколько в каждом статусе |
| `v_team_open_tasks` | Открытые задачи по команде |
| `v_tasks_by_release` | Задачи по релизу |

## Ключевые поля `task` (единая модель)

| Поле | Тип | Смысл |
|------|-----|--------|
| `source_system_id` + `external_id` | | Уникальность в мире источников |
| `title`, `description` | | Текст задачи |
| `canonical_status_id` | | Наш статус |
| `source_status` | | Как в Jira/TFS/Trello (List name) |
| `start_date`, `due_date`, `release_date` | date | Даты |
| `created_at`, `resolved_at`, `closed_at` | timestamptz | Жизненный цикл |
| `story_points`, `*_hours` | numeric | Оценки |
| `assignee_id`, `reporter_id` | FK | Люди |
| `release_id`, `sprint_name`, `iteration_path` | | Релиз / итерация |
| `extra_json` | jsonb | Немапленные поля до настройки ETL |

## Связи (кратко)

```
source_system → project → task
source_system → task (напрямую)
task → task_comment, task_status_*, task_assignee_history
task ↔ release (task_release)
team → project
canonical_status → task, task_status_duration
field_mapping, source_status_mapping → source_system
```

## Создать БД на машине

1. Установите PostgreSQL 14+ или запустите Docker Desktop → `docker compose up -d`
2. Выполните: `psql -U reporting -d reporting -f db/schema.sql`
3. Или скрипт: `.\scripts\apply-schema.ps1`

После создания пустые таблицы — только справочники `source_system` и `canonical_status` с начальными строками (без задач).
