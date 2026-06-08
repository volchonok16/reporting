# Диаграммы проекта reporting

Все схемы в одном месте. **На GitHub** диаграммы Mermaid ниже отображаются прямо в браузере — откройте этот файл в репозитории, PlantUML не нужен.

**Прямая ссылка:** [github.com/volchonok16/reporting/blob/main/docs/diagrams.md](https://github.com/volchonok16/reporting/blob/main/docs/diagrams.md)

| Раздел | Тип | Исходник |
|--------|-----|----------|
| [Архитектура](#архитектура) | Mermaid | [plantuml/architecture.puml](../plantuml/architecture.puml) |
| [Production](#production-nginx--certbot) | Mermaid | [deploy/DEPLOY.md](../deploy/DEPLOY.md) |
| [Синхронизация TFS](#синхронизация-tfs-зни) | Mermaid | backend `sync_service.py` |
| [ER — база данных](#er--база-данных) | Mermaid | [plantuml/database-er.puml](../plantuml/database-er.puml) |
| [Use Case](#use-case) | Mermaid | [plantuml/use-case.puml](../plantuml/use-case.puml) |
| [Классы](#диаграмма-классов) | Mermaid | [docs/uml-diagram.md](uml-diagram.md) |
| [Поток данных](#поток-данных-время-в-статусе) | Mermaid | [docs/uml-diagram.md](uml-diagram.md) |
| [PlantUML (детальные SVG)](#plantuml--детальные-диаграммы) | SVG | генерируются при push / локально |

---

## Архитектура

Веб-приложение reporting: TFS (ЗНИ + Ошибки) → FastAPI sync → PostgreSQL → Vite UI + CSV. Production — nginx + Let's Encrypt на **pallink.fun**.

```mermaid
flowchart TB
    subgraph External["Внешние системы"]
        TFS[Azure DevOps / TFS]
    end

    subgraph Prod["Production (опционально)"]
        NGINX[nginx + certbot\npallink.fun / api.pallink.fun]
    end

    subgraph App["Docker Compose"]
        FE[Vite + React :5173]
        API[FastAPI :8000]
        Sync[TFS Sync Service]
        Client[TfsClient\nWIQL + Batch]
        PG[(PostgreSQL :5432)]
    end

    Analyst[Аналитик] --> NGINX
    NGINX --> FE
    NGINX --> API
    FE --> API
    API --> Sync
    Sync --> Client
    Client --> TFS
    Sync --> PG
    API --> PG

    subgraph Storage["Ключевые таблицы"]
        Task[(task:\nchange_request, error)]
        Auth[(auth_session)]
        SyncRun[(sync_run)]
    end

    PG --- Task
    PG --- Auth
    PG --- SyncRun

    subgraph BI["Отчётность (опционально)"]
        FineBI[FineBI]
    end

    Task --> FineBI
    FE -->|CSV export| Analyst
```

---

## Production: nginx + certbot

```mermaid
flowchart LR
    User[Браузер] -->|HTTPS pallink.fun| N[nginx]
    User -->|HTTPS api.pallink.fun| N
    N -->|proxy :5173| FE[frontend]
    N -->|proxy :8000| BE[backend]
    BE --> PG[(postgres)]
    Cert[certbot\nLet's Encrypt] -.->|сертификат| N
```

Запуск: `sudo bash scripts/production.sh` · Конфиги: `deploy/nginx/` · Подробнее: [deploy/DEPLOY.md](../deploy/DEPLOY.md)

---

## Синхронизация TFS (ЗНИ)

Оптимизированный поток (без тяжёлого `$expand`):

```mermaid
sequenceDiagram
    participant UI as Frontend
    participant API as FastAPI
    participant Sync as SyncService
    participant TFS as TFS API
    participant DB as PostgreSQL

    UI->>API: POST /api/sync (X-Session-Id, board)
    API->>Sync: start_sync(board)
    Sync->>TFS: WIQL — ЗНИ по AreaPath
    TFS-->>Sync: ids[]
    Sync->>TFS: workItemsBatch (поля)
    TFS-->>Sync: ЗНИ fields
    Sync->>DB: upsert task (change_request)
    Sync->>TFS: WIQL — WorkItemLinks ЗНИ→Ошибка
    TFS-->>Sync: error ids[]
    Sync->>TFS: workItemsBatch (ошибки)
    Sync->>DB: upsert task (error, parent_task_id)
    Note over Sync,TFS: Closed старше 365 дн. — пропуск
    Sync->>DB: sync_run (status, counts)
    API-->>UI: progress / done
```

**Доски:** Digital Streams B2b (`Tele2\Digital\Streams\B2b`), BE-T2 Team (`BE-T2`). Фильтр «Все доски» — объединение.

---

## ER — база данных

Основные таблицы и связи единой БД (включая веб-приложение).

```mermaid
erDiagram
    source_system ||--o{ project : has
    source_system ||--o{ task : originates
    source_system ||--o{ field_mapping : maps
    source_system ||--o{ source_status_mapping : maps
    source_system ||--o{ sync_run : audits

    team ||--o{ project : owns
    team ||--o{ task : assigned
    team ||--o{ source_team_mapping : rules
    team ||--o{ team_workload_snapshot : measured

    project ||--o{ task : contains
    project ||--o{ release : ships

    canonical_status ||--o{ task : current
    canonical_status ||--o{ task_status_duration : interval

    person ||--o{ task : assignee
    person ||--o{ task_comment : author

    task ||--o{ task_comment : has
    task ||--o{ task_status_history : changelog
    task ||--o{ task_status_duration : time_in_status
    task ||--o{ task_release : versions
    task |o--o| task : parent_child

    release ||--o{ task : primary_release

    sync_run ||--o{ sync_run_log : logs

    auth_session {
        varchar id PK
        jsonb payload
        timestamptz created_at
    }

    task {
        bigint id PK
        bigint team_id FK
        bigint parent_task_id FK
        varchar external_id
        varchar task_type
        varchar title
        date start_date
        date release_date
        jsonb extra_json
    }

    team {
        varchar code
        varchar name
    }

    sync_run {
        bigint id PK
        varchar status
        int records_fetched
        int records_upserted
        jsonb parameters_json
    }
```

Полный глоссарий полей: [glossary.md](glossary.md)

---

## Use Case

```mermaid
flowchart LR
    subgraph Actors
        A1[Аналитик]
        A2[Администратор]
        A4[FineBI]
    end

    subgraph Web["Веб-приложение pallink.fun"]
        UC_AUTH((Вход PAT TFS))
        UC_DASH((Дашборд ЗНИ))
        UC_SYNC((Синхронизация TFS))
        UC_EXPORT((Экспорт CSV))
        UC_BOARD((Все доски / одна))
    end

    subgraph BI["Отчётность BI"]
        UC1((Отчёты по задачам))
        UC2((Время в статусах))
        UC3((Время в бэклоге))
        UC4((Загрузка команды))
        UC5((Отгрузка в релиз))
    end

    subgraph Admin["Администрирование"]
        UC6((Маппинг полей))
    end

    A1 --> UC_AUTH
    A1 --> UC_DASH
    A1 --> UC_SYNC
    A1 --> UC_EXPORT
    A1 --> UC_BOARD
    A1 --> UC1
    A4 --> UC1
    A4 --> UC2
    A2 --> UC6
    UC_SYNC -.-> UC_DASH
    UC_AUTH -.-> UC_DASH
```

Подробная таблица use cases: [use-case-diagram.md](use-case-diagram.md)

---

## Диаграмма классов

```mermaid
classDiagram
    class Task {
        +Long id
        +String externalId
        +String taskType
        +Long parentTaskId
        +String title
        +Date startDate
        +Date releaseDate
        +Json extraJson
    }

    class AuthSession {
        +String id
        +Json payload
        +DateTime createdAt
    }

    class CanonicalStatus {
        +String code
        +String category
    }

    class TaskStatusDuration {
        +DateTime enteredAt
        +DateTime leftAt
        +Long durationSeconds
    }

    class SourceSystem {
        +String code
    }

    class Project {
        +String externalKey
    }

    class SyncRun {
        +String status
        +Int recordsFetched
        +Int recordsUpserted
    }

    SourceSystem "1" --> "*" Project
    Project "1" --> "*" Task
    Task "1" --> "*" TaskStatusDuration
    Task --> CanonicalStatus
    Task "0..1" --> "0..*" Task : parent
    SourceSystem "1" --> "*" SyncRun
```

---

## Поток данных: время в статусе

```mermaid
sequenceDiagram
    participant API as Jira / TFS / Trello
    participant ETL as ETL / Sync
    participant H as task_status_history
    participant D as task_status_duration
    participant BI as FineBI

    ETL->>API: changelog / revisions / move card
    ETL->>H: insert events
    ETL->>D: close interval, open new
    Note over D: backlog = category backlog
    BI->>D: v_task_status_time
    BI->>D: v_task_backlog_duration
```

---

## PlantUML — детальные диаграммы

Детальные схемы с полным набором таблиц и полей. **SVG** обновляются при push в `main` (GitHub Actions) или локально:

```bash
docker run --rm -v "$(pwd):/work" -w /work plantuml/plantuml \
  -tsvg -o /work/docs/diagrams/svg \
  /work/plantuml/database-er.puml \
  /work/plantuml/architecture.puml \
  /work/plantuml/use-case.puml
```

| Диаграмма | SVG (в репозитории) | Исходник |
|-----------|---------------------|----------|
| ER база данных | [database-er.svg](diagrams/svg/database-er.svg) | [database-er.puml](../plantuml/database-er.puml) |
| Архитектура | [architecture.svg](diagrams/svg/architecture.svg) | [architecture.puml](../plantuml/architecture.puml) |
| Use Case | [use-case.svg](diagrams/svg/use-case.svg) | [use-case.puml](../plantuml/use-case.puml) |

> Если SVG ещё не сгенерированы — откройте любой `.puml` на [plantuml.com/plantuml](https://www.plantuml.com/plantuml/uml) или дождитесь workflow **Render diagrams** во вкладке Actions.

### Просмотр без GitHub

1. **В репозитории** — этот файл (`diagrams.md`), Mermaid рисуется сам.
2. **PlantUML онлайн** — скопировать текст из `plantuml/*.puml` → [plantuml.com](https://www.plantuml.com/plantuml/uml).
3. **Локально** — см. [plantuml/README.md](../plantuml/README.md).
