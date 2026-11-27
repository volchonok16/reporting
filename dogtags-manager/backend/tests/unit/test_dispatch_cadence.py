"""The real dispatcher loop keeps fast delivery separate from durable recovery."""
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.processing import recovery


class StopClock(BaseException):
    pass


class Clock:
    def __init__(self):
        self.now = 0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.now >= 25:
            raise StopClock()


class DispatchCadenceTests(unittest.TestCase):
    def exercise(self, fail_first_sweep=False):
        clock = Clock()
        dispatches, sweeps = [], []
        engine = MagicMock()

        def sweep(*args):
            sweeps.append(clock.now)
            if fail_first_sweep and len(sweeps) == 1:
                raise recovery.SQLAlchemyError("Synthetic database outage")

        with patch.multiple(
            recovery,
            time=clock,
            Settings=SimpleNamespace(from_environment=lambda: SimpleNamespace(
                database_url="unused", recovery_interval_seconds=10)),
            make_engine=lambda url: engine,
            make_session_factory=lambda value: object(),
            make_celery=lambda settings: object(),
            sweep=sweep,
            dispatch_batch=lambda *args: dispatches.append(clock.now),
            logging=MagicMock(),
        ):
            with self.assertRaises(StopClock):
                recovery.main()
        engine.dispose.assert_called_once_with()
        return dispatches, sweeps

    def test_new_jobs_dispatch_each_second_without_shortening_recovery(self):
        dispatches, sweeps = self.exercise()
        self.assertEqual(dispatches, list(range(25)))
        self.assertEqual(sweeps, [0, 10, 20])

    def test_database_failure_retries_then_restores_separate_schedules(self):
        dispatches, sweeps = self.exercise(fail_first_sweep=True)
        self.assertEqual(dispatches, list(range(1, 25)))
        self.assertEqual(sweeps, [0, 1, 11, 21])


if __name__ == "__main__":
    unittest.main()
