# Use Case Diagram — система учёта задач

## Диаграмма (Mermaid)

```mermaid
flowchart LR
    subgraph Actors
        A1[Аналитик / Менеджер]
        A2[Администратор]
        A3[ETL-сервис]
        A4[FineBI]
    end

    subgraph System["Единая система задач (PostgreSQL)"]
        UC1((Просмотр отчётов<br/>по задачам))
        UC2((Анализ времени<br/>в статусах))
        UC3((Анализ времени<br/>в бэклоге))
        UC4((Загрузка команды<br/>и бэклога))
        UC5((Отгрузка по релизам<br/>и датам))
        UC6((Настройка маппинга<br/>полей и статусов))
        UC7((Выгрузка задач<br/>из Jira))
        UC8((Выгрузка задач<br/>из TFS))
        UC9((Выгрузка из других<br/>систем))
        UC10((Синхронизация<br/>комментариев))
        UC11((Запись истории<br/>смены статусов))
        UC12((Расчёт длительности<br/>в статусах))
        UC13((Снимки загрузки<br/>команды))
        UC14((Аудит синхронизаций))
    end

    A1 --> UC1
    A1 --> UC2
    A1 --> UC3
    A1 --> UC4
    A1 --> UC5

    A4 --> UC1
    A4 --> UC2
    A4 --> UC3
    A4 --> UC4
    A4 --> UC5

    A2 --> UC6

    A3 --> UC7
    A3 --> UC8
    A3 --> UC9
    A3 --> UC10
    A3 --> UC11
    A3 --> UC12
    A3 --> UC13
    A3 --> UC14

    UC7 -.->|include| UC11
    UC8 -.->|include| UC11
    UC9 -.->|include| UC11
    UC7 -.->|include| UC10
    UC8 -.->|include| UC10
    UC11 -.->|include| UC12
    UC12 -.->|extend| UC13
```

## Краткое описание use cases

| ID | Use Case | Актор | Описание |
|----|----------|-------|----------|
| UC1 | Просмотр отчётов по задачам | Аналитик, FineBI | Что сделано / в работе / запланировано |
| UC2 | Анализ времени в статусах | Аналитик, FineBI | Сколько задача была в In Progress, Review и т.д. |
| UC3 | Анализ времени в бэклоге | Аналитик, FineBI | Метрика «застоя» до начала работ |
| UC4 | Загрузка команды и бэклога | Аналитик, FineBI | Открытые задачи, story points, размер бэклога |
| UC5 | Отгрузка по релизам и датам | Аналитик, FineBI | Сколько задач ушло в релиз / на дату |
| UC6 | Настройка маппинга | Администратор | `field_mapping`, `source_status_mapping` |
| UC7–UC9 | Выгрузка из систем | ETL | API Jira, TFS, прочие |
| UC10 | Синхронизация комментариев | ETL | Таблица `task_comment` |
| UC11 | История статусов | ETL | `task_status_history` из changelog |
| UC12 | Расчёт длительности | ETL / job | `task_status_duration` |
| UC13 | Снимки загрузки | ETL / job | `team_workload_snapshot` |
| UC14 | Аудит синхронизаций | ETL, Админ | `sync_run`, `sync_run_log` |

## PlantUML (альтернатива для экспорта в draw.io)

```plantuml
@startuml
left to right direction
actor "Аналитик" as analyst
actor "Администратор" as admin
actor "ETL-сервис" as etl
actor "FineBI" as bi

rectangle "Система учёта задач" {
  usecase "Отчёты по задачам" as UC1
  usecase "Время в статусах" as UC2
  usecase "Время в бэклоге" as UC3
  usecase "Загрузка команды" as UC4
  usecase "Отгрузка в релиз" as UC5
  usecase "Маппинг полей" as UC6
  usecase "Загрузка Jira/TFS" as UC7
  usecase "История статусов" as UC11
}

analyst --> UC1
analyst --> UC2
bi --> UC1
admin --> UC6
etl --> UC7
UC7 ..> UC11 : include
@enduml
```
