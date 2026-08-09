"""Simple progress + ETA helper."""
from __future__ import annotations

import time


class Progress:
    def __init__(self, total: int, label: str = "scan"):
        self.total = max(total, 1)
        self.label = label
        self.done = 0
        self.t0 = time.time()

    def tick(self, n: int = 1) -> str:
        self.done += n
        elapsed = max(time.time() - self.t0, 0.001)
        rate = self.done / elapsed
        left = max(self.total - self.done, 0)
        eta = left / rate if rate > 0 else 0.0
        pct = 100.0 * self.done / self.total
        return (
            f"{self.label} {self.done}/{self.total} ({pct:5.1f}%) "
            f"rate={rate:.2f}/s eta={eta:.0f}s"
        )
