# Словарь данных (краткая выжимка)

> **Полный глоссарий:** [glossary.md](glossary.md)  
> **Команды (подробно):** [teams.md](teams.md)  
> **Аудит пробелов в документации:** [documentation-gaps.md](documentation-gaps.md)

## team — каноническая команда

| Колонка | Тип | Описание |
|---------|-----|----------|
| code | varchar | Уникальный slug (создаёт ETL) |
| name | varchar | Отображаемое имя |
| is_active | boolean | Участвует в отчётах |

## source_team_mapping — правила команды

| Колонка | Описание |
|---------|----------|
| source_system_id | Jira / TFS / Trello |
| team_id | Целевая команда |
| match_type | `board_name`, `tag`, `label`, `area_path`, `iteration_path`, `project_key`, `component` |
| match_value | Значение для сравнения |
| is_regex | Поиск по regex |
| project_external_key | Ограничение проектом |
| priority | Приоритет правила |
| notes | Комментарий |

## task — основная сущность

| Колонка | Тип | Описание |
|---------|-----|----------|
| external_id | varchar | Ключ/ID в источнике |
| team_id | bigint | **Каноническая команда** — фильтр в FineBI |
| source_team | varchar | Команда из источника до маппинга |
| title | varchar | Заголовок |
| description | text | Описание |
| task_type | varchar | `change_request` (ЗНИ), `error` (Ошибка) |
| parent_task_id | bigint | ЗНИ → Ошибка |
| priority | varchar | Приоритет |
| source_status | varchar | Статус как в источнике |
| canonical_status_id | int | Единый статус |
| start_date | date | Начало работ |
| due_date | date | Срок |
| release_date | date | Дата релиза |
| created_at | timestamptz | Создана |
| resolved_at | timestamptz | Решена |
| closed_at | timestamptz | Закрыта |
| story_points | numeric | Оценка |
| sprint_name | varchar | Спринт / итерация |
| iteration_path | varchar | Путь итерации (TFS) |
| labels | text[] | Метки |
| extra_json | jsonb | `area_path`, `board_column` и др. |

### extra_json (TFS ЗНИ)

| Ключ | Источник TFS | Описание |
|------|--------------|----------|
| area_path | System.AreaPath | Область доски |
| board_column | System.BoardColumn | Колонка Kanban (статус на доске) |
| tags | System.Tags | Теги TFS (массив строк; ЗНИ — `b2b_product`, ошибки — `FE B2B` / `microservice`) |
| iteration_path | System.IterationPath | Итерация TFS |
| planned_date | из листа итерации или `release_date` | Планируемая дата (`2026.08.11.0-R` → `2026-08-11`; иначе Целевая дата TFS) |
| planned_status | `tbd` / `date` | `tbd` — дата в плане неизвестна |
| plan_quarter | из planned_date или `TBD` | Ключ квартала (`2026-Q3` или `TBD`) |
| planned_release | Logrocon.FoundinRelease / Logrocon.Release | Плановый релиз (`2026.06.02.0-R` или имя релиза) |
| customer_name | Logrocon.PO | Заказчик ЗНИ (ФИО) |
| business_goal | System.Description | Текст секции «Цель и бизнес-смысл доработки*» |
| business_value | Microsoft.VSTS.Common.BusinessValue | Ценность для бизнеса (целое число) |
| triage | Microsoft.VSTS.Common.Triage | Triage ЗНИ (для метрики «Скоро запуск» на BE Analytics) |
| pilot_transitions | TFS updates | Переходы в «Пилот»: `[{at, status}]` |
| ect_resource_reservation | WIQL WorkItemLinks (Related) | `true` / `false`: у ЗНИ есть Related на элемент «Бронь ресурсов» (колонка «Бронь ресурса ЕЦТ», `ДА` / `НЕТ`) |

## auth_session — сессия веб-приложения

| Колонка | Тип | Описание |
|---------|-----|----------|
| id | varchar(64) | sessionId для заголовка `X-Session-Id` |
| payload | jsonb | `pat`, `base_url`, `project`, `auth_mode` (`pat` / `app_user`), `app_login` |
| created_at | timestamptz | Время создания |

