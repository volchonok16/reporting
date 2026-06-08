# UML — ER-диаграмма и компоненты

## ER-диаграмма (Mermaid)

```mermaid
erDiagram
    source_system ||--o{ project : has
    source_system ||--o{ task : originates
    source_system ||--o{ field_mapping : maps
    source_system ||--o{ source_status_mapping : maps
    source_system ||--o{ sync_run : logs

    team ||--o{ project : owns
    team ||--o{ team_workload_snapshot : measured

    project ||--o{ task : contains
    project ||--o{ release : ships

    canonical_status ||--o{ source_status_mapping : target
    canonical_status ||--o{ task : current
    canonical_status ||--o{ task_status_history : transition
    canonical_status ||--o{ task_status_duration : interval

    person ||--o{ person_external : linked
    person ||--o{ task : assignee
    person ||--o{ task_comment : author

    task ||--o{ task_comment : has
    task ||--o{ task_status_history : changelog
    task ||--o{ task_status_duration : time_in_status
    task ||--o{ task_status_duration_agg : agg
    task ||--o{ task_assignee_history : ownership
    task ||--o{ task_release : versions
    task |o--o| task : parent_child

    release ||--o{ task : primary_release
    release ||--o{ task_release : many
    release ||--o{ team_workload_snapshot : shipped

    team ||--o{ task : assigned

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

    task_status_duration {
        bigint id PK
        timestamptz entered_at
        timestamptz left_at
        bigint duration_seconds
        boolean is_current
    }

    task_comment {
        bigint id PK
        text body
        timestamptz created_at
    }

    field_mapping {
        varchar source_field_path
        varchar canonical_field
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
