# Словарь данных (краткая выжимка)

> **Полный глоссарий** со всеми таблицами и полями: [glossary.md](glossary.md)

## task — основная сущность

| Колонка | Тип | Описание |
|---------|-----|----------|
| external_id | varchar | Ключ/ID в источнике |
| title | varchar | Заголовок |
| description | text | Описание |
| task_type | varchar | Тип задачи |
| priority | varchar | Приоритет |
| source_status | varchar | Статус как в источнике |
| team_id | bigint | Каноническая команда (digital, berkhut) |
| source_team | varchar | Команда из источника до маппинга |
| canonical_status_id | int | Единый статус (через mapping) |
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
| extra_json | jsonb | Немапленные поля источника |

## task_comment

| Колонка | Описание |
|---------|----------|
| external_comment_id | ID комментария в источнике |
| body | Текст |
| created_at | Дата комментария |
| is_internal | Внутренний комментарий (Jira) |

## task_status_history / task_status_duration

| Таблица | Назначение |
|---------|------------|
| task_status_history | Каждая смена статуса (событие) |
| task_status_duration | Интервал [entered_at, left_at] в каноническом статусе |
| task_status_duration_agg | Сумма секунд по статусу на задачу |

**Время в бэклоге:** `canonical_status.category = 'backlog'`.

## Справочники маппинга (заполните на этапе 1–2)

### field_mapping

| canonical_field | Смысл |
|-----------------|--------|
| title | Название задачи |
| start_date | Дата начала |
| release_date | Дата релиза / target |
| story_points | Оценка |
| assignee_id | Исполнитель (через person_external) |

### source_status_mapping

Заполняется после анализа полей Jira / TFS / Trello / other. Связь: `source_status_name` → `canonical_status.code`.

## Представления для FineBI

| View | Назначение |
|------|------------|
| v_task_backlog_duration | Дни/секунды в бэклоге по задаче |
| v_task_status_time | Время в каждом статусе |
| v_team_open_tasks | Открытые задачи по команде и категории статуса |
| v_tasks_by_release | Отгрузка задач в релиз |
