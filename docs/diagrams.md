# Диаграммы проекта reporting

Все схемы в одном месте. **На GitHub** диаграммы Mermaid ниже отображаются прямо в браузере — откройте этот файл в репозитории, PlantUML не нужен.

**Прямая ссылка:** [github.com/volchonok16/reporting/blob/main/docs/diagrams.md](https://github.com/volchonok16/reporting/blob/main/docs/diagrams.md)

| Раздел | Тип | Исходник |
|--------|-----|----------|
| [Архитектура](#архитектура) | Mermaid | [plantuml/architecture.puml](../plantuml/architecture.puml) |
| [ER — база данных](#er--база-данных) | Mermaid | [plantuml/database-er.puml](../plantuml/database-er.puml) |
| [Use Case](#use-case) | Mermaid | [plantuml/use-case.puml](../plantuml/use-case.puml) |
| [Классы](#диаграмма-классов) | Mermaid | [docs/uml-diagram.md](uml-diagram.md) |
| [Поток данных](#поток-данных-время-в-статусе) | Mermaid | [docs/uml-diagram.md](uml-diagram.md) |
| [PlantUML (детальные SVG)](#plantuml--детальные-диаграммы) | SVG | генерируются автоматически при push |

---

## Архитектура

Целевая схема: Jira, TFS, Trello → ETL → PostgreSQL `reporting` → FineBI.

```mermaid
flowchart TB
    subgraph External["Внешние системы"]
        Jira[Jira API]
        TFS[Azure DevOps / TFS]
        Trello[Trello API]
        Other[Прочая система]
    end

    subgraph ETL["Слой загрузки (будущее)"]
        CJ[Jira Connector]
        CT[TFS Connector]
        CTr[Trello Connector]
        Mapper[Маппер полей и статусов]
        Duration[Расчёт времени в статусах]
        Snapshot[Снимки загрузки команд]
    end

    subgraph Storage["PostgreSQL — reporting"]
        Core[(task, comment, history)]
        Ref[(mapping, status, team)]
        Metrics[(duration, workload_snapshot)]
        Views[(v_* views)]
    end

    subgraph BI["Отчётность"]
        FineBI[FineBI]
    end

    Jira --> CJ
    TFS --> CT
    Trello --> CTr
    Other --> Mapper
    CJ --> Mapper
    CT --> Mapper
    CTr --> Mapper
    Mapper --> Core
    Mapper --> Ref
    Core --> Duration
    Duration --> Metrics
    Metrics --> Snapshot
    Core --> Views
    Metrics --> Views
    Views --> FineBI
    Core --> FineBI
```

---

## ER — база данных

Основные таблицы и связи единой БД.

```mermaid
erDiagram
    source_system ||--o{ project : has
    source_system ||--o{ task : originates
    source_system ||--o{ field_mapping : maps
    source_system ||--o{ source_status_mapping : maps

    team ||--o{ project : owns
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

    team ||--o{ task : assigned
    team ||--o{ source_team_mapping : rules

    task {
        bigint id PK
        bigint team_id FK
        varchar external_id
        varchar title
        date start_date
        date release_date
    }

    team {
        varchar code
        varchar name
    }

    task_status_duration {
        timestamptz entered_at
        timestamptz left_at
        bigint duration_seconds
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
        A3[ETL-сервис]
        A4[FineBI]
    end

    subgraph System["Система reporting"]
        UC1((Отчёты по задачам))
        UC2((Время в статусах))
        UC3((Время в бэклоге))
        UC4((Загрузка команды))
        UC5((Отгрузка в релиз))
        UC6((Маппинг полей))
        UC7((Загрузка Jira/TFS/Trello))
    end

    A1 --> UC1
    A1 --> UC2
    A4 --> UC1
    A4 --> UC2
    A2 --> UC6
    A3 --> UC7
    UC7 -.-> UC2
```

Подробная таблица use cases: [use-case-diagram.md](use-case-diagram.md)

---

## Диаграмма классов

```mermaid
classDiagram
    class Task {
        +Long id
        +String externalId
        +String title
        +Date startDate
        +Date releaseDate
        +Status canonicalStatus
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

    SourceSystem "1" --> "*" Project
    Project "1" --> "*" Task
    Task "1" --> "*" TaskStatusDuration
    Task --> CanonicalStatus
```

---

## Поток данных: время в статусе

```mermaid
sequenceDiagram
    participant API as Jira / TFS / Trello
    participant ETL as ETL-сервис
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

Детальные схемы с полным набором таблиц и полей. **SVG** обновляются автоматически при каждом push в `main` (GitHub Actions).

| Диаграмма | SVG (в репозитории) | Исходник |
|-----------|---------------------|----------|
| ER база данных | [database-er.svg](diagrams/svg/database-er.svg) | [database-er.puml](../plantuml/database-er.puml) |
| Архитектура | [architecture.svg](diagrams/svg/architecture.svg) | [architecture.puml](../plantuml/architecture.puml) |
| Use Case | [use-case.svg](diagrams/svg/use-case.svg) | [use-case.puml](../plantuml/use-case.puml) |

> Если SVG ещё не сгенерированы — откройте любой `.puml` на [plantuml.com/plantuml](https://www.plantuml.com/plantuml/uml) (вставить содержимое файла) или дождитесь завершения workflow **Render diagrams** во вкладке Actions.

### Просмотр без GitHub

1. **В репозитории** — этот файл (`diagrams.md`), Mermaid рисуется сам.
2. **PlantUML онлайн** — скопировать текст из `plantuml/*.puml` → [plantuml.com](https://www.plantuml.com/plantuml/uml).
3. **Локально** — `docker run ...` см. [plantuml/README.md](../plantuml/README.md).
