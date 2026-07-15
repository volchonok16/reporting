# Reporting — страница для Confluence

Документ подготовлен для вставки в Confluence: короткие блоки, таблицы и **картинки** (PNG/SVG), без Mermaid (в Cloud он часто не рендерится без макроса).

## Как вставить

1. Создайте страницу → заголовок **Reporting — обзор системы**.
2. Скопируйте текст разделов ниже (Markdown → в Confluence: *… → Markup* / импорт Markdown, либо вставка через браузер).
3. Вставьте изображения из папки `docs/diagrams/png/` (предпочтительно) или `docs/diagrams/svg/`:
   - `architecture.png` — архитектура
   - `use-case.png` — use case
   - `database-er.png` — ER (широкая; можно «оригинал» + прокрутка)
4. Для Info-панели в Confluence: выделите абзац → **/info** или макрос *Info*.

Оригиналы схем: [diagrams.md](diagrams.md) · PlantUML: `plantuml/*.puml`.

---

## 1. Назначение

**Reporting** — единый workbook для команды B2B / Digital:

| Вкладка | Что делает |
|---------|------------|
| ЗНИ | Дашборд, sync из TFS, CSV |
| Статус продукта B2B | Таблица по офисам, новости, PPTX |
| Активности по выручкам | Активность, Статус, Ответственный, влияния, Комментарий, Результат (сумма); Excel |
| Планы Digital | Roadmap (приоритет, комментарий) |
| Доска | YouJail kanban + связь с ЗНИ |
| Staffing | Отпуска, бронь мест, офис, оргсхема |
| Диаграммы | UI-конструктор схем |

Вход: PAT TFS или email/пароль. Данные — **PostgreSQL**. Фото — **MinIO**.

---

## 2. Архитектура

> **Info.** Внешние системы: только **Azure DevOps / TFS** и опционально **FineBI**. Данные статуса продукта и презентации — из PostgreSQL + локальный `Status.pptx`.

**Вставить изображение:** `architecture.png`

| Компонент | Роль |
|-----------|------|
| Frontend (React) | Workbook UI |
| Backend (FastAPI) | REST, sync, PPTX, org, YouJail |
| PostgreSQL | Все доменные данные |
| MinIO | Фото сотрудников (`photos`) |
| youjail workspace | Вложения доски |
| nginx + TLS | Production HTTPS |

---

## 3. Use Case

**Вставить изображение:** `use-case.png`

| Группа | Возможности |
|--------|-------------|
| Вход / профиль | PAT или email; кабинет, фото, офис |
| ЗНИ | Дашборд, sync TFS, CSV, выбор доски |
| B2B | Статус, новости, генерация PPTX |
| Планы | Roadmap Digital |
| Доска | Kanban YouJail, связь с ЗНИ |
| Staffing | Отпуск, бронь, офис, пирамида, фото → MinIO |
| Диаграммы | Конструктор в UI |
| BI | Время в статусах / бэклог (views → FineBI) |

---

## 4. Модель данных (фрагмент)

**Вставить изображение:** `database-er.png`

Ключевые области:

| Пакет | Таблицы (примеры) |
|-------|-------------------|
| Задачи / TFS | `task`, `sync_run`, `auth_session` |
| Staffing | `employee`, `workspace_booking`, `employee_time_off_day` |
| YouJail | `youjail_board`, `youjail_card`, `youjail_card_zni` |
| B2B | `b2b_product_status_*`, `b2b_news_*` |
| Активности по выручкам | `revenue_activity_*` |

Полный глоссарий полей — в репозитории: `docs/glossary.md`.

---

## 5. Production (схема потока)

```
Браузер → nginx (HTTPS)
           ├─ UI  → frontend :5173
           └─ API → backend  :8000
                      ├─ PostgreSQL
                      ├─ MinIO (photos)
                      └─ youjail workspace
```

Запуск: `scripts/production.sh` (Docker + nginx + certbot).

---

## 6. Синхронизация TFS (кратко)

1. `POST /api/sync` (сессия)
2. WIQL → список ЗНИ
3. Batch полей → upsert `task` (change_request)
4. WIQL связей → ошибки → upsert `task` (error)
5. Аудит в `sync_run`

---

## 7. Чеклист для автора страницы Confluence

- [ ] Загружены три PNG (architecture, use-case, database-er)
- [ ] У ER выставлен «полный размер» / ширина страницы
- [ ] Добавлены Info у архитектуры (без Google)
- [ ] Ссылка на репозиторий / владельца страницы
- [ ] В «Связанные материалы» — deploy и glossary (по желанию)

---

*Сгенерировано из репозитория reporting. При изменении схем пересоберите PNG: см. `docs/diagrams/svg/README.md`.*
