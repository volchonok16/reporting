#!/usr/bin/env python3
"""YouJail CLI — ty."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import typer

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.db import SessionLocal  # noqa: E402
from app.youjail_service import (  # noqa: E402
    create_board,
    create_card,
    get_card,
    get_execution,
    list_boards,
    load_board,
    move_card,
    start_execution,
)

app = typer.Typer(help="YouJail CLI (ty)", no_args_is_help=True)
boards_app = typer.Typer(help="Доски")
cards_app = typer.Typer(help="Карточки")
exec_app = typer.Typer(help="Запуски")
app.add_typer(boards_app, name="boards")
app.add_typer(cards_app, name="cards")
app.add_typer(exec_app, name="exec")


def _dump(data: object) -> None:
    typer.echo(json.dumps(data, ensure_ascii=False, indent=2, default=str))


@boards_app.command("list")
def boards_list() -> None:
    """Список досок."""
    with SessionLocal() as db:
        _dump(list_boards(db))


@boards_app.command("create")
def boards_create(
    name: str = typer.Argument(..., help="Название доски"),
    slug: str | None = typer.Option(None, "--slug", help="Slug (по умолчанию из названия)"),
    description: str = typer.Option("", "--description", help="Описание"),
) -> None:
    """Создать доску с колонками Backlog…Done."""
    with SessionLocal() as db:
        board = create_board(db, {"name": name, "slug": slug, "description": description})
        _dump(board)


@boards_app.command("show")
def boards_show(
    board_id: int | None = typer.Option(None, "--board-id", help="ID доски"),
    search: str | None = typer.Option(None, "--search", help="Fuzzy-поиск"),
    archived: str = typer.Option("false", "--archived", help="false | true | all"),
) -> None:
    """Показать доску (колонки и карточки)."""
    with SessionLocal() as db:
        _dump(load_board(db, board_id=board_id, search=search, archived=archived))


@cards_app.command("create")
def cards_create(
    title: str = typer.Argument(..., help="Название карточки"),
    board_id: int | None = typer.Option(None, "--board-id", help="ID доски"),
    description: str = typer.Option("", "--description", help="Markdown-заметки"),
    executor: str = typer.Option("manual", "--executor", help="Исполнитель"),
) -> None:
    """Создать карточку в Backlog."""
    with SessionLocal() as db:
        card = create_card(
            db,
            {
                "title": title,
                "descriptionMd": description,
                "boardId": board_id,
                "executor": executor,
            },
            created_by="ty-cli",
        )
        _dump(card)


@cards_app.command("show")
def cards_show(card_id: int = typer.Argument(..., help="ID карточки")) -> None:
    """Детали карточки."""
    with SessionLocal() as db:
        _dump(get_card(db, card_id))


@cards_app.command("move")
def cards_move(
    card_id: int = typer.Argument(..., help="ID карточки"),
    column_key: str = typer.Argument(..., help="Ключ колонки: backlog, in_progress, blocked, done"),
    board_id: int | None = typer.Option(None, "--board-id", help="ID доски (для поиска колонки)"),
) -> None:
    """Переместить карточку в колонку."""
    with SessionLocal() as db:
        card = get_card(db, card_id)
        board = load_board(db, board_id=board_id or card["boardId"])
        column = next((item for item in board["columns"] if item["columnKey"] == column_key), None)
        if column is None:
            raise typer.BadParameter(f"Колонка {column_key!r} не найдена на доске.")
        moved = move_card(db, card_id, column_id=column["id"], sort_order=None)
        _dump(moved)


@cards_app.command("execute")
def cards_execute(
    card_id: int = typer.Argument(..., help="ID карточки"),
    executor: str | None = typer.Option(None, "--executor", help="Исполнитель"),
    feedback: str | None = typer.Option(None, "--feedback", help="Обратная связь для retry"),
) -> None:
    """Запустить исполнителя по карточке."""
    with SessionLocal() as db:
        execution = start_execution(db, card_id, executor=executor, feedback=feedback)
        _dump(execution)


@exec_app.command("logs")
def exec_logs(execution_id: int = typer.Argument(..., help="ID запуска")) -> None:
    """Показать лог запуска."""
    with SessionLocal() as db:
        _dump(get_execution(db, execution_id, with_logs=True))


@app.command("search")
def search_cards(
    query: str = typer.Argument(..., help="Fuzzy-запрос"),
    board_id: int | None = typer.Option(None, "--board-id", help="ID доски"),
) -> None:
    """Fuzzy-поиск карточек на доске."""
    with SessionLocal() as db:
        board = load_board(db, board_id=board_id, search=query, archived="all")
        _dump({"query": query, "matches": board["cards"]})


def main() -> None:
    app()


if __name__ == "__main__":
    main()
