# Обзор базы данных

> **Пробелы и устаревшие места в docs:** [documentation-gaps.md](documentation-gaps.md) reporting

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

## Приложение reporting

| Сервис | Порт (dev) | Назначение |
|--------|------------|------------|
| `frontend` | 5173 | Workbook: ЗНИ, B2B статус, Планы, Доска, Staffing, Диаграммы |
| `backend` | 8000 | FastAPI: TFS sync, org, youjail, B2B+PPTX, сессии |
| `postgres` | 5432 | PostgreSQL (`reporting_pgdata`) |
| `minio` | 9000 / 9001 | Фото сотрудников, bucket `photos` (`reporting_miniodata`) |
| `minio-init` | — | One-shot: создать bucket + public read |

**Тома / каталоги:** `YOUJAIL_WORKSPACE_DIR` (файлы доски), `ORG_UPLOADS_DIR` (fallback фото), `assets/Status.pptx` (шаблон презентаций).

**Локально:** `bash scripts/dev.sh` или `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`

**Production:** nginx + certbot → HTTPS UI и HTTPS API (хосты из `.env`). Запуск: `sudo bash scripts/production.sh`. См. [deploy/DEPLOY.md](../deploy/DEPLOY.md) · MinIO/env: [docker.md](docker.md).

### Доски TFS

| Код | AreaPath | Теги ЗНИ | Теги ошибок | Отображаемое имя |
|-----|----------|----------|-------------|------------------|
| `digital_streams_b2b` | `Tele2\Digital\Streams\B2b` | — (без `EFO`) | `FE B2B`, `microservice` (без `EFO`) | Digital |
| `tele2_products` | `Tele2\Продукты` | `b2b_product` (без `EFO`) | без фильтра по тегам (без `EFO`) | Продукты |
| `reports` | `Tele2\Reports\Team A` | `b2b_product` (без `EFO`) | без фильтра по тегам (без `EFO`) | Reports |
| `b2b_product_core` | `Tele2\B2B Product` | — (без `EFO`) | `FE B2B`, `microservice` (без `EFO`) | CORE |
| `b2b_product_partners` | `Tele2\B2B Product Partners` | — (без `EFO`) | `FE B2B`, `microservice` (без `EFO`) | КАТС |
| `b2b_voice_products` | `Tele2\B2B Product\B2B Voice Products` | — (без `EFO`) | `FE B2B`, `microservice` (без `EFO`) | Голосовые продукты |
| `b2b_m2m_platform` | `Tele2\B2B Product\M2M Platform` | — (без `EFO`) | `FE B2B`, `microservice` (без `EFO`) | М2М / IoT |
| `b2b_sms_target` | `Tele2\B2B Product\SMS-Target` | — (без `EFO`) | `FE B2B`, `microservice` (без `EFO`) | SMS |
| `b2b_solar` | `Tele2\B2B Product\Solar` | — (без `EFO`) | `FE B2B`, `microservice` (без `EFO`) | Solar |
| `b2b_umnico` | `Tele2\B2B Product\Umnico` | — (без `EFO`) | `FE B2B`, `microservice` (без `EFO`) | Umnico |
| `be_t2_team` | `BE-T2\BE Analytics` | `b2b_product` | `FE B2B`, `microservice` | BE Analytics (без статуса `Rejected`) |
| `esb_analytics` | `BE-T2\ESB\ESB Analytics` | `b2b_product` | `FE B2B`, `microservice` | ESB (без статуса `Rejected`) |

Фильтр «Все доски» — объединение всех досок.

### Метрики дашборда (ЗНИ)

| Карточка | Источник | Примечание |
|----------|----------|------------|
| Всего задач | `task` где `task_type = change_request` | По выбранной доске |
| Скоро запуск | Digital, Продукты и B2B Product (*): `UAT`; BE Analytics / ESB: `UAT Prod`, `Implementation Prod` или Triage `в Работе` | `System.State` / `Triage` |
| Запущено | Digital, Продукты и B2B Product (*): `Pilot`; BE Analytics / ESB: `Closed` | workflow |
| Ошибки | ЗНИ с привязанными `error` (без Closed) | Клик по карточке — фильтр таблицы |

### REST API (основное)

| Метод | Путь | Назначение |
|-------|------|------------|
| POST | `/api/auth/login` | Вход PAT или email/пароль → `sessionId` |
| GET | `/api/dashboard` | Метрики и список ЗНИ |
| POST | `/api/sync` | Запуск синхронизации доски |
| GET | `/api/export` | Экспорт ЗНИ + ошибки (CSV) |
| GET/POST | `/api/product-status/b2b/presentation` | Генерация PPTX |
| GET/POST | `/api/revenue-activities` | Активности по выручкам (Активность / влияния / Комментарий / Результат) |
| GET/POST | `/api/revenue-activities/excel` | Экспорт в Excel (числа как number) |
| * | `/api/org/*` | Staffing: отпуска, бронь, офис, сотрудники |
| * | `/api/youjail/*` | Доска YouJail |

