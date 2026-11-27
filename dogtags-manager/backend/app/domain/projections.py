"""The exact output whitelist over one checked, source-ordered canonical snapshot."""
import json

from app.domain.canonical import connection
from app.domain.reconciliation import reconcile
from app.domain.output_spec import dataset_operation, dataset_spec, dataset_file_definition
from app.domain.source_inspection import CONTRACT_ROOT

OUTPUT_CONTRACT = json.loads((CONTRACT_ROOT / "output-v1.json").read_text())
OUTPUT_ORDER = tuple(OUTPUT_CONTRACT["order"])


class ProjectionFailure(Exception):
    def __init__(self, diagnostics):
        self.diagnostics = diagnostics
        super().__init__("The complete output kit requires review.")


def projection_entries(dataset, role):
    if role not in dataset_spec(dataset)['roles']:
        raise ValueError("Unsupported output projection.")
    if role in ('ERRORS', 'ERROR_OTHER_OPERATOR') and dataset.summary.get('error_source'):
        from app.domain.error_exports import error_entries, error_description
        for values, ordinal, _, messages in error_entries(dataset, role):
            if role == 'ERRORS' and dataset.summary['error_source'].get('diagnostic_column'):
                values = [*values, error_description(messages)]
            yield values, ordinal
        return
    definition = dataset_file_definition(dataset, role)
    for batch in dataset.batches(role):
        for row in batch.to_pylist():
            values = [row.get(field) for field in definition["columns"]]
            for field, value in zip(definition["columns"], values, strict=True):
                if not isinstance(value, str) or (field in definition["required"] and value == ""):
                    raise ProjectionFailure([{"code": "output_value_error", "role": role, "field": field}])
                if field in definition.get("constants", {}) and value != definition["constants"][field]:
                    raise ProjectionFailure([{"code": "output_constant_error", "role": role, "field": field}])
            yield values, row["page_index"]


def projection_rows(dataset, role):
    for values, _ in projection_entries(dataset, role):
        yield values


def verify_projections(dataset):
    if dataset.summary["blocking"]:
        raise ProjectionFailure([{"code": "dataset_blocked", "issue_counts": dataset.summary["issue_counts"],
                                  "file_errors": dataset.summary["file_errors"]}])
    with connection(memory_limit=dataset.memory_limit, threads=dataset.threads,
                    temp_directory=dataset.directory / '.projection-verification-spill') as db:
        if dataset_operation(dataset) == 'REPAIR':
            from app.domain.repair import reconcile_repair
            checked = reconcile_repair(db, dataset.directory, dataset.summary)
        elif dataset.summary.get('retry'):
            from app.domain.reconciliation import reconcile_retry
            checked = reconcile_retry(db, dataset.directory, dataset.summary)
        elif dataset_operation(dataset) == 'WHITEMAV':
            from app.domain.whitemav import reconcile_whitemav
            from app.domain.whitemav_inns import DEFAULT_INNS
            checked = reconcile_whitemav(db, dataset.directory, dataset.summary.get('whitemav_inn', DEFAULT_INNS[0]))
        elif dataset_operation(dataset) == 'DELETE':
            from app.domain.delete import reconcile_delete
            checked = reconcile_delete(db, dataset.directory)
        elif dataset_operation(dataset) == 'CHANGE':
            from app.domain.reconciliation import reconcile_change
            checked = reconcile_change(db, dataset.directory)
        else:
            checked = reconcile(db, dataset.directory)
        if dataset_spec(dataset).get('version') == 'source-output-v1':
            from app.domain.source_errors import reconcile_source_errors
            checked = reconcile_source_errors(db, dataset.directory, checked)
    if not checked["complete"]:
        raise ProjectionFailure([{"code": "projection_coverage", "reconciliation": checked}])
    counts = {role: sum(1 for _ in projection_rows(dataset, role)) for role in dataset_spec(dataset)['roles']}
    if counts != dataset.summary["counts"]:
        raise ProjectionFailure([{"code": "projection_count_mismatch"}])
    return {"counts": counts, "reconciliation": checked}
