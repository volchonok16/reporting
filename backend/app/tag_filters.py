from dataclasses import dataclass


@dataclass(frozen=True)
class TagFilterGroup:
    key: str
    label: str
    root_tags: tuple[str, ...]
    subsection_prefixes: tuple[str, ...] = ()


TAG_FILTER_GROUPS: tuple[TagFilterGroup, ...] = (
    TagFilterGroup(
        key="newlk",
        label="newlk",
        root_tags=("LK_B2B",),
        subsection_prefixes=("lk_",),
    ),
    TagFilterGroup(
        key="site",
        label="site",
        root_tags=("site_b2b",),
        subsection_prefixes=("site_",),
    ),
)

_TAG_FILTER_GROUP_BY_KEY = {group.key: group for group in TAG_FILTER_GROUPS}


def tag_filter_group_by_key(key: str | None) -> TagFilterGroup | None:
    if not key:
        return None
    return _TAG_FILTER_GROUP_BY_KEY.get(key.strip().lower())


def normalize_tag_group_keys(keys: list[str] | None) -> list[str]:
    if not keys:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for key in keys:
        group = tag_filter_group_by_key(key)
        if group is None or group.key in seen:
            continue
        seen.add(group.key)
        normalized.append(group.key)
    return normalized


def _normalized_task_tags(tags: list[str] | tuple[str, ...] | None) -> set[str]:
    if not tags:
        return set()
    result: set[str] = set()
    for tag in tags:
        if isinstance(tag, str) and tag.strip():
            result.add(tag.strip().casefold())
    return result


def task_matches_tag_group(
    task_tags: list[str] | tuple[str, ...] | None,
    group: TagFilterGroup,
) -> bool:
    normalized = _normalized_task_tags(task_tags)
    if not normalized:
        return False

    roots = {tag.casefold() for tag in group.root_tags}
    if normalized & roots:
        return True

    prefixes = tuple(
        prefix.casefold() for prefix in group.subsection_prefixes if prefix
    )
    for tag in normalized:
        if any(tag.startswith(prefix) for prefix in prefixes):
            return True
    return False


def task_matches_tag_groups(
    task_tags: list[str] | tuple[str, ...] | None,
    group_keys: list[str],
) -> bool:
    if not group_keys:
        return True
    for key in group_keys:
        group = tag_filter_group_by_key(key)
        if group and task_matches_tag_group(task_tags, group):
            return True
    return False
