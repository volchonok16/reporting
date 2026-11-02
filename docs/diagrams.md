# Диаграммы проекта reporting

Все схемы в одном месте.

| Для чего | Куда |
|----------|------|
| **Вставка в Confluence** | [confluence.md](confluence.md) + картинки [diagrams/png/](diagrams/png/) |
| Просмотр на GitHub (Mermaid) | этот файл |
| Исходники PlantUML | [plantuml/](../plantuml/) |
| SVG | [diagrams/svg/](diagrams/svg/) |

**Прямая ссылка (GitHub):** [docs/diagrams.md](https://github.com/volchonok16/reporting/blob/main/docs/diagrams.md)

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

Workbench: **ЗНИ**, **Статус продукта B2B** (+ PPTX), **Staffing**, **Планирование**, **Voice**.  
Инфраструктура Compose: **PostgreSQL**, **MinIO** (фото), шаблон **Status.pptx**.

```mermaid
flowchart TB
    subgraph External["Внешние системы"]
        TFS[Azure DevOps / TFS]
        FineBI[FineBI]
    end

    subgraph Prod["Production"]
        NGINX[nginx + certbot\nHTTPS UI / API]
    end

    subgraph App["Docker Compose"]
        FE[Frontend :5173]
        API[Backend FastAPI :8000]
        PG[(PostgreSQL :5432\nreporting_pgdata)]
        MinIO[(MinIO :9000 / :9001\nbucket photos\nreporting_miniodata)]
        MinInit[minio-init\nmc mb + public read]
        Uploads[("ORG_UPLOADS_DIR\nfallback фото")]
        Tpl[("assets/Status.pptx")]
    end

    User[Пользователь] --> NGINX
    NGINX --> FE
    NGINX --> API
    FE --> API

    API --> PG
    API --> TFS
    API --> MinIO
    API --> Uploads
    API --> Tpl
    MinInit --> MinIO
    PG --> FineBI

    subgraph Modules["Модули backend"]
        Sync[TFS Sync]
        Org[Org / Staffing + фото]
        B2B[B2B Status + PPTX]
        Road[Roadmap]
        Auth[Auth PAT / org_user]
    end

    API --- Modules
    Org --> MinIO
    Org --> Uploads
    B2B --> Tpl
    Sync --> TFS

    subgraph Tabs["Вкладки UI"]
        S1[ЗНИ]
        S2[Статус B2B / новости]
        S5[Staffing]
        S8[Планирование]
        S9[Voice]
        S7[Профиль]
    end

    FE --- Tabs
```

| Компонент | Назначение |
|-----------|------------|
| PostgreSQL | Все доменные таблицы (ЗНИ, org, B2B), `auth_session`, sync |
| MinIO | S3-совместимое хранилище фото (`MINIO_BUCKET=photos`, без anonymous) |
| minio-init | Создаёт buckets + `anonymous set none` |
| `ORG_UPLOADS_DIR` | Локальный fallback, если MinIO недоступен |
| Auth / ACL | [auth-and-roles.md](auth-and-roles.md) — сессии, page ACL, SSO iframe |
| `assets/Status.pptx` | Шаблон генерации презентаций B2B |
| FineBI | Чтение views `v_*` из PostgreSQL |

---

## Production: nginx + certbot

```mermaid
flowchart LR
    User[Браузер] -->|HTTPS UI| N[nginx]
    User -->|HTTPS API| N
    N -->|:5173| FE[frontend]
    N -->|:8000| BE[backend]
    BE --> PG[(postgres)]
    BE --> M[(MinIO\nphotos)]
    Cert[certbot] -.->|LE cert| N
```

Стек на хосте: Docker Compose (`postgres`, `backend`, `frontend`, `minio`, `minio-init`) + nginx + certbot.  
Запуск: `sudo bash scripts/production.sh` · [deploy/DEPLOY.md](../deploy/DEPLOY.md) · MinIO/env: [docker.md](docker.md)

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

**Доски:** Digital, Продукты, Reports, B2B Product (CORE, КАТС, Voice, M2M, SMS, Solar, Umnico), BE Analytics, ESB. Фильтр «Все доски» — объединение.

---

## ER — база данных

Ядро задач + Staffing + B2B (полная PlantUML: [database-er.puml](../plantuml/database-er.puml)).

```mermaid
erDiagram
    source_system ||--o{ task : originates
    source_system ||--o{ sync_run : audits
    team ||--o{ task : assigned
    task |o--o| task : parent_child
    task ||--o{ task_status_duration : time_in_status
    task ||--o| zni_external_data : external
    zni_category ||--o{ zni_external_data : category

    org_user ||--o| employee : may_bind
    org_user ||--o{ app_notification_recipient : receives
    app_notification ||--o{ app_notification_recipient : to
    master_state ||--o{ master_records : revision
    master_records ||--o{ master_changes : history
    employee ||--o{ department_member : in
    department ||--o{ department_member : has
    employee ||--o{ employee_time_off_day : absence
    employee ||--o{ workspace_booking : books
    workspace_place ||--o{ workspace_booking : reserved
    employee ||--o{ employee_office_day : present


    b2b_product_status_office ||--o{ b2b_product_status_row : rows
    b2b_product_status_office ||--o{ b2b_product_status_project : projects
    b2b_product_status_office ||--o{ b2b_product_status_office_member : members
    b2b_product_status_office ||--o{ b2b_product_status_office_schedule : auto_lock
    employee ||--o{ b2b_product_status_office_member : assigned
    b2b_product_status_schedule {
        text job_key PK
        smallint weekday
        smallint minutes
    }
    b2b_news_section ||--o{ b2b_news_row : rows
    revenue_activity_section ||--o{ revenue_activity_row : rows

    auth_session {
        varchar id PK
        jsonb payload
    }

    task {
        bigint id PK
        varchar task_type
        jsonb extra_json
    }

    zni_external_data {
        bigint task_id PK
        varchar priority
        varchar plan_quarter
        bigint category_id FK
        text comment
    }

    zni_category {
        bigint id PK
        varchar name
    }

    workspace_booking {
        bigint place_id FK
        bigint employee_id FK
        date day
    }


    b2b_product_status_row {
        bigint id PK
        jsonb cells
    }
```

Глоссарий: [glossary.md](glossary.md) · обзор таблиц: [database-overview.md](database-overview.md)

---

## Use Case

```mermaid
flowchart TB
    subgraph Actors
        A1[Пользователь]
        A2[Админ org]
        A4[FineBI]
    end

    subgraph Web["Workbook + infra"]
        UC_AUTH((Вход PAT / email))
        UC_DASH((ЗНИ + sync TFS))
        UC_B2B((Статус B2B +\nPPTX))
        UC_ROAD((Планирование))
        UC_STAFF((Staffing))
        UC_PHOTO((Фото → MinIO))
        UC_ORG((Оргсхема))
        UC_VOICE((Voice))
        UC_PROFILE((Профиль))
    end

    subgraph BI["BI"]
        UC2((Views v_*))
    end

    A1 --> UC_AUTH
    A1 --> UC_DASH
    A1 --> UC_B2B
    A1 --> UC_ROAD
    A1 --> UC_STAFF
    A1 --> UC_PHOTO
    A1 --> UC_ORG
    A1 --> UC_VOICE
    A1 --> UC_PROFILE
    A2 --> UC_ORG
    A2 --> UC_STAFF
    A2 --> UC_PHOTO
    A4 --> UC2
```

Подробная таблица: [use-case-diagram.md](use-case-diagram.md)

---

## Диаграмма классов

```mermaid
classDiagram
    class Task {
        +Long id
        +String externalId
        +String taskType
        +Long parentTaskId
        +Json extraJson
    }

    class Employee {
        +Long id
        +UUID publicId
        +String fullName
    }

    class WorkspaceBooking {
        +Long placeId
        +Long employeeId
        +Date day
    }


    class B2BStatusRow {
        +Long officeId
        +Json cells
    }

    class AuthSession {
        +String id
        +Json payload
    }

    class SyncRun {
        +String status
        +Int recordsUpserted
    }

    Task "0..1" --> "0..*" Task : parent
    Employee "1" --> "0..*" WorkspaceBooking
    B2BStatusRow ..> Task : cells.ЗНИ
    SyncRun --> Task : upserts
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

### Генерация PPTX (Статус продукта B2B)

```mermaid
sequenceDiagram
    participant UI as Frontend B2B
    participant API as FastAPI
    participant Gen as product_status_presentation
    participant Tpl as assets/Status.pptx
    participant DB as PostgreSQL

    UI->>API: GET/POST /api/product-status/b2b/presentation
    API->>DB: строки статуса / новости
    API->>Gen: generate(rows)
    Gen->>Tpl: шаблон PPTX
    Gen-->>API: PPTX bytes
    API-->>UI: download .pptx
```

### Фото сотрудника (MinIO)

```mermaid
sequenceDiagram
    participant UI as Профиль / Staffing
    participant API as FastAPI org
    participant M as MinIO bucket photos
    participant FS as ORG_UPLOADS_DIR

    UI->>API: POST multipart photo (X-Session-Id)
    alt MinIO доступен
        API->>M: putObject employees/… (private)
        API-->>UI: /api/org/photos/employees/… (+ sid для img)
    else fallback
        API->>FS: save file
        API-->>UI: тот же API-путь
    end
    UI->>API: GET photo (?sid= или заголовок)
    API->>M: getObject (allowlist employees/)
```

---

## PlantUML — детальные диаграммы

Детальные схемы. **SVG** обновляются при push в `main` (GitHub Actions) или локально:

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

> Если SVG ещё не сгенерированы — откройте любой `.puml` на [plantuml.com/plantuml](https://www.plantuml.com/plantuml/uml) или дождитесь workflow **Render diagrams**.

### Просмотр без GitHub

1. **В репозитории** — этот файл (`diagrams.md`), Mermaid рисуется сам.
2. **PlantUML онлайн** — скопировать текст из `plantuml/*.puml` → [plantuml.com](https://www.plantuml.com/plantuml/uml).
3. **Локально** — см. [plantuml/README.md](../plantuml/README.md).
