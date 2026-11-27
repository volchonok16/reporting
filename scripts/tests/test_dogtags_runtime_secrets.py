"""Exercise first install, restart and migration without exposing secret values."""
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("runtime_secrets", ROOT / "dogtags-manager/runtime_secrets.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class DogtagsRuntimeSecretsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.pg, self.mq = root / "pg-secrets", root / "mq-secrets"
        self.pgdata, self.mqdata = root / "pg-data", root / "mq-data"
        self.pgdata.mkdir()
        self.mqdata.mkdir()

    def initialize(self, **passwords):
        runtime.initialize(self.pg, self.mq, self.pgdata, self.mqdata,
                           uid=os.getuid(), gid=os.getgid(), **passwords)

    def test_new_install_generates_distinct_persistent_private_secrets(self):
        (self.mqdata / ".wget-hsts").write_text("Image metadata, not a queue database")
        self.initialize()
        pg, mq = (p / "password" for p in (self.pg, self.mq))
        original = (pg.read_bytes(), mq.read_bytes())
        self.assertGreaterEqual(len(original[0]), 43)
        self.assertGreaterEqual(len(original[1]), 43)
        self.assertNotEqual(*original)
        self.assertEqual(stat.S_IMODE(pg.stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE(self.pg.stat().st_mode), 0o700)
        self.initialize()
        self.assertEqual((pg.read_bytes(), mq.read_bytes()), original)

    def test_existing_install_imports_passwords_without_changing_data(self):
        (self.pgdata / "PG_VERSION").write_text("17")
        (self.mqdata / "mnesia").mkdir()
        self.initialize(postgres_password="existing-db-secret", rabbitmq_password="existing-queue-secret")
        self.assertEqual((self.pg / "password").read_text(), "existing-db-secret")
        self.assertEqual((self.mq / "password").read_text(), "existing-queue-secret")
        self.assertEqual((self.pgdata / "PG_VERSION").read_text(), "17")
        self.initialize()

    def test_existing_database_never_gets_a_new_password(self):
        (self.pgdata / "PG_VERSION").write_text("17")
        with self.assertRaisesRegex(runtime.SecretError, "POSTGRES_PASSWORD"):
            self.initialize()
        self.assertFalse((self.pg / "password").exists())

    def test_existing_queue_never_gets_a_new_password(self):
        (self.mqdata / "mnesia").mkdir()
        with self.assertRaisesRegex(runtime.SecretError, "RABBITMQ_PASSWORD"):
            self.initialize()

    def test_configuration_cannot_silently_rotate_a_saved_password(self):
        self.initialize()
        original = (self.pg / "password").read_bytes()
        with self.assertRaises(runtime.SecretError):
            self.initialize(postgres_password="replacement-must-not-be-written")
        self.assertEqual((self.pg / "password").read_bytes(), original)

    def test_secret_symlink_is_rejected(self):
        self.pg.mkdir()
        target = Path(self.tmp.name) / "outside"
        target.write_text("not-a-runtime-secret")
        (self.pg / "password").symlink_to(target)
        with self.assertRaises(runtime.SecretError):
            self.initialize()
        self.assertEqual(target.read_text(), "not-a-runtime-secret")


if __name__ == "__main__":
    unittest.main()
