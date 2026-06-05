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
| **Диаграммы (схема в браузере)** | [**docs/diagrams.md**](docs/diagrams.md) — Mermaid на GitHub без PlantUML |
| Обзор всех таблиц | [docs/database-overview.md](docs/database-overview.md) |
| **Глоссарий: таблицы и поля** | [docs/glossary.md](docs/glossary.md) |
| **Команды (поля + ETL)** | [docs/teams.md](docs/teams.md) |
| PlantUML SVG | [docs/diagrams/svg/](docs/diagrams/svg/) (авто при push) |
| Создать БД | [db/schema.sql](db/schema.sql), [scripts/apply-schema.ps1](scripts/apply-schema.ps1) |
| Docker PostgreSQL | `docker compose up -d` → [docs/docker.md](docs/docker.md) |

```bash
git clone https://github.com/volchonok16/reporting.git
cd reporting
docker compose up -d
```

Подключение снаружи (порт `5432`):

| Пользователь | Права | Строка подключения |
|--------------|-------|-------------------|
| `alex` | Полный доступ | `postgresql://alex:alex@localhost:5432/reporting` |
| `ivan` | Полный доступ | `postgresql://ivan:ivan@localhost:5432/reporting` |

Пароли: `.env.example` → `.env`

## Структура репозитория

```
reporting/
├── db/schema.sql                 # DDL PostgreSQL
├── plantuml/                     # .puml — ER, архитектура, use case
├── docs/
│   ├── diagrams.md               # Все диаграммы (Mermaid в браузере)
│   ├── diagrams/svg/             # PlantUML → SVG (GitHub Actions)
│   ├── glossary.md               # Глоссарий: таблицы и поля
│   ├── teams.md                  # Команды: team_id, маппинг, FineBI
│   ├── database-overview.md      # Краткий обзор БД
│   ├── plan.md                   # Этапы проекта
│   ├── data-dictionary.md        # Краткая выжимка полей task
│   ├── use-case-diagram.md
│   └── uml-diagram.md
├── db/init-users.sh            # ETL + BI пользователи (Docker init)
├── scripts/apply-schema.ps1
├── docker-compose.yml
├── .env.example
├── .cursor/rules/                # Правила Cursor (глоссарий + push)
├── docs/docker.md
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

## Правила для Cursor (AI)

В `.cursor/rules/glossary-and-git.mdc`: при изменениях БД агент дополняет **глоссарий** и связанные docs, затем делает **commit + push** в GitHub.

## Клонирование и разработка

```bash
git clone https://github.com/volchonok16/reporting.git
cd reporting
```

Диаграммы: [docs/diagrams.md](docs/diagrams.md) · БД: `docker compose up -d`

## Лицензия

Проект в разработке. Использование — по согласованию с владельцем репозитория.
