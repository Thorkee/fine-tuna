import os
import sys
import time
import unittest
from typing import Any, Dict, Optional


THIS_DIR = os.path.dirname(__file__)
SERVICE_DIR = os.path.abspath(os.path.join(THIS_DIR, ".."))
if SERVICE_DIR not in sys.path:
    sys.path.insert(0, SERVICE_DIR)

import sessions  # noqa: E402
import runner  # noqa: E402


class _DummyFiles:
    def make_dir(self, path: str) -> None:
        return None


class _DummySandbox:
    last_create_kwargs: Optional[Dict[str, Any]] = None

    def __init__(self) -> None:
        self.files = _DummyFiles()
        self.set_timeout_calls: list[int] = []
        self.closed = False

    @classmethod
    def create(cls, *args, **kwargs):  # noqa: ANN001,ANN002,ANN003
        cls.last_create_kwargs = dict(kwargs)
        return cls()

    def set_timeout(self, timeout: int) -> None:
        self.set_timeout_calls.append(int(timeout))

    def close(self) -> None:
        self.closed = True


class SessionTimeoutTests(unittest.TestCase):
    def setUp(self) -> None:
        # Ensure runner env checks pass
        os.environ["E2B_API_KEY"] = "dummy"

        # Make the test deterministic and fast
        os.environ["RUNNER_SESSION_TTL_SECONDS"] = "1"
        os.environ["RUNNER_E2B_SANDBOX_TIMEOUT_SECONDS"] = "123"
        os.environ["RUNNER_E2B_SANDBOX_MAX_TIMEOUT_SECONDS"] = "999"
        os.environ["RUNNER_E2B_SANDBOX_TIMEOUT_REFRESH_MIN_SECONDS"] = "0"
        os.environ["RUNNER_E2B_PREINSTALL_COLAB_DEPS"] = "false"
        os.environ.pop("RUNNER_E2B_TEMPLATE", None)

        sessions.Sandbox = _DummySandbox  # type: ignore[assignment]
        runner.Sandbox = _DummySandbox  # type: ignore[assignment]
        self.manager = sessions.SessionManager()

    def test_create_passes_timeout_to_sandbox(self) -> None:
        entry = self.manager.create(workdir="/code")
        self.assertIsNotNone(_DummySandbox.last_create_kwargs)
        self.assertEqual(_DummySandbox.last_create_kwargs.get("timeout"), 123)
        self.assertIn(123, entry.sandbox.set_timeout_calls)

    def test_create_passes_template_when_configured(self) -> None:
        os.environ["RUNNER_E2B_TEMPLATE"] = "colab-base"
        entry = self.manager.create(workdir="/code")
        self.assertIsNotNone(_DummySandbox.last_create_kwargs)
        self.assertEqual(_DummySandbox.last_create_kwargs.get("template"), "colab-base")
        self.assertEqual(_DummySandbox.last_create_kwargs.get("timeout"), 123)
        self.assertIn(123, entry.sandbox.set_timeout_calls)

    def test_get_refreshes_timeout(self) -> None:
        entry = self.manager.create(workdir="/code")
        entry.sandbox.set_timeout_calls.clear()
        entry.sandbox_timeout_refreshed_at = 0.0
        got = self.manager.get(entry.id)
        self.assertIs(got, entry)
        self.assertIn(123, entry.sandbox.set_timeout_calls)

    def test_cleanup_skips_running_sessions(self) -> None:
        entry = self.manager.create(workdir="/code")
        entry.status = "running"
        entry.last_access = time.time() - 10
        self.manager.cleanup_expired()
        # Should still exist since it's running.
        got = self.manager.get(entry.id)
        self.assertIs(got, entry)


if __name__ == "__main__":
    unittest.main()

