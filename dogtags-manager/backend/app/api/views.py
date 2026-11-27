def source_view(source):
    result = {"id": str(source.id), "case_id": str(source.case_id), "filename": source.filename,
            "encoding": source.encoding, "sha256": source.sha256, "size_bytes": source.size_bytes,
            "inspection": source.inspection, "created_at": source.created_at.isoformat()}
    if source.metadata_version == 2:
        result['metadata_version'] = 2
        result['inspection'] = {'columns': None, 'records_count': None, 'errors': [],
                                'schema_supported': False, 'contract_version': 'uninspected-v2'}
    return result


def revision_view(revision, source, run=None):
    return {"id": str(revision.id), "case_id": str(revision.case_id), "sequence": revision.sequence,
            "assessment_id": str(revision.assessment_id) if revision.assessment_id else None,
            "parent_revision_id": str(revision.parent_revision_id) if revision.parent_revision_id else None,
            "source": source_view(source), "profile_version_id": str(revision.profile_version_id),
            "profile_snapshot": revision.profile_snapshot, "settings": revision.settings,
            "correction_overlay": revision.correction_overlay, "config_hash": revision.config_hash,
            "rules_version": revision.rules_version, "serializer_version": revision.serializer_version,
            "export_timestamp": revision.export_timestamp.isoformat(), "export_timezone": revision.export_timezone,
            "filename_components": revision.filename_components, "created_at": revision.created_at.isoformat(),
            "state": run.state if run else "DRAFT", "run_id": str(run.id) if run else None}


def case_view(case):
    return {"id": str(case.id), "title": case.title,
            "head_revision_id": str(case.head_revision_id) if case.head_revision_id else None,
            "external_state": case.external_state, "created_at": case.created_at.isoformat()}
