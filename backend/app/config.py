from pydantic import Field, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.app_users import parse_app_users


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = Field(
        default="postgresql+psycopg://alex:alex@postgres:5432/reporting",
        alias="DATABASE_URL",
    )

    tfs_base_url: str = Field(default="https://tfs.t2.ru/tfs/Main", alias="TFS_BASE_URL")
    tfs_verify_tls: bool = Field(default=True, alias="TFS_VERIFY_TLS")
    tfs_timeout_seconds: float = Field(default=45, alias="TFS_TIMEOUT_SECONDS")
    tfs_auth_probe_timeout_seconds: float = Field(
        default=10,
        alias="TFS_AUTH_PROBE_TIMEOUT_SECONDS",
        description="Таймаут HTTP при проверке PAT при входе (сек).",
    )
    tfs_api_version: str = Field(default="6.1", alias="TFS_API_VERSION")
    tfs_batch_size: int = Field(default=200, alias="TFS_BATCH_SIZE")
    tfs_linked_batch_size: int = Field(
        default=200,
        alias="TFS_LINKED_BATCH_SIZE",
        description="Порция ошибок за один проход (не больше 200 — лимит TFS workItemsBatch).",
    )
    tfs_request_delay_seconds: float = Field(default=0.15, alias="TFS_REQUEST_DELAY_SECONDS")
    tfs_fetch_all_fields: bool = Field(default=False, alias="TFS_FETCH_ALL_FIELDS")
    tfs_fetch_relations: bool = Field(
        default=False,
        alias="TFS_FETCH_RELATIONS",
        description="Relations на каждом ЗНИ — медленно; ошибки грузим отдельным WIQL.",
    )
    tfs_wiql_max_results: int = Field(default=15000, alias="TFS_WIQL_MAX_RESULTS")
    tfs_user_start_date_field: str = Field(
        default="Microsoft.VSTS.Scheduling.StartDate",
        alias="TFS_USER_START_DATE_FIELD",
    )
    tfs_start_date_fields: str = Field(
        default="Microsoft.VSTS.Scheduling.StartDate,System.CreatedDate",
        alias="TFS_START_DATE_FIELDS",
    )
    tfs_target_date_fields: str = Field(
        default="Microsoft.VSTS.Scheduling.TargetDate,Microsoft.VSTS.Scheduling.FinishDate",
        alias="TFS_TARGET_DATE_FIELDS",
    )
    tfs_change_type_values: str = Field(default="Запрос на изменение", alias="TFS_CHANGE_TYPE_VALUES")
    tfs_error_type_values: str = Field(default="Ошибка", alias="TFS_ERROR_TYPE_VALUES")
    tfs_resource_reservation_type_values: str = Field(
        default="Бронь ресурсов",
        alias="TFS_RESOURCE_RESERVATION_TYPE_VALUES",
        description="Тип TFS «Бронь ресурсов» для колонки «Бронь ресурса ЕЦТ».",
    )
    tfs_ect_acceptance_type_values: str = Field(
        default="Приемка ЕЦТ",
        alias="TFS_ECT_ACCEPTANCE_TYPE_VALUES",
        description="Тип TFS «Приемка ЕЦТ» для колонки «Приемка ЕЦТ» на План digital.",
    )
    tfs_pilot_state_values: str = Field(
        default="Пилот,Pilot",
        alias="TFS_PILOT_STATE_VALUES",
        description="Статусы workflow «пилот» для метрики Запущено.",
    )
    tfs_fetch_pilot_history: bool = Field(
        default=True,
        alias="TFS_FETCH_PILOT_HISTORY",
        description="Загружать историю updates TFS для переходов в пилот.",
    )
    change_request_states: str = Field(default="", alias="CHANGE_REQUEST_STATES")
    tfs_closed_state_values: str = Field(default="Closed", alias="TFS_CLOSED_STATE_VALUES")
    tfs_exclude_closed_older_than_days: int = Field(
        default=365,
        alias="TFS_EXCLUDE_CLOSED_OLDER_THAN_DAYS",
        description="Не загружать ЗНИ в статусе Closed, если ChangedDate старше N дней.",
    )
    launching_soon_days: int = Field(default=60, alias="LAUNCHING_SOON_DAYS")
    sync_button_cooldown_seconds: int = Field(default=30, alias="SYNC_BUTTON_COOLDOWN_SECONDS")
    app_public_url: str = Field(default="http://localhost:5173", alias="APP_PUBLIC_URL")
    api_public_url: str = Field(default="http://localhost:8000", alias="API_PUBLIC_URL")
    cors_allow_origins: str = Field(default="", alias="CORS_ALLOW_ORIGINS")
    tfs_sync_pat: str = Field(
        default="",
        alias="TFS_SYNC_PAT",
        description="PAT TFS для синхронизации при входе по логину/паролю приложения.",
    )
    app_auth_users: str = Field(
        default="",
        alias="APP_AUTH_USERS",
        description="Пользователи приложения: login:password (по одному на строку).",
    )
    app_auth_roadmap_users: str = Field(
        default="",
        alias="APP_AUTH_ROADMAP_USERS",
        description=(
            "Пользователи только Планы: login:password. "
            "Доступ к вкладке Планы и синхронизации доски Digital Streams B2b."
        ),
    )
    b2b_product_status_spreadsheet_id: str = Field(
        default="1zTxzUqa1p6wFUjmk-8_2czfsJaSm3eTrNGazN0oFKqI",
        alias="B2B_PRODUCT_STATUS_SPREADSHEET_ID",
        description="ID Google Sheets для вкладки «Статус продукта B2B».",
    )
    b2b_product_status_sheet_url: str = Field(
        default=(
            "https://docs.google.com/spreadsheets/d/"
            "1zTxzUqa1p6wFUjmk-8_2czfsJaSm3eTrNGazN0oFKqI/export?format=csv&gid=0"
        ),
        alias="B2B_PRODUCT_STATUS_SHEET_URL",
        description="CSV-экспорт первого листа (fallback, если нет списка листов).",
    )
    b2b_product_status_sheets: str = Field(
        default="",
        alias="B2B_PRODUCT_STATUS_SHEETS",
        description=(
            "Список листов: JSON [{gid,name}] или gid:имя;gid2:имя2. "
            "Пусто — автоизвлечение из Google Sheets."
        ),
    )
    b2b_product_status_sheet_public_url: str = Field(
        default="https://docs.google.com/spreadsheets/d/1zTxzUqa1p6wFUjmk-8_2czfsJaSm3eTrNGazN0oFKqI/edit",
        alias="B2B_PRODUCT_STATUS_SHEET_PUBLIC_URL",
        description="Ссылка на исходную таблицу (для кнопки «Открыть в Google Sheets»).",
    )
    b2b_product_status_presentation_template: str = Field(
        default="",
        alias="B2B_PRODUCT_STATUS_PRESENTATION_TEMPLATE",
        description="Локальный путь к PPTX-эталону. Пусто — backend/assets/Status.pptx.",
    )
    b2b_product_status_presentation_reference_url: str = Field(
        default="",
        alias="B2B_PRODUCT_STATUS_PRESENTATION_REFERENCE_URL",
        description=(
            "Опциональная внешняя ссылка на эталон в UI. Генерация PPTX всегда из локального файла."
        ),
    )
    b2b_news_spreadsheet_id: str = Field(
        default="",
        alias="B2B_NEWS_SPREADSHEET_ID",
        description="ID Google Sheets для вкладки «Новости».",
    )
    b2b_news_sheet_url: str = Field(
        default="",
        alias="B2B_NEWS_SHEET_URL",
        description="CSV-экспорт листа новостей (fallback, если нет списка листов).",
    )
    b2b_news_sheets: str = Field(
        default="",
        alias="B2B_NEWS_SHEETS",
        description=(
            "Список листов новостей: JSON [{gid,name}] или gid:имя;gid2:имя2. "
            "Пусто — автоизвлечение из Google Sheets."
        ),
    )
    b2b_news_sheet_public_url: str = Field(
        default="",
        alias="B2B_NEWS_SHEET_PUBLIC_URL",
        description="Ссылка на таблицу новостей (кнопка «Открыть таблицу»).",
    )
    b2b_audit_retention_days: int = Field(
        default=28,
        alias="B2B_AUDIT_RETENTION_DAYS",
        description=(
            "Срок хранения истории правок и снимков версий B2B (дней). "
            "Строки таблиц не удаляются."
        ),
    )
    google_sheets_api_key: str = Field(
        default="",
        alias="GOOGLE_SHEETS_API_KEY",
        description=(
            "API-ключ Google Sheets для чтения стилей ячеек (цвет текста, заливка, "
            "частичное выделение). Пусто — fallback на XLSX-экспорт, затем CSV."
        ),
    )
    google_sheets_workbook_cache_ttl_seconds: int = Field(
        default=300,
        alias="GOOGLE_SHEETS_WORKBOOK_CACHE_TTL_SECONDS",
        description=(
            "TTL in-memory кеша листов Google Sheets на backend (сек). "
            "Кнопка «Обновить» с refresh=true обходит кеш."
        ),
    )
    google_sheets_service_account_json: str = Field(
        default="",
        alias="GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON",
        description=(
            "JSON сервисного аккаунта Google (или путь к .json) для записи "
            "в таблицу статуса продукта B2B."
        ),
    )
    outbound_http_proxy: str = Field(
        default="",
        alias="OUTBOUND_HTTP_PROXY",
        description="HTTP(S)-прокси для запросов к Google Sheets (если с сервера нет прямого доступа).",
    )
    org_uploads_dir: str = Field(
        default="/app/uploads",
        alias="ORG_UPLOADS_DIR",
        description="Локальный каталог фото сотрудников (fallback, если MinIO недоступен).",
    )
    youjail_workspace_dir: str = Field(
        default="/app/youjail-workspace",
        alias="YOUJAIL_WORKSPACE_DIR",
        description="Корень git worktree и вложений YouJail.",
    )
    youjail_executor_command: str = Field(
        default="",
        alias="YOUJAIL_EXECUTOR_COMMAND",
        description=(
            "Команда исполнителя: шаблон с {worktree_path}, {title}, {description}, {card_id}. "
            "Пусто — демо-режим (лог без реального агента)."
        ),
    )
    youjail_max_attachment_bytes: int = Field(
        default=50 * 1024 * 1024,
        alias="YOUJAIL_MAX_ATTACHMENT_BYTES",
    )
    minio_endpoint: str = Field(
        default="",
        alias="MINIO_ENDPOINT",
        description="S3-совместимый endpoint MinIO, например http://minio:9000.",
    )
    minio_access_key: str = Field(
        default="",
        alias="MINIO_ROOT_USER",
        description="Access key MinIO (MINIO_ROOT_USER).",
    )
    minio_secret_key: str = Field(
        default="",
        alias="MINIO_ROOT_PASSWORD",
        description="Secret key MinIO (MINIO_ROOT_PASSWORD).",
    )
    minio_bucket: str = Field(
        default="photos",
        alias="MINIO_BUCKET",
        description="Bucket для фото сотрудников.",
    )
    minio_public_url: str = Field(
        default="",
        alias="MINIO_PUBLIC_URL",
        description=(
            "Публичный URL MinIO для прямых ссылок на фото "
            "(например http://localhost:9000). Пусто — отдача через /api/org/photos/."
        ),
    )
    minio_region: str = Field(
        default="us-east-1",
        alias="MINIO_REGION",
        description="Регион S3-клиента (для MinIO обычно us-east-1).",
    )

    @computed_field
    @property
    def cors_origin_list(self) -> list[str]:
        origins = [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "https://tfs.t2.ru",
        ]
        app_url = self.app_public_url.rstrip("/")
        if app_url:
            origins.append(app_url)
        for item in self.cors_allow_origins.split(","):
            value = item.strip().rstrip("/")
            if value:
                origins.append(value)
        return list(dict.fromkeys(origins))

    @computed_field
    @property
    def change_request_state_list(self) -> list[str]:
        return [item.strip() for item in self.change_request_states.split(",") if item.strip()]

    @computed_field
    @property
    def start_date_field_list(self) -> list[str]:
        return [item.strip() for item in self.tfs_start_date_fields.split(",") if item.strip()]

    @computed_field
    @property
    def target_date_field_list(self) -> list[str]:
        return [item.strip() for item in self.tfs_target_date_fields.split(",") if item.strip()]

    @computed_field
    @property
    def scheduling_batch_field_list(self) -> list[str]:
        return list(
            dict.fromkeys(
                [
                    self.tfs_user_start_date_field,
                    "Microsoft.VSTS.Scheduling.TargetDate",
                    "Microsoft.VSTS.Scheduling.FinishDate",
                ]
            )
        )

    @computed_field
    @property
    def change_type_list(self) -> list[str]:
        return [item.strip() for item in self.tfs_change_type_values.split(",") if item.strip()]

    @computed_field
    @property
    def error_type_list(self) -> list[str]:
        return [item.strip() for item in self.tfs_error_type_values.split(",") if item.strip()]

    @computed_field
    @property
    def resource_reservation_type_list(self) -> list[str]:
        return [
            item.strip()
            for item in self.tfs_resource_reservation_type_values.split(",")
            if item.strip()
        ]

    @computed_field
    @property
    def ect_acceptance_type_list(self) -> list[str]:
        return [
            item.strip()
            for item in self.tfs_ect_acceptance_type_values.split(",")
            if item.strip()
        ]

    @computed_field
    @property
    def pilot_state_list(self) -> list[str]:
        return [item.strip() for item in self.tfs_pilot_state_values.split(",") if item.strip()]

    @computed_field
    @property
    def closed_state_list(self) -> list[str]:
        return [item.strip() for item in self.tfs_closed_state_values.split(",") if item.strip()]

    @computed_field
    @property
    def app_auth_users_map(self) -> dict[str, str]:
        return parse_app_users(self.app_auth_users)

    @computed_field
    @property
    def app_auth_roadmap_users_map(self) -> dict[str, str]:
        return parse_app_users(self.app_auth_roadmap_users)


settings = Settings()
