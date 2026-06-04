# reporting — единый учёт задач и отчётность

**Репозиторий:** [github.com/volchonok16/reporting](https://github.com/volchonok16/reporting)

Централизованная платформа для выгрузки задач из **Jira**, **TFS (Azure DevOps)**, **Trello** и **прочих систем** в единую **PostgreSQL**-базу с каноническими полями. На этой базе планируются отчёты в **FineBI**: что сделано, что в работе, время в бэклоге и статусах, загрузка команд, отгрузка по релизам.

## Текущий этап

- Схема БД (`db/schema.sql`) — без тестовых задач
- PlantUML: ER, архитектура, use case (`plantuml/`)
- Документация и план (`docs/`)
- ETL и маппинг полей — следующий этап (после примеров из ваших систем)

## Быстрый старт

| Задача | Файл |
|--------|------|
| Обзор всех таблиц | [docs/database-overview.md](docs/database-overview.md) |
| **Глоссарий: таблицы и поля** | [docs/glossary.md](docs/glossary.md) |
| PlantUML (отрисовка) | [plantuml/database-er.puml](plantuml/database-er.puml), [architecture.puml](plantuml/architecture.puml) |
| Создать БД | [db/schema.sql](db/schema.sql), [scripts/apply-schema.ps1](scripts/apply-schema.ps1) |
| Docker PostgreSQL | `docker compose up -d` |

```bash
git clone https://github.com/volchonok16/reporting.git
cd reporting
docker compose up -d
# или: psql -U taskhub -d taskhub -f db/schema.sql
```

## Структура репозитория

```
reporting/
├── db/schema.sql                 # DDL PostgreSQL
├── plantuml/                     # .puml — ER, архитектура, use case
├── docs/
│   ├── glossary.md               # Глоссарий: таблицы и поля
│   ├── database-overview.md      # Краткий обзор БД
│   ├── plan.md                   # Этапы проекта
│   ├── data-dictionary.md        # Краткая выжимка полей task
│   ├── use-case-diagram.md
│   └── uml-diagram.md
├── scripts/apply-schema.ps1
├── docker-compose.yml
└── README.md
```

## Источники данных

| code | Система |
|------|---------|
| `jira` | Atlassian Jira |
| `tfs` | Azure DevOps / TFS |
| `trello` | Trello |
| `other` | Прочая система |

## Возможности схемы

| Метрика / функция | Таблицы / views |
|-------------------|-----------------|
| Единая задача | `task`, `project`, `source_system` |
| Комментарии | `task_comment` |
| Маппинг полей и статусов | `field_mapping`, `source_status_mapping` |
| Время в статусе и бэклоге | `task_status_duration`, `v_task_backlog_duration` |
| Загрузка команды | `team_workload_snapshot`, `v_team_open_tasks` |
| Релизы | `release`, `v_tasks_by_release` |
| FineBI | views `v_*` |

## Клонирование и разработка

```bash
git clone https://github.com/volchonok16/reporting.git
cd reporting
```

После клонирования примените схему (см. [plantuml/README.md](plantuml/README.md) для диаграмм).

## Лицензия

Проект в разработке. Использование — по согласованию с владельцем репозитория.
