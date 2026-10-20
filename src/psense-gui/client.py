"""JSON-over-unix-socket client for psensed + background pollers.

Protocol identical to the CLI (`src/psense::daemon_req`): newline-delimited
JSON request -> single JSON response. All daemon traffic runs on worker
threads; the GUI thread never blocks.
"""
from __future__ import annotations

import json
import socket
from threading import Event

from PySide6.QtCore import (QObject, QRunnable, QThread, QThreadPool,
                            Signal, Slot)


SOCKET_PATH = "/run/psense.sock"


def request(op: dict, sock: str = SOCKET_PATH, timeout: float = 20.0):
    """One-shot synchronous request. Returns dict or None on failure."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(sock)
        s.sendall((json.dumps(op) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        s.close()
        return json.loads(data.decode())
    except (FileNotFoundError, ConnectionRefusedError, socket.timeout, OSError):
        return None


class _PollWorker(QObject):
    """Poll one op on an interval (runs inside its QThread); emits dicts."""

    data = Signal(dict)

    def __init__(self, op: dict, interval_ms: int, sock: str = SOCKET_PATH):
        super().__init__()
        self.op, self.interval, self.sock = op, interval_ms, sock
        self.stop = Event()

    @Slot()
    def run(self) -> None:
        while not self.stop.wait(max(self.interval / 1000.0, 0.25)):
            r = request(self.op, self.sock)
            if r is not None:
                self.data.emit(r)


class Poller(QObject):
    """Owner of a polling thread; `data` emits on its worker thread → UI slots run queued (thread-safe)."""

    def __init__(self, op: dict, interval_ms: int, parent=None):
        super().__init__(parent)
        self.thread = QThread(self)
        self.worker = _PollWorker(op, interval_ms)
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.run)
        self.data = self.worker.data

    def connect_to(self, slot) -> None:
        """Connect the worker's data signal to a UI slot (queued across threads)."""
        self.data.connect(slot)

    def start(self) -> None:
        self.thread.start()

    def stopPoller(self) -> None:
        self.worker.stop.set()
        self.thread.quit()
        self.thread.wait(1500)


class _OpSignalHolder(QObject):
    done = Signal(dict)


class OpJob(QRunnable):
    """One-off op queued on QThreadPool; emits done(dict) on the UI thread."""

    def __init__(self, op: dict, sock: str = SOCKET_PATH):
        super().__init__()
        self.op, self.sock = op, sock
        self.signals = _OpSignalHolder()

    @Slot()
    def run(self) -> None:
        r = request(self.op, self.sock)
        self.signals.done.emit(r if isinstance(r, dict) else {"op": "?", "error": "daemon unreachable"})


def run_op(op: dict, on_done, sock: str = SOCKET_PATH) -> None:
    """Queue an op; on_done(dict) is invoked (queued) on the caller's thread."""
    job = OpJob(op, sock)
    job.signals.done.connect(on_done)
    QThreadPool.globalInstance().start(job)
