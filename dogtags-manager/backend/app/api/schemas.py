"""Explicit OpenAPI surface shared with generated UI types in subsequent units."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StrictBool, StrictStr, field_validator, model_validator
from fastapi import Query, Request

from app.errors import ApiError
from app.domain.rules import PARTNERS, PARTNER_NAMES, Profile


class WhitemavInnEntry(BaseModel):
    inn: str
    company_name: str


class WhitemavInnList(BaseModel):
    items: list[str]
    entries: list[WhitemavInnEntry]


class WhitemavInnNameInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    company_name: StrictStr = Field(default='', max_length=500)

    @field_validator('company_name')
    @classmethod
    def trimmed_name(cls, value):
        return value.strip()


class WhitemavInnInput(WhitemavInnNameInput):
    inn: StrictStr = Field(min_length=10, max_length=12)

    @field_validator('inn')
    @classmethod
    def valid_inn(cls, value):
        from app.domain.whitemav_inns import checked_inn
        return checked_inn(value)


class ProcessingMnemonicState(BaseModel):
    id: UUID
    code: str
    description: str
    used_by: list[PARTNERS]


class ProcessingSettingsState(BaseModel):
    token: str
    can_manage: bool
    rules_ready: bool
    profiles: dict[PARTNERS, Profile]
    mnemonics: list[ProcessingMnemonicState]


class SettingsWriteBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    expected_token: StrictStr = Field(pattern=r'^[0-9a-f]{64}$')


class MnemonicWriteBody(SettingsWriteBody):
    action: Literal['add', 'edit', 'delete']
    mnemonic_id: UUID | None = None
    code: StrictStr | None = Field(default=None, min_length=1, max_length=120)
    description: StrictStr = Field(default='', max_length=500)

    @field_validator('code')
    @classmethod
    def mnemonic_code(cls, value):
        if value is None:
            return value
        value = value.strip()
        if value.casefold() == 'none':
            raise ValueError('Для пустого имени выберите «Без оператора» в настройках партнёра.')
        if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError('Мнемоника не может быть пустой или содержать управляющие символы.')
        try:
            value.encode('cp1251')
        except UnicodeEncodeError:
            raise ValueError('Мнемоника должна поддерживать Windows-1251 выходного CSV.') from None
        return value

    @model_validator(mode='after')
    def action_fields(self):
        if self.action == 'add' and (self.mnemonic_id is not None or self.code is None):
            raise ValueError('Для добавления нужна новая мнемоника без идентификатора.')
        if self.action == 'edit' and (self.mnemonic_id is None or self.code is None):
            raise ValueError('Для редактирования нужны идентификатор и мнемоника.')
        if self.action == 'delete' and (self.mnemonic_id is None or self.code is not None or self.description):
            raise ValueError('Для удаления нужен только идентификатор мнемоники.')
        return self


class PartnerSettingsBody(SettingsWriteBody):
    profiles: dict[PARTNERS, Profile]

    @field_validator('profiles')
    @classmethod
    def all_partners(cls, value):
        if not set(PARTNER_NAMES) <= set(value):
            raise ValueError('Нужно сохранить настройки всех партнёров.')
        return value


def page_limit(request: Request, limit: int | None = Query(None, ge=1)):
    settings = request.app.state.settings
    effective = settings.page_size if limit is None else limit
    if effective > settings.max_page_size:
        raise ApiError(422, "page_limit_exceeded", "Размер страницы превышает настроенный предел.")
    return effective


class ErrorDetail(BaseModel):
    code: str
    message: str
    retryable: bool
    operation_id: UUID | None = None


class ErrorEnvelope(BaseModel):
    error: ErrorDetail
    trace_id: UUID


ERROR_RESPONSES = {status: {"model": ErrorEnvelope} for status in (400, 401, 403, 404, 409, 413, 422, 500, 503)}


class SessionUser(BaseModel):
    id: UUID
    username: str
    permissions: list[str]


class SessionState(BaseModel):
    authenticated: bool
    csrf_token: str
    expires_at: datetime
    user: SessionUser | None


class LogoutState(BaseModel):
    authenticated: Literal[False]


class InspectionError(BaseModel):
    code: str
    message: str


class SourceInspection(BaseModel):
    columns: list[str] | None
    records_count: int | None
    errors: list[InspectionError]
    schema_supported: bool
    contract_version: str


class SourceState(BaseModel):
    id: UUID
    case_id: UUID
    filename: str
    encoding: Literal["utf-8", "cp1251"]
    sha256: str
    size_bytes: int
    inspection: SourceInspection
    created_at: datetime


class IntakeSourceState(SourceState):
    """Raw receipt facts; reader inspection belongs to its immutable assessment."""
    metadata_version: Literal[2]
    encoding: None = None


class RevisionState(BaseModel):
    id: UUID
    case_id: UUID
    sequence: int
    parent_revision_id: UUID | None
    source: SourceState | IntakeSourceState
    assessment_id: UUID | None = None
    profile_version_id: UUID
    profile_snapshot: dict[str, JsonValue]
    settings: dict[str, JsonValue]
    correction_overlay: list[dict[str, JsonValue]]
    config_hash: str
    rules_version: str
    serializer_version: str
    export_timestamp: datetime
    export_timezone: str
    filename_components: dict[str, JsonValue]
    created_at: datetime
    state: str
    run_id: UUID | None


class CaseState(BaseModel):
    id: UUID
    title: str
    head_revision_id: UUID | None
    external_state: str
    created_at: datetime
    revision: RevisionState | None = None


class CasePage(BaseModel):
    items: list[CaseState]
    next_cursor: UUID | None


class ProcessingState(BaseModel):
    id: UUID
    case_id: UUID
    revision_id: UUID
    state: str
    attempt: int
    generation: int
    progress: dict[str, JsonValue]
    summary: dict[str, JsonValue]
    error: dict[str, JsonValue] | None
    next_attempt_at: datetime | None
    created_at: datetime


class ApprovalState(BaseModel):
    id: UUID
    case_id: UUID
    revision_id: UUID
    artifact_set_id: UUID
    manifest_hash: str
    author_id: UUID
    created_at: datetime


class RevisionApprovalState(BaseModel):
    revision_id: UUID
    head_revision_id: UUID | None
    current: bool
    approved: bool
    approval: ApprovalState | None


class DownloadAttemptState(BaseModel):
    attempt_id: UUID
    approval_id: UUID
    artifact_set_id: UUID
    manifest_hash: str
    sha256: str
    size_bytes: int
    attempted_at: datetime
    response_completed_at: datetime | None
    bytes_sent: int | None


class DownloadEvidenceState(BaseModel):
    revision_id: UUID
    artifact_id: UUID
    latest_attempt: DownloadAttemptState | None


class OperationResult(BaseModel):
    case: CaseState | None = None
    source: SourceState | IntakeSourceState | None = None
    revision: RevisionState | None = None
    job: 'ProcessingState | DiscoveryProcessingState | None' = None
    intake: 'IntakeState | None' = None
    version: 'IntakeVersionState | None' = None
    assessment: 'IntakeAssessmentState | None' = None
    approval: ApprovalState | None = None


class OperationFailure(BaseModel):
    status: int
    code: str
    message: str
    retryable: bool


class OperationState(BaseModel):
    id: UUID
    operation_id: UUID
    case_id: UUID | None
    action: str
    status: Literal["RUNNING", "SUCCEEDED", "FAILED"]
    result: OperationResult | None
    error: OperationFailure | None
    created_at: datetime
    completed_at: datetime | None


class CorrectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    record_id: UUID
    ordinal: int = Field(ge=1)
    field: Literal["INN", "MSISDN", "MAV_LABEL_NAME", "MAV_LABEL_LATIN", "IS_MAV", "IS_KSS",
                   "COMPANY_NAME", "COMPANY_CONTRACT", "MAV_OPERATOR_NAME", "IS_ACTIVE",
                   "SPREADING", "INTERNAL_OPERATOR_NAME", "STATUS"]
    before: StrictStr
    after: StrictStr
    reason: StrictStr = Field(default="", max_length=2000)


class ProfileOverrideInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: Literal["SPREADING", "INTERNAL_OPERATOR_NAME"]
    before: StrictStr
    after: StrictStr
    reason: StrictStr = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def nonempty_reason(cls, value):
        if not value.strip():
            raise ValueError("A reason is required.")
        return value


class RowSelectionInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    record_id: UUID
    ordinal: int = Field(ge=1)
    before: StrictBool
    excluded: StrictBool


class SaveRevisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_revision_id: UUID
    source_asset_id: UUID
    corrections: list[CorrectionInput] = Field(default_factory=list, max_length=100)
    overrides: list[ProfileOverrideInput] = Field(default_factory=list, max_length=2)
    row_selections: list[RowSelectionInput] = Field(default_factory=list, max_length=100)
    prefix_msisdn: StrictBool = Field(default_factory=lambda: False)
    bulk_labels: dict[Literal['MAV_LABEL_NAME', 'MAV_LABEL_LATIN'], StrictStr] = Field(default_factory=dict)


class StartProcessingBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_revision_id: UUID


class ApproveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_revision_id: UUID
    manifest_hash: StrictStr = Field(pattern=r"^[0-9a-f]{64}$")


class RecordIssue(BaseModel):
    field: str
    code: str
    message: str
    scope: str


class RecordState(BaseModel):
    record_id: UUID
    ordinal: int
    page_index: int
    line_start: int
    line_end: int
    raw_cells: list[str]
    issue_fields: list[str] = Field(default_factory=list)
    issues: list[RecordIssue] = Field(default_factory=list)
    effective: dict[str, str]
    disposition: Literal["included", "exact_duplicate", "excluded_error", "excluded_scientific_inn", "excluded_manual", "conflict", "agreed_skip"] | None
    duplicate_kind: str = ""
    representative_id: UUID | None = None
    representative_ordinal: int | None = None
    SPREADING: str | None = None
    INTERNAL_OPERATOR_NAME: str | None = None


class RecordPage(BaseModel):
    revision_id: UUID
    source_asset_id: UUID
    state: str
    columns: list[str] | None
    dataset_available: bool
    items: list[RecordState]
    next_cursor: int | None


class IssueState(BaseModel):
    record_id: UUID
    ordinal: int
    field: str
    code: str
    message: str
    scope: str
    page_index: int


class IssuePage(BaseModel):
    revision_id: UUID
    source_asset_id: UUID
    state: str
    available: bool
    items: list[IssueState]
    next_cursor: int | None


class ReviewState(BaseModel):
    revision_id: UUID
    source_asset_id: UUID
    state: str
    dataset_available: bool
    inspection: SourceInspection
    summary: dict[str, JsonValue] | None


class NormalizationState(BaseModel):
    field: str
    before: str
    after: str
    rule_id: str
    rule_version: str
    rule_digest: str


class RecordDetail(BaseModel):
    revision_id: UUID
    source_asset_id: UUID
    record: RecordState
    corrections: list[dict[str, JsonValue]]
    normalizations: list[NormalizationState] = Field(default_factory=list)
    issues_available: bool
    issues: list[IssueState]


class ArtifactState(BaseModel):
    database_status: Literal['IN_PROGRESS', 'LOADED'] = 'IN_PROGRESS'
    id: UUID
    role: Literal["CLIENTS", "DOGTAGS", "NUMBERS", "DELETE", "ERRORS", "ERROR_OTHER_OPERATOR", "ZIP"]
    stage: str | None = None
    download_filename: str
    sha256: str
    size_bytes: int
    row_count: int | None


class ArtifactSetState(BaseModel):
    revision_id: UUID
    state: str
    available: bool
    artifact_set_id: UUID | None
    manifest_hash: str | None
    manifest: dict[str, JsonValue] | None
    artifacts: list[ArtifactState]
    output_spec: dict[str, JsonValue] | None = None


class ArtifactPreview(BaseModel):
    revision_id: UUID
    artifact_id: UUID
    role: Literal["CLIENTS", "DOGTAGS", "NUMBERS", "DELETE", "ERRORS", "ERROR_OTHER_OPERATOR"]
    columns: list[str]
    row_count: int
    items: list[list[str]]
    next_cursor: int | None


class IntakeVersionState(BaseModel):
    id: UUID
    case_id: UUID
    intake_id: UUID
    source_asset_id: UUID
    parent_version_id: UUID | None
    sequence: int
    created_by: UUID
    decisions: dict[str, JsonValue]
    created_at: datetime


class IntakeAssessmentState(BaseModel):
    id: UUID
    case_id: UUID
    intake_id: UUID
    source_asset_id: UUID
    intake_version_id: UUID
    reader_version: str | None
    result: dict[str, JsonValue]
    questions: list[dict[str, JsonValue]]
    created_at: datetime


class IntakeState(BaseModel):
    database_status: Literal['IN_PROGRESS', 'LOADED'] = 'IN_PROGRESS'
    id: UUID
    case_id: UUID
    source_asset_id: UUID
    current_version_id: UUID | None
    current_assessment_id: UUID | None
    state: str
    created_at: datetime
    deleted_at: datetime | None = None
    worked_at: datetime | None = None


class BuildProcessingState(ProcessingState):
    kind: Literal['BUILD'] = 'BUILD'
    intake_version_id: None = None


class DiscoveryProcessingState(BaseModel):
    id: UUID
    case_id: UUID
    kind: Literal['DISCOVER']
    revision_id: None = None
    intake_version_id: UUID
    state: str
    attempt: int
    generation: int
    progress: dict[str, JsonValue]
    summary: dict[str, JsonValue]
    error: dict[str, JsonValue] | None
    next_attempt_at: datetime | None
    created_at: datetime


class CSVReaderChoice(BaseModel):
    model_config = ConfigDict(extra='forbid')
    format: Literal['csv']
    encoding: Literal['utf-8', 'utf-8-sig', 'cp1251']
    delimiter: Literal[';', ',', '\t', '|']


class ExcelReaderChoice(BaseModel):
    model_config = ConfigDict(extra='forbid')
    format: Literal['xlsx', 'xls', 'xlsb', 'numbers']
    sheet: str = Field(min_length=1, max_length=255)
    header_row: int = Field(ge=1, strict=True)
    end_row: int | None = Field(default=None, ge=1, strict=True)


class DeleteScopeSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    artifact_id: UUID
    manifest_hash: str = Field(pattern=r'^[0-9a-f]{64}$')
    confirmed: Literal[True]


class ChangeBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    expected_revision_id: UUID
    delete_scope: DeleteScopeSelection


class ChangeStageState(BaseModel):
    id: UUID
    name: Literal['DELETE', 'ADD']
    artifact_set_id: UUID
    depends_on_id: UUID | None
    artifact_ids: list[UUID]


class ChangeSourceState(BaseModel):
    artifact_id: UUID
    case_id: UUID
    revision_id: UUID
    artifact_set_id: UUID
    manifest_hash: str
    role: Literal['DELETE', 'NUMBERS']
    filename: str
    sha256: str
    row_count: int


class ChangeSourcePage(BaseModel):
    items: list[ChangeSourceState]
    next_cursor: UUID | None


class ChangeState(BaseModel):
    revision_id: UUID
    delete_scope: dict[str, JsonValue]
    stages: list[ChangeStageState]


class IntakeDecisions(BaseModel):
    model_config = ConfigDict(extra='forbid')
    partner: PARTNERS | None = None
    whitemav_inn: StrictStr | None = Field(default=None, min_length=10, max_length=12)
    reason: StrictStr | None = Field(default=None, max_length=2000)
    operation: Literal['ADD', 'DELETE', 'CHANGE', 'STATUS', 'REPAIR', 'WHITEMAV'] | None = None
    repair_role: Literal['CLIENTS', 'DOGTAGS', 'NUMBERS'] | None = None
    delete_scope: DeleteScopeSelection | None = None
    return_attempt_id: UUID | None = None
    reader: CSVReaderChoice | ExcelReaderChoice | None = None
    mapping: dict[str, int] | None = None
    missing_flags: dict[Literal["IS_MAV", "IS_KSS"], Literal["0", "1"]] | None = None

    @field_validator('mapping', mode='before')
    @classmethod
    def mapping_is_explicit(cls, value):
        from app.domain.ingress import HUB_COLUMNS
        from app.domain.output_spec import CONTRACTS
        exported = {field for contract in CONTRACTS.values() for file in contract['files'].values() for field in file['columns']}
        if value is not None and (not isinstance(value, dict) or any(
            key not in {*HUB_COLUMNS, *exported, 'STATUS'} or type(index) is not int or index < 0
            for key, index in value.items()) or len(set(value.values())) != len(value)):
            raise ValueError('Mapping requires distinct nonnegative source indices and known fields.')
        return value


class IntakeDecisionBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    expected_version_id: UUID
    decisions: IntakeDecisions


class IntakeArchiveBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    expected_version_id: UUID
    expected_deleted_at: datetime | None = None
    deleted: bool


class IntakeDatabaseStatusBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    expected_status: Literal['IN_PROGRESS', 'LOADED']
    status: Literal['IN_PROGRESS', 'LOADED']
    artifact_id: UUID | None = None


class IntakeOutputFile(BaseModel):
    database_status: Literal['IN_PROGRESS', 'LOADED'] = 'IN_PROGRESS'
    id: UUID
    role: str
    download_filename: str
    row_count: int | None


class IntakeDetail(BaseModel):
    intake: IntakeState
    version: IntakeVersionState
    assessment: IntakeAssessmentState | None
    source: IntakeSourceState
    revision: RevisionState | None
    job: BuildProcessingState | DiscoveryProcessingState | None
    output_files: list[IntakeOutputFile] = Field(default_factory=list)


class IntakePage(BaseModel):
    items: list[IntakeDetail]
    next_cursor: UUID | None


class IntakeOperationState(OperationState):
    result: IntakeDetail | None

OperationResult.model_rebuild()
OperationState.model_rebuild()


class IntakeRawPage(BaseModel):
    intake_id: UUID
    assessment_id: UUID
    source_asset_id: UUID
    columns: list[str]
    table_id: str
    items: list[dict[str, JsonValue]]
    next_cursor: int | None


def nonempty_evidence_reason(value):
    if not value.strip():
        raise ValueError('An evidence reason must not be blank.')
    return value


class ExternalAttemptBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    artifact_id: UUID
    artifact_set_id: UUID
    manifest_hash: str = Field(pattern=r'^[0-9a-f]{64}$')
    stage_id: UUID | None = None
    predecessor_ids: list[UUID] = Field(default_factory=list, max_length=100)
    reason: str = Field(min_length=1, max_length=2000)

    nonempty_reason = field_validator('reason')(nonempty_evidence_reason)


class EvidenceBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    outcome: Literal['APPLIED', 'REJECTED', 'UNKNOWN', 'PARTIAL']
    coverage: Literal['FILE', 'ROWS', 'UNKNOWN']
    export_row_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    reason: str = Field(min_length=1, max_length=2000)
    origin: Literal['MANUAL'] = 'MANUAL'
    source_asset_id: UUID | None = None
    expected_snapshot_version: int | None = Field(None, ge=0)

    nonempty_reason = field_validator('reason')(nonempty_evidence_reason)


class RegistryBatchBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    batch_size: int = Field(1000, ge=1, le=5000)
    artifact_id: UUID | None = None
    after: UUID | None = None


class EvidenceResolutionBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    entry_id: UUID
    evidence_ids: list[UUID] = Field(min_length=1, max_length=1000)
    chosen_event_id: UUID
    reason: str = Field(min_length=1, max_length=2000)
    expected_snapshot_version: int = Field(ge=0)

    nonempty_reason = field_validator('reason')(nonempty_evidence_reason)


class ExternalAttemptState(BaseModel):
    filename: str
    role: str
    case_id: UUID
    revision_id: UUID
    revision_sequence: int
    id: UUID
    artifact_id: UUID
    artifact_set_id: UUID
    stage_id: UUID
    manifest_hash: str
    owner_id: UUID
    reason: str
    predecessor_ids: list[UUID]
    created_at: datetime


class EvidenceState(BaseModel):
    return_assessment_id: UUID | None = None
    id: UUID
    attempt_id: UUID
    artifact_id: UUID
    author_id: UUID
    reason: str
    origin: Literal['MANUAL', 'RETURN']
    source_asset_id: UUID | None
    outcome: Literal['APPLIED', 'REJECTED', 'UNKNOWN', 'PARTIAL']
    coverage: Literal['FILE', 'ROWS', 'UNKNOWN']
    covered_rows: int
    snapshot_version: int
    created_at: datetime


class EvidencePage(BaseModel):
    items: list[EvidenceState]
    next_cursor: UUID | None


class ExportRowState(BaseModel):
    id: UUID
    artifact_id: UUID
    artifact_set_id: UUID
    case_id: UUID
    ordinal: int
    kind: Literal['CLIENT', 'LABEL', 'ASSIGNMENT']
    business_key: str
    values: dict[str, str]
    evidence_state: Literal['UNKNOWN', 'APPLIED', 'REJECTED', 'CONFLICT']
    coverage_state: Literal['MISSING', 'UNKNOWN', 'KNOWN', 'CONFLICT']
    revision_id: UUID
    source_asset_id: UUID


class ExportRowPage(BaseModel):
    items: list[ExportRowState]
    next_cursor: int | None
    complete: bool
    indexed_rows: int
    expected_rows: int
    snapshot_version: int


class RegistryEntryState(BaseModel):
    display_values: dict[str, str]
    id: UUID
    kind: Literal['CLIENT', 'LABEL', 'ASSIGNMENT']
    business_key: str
    prepared_count: int
    external_state: Literal['UNKNOWN', 'APPLIED', 'DELETED', 'REJECTED', 'CONFLICT']


class RegistryPage(BaseModel):
    items: list[RegistryEntryState]
    next_cursor: UUID | None
    snapshot_version: int
    complete: bool
    incomplete_artifacts: int


class RegistryBatchState(BaseModel):
    artifact_id: UUID | None = None
    cursor: int | None = None
    expected_rows: int | None = None
    artifact_complete: bool | None = None
    complete: bool
    snapshot_version: int
    next_cursor: UUID | None = None


class EvidenceResolutionState(BaseModel):
    id: UUID
    entry_id: UUID
    chosen_event_id: UUID
    reason: str
    author_id: UUID
    snapshot_version: int


class ExternalAttemptPage(BaseModel):
    items: list[ExternalAttemptState]
    next_cursor: UUID | None


class RegistrySourcePage(BaseModel):
    items: list[ExportRowState]
    next_cursor: UUID | None


class ReturnAssessmentState(BaseModel):
    id: UUID
    intake_id: UUID
    source_asset_id: UUID
    intake_version_id: UUID
    assessment_id: UUID
    artifact_id: UUID
    attempt_id: UUID
    rule_version: str
    rule_digest: str
    counts: dict[str, int]
    created_at: datetime


class ReturnResolutionState(BaseModel):
    id: UUID
    previous_id: UUID
    replacement_id: UUID
    reason: str
    snapshot_version: int
    owner_id: UUID
    created_at: datetime


class ReturnDetail(BaseModel):
    intake_id: UUID
    assessment: ReturnAssessmentState | None
    resolution: ReturnResolutionState | None
    superseded_by: ReturnResolutionState | None
    snapshot_version: int


class ReturnRowState(BaseModel):
    id: UUID
    ordinal: int
    raw_record_id: UUID | None
    raw_cells: list[str]
    raw_status: str | None
    export_row_id: UUID | None
    classification: Literal['APPLIED','REJECTED','UNKNOWN','MISSING','UNMATCHED','AMBIGUOUS','CONFLICT','INVALID']
    reason: str
    rule_version: str
    rule_digest: str
    attempt_state: Literal['APPLIED','REJECTED','UNKNOWN','CONFLICT']


class ReturnRowPage(BaseModel):
    assessment_id: UUID
    items: list[ReturnRowState]
    next_cursor: int | None
    snapshot_version: int


class ReturnHistoryPage(BaseModel):
    items: list[ReturnAssessmentState]
    next_cursor: UUID | None