Диаграммы: [diagrams.md](diagrams.md) · глоссарий API подробнее: [glossary.md](glossary.md).

## Таблицы (36) + представления (4)

### Справочники и маппинг

| Таблица | Назначение |
|---------|------------|
| `source_system` | Jira, TFS, Trello, other |
| `canonical_status` | Единые статусы |
| `source_status_mapping` | Статус источника → канонический статус |
| `source_team_mapping` | Признак источника → команда (`team_id`) |
| `field_mapping` | Поле источника → поле `task` |
| `team` | Канонические команды (коды досок из `boards.py`, напр. `digital_streams_b2b`, `b2b_product_core`, `be_t2_team`) |
| `auth_session` | Сессии PAT для веб-приложения |
| `org_user` | Учётные записи сотрудников (email/пароль) |
| `job_position` | Справочник должностей |
| `team_role` | Роли в составе отдела |
| `expertise_direction` | Направления экспертизы |
| `employee` | Сотрудники организации (`public_id` — UUID для публичных ссылок) |
| `employee_expertise` | Экспертиза сотрудника |
| `employee_time_off_day` | График отпусков (день + тип) |
| `workspace_place` | Справочник рабочих мест (номера 23–53 и 99–106; см. миграции `008`, `012`) |
| `workspace_booking` | Бронь места на календарный день |
| `employee_office_day` | Дни присутствия сотрудника в офисе без привязки к месту |
| `department` | Отделы |
| `department_member` | Состав отдела |
| `org_chart_layout` | Сохранённая ручная раскладка оргсхемы (координаты карточек и линии) |
| `youjail_board` | Доски YouJail (общие/командные и личные по `owner_employee_id`) |
| `youjail_board_pin` | Закреплённые доски пользователя (персональный порядок) |
| `youjail_board_member` | Прямой доступ к доске: `admin` или `member` |
| `youjail_project` | Проекты доски YouJail (repo, контекст) |
| `youjail_task_type` | Типы карточек YouJail |
| `youjail_column` | Колонки kanban (Backlog … Done) |
| `youjail_card` | Карточки YouJail с заметками markdown |
| `youjail_tag` | Теги карточек YouJail (labels) |
| `youjail_card_tag` | Связь карточки и тегов |
| `youjail_card_zni` | Привязка карточки к ЗНИ (`task`, `change_request`) |
| `youjail_card_event` | История изменений карточки |
| `youjail_card_link` | Связи карточек на одной доске |
| `youjail_card_comment` | Комментарии к карточке YouJail |
| `youjail_comment_attachment` | Вложения к комментариям |
| `youjail_attachment` | Вложения карточек |
| `youjail_execution` | Запуски исполнителя |
| `youjail_execution_log` | Лог stdout/stderr/system |
| `b2b_product_status_office` | Продуктовые офисы B2B (вкладки статуса: SMS, VOICE, CORE, Аналитики, Проекты и др.) |
| `b2b_product_status_row` | Строки таблицы «Статус продукта B2B» (`cells` jsonb) |
| `b2b_product_status_history` | История изменений строк статуса продукта B2B |
| `b2b_product_status_snapshot` | Снимки версий офиса для отката к сохранённому состоянию |
| `b2b_news_section` | Вкладки «Новости» и «Запуски» |
| `b2b_news_row` | Строки таблицы новостей/запусков (`cells` jsonb) |
| `b2b_news_history` | История изменений новостей и запусков |
| `b2b_news_snapshot` | Снимки версий вкладки для отката |
| `revenue_activity_section` | Вкладка «Активности по выручкам» |
| `revenue_activity_row` | Строки таблицы активностей (`cells` jsonb: Активность, Статус, Ответственный, влияния, Комментарий, Результат) |
| `revenue_activity_history` | История изменений активностей по выручкам |
| `revenue_activity_snapshot` | Снимки версий для отката |
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
| `task_type` | `change_request` (ЗНИ), `error` (Ошибка) |
| `parent_task_id` | Ошибка → родительская ЗНИ |
| `team_id` | Каноническая команда (фильтр отчётов) |
| `source_team` | Команда из API до маппинга |
| `title`, `description` | Текст |
| `canonical_status_id`, `source_status` | Статус |
| `start_date`, `due_date`, `release_date` | Даты; `start_date` пусто → `created_at` |
| `story_points`, `*_hours` | Оценки |
| `assignee_id`, `reporter_id` | Люди |
| `extra_json` | `area_path`, `board_column` и др. |

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
bash scripts/dev.sh           # локально: postgres + backend + frontend
# миграции для существующей БД:
# bash scripts/migrate.sh
```

См. [docker.md](docker.md), [deploy/DEPLOY.md](../deploy/DEPLOY.md).
