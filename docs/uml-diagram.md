# UML — ER-диаграмма и компоненты

> Актуальная полная картина workbook: [diagrams.md](diagrams.md) (architecture, use case, ER с Staffing / YouJail / B2B).

## ER-диаграмма (Mermaid)

```mermaid
erDiagram
    source_system ||--o{ project : has
    source_system ||--o{ task : originates
    source_system ||--o{ sync_run : logs
    team ||--o{ task : assigned
    task |o--o| task : parent_child
    task ||--o{ task_status_duration : time_in_status
    task ||--o{ youjail_card_zni : linked

    employee ||--o{ workspace_booking : books
    workspace_place ||--o{ workspace_booking : place
    employee ||--o{ employee_time_off_day : absence
    youjail_board ||--o{ youjail_card : cards
    youjail_card ||--o{ youjail_card_zni : zni
    b2b_product_status_office ||--o{ b2b_product_status_row : rows

    auth_session {
        varchar id PK
        jsonb payload
    }

    task {
        bigint id PK
        varchar task_type
        jsonb extra_json
    }

    workspace_booking {
        bigint place_id FK
        bigint employee_id FK
        date day
    }
```

## Диаграмма классов (логическая модель)

```mermaid
classDiagram
    class SourceSystem {
        +Short id
        +String code
        +String name
    }

    class Project {
        +Long id
        +String externalKey
        +String name
    }

    class Task {
        +Long id
        +UUID uuid
        +String externalId
        +String taskType
        +Long parentTaskId
        +String title
        +Date startDate
        +Date releaseDate
        +Status canonicalStatus
        +String sourceStatus
        +sync()
    }

    class AuthSession {
        +String id
        +Json payload
        +DateTime createdAt
    }

    class CanonicalStatus {
        +Int id
        +String code
        +String category
        +Boolean isTerminal
    }

    class TaskStatusHistory {
        +DateTime changedAt
        +Status fromStatus
        +Status toStatus
    }

    class TaskStatusDuration {
        +DateTime enteredAt
        +DateTime leftAt
        +Long durationSeconds
        +calcDuration()
    }

    class TaskComment {
        +String body
        +DateTime createdAt
    }

    class Release {
        +String name
        +Date plannedReleaseDate
        +Date actualReleaseDate
    }

    class TeamWorkloadSnapshot {
        +Date snapshotDate
        +Int backlogCount
        +Int activeCount
        +Int tasksShippedToRelease
    }

    class FieldMapping {
        +String sourceFieldPath
        +String canonicalField
        +String transformRule
    }

    SourceSystem "1" --> "*" Project
    SourceSystem "1" --> "*" FieldMapping
    Project "1" --> "*" Task
    Project "1" --> "*" Release
    Task "1" --> "*" TaskComment
    Task "1" --> "*" TaskStatusHistory
    Task "1" --> "*" TaskStatusDuration
    Task "0..1" --> "0..*" Task : parent
    Task --> CanonicalStatus
    Task --> Release
    TaskStatusHistory --> CanonicalStatus
    TaskStatusDuration --> CanonicalStatus
```

## Диаграмма компонентов

```mermaid
flowchart TB
    subgraph External["Внешние системы"]
        TFS[Azure DevOps / TFS]
        Jira[Jira API — будущее]
    end

    subgraph Web["Веб-приложение (реализовано)"]
        FE[Vite + React]
        API[FastAPI]
        Sync[TFS Sync\nWIQL + Batch]
        Auth[auth_session PAT]
    end

    subgraph Storage["PostgreSQL"]
        Core[(task: ЗНИ, error)]
        Ref[(mapping, status, team)]
        App[(auth_session, sync_run)]
        Metrics[(duration, workload_snapshot)]
        Views[(v_* views)]
    end

    subgraph BI["Отчётность"]
        FineBI[FineBI]
    end

    Analyst[Аналитик] --> FE
    FE --> API
    API --> Auth
    API --> Sync
    Sync --> TFS
    Sync --> Core
    Auth --> App
    Core --> Views
    Metrics --> Views
    Views --> FineBI
    FE -->|CSV| Analyst
```

## Поток данных: время в статусе

```mermaid
sequenceDiagram
    participant API as Jira / TFS API
    participant ETL as ETL-сервис
    participant H as task_status_history
    participant D as task_status_duration
    participant BI as FineBI

    ETL->>API: changelog / revisions
    ETL->>H: insert events
    ETL->>D: close previous interval, open new
    Note over D: backlog_seconds = sum where category=backlog
    BI->>D: v_task_status_time
    BI->>D: v_task_backlog_duration
```

## Связь с файлами

| Артефакт | Файл |
|----------|------|
| **Все диаграммы в браузере** | [diagrams.md](diagrams.md) |
| DDL PostgreSQL | `db/schema.sql` |
| Глоссарий | [glossary.md](glossary.md) |
| План | [plan.md](plan.md) |
