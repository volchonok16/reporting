# План проекта: единая система учёта задач

## Цель

Собирать задачи из **Jira**, **TFS**, **Trello** и **прочих систем** в **единую PostgreSQL-базу** с каноническими полями. Веб-приложение **reporting** выгружает **ЗНИ** и **ошибки** с досок TFS; визуализация — дашборд (Vite) и опционально **FineBI**.

## Этапы

| Этап | Содержание | Статус |
|------|------------|--------|
| 0 | Схема БД, use case, UML, план | Готово |
| 1 | Веб-приложение ЗНИ (FastAPI + Vite, TFS sync, экспорт, PAT) | **Готово** |
| 1b | Production: nginx + certbot, pallink.fun | **Готово** |
| 2 | Маппинг полей Jira → каноническая модель | Ожидает примеров данных |
| 3 | Маппинг команд (`source_team_mapping`): доска, тег, area | Частично (доски TFS) |
| 4 | Расчёт `task_status_duration` из changelog | После ETL |
| 5 | Снимки `team_workload_snapshot` (cron) | После данных |
| 6 | Дашборды FineBI на views и таблицах | Опционально |
| 7 | Метрика «Запущено» — правила подсчёта | TBD |

## Каноническая модель (единые поля)

Независимо от источника в таблице `task` используются одни имена:

| Поле | Назначение |
|------|------------|
| `external_id` | ID/ключ в источнике (PROJ-123, WI id) |
| `title`, `description` | Название и описание |
| `task_type`, `priority` | Тип (`change_request`, `error`) и приоритет |
| `parent_task_id` | Ошибка → ЗНИ |
| `canonical_status_id` + `source_status` | Единый статус + сырой из системы |
| `start_date`, `due_date`, `release_date` | Начало, дедлайн, релиз |
| `created_at`, `resolved_at`, `closed_at` | Жизненный цикл |
| `story_points`, `*_hours` | Оценки |
| `release_id`, `sprint_name`, `iteration_path` | Релиз и итерация |
| `assignee_id`, `reporter_id` | Люди |
| `team_id`, `source_team` | Каноническая команда и сырое значение |
| `extra_json` | `area_path`, `board_column` и немапленные поля |

Маппинг: `field_mapping`, `source_status_mapping`, `source_team_mapping`. Подробно: [teams.md](teams.md), [glossary.md](glossary.md).

## Метрики

### Веб-дашборд ЗНИ

1. **Всего задач** — ЗНИ (`change_request`) по доске.
2. **Скоро запуск** — `release_date` / `TargetDate`.
3. **Запущено** — заглушка; логика уточняется.
4. **Ошибок** — `error` с `parent_task_id` на ЗНИ.

### BI (FineBI)

1. **Время в бэклоге** — `v_task_backlog_duration`.
2. **Время в статусе** — `v_task_status_time`.
3. **Загрузка команды** — `v_team_open_tasks`, `team_workload_snapshot`.
4. **Отгрузка в релиз** — `v_tasks_by_release`.

## Роли (use case)

- **Аналитик** — дашборд ЗНИ, синхронизация, экспорт CSV; отчёты FineBI.
- **Sync Service** (backend) — WIQL + batch TFS, запись в `task`, аудит `sync_run`.
- **Администратор** — справочники, маппинг статусов и полей.

## Следующие шаги

1. Уточнить правила метрики **«Запущено»**.
2. При необходимости — маппинг Jira по примерам полей.
3. Расчёт `task_status_duration` при полном ETL changelog.

Диаграммы: [diagrams.md](diagrams.md) · Production: [deploy/DEPLOY.md](../deploy/DEPLOY.md).