Переменные окружения: `APP_AUTH_USERS` (полный доступ), `APP_AUTH_ROADMAP_USERS` (только Планы + sync Digital), `TFS_SYNC_PAT` (PAT для входа по логину).

## project — команда по умолчанию

| Колонка | Описание |
|---------|----------|
| team_id | Команда для всех задач проекта, если `task.team_id` не задан |

## Справочники маппинга

| Таблица | Назначение |
|---------|------------|
| field_mapping | Поле API → колонка `task` |
| source_status_mapping | Статус источника → `canonical_status` |
| source_team_mapping | Доска/тег/area → `team` |

### field_mapping — частые целевые поля

| canonical_field | Смысл |
|-----------------|--------|
| title | Название |
| team_id | Команда (через `source_team_mapping` или прямое правило) |
| source_team | Сырое значение команды |
| start_date | Дата начала |
| release_date | Дата релиза |
| story_points | Оценка |
| assignee_id | Исполнитель |

## Представления для FineBI

| View | Назначение | Поля команды |
|------|------------|--------------|
| v_task_backlog_duration | Время в бэклоге | team_code, team_name |
| v_task_status_time | Время в статусе | team_code, team_name |
| v_team_open_tasks | Открытые задачи по команде | team_id, team_code, team_name |
| v_tasks_by_release | Отгрузка в релиз | team_code, team_name |

## Метрики веб-дашборда (ЗНИ)

| Метрика | Таблица / поле |
|---------|----------------|
| Всего ЗНИ | `task` · `task_type = change_request` |
| В работе | `source_status` / `extra_json.board_column` = `Development` |
| Скоро запуск | Digital и B2B Product: `UAT`; BE Analytics / ESB: `UAT Prod` / `Implementation Prod` / Triage `в Работе` |
| Запущено | Digital и B2B Product: `Pilot`; BE Analytics / ESB: `Closed` |
| Ошибок | `task` · `task_type = error` · `parent_task_id` |

## sync_run — аудит синхронизации

| Колонка | Описание |
|---------|----------|
| source_system_id | `tfs` |
| status | `running`, `success`, `failed` |
| records_fetched | Получено из API |
| records_upserted | Записано в `task` |
| parameters_json | `board`, фильтры |

## workspace_place — рабочие места (бронь)

| Колонка | Тип | Описание |
|---------|-----|----------|
| name | varchar | Отображаемое имя (`Место 23`, …) |
| sort_order | int | Номер места и порядок строк в сетке «Бронь мест» |
| is_active | boolean | Скрыть место из брони без удаления |

Наполнение: `008_workspace_booking.sql` (23–53), `012_workspace_places_99_106.sql` (99–106). Подробнее — [glossary.md](glossary.md#workspace_place--справочник-рабочих-мест).

## workspace_booking — бронь на день

| Колонка | Тип | Описание |
|---------|-----|----------|
| place_id | bigint | FK → `workspace_place` |
| employee_id | bigint | FK → `employee` |
| day | date | Календарный день |

Уникальность: одно место в день, один сотрудник — одно место в день.

## employee_office_day — присутствие в офисе без места

| Колонка | Тип | Описание |
|---------|-----|----------|
| employee_id | bigint | FK на сотрудника (`employee.id`) |
| day | date | День, когда сотрудник отметил «в офисе» |

Применение: вкладка «Сотрудники в офисе» учитывает `workspace_booking` (с местом) и `employee_office_day` (без места), а также исключения по `employee_time_off_day` (отпуск, отгул, больничный, командировка).

## org_chart_layout — ручная оргсхема

| Колонка | Тип | Описание |
|---------|-----|----------|
| scope | varchar | `company` или `department` |
| department_id | bigint | FK на отдел, только для схемы отдела |
| layout_json | jsonb | `nodes` с координатами карточек и `edges` с нарисованными линиями |

Применение: вкладка «Пирамида» показывает всем пользователям сохранённую администратором ручную раскладку оргструктуры.
