"""Общая фикстура: кэш досок ЗНИ для тестов без БД."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Позволяет импортировать boards_fixtures при запуске из корня репозитория.
_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from app.boards import clear_boards_cache
from boards_fixtures import install_default_boards


@pytest.fixture(autouse=True)
def _install_zni_boards_cache() -> None:
    install_default_boards()
    yield
    clear_boards_cache()
