"""Four local execution slots; OS ownership survives lease expiry and SIGSTOP.

Every consumer and dispatcher must share a scratch volume with working POSIX flock.
Reservation files deliberately survive process death until the next safe cleanup.
"""
import fcntl
import shutil
from contextlib import contextmanager

PROCESSING_SLOTS = 4


def _lock(stream, *, blocking=True):
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return True
    except BlockingIOError:
        return False


def _clean(root, index):
    directory = root / f"slot-{index}"
    if directory.exists():
        shutil.rmtree(directory)
    (root / f"slot-{index}.reserved").unlink(missing_ok=True)


@contextmanager
def execution_slot(settings):
    """Reserve before claim; release only after the current computation and cleanup.

All reservation accounting and orphan cleanup are serialized. An expired lease
cannot release a live/stopped process's flock; a crashed process's scratch must
be removed before its reservation is subtracted.
    """
    root = settings.scratch_root / "capacity"
    root.mkdir(parents=True, exist_ok=True)
    chosen, held = None, None
    with (root / "accounting.lock").open("a+b") as accounting:
        _lock(accounting)
        try:
            reserved, cleanup_error = 0, None
            for index in range(PROCESSING_SLOTS):
                stream = (root / f"slot-{index}.lock").open("a+b")
                if _lock(stream, blocking=False):
                    try:
                        _clean(root, index)
                    except OSError as error:
                        cleanup_error = error
                        stream.close()
                        # Keep an uncleanable owner's bytes charged; other slots
                        # may still progress when the remaining disk permits it.
                        reserved += int((root / f"slot-{index}.reserved").read_text())
                        continue
                    if held is None:
                        chosen, held = index, stream
                    else:
                        stream.close()
                else:
                    stream.close()
                    reserved += int((root / f"slot-{index}.reserved").read_text())
            if held is not None:
                if shutil.disk_usage(root).free - reserved < settings.scratch_reservation_bytes:
                    held.close()
                    held = None
                else:
                    (root / f"slot-{chosen}.reserved").write_text(str(settings.scratch_reservation_bytes))
            if held is None and cleanup_error is not None:
                raise cleanup_error
        except BaseException:
            if held is not None:
                held.close()
            raise
    try:
        yield root / f"slot-{chosen}" if held is not None else None
    finally:
        if held is not None:
            try:
                with (root / "accounting.lock").open("a+b") as accounting:
                    _lock(accounting)
                    _clean(root, chosen)
            finally:
                # Failed cleanup leaves its reservation on disk. The next owner
                # must successfully clean before either accounting or computing.
                held.close()
