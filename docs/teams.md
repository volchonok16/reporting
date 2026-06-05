# Команды (team): модель и маппинг

Как в единой БД `reporting` хранятся команды, откуда они берутся в Jira/TFS/Trello и как по ним фильтровать в отчётах и FineBI.

**Связанные документы:** [glossary.md](glossary.md) · [database-overview.md](database-overview.md)

> **Важно:** в БД **нет захардкоженных команд**. Таблица `team` изначально **пустая**. Команды создаёт **ETL-скрипт** по доскам, тегам, area path и правилам `source_team_mapping`. Названия вроде Digital или Berkhut — лишь примеры из обсуждения, не seed-данные.

---

## Зачем нужно поле команды

Из разных систем загружаются задачи **множества команд**. Одна каноническая команда может объединять задачи из Jira и TFS (например, одна продуктовая команда в двух трекерах).

В отчётах нужен **единый фильтр** по `team.code`, независимо от источника.

---

## Три уровня хранения

| Уровень | Таблица / поле | Роль |
|---------|----------------|------|
| **Канон** | `team` | Справочник; строки **добавляет ETL** |
| **Задача** | `task.team_id` | Главное поле для фильтрации в BI |
| **Сырьё** | `task.source_team` | Значение из API до нормализации |
| **Правила** | `source_team_mapping` | Как скрипт сопоставляет признак → `team_id` |
| **Проект** | `project.team_id` | Команда по умолчанию для доски (fallback) |

---

## Справочник `team`

| Поле | Тип | Описание |
|------|-----|----------|
| `code` | varchar(64) | Уникальный slug (`digital`, `berkhut`, …) — **задаёт скрипт** |
| `name` | varchar(255) | Отображаемое имя |
| `is_active` | boolean | Участвует в отчётах |

**Создание команды — в ETL**, например:

```sql
INSERT INTO team (code, name)
VALUES ('digital', 'Digital')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
```

Скрипт может создавать команду при первом появлении признака в источнике.

---

## Поля на задаче `task`

| Поле | Кто заполняет | Описание |
|------|---------------|----------|
| `team_id` | ETL | FK → `team`; **фильтр в FineBI** |
| `source_team` | ETL | Сырая строка из API (доска, тег, area) |

**Логика ETL (будущий скрипт):**

1. Прочитать признаки задачи (доска, тег, area path, project key).
2. Найти или создать запись в `team`.
3. Применить `source_team_mapping` (если правила уже в БД).
4. Записать `task.team_id` и при необходимости `source_team`.
5. Fallback: `project.team_id`.

**Приоритет:** `task.team_id` → иначе `project.team_id` (так же в views).

---

## `source_team_mapping`

Правила сопоставления признака источника с командой. Заполняется **скриптом или админом**, не при `docker compose up`.

| Поле | Описание |
|------|----------|
| `match_type` | `board_name`, `tag`, `label`, `area_path`, `iteration_path`, `project_key`, `component` |
| `match_value` | Значение для сравнения |
| `is_regex` | Regex-поиск |
| `priority` | При нескольких совпадениях — большее значение важнее |

Конкретные правила определяете вы в скрипте загрузки.

---

## Отчётность и FineBI

Views содержат `team_code`, `team_name`: `v_team_open_tasks`, `v_task_status_time`, `v_task_backlog_duration`, `v_tasks_by_release`.

Фильтр: `team_code = '...'` после того, как ETL наполнит `team`.

---

## Миграции

```bash
# Структура (от reporting):
docker-compose exec -T postgres psql -U reporting -d reporting < db/migrations/002_add_team_to_task.sql

# Убрать примеры digital/berkhut, если попали из старой версии:
docker-compose exec -T postgres psql -U reporting -d reporting < db/migrations/003_remove_seed_teams.sql
```

**DDL** — пользователь `reporting`. **DBeaver / данные** — `alex` / `ivan`.
