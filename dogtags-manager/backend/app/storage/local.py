import errno
import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from starlette.concurrency import run_in_threadpool

from app.errors import ApiError

CHUNK_BYTES = 64 * 1024


class StorageFailure(Exception):
    """Classified without exposing a filesystem path or source content."""


@dataclass
class StagedObject:
    path: Path | None
    sha256: str
    size_bytes: int
    failed: bool = False


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root

    async def stage_upload(self, upload, max_bytes):
        digest, size, output, path, failed = hashlib.sha256(), 0, None, None, False
        try:
            directory = self.root / ".staging" / uuid4().hex
            try:
                await run_in_threadpool(directory.mkdir, parents=True)
                path = directory / "raw"
                output = await run_in_threadpool(path.open, "xb")
            except OSError:
                failed = True
            while chunk := await upload.read(CHUNK_BYTES):
                size += len(chunk)
                if size > max_bytes:
                    raise ApiError(413, "file_too_large", "Размер файла превышает настроенный лимит.")
                digest.update(chunk)
                if output and not failed:
                    try:
                        await run_in_threadpool(output.write, chunk)
                    except OSError:
                        failed = True
            if output and not failed:
                try:
                    await run_in_threadpool(output.flush)
                    await run_in_threadpool(os.fsync, output.fileno())
                except OSError:
                    failed = True
        except BaseException:
            if output:
                try:
                    await run_in_threadpool(output.close)
                except OSError:
                    pass
                output = None
            await run_in_threadpool(self.discard, StagedObject(path, "", size))
            raise
        finally:
            if output:
                try:
                    await run_in_threadpool(output.close)
                except OSError:
                    failed = True
        return StagedObject(path, digest.hexdigest(), size, failed)

    def key_for_hash(self, sha256):
        if not re.fullmatch(r"[0-9a-f]{64}", sha256):
            raise StorageFailure()
        return f"objects/sha256/{sha256[:2]}/{sha256}"

    def path_for_key(self, key):
        if not re.fullmatch(r"objects/sha256/([0-9a-f]{2})/([0-9a-f]{64})", key):
            raise StorageFailure()
        parts = key.split("/")
        if parts[2] != parts[3][:2]:
            raise StorageFailure()
        return self.root / key

    def verify(self, key, sha256, size_bytes):
        path = self.path_for_key(key)
        digest, size = hashlib.sha256(), 0
        try:
            with path.open("rb") as stream:
                while chunk := stream.read(CHUNK_BYTES):
                    digest.update(chunk)
                    size += len(chunk)
        except OSError:
            raise StorageFailure() from None
        if size != size_bytes or digest.hexdigest() != sha256:
            raise StorageFailure()
        return path

    def publish(self, staged):
        if staged.failed or not staged.path:
            raise StorageFailure()
        key = self.key_for_hash(staged.sha256)
        destination = self.path_for_key(key)
        copied = None
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            try:
                try:
                    os.link(staged.path, destination)  # Atomic no-clobber publication on the artifact volume.
                except OSError as error:
                    if error.errno != errno.EXDEV:
                        raise
                    copied = self._copy_to_artifact_volume(staged)
                    os.link(copied.path, destination)
            except FileExistsError:
                self.verify(key, staged.sha256, staged.size_bytes)
            self._fsync_directory(destination.parent)
            self._fsync_directory(destination.parent.parent)
            self._fsync_directory(destination.parent.parent.parent)
            self._fsync_directory(self.root)
        except OSError:
            raise StorageFailure() from None
        finally:
            if copied:
                self.discard(copied)
        return key

    def _copy_to_artifact_volume(self, staged):
        """Scratch and artifact volumes may differ; final publication remains atomic."""
        directory = self.root / ".staging" / uuid4().hex
        directory.mkdir(parents=True)
        path = directory / "publish"
        copied = StagedObject(path, staged.sha256, staged.size_bytes)
        digest, size = hashlib.sha256(), 0
        try:
            with staged.path.open("rb") as source, path.open("xb") as target:
                while chunk := source.read(CHUNK_BYTES):
                    target.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                target.flush()
                os.fsync(target.fileno())
            if digest.hexdigest() != staged.sha256 or size != staged.size_bytes:
                raise StorageFailure()
            return copied
        except BaseException:
            self.discard(copied)
            raise

    @staticmethod
    def _fsync_directory(directory):
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def discard(self, staged):
        if staged.path:
            try:
                staged.path.unlink(missing_ok=True)
                staged.path.parent.rmdir()
            except OSError:
                pass  # Unreferenced staging is never served; cleanup must not mask the result.
