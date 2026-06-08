# reporting — единый учёт задач и отчётность

**Репозиторий:** [github.com/volchonok16/reporting](https://github.com/volchonok16/reporting)

Централизованная платформа для выгрузки задач из **Jira**, **TFS (Azure DevOps)**, **Trello** и **прочих систем** в единую **PostgreSQL**-базу с каноническими полями. Веб-приложение **FastAPI + Vite** выгружает **ЗНИ** (запросы на изменение) и **ошибки** с досок TFS Digital Streams B2b и BE-T2 Team.

## Текущий этап

- Схема БД (`db/schema.sql`) + веб-приложение отчётности
- **Backend:** FastAPI, синхронизация TFS (PAT), экспорт CSV
- **Frontend:** дашборд ЗНИ по макету (фильтры, метрики, таблица)
- PlantUML: ER, архитектура, use case (`plantuml/`)
- Документация (`docs/`)

## Быстрый старт

| Задача | Файл |
|--------|------|
| **Запуск приложения** | `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` |
| **Диаграммы** | [docs/diagrams.md](docs/diagrams.md) |
| Обзор всех таблиц | [docs/database-overview.md](docs/database-overview.md) |
| **Глоссарий** | [docs/glossary.md](docs/glossary.md) |
| Docker | [docs/docker.md](docs/docker.md) |

```bash
git clone https://github.com/volchonok16/reporting.git
cd reporting
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

- UI: http://localhost:5173
- API: http://localhost:8000/api/health

Подключение снаружи (порт `5432`):

| Пользователь | Права | Строка подключения |
|--------------|-------|-------------------|
| `alex` | Полный доступ | `postgresql://alex:alex@localhost:5432/reporting` |
| `ivan` | Полный доступ | `postgresql://ivan:ivan@localhost:5432/reporting` |

Пароли: `.env.example` → `.env`

## Структура репозитория

```
reporting/
├── backend/                      # FastAPI: TFS sync, отчёты, экспорт
├── frontend/                     # Vite + React: дашборд ЗНИ
├── db/schema.sql                 # DDL PostgreSQL
├── db/migrations/                # Миграции (auth_session и др.)
├── plantuml/                     # ER, архитектура, use case
├── docs/                         # Глоссарий, docker, диаграммы
├── docker-compose.yml            # postgres + backend + frontend
├── docker-compose.dev.yml        # порты для локальной разработки
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
