from __future__ import annotations

import asyncio
import logging
import os
import select
import subprocess
import sys
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import WebSocket

logger = logging.getLogger(__name__)

HAS_PTY = sys.platform != "win32"
if HAS_PTY:
    import fcntl
    import pty
    import struct
    import termios

_main_loop: asyncio.AbstractEventLoop | None = None


def set_main_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _main_loop
    _main_loop = loop


class TerminalBroker:
    def __init__(self) -> None:
        self._subscribers: dict[int, set[WebSocket]] = {}
        self._lock = threading.Lock()

    def subscribe(self, execution_id: int, websocket: WebSocket) -> None:
        with self._lock:
            self._subscribers.setdefault(execution_id, set()).add(websocket)

    def unsubscribe(self, execution_id: int, websocket: WebSocket) -> None:
        with self._lock:
            subscribers = self._subscribers.get(execution_id)
            if subscribers is None:
                return
            subscribers.discard(websocket)
            if not subscribers:
                self._subscribers.pop(execution_id, None)

    def _schedule_broadcast(self, execution_id: int, data: bytes) -> None:
        if _main_loop is None or _main_loop.is_closed():
            return
        asyncio.run_coroutine_threadsafe(self._broadcast(execution_id, data), _main_loop)

    async def _broadcast(self, execution_id: int, data: bytes) -> None:
        with self._lock:
            subscribers = list(self._subscribers.get(execution_id, set()))
        dead: list[WebSocket] = []
        for websocket in subscribers:
            try:
                await websocket.send_bytes(data)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.unsubscribe(execution_id, websocket)


terminal_broker = TerminalBroker()


class ActivePtySession:
    def __init__(self, execution_id: int) -> None:
        self.execution_id = execution_id
        self.master_fd: int | None = None
        self.process: subprocess.Popen[str] | None = None
        self._input_lock = threading.Lock()

    def write_input(self, data: bytes) -> None:
        if self.master_fd is None:
            return
        with self._input_lock:
            try:
                os.write(self.master_fd, data)
            except OSError:
                logger.debug("PTY write failed execution_id=%s", self.execution_id, exc_info=True)

    def resize(self, rows: int, cols: int) -> None:
        if not HAS_PTY or self.master_fd is None:
            return
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)


_active_sessions: dict[int, ActivePtySession] = {}
_sessions_lock = threading.Lock()


def register_session(session: ActivePtySession) -> None:
    with _sessions_lock:
        _active_sessions[session.execution_id] = session


def unregister_session(execution_id: int) -> None:
    with _sessions_lock:
        _active_sessions.pop(execution_id, None)


def get_session(execution_id: int) -> ActivePtySession | None:
    with _sessions_lock:
        return _active_sessions.get(execution_id)


def write_execution_input(execution_id: int, data: bytes) -> bool:
    session = get_session(execution_id)
    if session is None:
        return False
    session.write_input(data)
    return True


def resize_execution_terminal(execution_id: int, rows: int, cols: int) -> bool:
    session = get_session(execution_id)
    if session is None:
        return False
    session.resize(rows, cols)
    return True


def _emit_output(execution_id: int, data: bytes, on_text_line: Callable[[str, str], None]) -> None:
    terminal_broker._schedule_broadcast(execution_id, data)
    try:
        text = data.decode("utf-8", errors="replace")
    except Exception:
        text = data.decode("latin-1", errors="replace")
    for line in text.splitlines():
        if line:
            on_text_line("pty", line)


def run_command_with_pty(
    execution_id: int,
    command: str,
    *,
    cwd: str | None,
    on_text_line: Callable[[str, str], None],
) -> int:
    if not HAS_PTY:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
        )
        if completed.stdout:
            for line in completed.stdout.splitlines():
                on_text_line("stdout", line)
                terminal_broker._schedule_broadcast(execution_id, (line + "\n").encode("utf-8"))
        if completed.stderr:
            for line in completed.stderr.splitlines():
                on_text_line("stderr", line)
                terminal_broker._schedule_broadcast(execution_id, (line + "\n").encode("utf-8"))
        return completed.returncode

    master_fd, slave_fd = pty.openpty()
    session = ActivePtySession(execution_id)
    session.master_fd = master_fd
    register_session(session)

    process = subprocess.Popen(
        command,
        shell=True,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        cwd=cwd,
        close_fds=True,
        env={**os.environ, "TERM": "xterm-256color"},
    )
    session.process = process
    os.close(slave_fd)

    try:
        while process.poll() is None:
            readable, _, _ = select.select([master_fd], [], [], 0.1)
            if master_fd not in readable:
                continue
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            _emit_output(execution_id, chunk, on_text_line)

        while True:
            readable, _, _ = select.select([master_fd], [], [], 0)
            if master_fd not in readable:
                break
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            _emit_output(execution_id, chunk, on_text_line)

        return int(process.wait())
    finally:
        unregister_session(execution_id)
        try:
            os.close(master_fd)
        except OSError:
            pass
