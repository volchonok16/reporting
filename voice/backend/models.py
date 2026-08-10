from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


HEADER = (
    "order=cap_idp_location_number&CAP_DRN_CLD&CAP_DRN_CLD_BCD&"
    "cap_idp_calling_party_number"
)
NO_REGION_PREFIX = "null/$ & null/$ & null/$ &"
PANI_PREFIX_PATTERN = re.compile(r"(\+?)([0-9]+)& null/\$ & null/\$ &$")
PANI_REGION_PREFIX_PATTERN = re.compile(
    r"(\+?)([0-9]+)& D([0-9]+)\$&null&$"
)
LEGACY_PANI_REGION_PREFIX_PATTERN = re.compile(
    r"(\+?)([0-9]+)& null&D([0-9]+)\$&$"
)


def canonicalize_pani_region_prefix(value: str) -> str:
    """Return the required output layout for a PANI + region prefix."""

    if PANI_REGION_PREFIX_PATTERN.fullmatch(value) is not None:
        return value
    legacy = LEGACY_PANI_REGION_PREFIX_PATTERN.fullmatch(value)
    if legacy is None:
        return value
    sign, digits, region = legacy.groups()
    return f"{sign}{digits}& D{region}$&null&"


def validate_pani_prefix(value: str) -> None:
    combined = PANI_REGION_PREFIX_PATTERN.fullmatch(
        value
    ) or LEGACY_PANI_REGION_PREFIX_PATTERN.fullmatch(value)
    if combined is not None:
        sign, digits, region = combined.groups()
        if sign or len(digits) != 11:
            raise ValueError("PANI must contain exactly 11 digits")
        if not 1 <= int(region) <= 84:
            raise ValueError("region code must be between 1 and 84")
        return
    match = PANI_PREFIX_PATTERN.fullmatch(value)
    if match is None:
        return
    sign, digits = match.groups()
    if sign or len(digits) != 11:
        raise ValueError("PANI must contain exactly 11 digits")


class CsvSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    encoding: Literal["utf-8"] = "utf-8"
    bom: bool = False
    delimiter: str = ","
    line_ending: Literal["CRLF", "LF"] = Field("CRLF", alias="lineEnding")

    @field_validator("delimiter")
    @classmethod
    def valid_delimiter(cls, value: str) -> str:
        if len(value) != 1 or value in {'"', "\r", "\n", "\x00"}:
            raise ValueError("delimiter must be one safe character")
        return value


class TemplateSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    prefix: str | None = None
    region_code: str | None = Field(None, alias="regionCode", max_length=32)
    first_b_marker: str = Field("4:4", alias="firstBMarker")
    next_b_marker: str = Field("4", alias="nextBMarker")
    weight: str = "1"

    @field_validator("first_b_marker", "next_b_marker", "weight")
    @classmethod
    def non_empty_safe_text(cls, value: str) -> str:
        if not value or any(char in value for char in "\r\n\x00"):
            raise ValueError("template values must be non-empty single-line text")
        return value

    @field_validator("prefix")
    @classmethod
    def valid_prefix(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if (
            not value
            or any(char in value for char in "\r\n\x00")
            or not value.endswith("&")
            or value.count("&") != 3
            or "=" in value
            or ";" in value
        ):
            raise ValueError(
                "prefix must match the supported output template"
            )
        validate_pani_prefix(value)
        return value

    @field_validator("region_code")
    @classmethod
    def valid_region_code(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().removesuffix("$")
        if normalized.upper().startswith("D"):
            normalized = normalized[1:]
        if not normalized:
            return None
        if not normalized.isascii() or not normalized.isdigit():
            raise ValueError("regionCode must contain digits only")
        if not 1 <= int(normalized) <= 84:
            raise ValueError("regionCode must be between 1 and 84")
        return normalized

    @model_validator(mode="after")
    def one_prefix_source(self) -> "TemplateSettings":
        if self.prefix is not None and self.region_code is not None:
            raise ValueError("prefix and regionCode cannot be used together")
        return self

    @property
    def resolved_prefix(self) -> str:
        if self.prefix is not None:
            return self.prefix
        if self.region_code is not None:
            return f"null/$ & null&D{self.region_code}$&"
        return NO_REGION_PREFIX

    @field_validator("first_b_marker", "next_b_marker", "weight")
    @classmethod
    def no_separators(cls, value: str) -> str:
        if "," in value or ";" in value or "=" in value:
            raise ValueError("template marker values contain a reserved separator")
        return value


class InspectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sheet: str | None = None
    mode: Literal["auto", "raw", "formatted"] = "auto"
    previewRows: int | None = Field(None, ge=1)


class ManualMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aNumber: str
    bNumbers: list[str] = Field(min_length=1)


class RenameACommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fromANumber: str
    toANumber: str

    @field_validator("fromANumber")
    @classmethod
    def valid_source_a_number(cls, value: str) -> str:
        compact = "".join(char for char in value if not char.isspace())
        normalized = compact.removeprefix("+")
        if (
            not normalized
            or not normalized.isascii()
            or not normalized.isdigit()
        ):
            raise ValueError("A-number must contain digits only")
        return value

    @field_validator("toANumber")
    @classmethod
    def valid_target_a_number(cls, value: str) -> str:
        compact = "".join(char for char in value if not char.isspace())
        normalized = compact.removeprefix("+")
        if not normalized or not normalized.isascii() or not normalized.isdigit():
            raise ValueError("A-number must contain digits only")
        return value.removeprefix("+")


class MappingFormatOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aNumber: str
    prefix: str = Field(max_length=256)

    @field_validator("aNumber")
    @classmethod
    def valid_a_number(cls, value: str) -> str:
        compact = "".join(char for char in value if not char.isspace())
        normalized = compact.removeprefix("+")
        if (
            not normalized
            or not normalized.isascii()
            or not normalized.isdigit()
        ):
            raise ValueError("aNumber must contain digits only")
        return value.removeprefix("+")

    @field_validator("prefix")
    @classmethod
    def valid_mapping_prefix(cls, value: str) -> str:
        if (
            not value
            or any(char in value for char in "\r\n\x00")
            or not value.endswith("&")
            or value.count("&") != 3
            or "=" in value
            or ";" in value
        ):
            raise ValueError(
                "prefix must contain four '&'-separated fields and end with &"
            )
        validate_pani_prefix(value)
        return value


class DeleteBCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aNumber: str
    bNumbers: list[str] = Field(min_length=1)


class ConvertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    uploadId: str
    mode: Literal["raw", "formatted"]
    sheet: str | None = None
    aColumn: int = Field(0, ge=0)
    bColumn: int = Field(1, ge=0)
    keepDuplicateB: bool = False
    additions: list[ManualMapping] = Field(default_factory=list)
    renameANumbers: list[RenameACommand] = Field(default_factory=list)
    mappingFormats: list[MappingFormatOverride] = Field(default_factory=list)
    deleteANumbers: list[str] = Field(default_factory=list)
    deleteBCommands: list[DeleteBCommand] = Field(default_factory=list)
    deleteBNumbers: list[str] = Field(default_factory=list)
    deleteACommandUploadId: str | None = None
    csv: CsvSettings = Field(default_factory=CsvSettings)
    template: TemplateSettings = Field(default_factory=TemplateSettings)

    @model_validator(mode="after")
    def distinct_raw_columns(self) -> "ConvertRequest":
        if self.mode == "raw" and self.aColumn == self.bColumn:
            raise ValueError("aColumn and bColumn must be different")
        format_numbers = [item.aNumber for item in self.mappingFormats]
        if len(format_numbers) != len(set(format_numbers)):
            raise ValueError("mappingFormats contains duplicate A-numbers")
        rename_sources = [item.fromANumber for item in self.renameANumbers]
        if len(rename_sources) != len(set(rename_sources)):
            raise ValueError("renameANumbers contains duplicate source A-numbers")
        return self


class DeleteARequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    uploadId: str
    mode: Literal["raw", "formatted"] = "formatted"
    sheet: str | None = None
    aColumn: int = Field(0, ge=0)
    bColumn: int = Field(1, ge=0)
    aNumbers: list[str] = Field(default_factory=list)
    commandUploadId: str | None = None
    additions: list[ManualMapping] = Field(default_factory=list)
    csv: CsvSettings = Field(default_factory=CsvSettings)
    template: TemplateSettings = Field(default_factory=TemplateSettings)

    @model_validator(mode="after")
    def has_commands(self) -> "DeleteARequest":
        if not self.aNumbers and not self.commandUploadId:
            raise ValueError("aNumbers or commandUploadId is required")
        if self.mode == "raw" and self.aColumn == self.bColumn:
            raise ValueError("aColumn and bColumn must be different")
        return self


class DeleteBRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    uploadId: str
    mode: Literal["raw", "formatted"] = "formatted"
    sheet: str | None = None
    aColumn: int = Field(0, ge=0)
    bColumn: int = Field(1, ge=0)
    commands: list[DeleteBCommand] = Field(min_length=1)
    additions: list[ManualMapping] = Field(default_factory=list)
    csv: CsvSettings = Field(default_factory=CsvSettings)
    template: TemplateSettings = Field(default_factory=TemplateSettings)

    @model_validator(mode="after")
    def distinct_raw_columns(self) -> "DeleteBRequest":
        if self.mode == "raw" and self.aColumn == self.bColumn:
            raise ValueError("aColumn and bColumn must be different")
        return self


class MappingOptionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sheet: str | None = None
    mode: Literal["auto", "raw", "formatted"] = "auto"
    aColumn: int = Field(0, ge=0)
    bColumn: int = Field(1, ge=0)
    query: str = Field("", max_length=64)
    offset: int = Field(0, ge=0)
    limit: int = Field(100, ge=1, le=500)

    @model_validator(mode="after")
    def distinct_raw_columns(self) -> "MappingOptionsRequest":
        if self.mode == "raw" and self.aColumn == self.bColumn:
            raise ValueError("aColumn and bColumn must be different")
        return self


class Mapping(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aNumber: str
    bNumbers: list[str]
    firstSeenOrder: int
    sourcePrefix: str | None = None


class MasterImportAnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    uploadId: str
    mode: Literal["auto", "raw", "formatted"] = "auto"
    sheet: str | None = None
    aColumn: int = Field(0, ge=0)
    bColumn: int = Field(1, ge=0)

    @model_validator(mode="after")
    def distinct_raw_columns(self) -> "MasterImportAnalyzeRequest":
        if self.mode == "raw" and self.aColumn == self.bColumn:
            raise ValueError("aColumn and bColumn must be different")
        return self


class MasterMergeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conflictStrategy: Literal["keep_all", "replace_all", "selected"] = "keep_all"
    replaceConflictItemIds: list[str] = Field(default_factory=list)


class MasterRecordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aNumber: str
    bNumbers: list[str] = Field(default_factory=list)
    sourcePrefix: str | None = Field(None, max_length=256)
    comment: str | None = Field(None, max_length=1000)
    expectedVersion: int | None = Field(None, ge=1)


class MasterBatchDeleteARequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aNumbers: list[str] = Field(min_length=1, max_length=10000)


class MasterBatchDeleteBRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bNumbers: list[str] = Field(min_length=1, max_length=10000)


class MasterScopedBatchDeleteBRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aNumbers: list[str] = Field(min_length=1, max_length=10000)
    bNumbers: list[str] = Field(min_length=1, max_length=10000)


class MasterLockNotificationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["reminder", "upload_attempt"] = "reminder"


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)


class UserCreateRequest(LoginRequest):
    role: Literal["superuser", "standard"] = "standard"
    canAccessMaster: bool = False


class UserUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["superuser", "standard"] | None = None
    canAccessMaster: bool | None = None
    isActive: bool | None = None
    password: str | None = Field(None, min_length=8, max_length=256)


class PasswordChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    currentPassword: str = Field(min_length=8, max_length=256)
    newPassword: str = Field(min_length=8, max_length=256)
