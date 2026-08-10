from __future__ import annotations

import csv
import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Iterable

from .config import Settings
from .errors import AppError, CancelledError
from .importers import FormattedMappingImporter, importer_for
from .mapping import (
    A_HEADER_TOKENS,
    AddMappingsService,
    DeleteAService,
    DeleteBService,
    MappingBuilder,
    MappingParser,
    MappingSerializer,
    MappingSpool,
    _header_token,
)
from .models import (
    ConvertRequest,
    DeleteARequest,
    DeleteBRequest,
    TemplateSettings,
)
from .reporting import ReportWriter
from .storage import JobRecord, Registry, TERMINAL_STATUSES, UploadRecord, opaque_id
from .validation import ValidationService


logger = logging.getLogger(__name__)


class JobService:
    def __init__(self, config: Settings, registry: Registry):
        self.config = config
        self.registry = registry
        self.executor = ThreadPoolExecutor(
            max_workers=config.job_workers,
            thread_name_prefix="mapping-job",
        )
        self.validation = ValidationService(config.preview_limit)
        self._capacity = threading.BoundedSemaphore(config.job_workers * 4)
        self._cancellations: dict[str, threading.Event] = {}
        self._futures: dict[str, Future[None]] = {}
        self._lock = threading.RLock()
        self._stopping = threading.Event()
        self._cleanup_thread: threading.Thread | None = None
        self._executor_shutdown = False

    def start(self) -> None:
        if self._executor_shutdown:
            self.executor = ThreadPoolExecutor(
                max_workers=self.config.job_workers,
                thread_name_prefix="mapping-job",
            )
            self._capacity = threading.BoundedSemaphore(
                self.config.job_workers * 4
            )
            with self._lock:
                self._cancellations.clear()
                self._futures.clear()
            self._executor_shutdown = False
        self.registry.cleanup_expired()
        if self._cleanup_thread is not None and self._cleanup_thread.is_alive():
            return
        self._stopping.clear()
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop,
            name="mapping-ttl-cleanup",
            daemon=True,
        )
        self._cleanup_thread.start()

    def shutdown(self) -> None:
        self._stopping.set()
        if self._cleanup_thread is not None:
            self._cleanup_thread.join(timeout=2)
        with self._lock:
            for event in self._cancellations.values():
                event.set()
        self.executor.shutdown(wait=True, cancel_futures=True)
        self._executor_shutdown = True

    def _cleanup_loop(self) -> None:
        while not self._stopping.wait(self.config.cleanup_interval_seconds):
            try:
                self.registry.cleanup_expired()
            except Exception:
                logger.error("TTL cleanup failed")

    def _new_job(
        self,
        *,
        session_id: str,
        kind: str,
        upload_id: str,
        worker: Callable[[JobRecord, threading.Event], None],
    ) -> JobRecord:
        if not self._capacity.acquire(blocking=False):
            raise AppError(
                "JOB_QUEUE_FULL",
                "Очередь заданий заполнена, повторите попытку позже",
                status_code=503,
            )
        job_id = opaque_id()
        workspace = self.config.data_dir / "jobs" / job_id
        workspace.mkdir(parents=True, mode=0o700)
        now = time.time()
        record = JobRecord(
            id=job_id,
            session_id=session_id,
            kind=kind,
            upload_id=upload_id,
            status="queued",
            stage="В очереди",
            progress=0,
            processed_rows=0,
            total_rows=0,
            error=None,
            summary=None,
            workspace=workspace,
            result_path=workspace / "result.csv",
            report_path=workspace / "report.csv",
            created_at=now,
            updated_at=now,
            expires_at=now + self.config.object_ttl_seconds,
        )
        event = threading.Event()
        try:
            self.registry.add_job(record)
            with self._lock:
                self._cancellations[job_id] = event
                future = self.executor.submit(
                    self._run_safely, record, event, worker
                )
                self._futures[job_id] = future
            return record
        except BaseException:
            self._capacity.release()
            raise

    def _run_safely(
        self,
        record: JobRecord,
        event: threading.Event,
        worker: Callable[[JobRecord, threading.Event], None],
    ) -> None:
        try:
            if event.is_set():
                raise CancelledError
            worker(record, event)
        except CancelledError:
            record.result_path.unlink(missing_ok=True)
            self._ensure_report(record.report_path)
            self.registry.update_job(
                record.id,
                status="cancelled",
                stage="Отменено",
                progress=0,
                error=None,
            )
        except AppError as exc:
            record.result_path.unlink(missing_ok=True)
            self._ensure_report(record.report_path)
            self.registry.update_job(
                record.id,
                status="failed",
                stage="Ошибка",
                error=exc.detail,
            )
        except Exception:
            record.result_path.unlink(missing_ok=True)
            self._ensure_report(record.report_path)
            logger.error("job failed id=%s type=unexpected", record.id)
            self.registry.update_job(
                record.id,
                status="failed",
                stage="Ошибка",
                error={
                    "code": "INTERNAL_ERROR",
                    "message": "Не удалось обработать файл",
                },
            )
        finally:
            with self._lock:
                self._cancellations.pop(record.id, None)
                self._futures.pop(record.id, None)
            self._capacity.release()

    @staticmethod
    def _ensure_report(path: Path) -> None:
        if not path.exists():
            with ReportWriter(path):
                pass

    def create_convert(
        self, request: ConvertRequest, session_id: str
    ) -> JobRecord:
        upload = self.registry.get_upload(request.uploadId, session_id)
        command_upload = (
            self.registry.get_upload(request.deleteACommandUploadId, session_id)
            if request.deleteACommandUploadId
            else None
        )
        return self._new_job(
            session_id=session_id,
            kind="convert",
            upload_id=upload.id,
            worker=lambda record, event: self._convert_worker(
                record, event, upload, command_upload, request
            ),
        )

    def create_delete_a(
        self, request: DeleteARequest, session_id: str
    ) -> JobRecord:
        upload = self.registry.get_upload(request.uploadId, session_id)
        command_upload = (
            self.registry.get_upload(request.commandUploadId, session_id)
            if request.commandUploadId
            else None
        )
        return self._new_job(
            session_id=session_id,
            kind="delete-a",
            upload_id=upload.id,
            worker=lambda record, event: self._delete_a_worker(
                record, event, upload, command_upload, request
            ),
        )

    def create_delete_b(
        self, request: DeleteBRequest, session_id: str
    ) -> JobRecord:
        upload = self.registry.get_upload(request.uploadId, session_id)
        return self._new_job(
            session_id=session_id,
            kind="delete-b",
            upload_id=upload.id,
            worker=lambda record, event: self._delete_b_worker(
                record, event, upload, request
            ),
        )

    def _progress_callback(self, job_id: str) -> Callable[[int], None]:
        def update(processed: int) -> None:
            self.registry.update_job(
                job_id,
                processed_rows=processed,
                progress=min(79, 20 + processed // 10_000),
            )

        return update

    def _select_sheet(
        self,
        upload: UploadRecord,
        *,
        requested_sheet: str | None,
        requested_mode: str,
    ) -> tuple[Any, str, str]:
        importer = importer_for(upload.path, upload.format)
        analysis, mode = self.validation.choose(
            importer,
            requested_sheet=requested_sheet,
            requested_mode=requested_mode,
        )
        return importer, analysis.name, mode

    def _convert_worker(
        self,
        job: JobRecord,
        event: threading.Event,
        upload: UploadRecord,
        command_upload: UploadRecord | None,
        request: ConvertRequest,
    ) -> None:
        self.registry.update_job(
            job.id, status="inspecting", stage="Проверка структуры", progress=5
        )
        importer, sheet, _mode = self._select_sheet(
            upload,
            requested_sheet=request.sheet,
            requested_mode=request.mode,
        )
        if event.is_set():
            raise CancelledError
        self.registry.update_job(
            job.id, status="validating", stage="Валидация номеров", progress=15
        )
        with ReportWriter(job.report_path) as report, MappingSpool(
            job.workspace / "spool.sqlite3"
        ) as spool:
            builder = MappingBuilder(spool, report)
            self.registry.update_job(
                job.id, status="processing", stage="Группировка связок", progress=20
            )
            if request.mode == "raw":
                stats = builder.build_raw(
                    importer.iterateRows(sheet),
                    a_column=request.aColumn,
                    b_column=request.bColumn,
                    keep_duplicate_b=request.keepDuplicateB,
                    allow_number_whitespace=True,
                    progress=self._progress_callback(job.id),
                    cancelled=event.is_set,
                )
            else:
                stats = builder.build_formatted(
                    FormattedMappingImporter(importer).iterateRows(sheet),
                    parser=MappingParser(
                        auto_detect=True,
                        allow_mixed_templates=True,
                        allow_number_whitespace=True,
                    ),
                    keep_duplicate_b=request.keepDuplicateB,
                    progress=self._progress_callback(job.id),
                    cancelled=event.is_set,
                )
            renamed_a = 0
            rename_not_found = 0
            for command in request.renameANumbers:
                if spool.rename_a(command.fromANumber, command.toANumber):
                    renamed_a += 1
                    report.add(
                        code="A_RENAMED",
                        message=(
                            f"Опорный номер исправлен: {command.fromANumber} → "
                            f"{command.toANumber}"
                        ),
                        a_number=command.toANumber,
                    )
                else:
                    rename_not_found += 1
                    report.add(
                        code="A_RENAME_NOT_FOUND",
                        message="Опорный номер для исправления не найден",
                        a_number=command.fromANumber,
                    )
            spool.commit()
            additions = AddMappingsService().apply(
                spool,
                request.additions,
                report,
            )
            if stats["uniqueA"] == 0 and not request.additions:
                raise AppError(
                    "NO_VALID_MAPPINGS",
                    "Файл не содержит ни одной корректной связки",
                )
            delete_b = DeleteBService().apply(
                spool,
                (
                    (command.aNumber, command.bNumbers)
                    for command in request.deleteBCommands
                ),
                report,
            )
            global_delete_b = DeleteBService().apply_everywhere(
                spool,
                request.deleteBNumbers,
                report,
            )
            delete_a_commands: Iterable[Any] = request.deleteANumbers
            if command_upload is not None:
                delete_a_commands = list(request.deleteANumbers) + list(
                    self._command_numbers(command_upload)
                )
            delete_a = DeleteAService().apply(
                spool,
                delete_a_commands,
                report,
            )
            self.registry.update_job(
                job.id, status="exporting", stage="Формирование CSV", progress=85
            )
            formatted_a = sum(
                spool.contains_a(item.aNumber)
                for item in request.mappingFormats
            )
            result_rows, result_size = MappingSerializer(
                request.csv,
                request.template,
                request.mappingFormats,
            ).write(spool.iter_mappings(), job.result_path, cancelled=event.is_set)
            stats.update(
                {
                    **additions,
                    **delete_b,
                    **global_delete_b,
                    **delete_a,
                    "renamedA": renamed_a,
                    "renameANotFound": rename_not_found,
                    "customFormatsRequested": len(request.mappingFormats),
                    "customFormatsApplied": formatted_a,
                    "customFormatsNotFound": (
                        len(request.mappingFormats) - formatted_a
                    ),
                    "resultRows": result_rows,
                    "resultSize": result_size,
                    "reportRows": report.rows,
                }
            )
        self.registry.update_job(
            job.id,
            status="completed",
            stage="Готово",
            progress=100,
            processed_rows=stats["inputRows"],
            total_rows=stats["inputRows"],
            summary=stats,
            error=None,
        )

    def _load_formatted(
        self,
        job: JobRecord,
        event: threading.Event,
        upload: UploadRecord,
        report: ReportWriter,
        spool: MappingSpool,
        *,
        requested_sheet: str | None = None,
    ) -> tuple[dict[str, int], TemplateSettings]:
        importer, sheet, _mode = self._select_sheet(
            upload,
            requested_sheet=requested_sheet,
            requested_mode="formatted",
        )
        parser = MappingParser(
            auto_detect=True,
            allow_number_whitespace=True,
        )
        stats = MappingBuilder(spool, report).build_formatted(
            FormattedMappingImporter(importer).iterateRows(sheet),
            parser=parser,
            keep_duplicate_b=False,
            progress=self._progress_callback(job.id),
            cancelled=event.is_set,
        )
        if stats["uniqueA"] == 0 or parser.detected_template is None:
            raise AppError(
                "NO_VALID_MAPPINGS",
                "Файл не содержит ни одной корректной связки",
            )
        return stats, parser.detected_template

    def _load_delete_input(
        self,
        job: JobRecord,
        event: threading.Event,
        upload: UploadRecord,
        report: ReportWriter,
        spool: MappingSpool,
        *,
        mode: str,
        sheet: str | None,
        a_column: int,
        b_column: int,
    ) -> tuple[dict[str, int], TemplateSettings]:
        if mode == "formatted":
            return self._load_formatted(
                job,
                event,
                upload,
                report,
                spool,
                requested_sheet=sheet,
            )

        importer, selected_sheet, _mode = self._select_sheet(
            upload,
            requested_sheet=sheet,
            requested_mode="raw",
        )
        stats = MappingBuilder(spool, report).build_raw(
            importer.iterateRows(selected_sheet),
            a_column=a_column,
            b_column=b_column,
            keep_duplicate_b=False,
            allow_number_whitespace=True,
            progress=self._progress_callback(job.id),
            cancelled=event.is_set,
        )
        if stats["uniqueA"] == 0:
            raise AppError(
                "NO_VALID_MAPPINGS",
                "Файл не содержит ни одной корректной связки",
            )
        return stats, TemplateSettings()

    def _command_numbers(self, upload: UploadRecord) -> Iterable[Any]:
        importer = importer_for(upload.path, upload.format)
        sheet = importer.listSheets()[0]
        for row in importer.iterateRows(sheet):
            value = next(
                (
                    cell
                    for cell in row.values
                    if cell is not None and str(cell).strip()
                ),
                None,
            )
            if value is None or _header_token(value) in A_HEADER_TOKENS:
                continue
            yield value

    def _delete_a_worker(
        self,
        job: JobRecord,
        event: threading.Event,
        upload: UploadRecord,
        command_upload: UploadRecord | None,
        request: DeleteARequest,
    ) -> None:
        self.registry.update_job(
            job.id, status="inspecting", stage="Разбор готового файла", progress=5
        )
        with ReportWriter(job.report_path) as report, MappingSpool(
            job.workspace / "spool.sqlite3"
        ) as spool:
            self.registry.update_job(
                job.id, status="validating", stage="Валидация связок", progress=15
            )
            input_stats, _input_template = self._load_delete_input(
                job,
                event,
                upload,
                report,
                spool,
                mode=request.mode,
                sheet=request.sheet,
                a_column=request.aColumn,
                b_column=request.bColumn,
            )
            self.registry.update_job(
                job.id, status="processing", stage="Удаление A", progress=75
            )
            commands: Iterable[Any] = request.aNumbers
            if command_upload is not None:
                commands = list(request.aNumbers) + list(
                    self._command_numbers(command_upload)
                )
            operation = DeleteAService().apply(spool, commands, report)
            additions = AddMappingsService().apply(
                spool,
                request.additions,
                report,
            )
            self.registry.update_job(
                job.id, status="exporting", stage="Формирование CSV", progress=85
            )
            result_rows, result_size = MappingSerializer(
                request.csv, request.template
            ).write(spool.iter_mappings(), job.result_path, cancelled=event.is_set)
            summary = {
                **input_stats,
                **operation,
                **additions,
                "resultRows": result_rows,
                "resultSize": result_size,
                "reportRows": report.rows,
            }
        self.registry.update_job(
            job.id,
            status="completed",
            stage="Готово",
            progress=100,
            processed_rows=input_stats["inputRows"],
            total_rows=input_stats["inputRows"],
            summary=summary,
            error=None,
        )

    def _delete_b_worker(
        self,
        job: JobRecord,
        event: threading.Event,
        upload: UploadRecord,
        request: DeleteBRequest,
    ) -> None:
        self.registry.update_job(
            job.id, status="inspecting", stage="Разбор исходного файла", progress=5
        )
        with ReportWriter(job.report_path) as report, MappingSpool(
            job.workspace / "spool.sqlite3"
        ) as spool:
            self.registry.update_job(
                job.id, status="validating", stage="Валидация связок", progress=15
            )
            input_stats, _input_template = self._load_delete_input(
                job,
                event,
                upload,
                report,
                spool,
                mode=request.mode,
                sheet=request.sheet,
                a_column=request.aColumn,
                b_column=request.bColumn,
            )
            self.registry.update_job(
                job.id, status="processing", stage="Удаление B", progress=75
            )
            operation = DeleteBService().apply(
                spool,
                (
                    (command.aNumber, command.bNumbers)
                    for command in request.commands
                ),
                report,
            )
            additions = AddMappingsService().apply(
                spool,
                request.additions,
                report,
            )
            self.registry.update_job(
                job.id, status="exporting", stage="Формирование CSV", progress=85
            )
            result_rows, result_size = MappingSerializer(
                request.csv, request.template
            ).write(spool.iter_mappings(), job.result_path, cancelled=event.is_set)
            summary = {
                **input_stats,
                **operation,
                **additions,
                "resultRows": result_rows,
                "resultSize": result_size,
                "reportRows": report.rows,
            }
        self.registry.update_job(
            job.id,
            status="completed",
            stage="Готово",
            progress=100,
            processed_rows=input_stats["inputRows"],
            total_rows=input_stats["inputRows"],
            summary=summary,
            error=None,
        )

    def cancel(self, job_id: str, session_id: str) -> JobRecord:
        job = self.registry.get_job(job_id, session_id)
        if job.status in TERMINAL_STATUSES:
            return job
        with self._lock:
            event = self._cancellations.get(job_id)
            future = self._futures.get(job_id)
            if event is not None:
                event.set()
            if future is not None and future.cancel():
                self.registry.update_job(
                    job_id,
                    status="cancelled",
                    stage="Отменено",
                    progress=0,
                    error=None,
                )
                self._ensure_report(job.report_path)
                self._cancellations.pop(job_id, None)
                self._futures.pop(job_id, None)
                self._capacity.release()
        return self.registry.get_job(job_id, session_id)

    def preview(self, job: JobRecord, limit: int | None = None) -> dict[str, Any]:
        if job.status != "completed" or not job.result_path.is_file():
            raise AppError(
                "RESULT_NOT_READY",
                "Результат задания еще не готов",
                status_code=409,
            )
        rows: list[str] = []
        with job.result_path.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source)
            for row in reader:
                rows.append(row[0] if row else "")
                if limit is not None and len(rows) >= limit + 1:
                    break
        total_rows = int((job.summary or {}).get("resultRows", max(0, len(rows) - 1)))
        return {
            "header": rows[0] if rows else "",
            "rows": rows[1:],
            "truncated": total_rows > len(rows) - 1,
        }
