# Словарь данных (краткая выжимка)

> **Полный глоссарий:** [glossary.md](glossary.md)  
> **Команды (подробно):** [teams.md](teams.md)

## team — каноническая команда

| Колонка | Тип | Описание |
|---------|-----|----------|
| code | varchar | Уникальный код: `digital`, `berkhut` |
| name | varchar | Отображаемое имя: Digital, Berkhut |
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
| task_type | varchar | Тип задачи |
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
| extra_json | jsonb | Немапленные поля |

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
