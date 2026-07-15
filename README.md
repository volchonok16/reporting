# reporting — единый учёт задач и отчётность

**Репозиторий:** [github.com/volchonok16/reporting](https://github.com/volchonok16/reporting)

Централизованная платформа для выгрузки задач из **Jira**, **TFS (Azure DevOps)**, **Trello** и **прочих систем** в единую **PostgreSQL**-базу. Веб-приложение **FastAPI + Vite** — workbook: **ЗНИ**, **Статус продукта B2B** (включая генерацию PPTX), **Планы Digital**, **Доска YouJail**, **Staffing** (отпуска, бронь мест, офис, оргсхема), **Диаграммы**.

## Текущий этап

- Схема БД (`db/schema.sql` + миграции) и полный workbook
- **Backend:** FastAPI — TFS sync, org/staffing, YouJail, B2B status + PPTX, roadmap
- **Frontend:** вкладки workbook + личный кабинет
- PlantUML / Mermaid: ER, архитектура, use case (`plantuml/`, `docs/diagrams.md`)
- Документация (`docs/`)

## Быстрый старт

| Задача | Файл |
|--------|------|
| **Запуск приложения** | `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` |
| **Диаграммы** | [docs/diagrams.md](docs/diagrams.md) |
| **Confluence** | [docs/confluence.md](docs/confluence.md) + `docs/diagrams/png/` |
| Обзор всех таблиц | [docs/database-overview.md](docs/database-overview.md) |
| **Глоссарий** | [docs/glossary.md](docs/glossary.md) |
| **Пробелы в docs** | [docs/documentation-gaps.md](docs/documentation-gaps.md) |
| Docker | [docs/docker.md](docs/docker.md) |

```bash
git clone https://github.com/volchonok16/reporting.git
cd reporting
bash scripts/dev.sh
```

- UI: http://localhost:5173
- API: http://localhost:8000/api/health

### Production (nginx + certbot)

```bash
cp .env.production.example .env
# CERTBOT_EMAIL=you@example.com
sudo bash scripts/production.sh   # первый раз: nginx + certbot + Docker
```

**Обновление на сервере** (git pull + пересборка + туннель PostgreSQL):

```bash
bash scripts/up.sh prod
# то же: bash scripts/prod.sh
```

Подробнее: [deploy/DEPLOY.md](deploy/DEPLOY.md)

Подключение снаружи (порт `5432`):

| Пользователь | Права | Строка подключения |
|--------------|-------|-------------------|
| `alex` | Полный доступ | `postgresql://alex:alex@localhost:5432/reporting` |
| `ivan` | Полный доступ | `postgresql://ivan:ivan@localhost:5432/reporting` |

Пароли: `.env.example` → `.env`

## Структура репозитория

```
reporting/
├── backend/                      # FastAPI: TFS, org, youjail, B2B+PPTX, roadmap
├── frontend/                     # Vite + React: workbook (6 вкладок)
├── deploy/                       # nginx, certbot, production-скрипты
├── db/schema.sql                 # DDL PostgreSQL
├── db/migrations/                # Миграции (org, youjail, b2b, …)
├── plantuml/                     # ER, архитектура, use case
├── docs/                         # Глоссарий, docker, диаграммы
├── scripts/                      # dev.sh, production.sh, migrate.sh
├── docker-compose.yml            # postgres + backend + frontend + MinIO
├── docker-compose.dev.yml        # порты для локальной разработки
├── docker-compose.prod.yml       # bind 127.0.0.1 для nginx / MinIO
└── README.md
```

## Источники данных

| code | Система |
|------|---------|
| `jira` | Atlassian Jira |
| `tfs` | Azure DevOps / TFS |
| `trello` | Trello |
| `other` | Прочая система |

## Возможности

| Функция | Реализация |
|---------|------------|
| Дашборд ЗНИ | Frontend + `GET /api/dashboard` |
| Синхронизация TFS | WIQL + batch, доски Digital / B2B / BE / ESB |
| Экспорт CSV | ЗНИ + связанные ошибки |
| Статус продукта B2B | таблицы офисов/строк; новости |
| Генерация презентаций PPTX | `GET/POST /api/product-status/b2b/presentation` + `assets/Status.pptx` |
| Планы Digital | roadmap priority/comment в `extra_json` |
| Доска YouJail | `/api/youjail/*`; файлы в `YOUJAIL_WORKSPACE_DIR` |
| MinIO | фото сотрудников, bucket `photos` (`minio` + `minio-init`) |
| Staffing | отпуска, бронь мест, офис, оргсхема (`/api/org/*`) |
| Диаграммы (UI) | вкладка «Диаграммы» — конструктор |
| Вход | PAT **или** email/пароль (`org_user` / `APP_AUTH_*`) |
| Единая задача | `task`, `project`, `source_system` |
| ЗНИ ↔ Ошибка | `task_type`, `parent_task_id` |
| Время в статусе / бэклоге | `task_status_duration`, views `v_*` |
| FineBI | views `v_*` из PostgreSQL |
| Production HTTPS | nginx + certbot (домены из `.env`) |

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
