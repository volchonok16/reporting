# План проекта: единая система учёта задач

## Цель

Собирать задачи из **Jira**, **TFS**, **Trello** и **прочих систем** в **единую PostgreSQL-базу** с каноническими полями, чтобы строить отчётность: что сделано, что в работе, сроки, релизы, загрузка команд. Визуализация — **FineBI** (и при необходимости другие BI-инструменты).

## Этапы

| Этап | Содержание | Статус |
|------|------------|--------|
| 0 | Схема БД, use case, UML, план | **Текущий** |
| 1 | Маппинг полей Jira → каноническая модель | Ожидает примеров данных |
| 1b | Маппинг команд (`source_team_mapping`): доска, тег, area | Ожидает правил из скрипта |
| 2 | Маппинг полей TFS → каноническая модель | Ожидает примеров данных |
| 3 | ETL/синхронизация (API, расписание, `sync_run`) | После маппинга |
| 4 | Расчёт `task_status_duration` из changelog | После ETL |
| 5 | Снимки `team_workload_snapshot` (cron) | После данных |
| 6 | Дашборды FineBI на views и таблицах | После наполнения |

## Каноническая модель (единые поля)

Независимо от источника в таблице `task` используются одни имена:

| Поле | Назначение |
|------|------------|
| `external_id` | ID/ключ в источнике (PROJ-123, WI id) |
| `title`, `description` | Название и описание |
| `task_type`, `priority` | Тип и приоритет (после нормализации) |
| `canonical_status_id` + `source_status` | Единый статус + сырой из системы |
| `start_date`, `due_date`, `release_date` | Начало, дедлайн, релиз |
| `created_at`, `resolved_at`, `closed_at` | Жизненный цикл |
| `story_points`, `*_hours` | Оценки |
| `release_id`, `sprint_name`, `iteration_path` | Релиз и итерация |
| `assignee_id`, `reporter_id` | Люди |
| `team_id`, `source_team` | Каноническая команда и сырое значение (Digital, Berkhut, …) |
| `extra_json` | Временное хранение немапленных полей |

Маппинг настраивается в `field_mapping`, `source_status_mapping` и `source_team_mapping`. Подробно о командах: [teams.md](teams.md).

## Метрики времени и загрузки

1. **Время в бэклоге** — сумма интервалов `task_status_duration`, где `canonical_status.category = 'backlog'` (view `v_task_backlog_duration`).
2. **Время в любом статусе** — строки `task_status_duration` / view `v_task_status_time`.
3. **Загрузка команды** — фильтр по `task.team_id` / `team.code`; view `v_team_open_tasks` + `team_workload_snapshot`.
4. **Отгрузка в релиз** — `task.release_id`, `task_release`, view `v_tasks_by_release`.

## Роли (для use case)

- **Аналитик / менеджмент** — отчёты, FineBI, снимки загрузки.
- **ETL-сервис** (будущий) — выгрузка из Jira/TFS, запись в БД.
- **Администратор** — справочники, маппинг статусов и полей.

## Следующий шаг от вас

Пришлите примеры полей из Jira и TFS (скрин, JSON или список имён) — заполним `field_mapping` и `source_status_mapping`, затем спроектируем загрузку.
