"""HTTP helpers with jittered retries."""
from __future__ import annotations

import random
import time
from typing import Any

import requests


def request_json(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    params: Any = None,
    json_body: Any = None,
    timeout: int = 25,
    retry_max: int = 3,
    retry_base_ms: int = 400,
) -> dict | list | None:
    last_err: Exception | None = None
    for attempt in range(max(1, retry_max)):
        try:
            r = requests.request(
                method,
                url,
                headers=headers or {},
                params=params,
                json=json_body,
                timeout=timeout,
            )
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP {r.status_code}")
            if not r.ok:
                return None
            data = r.json()
            # JSON-RPC error payloads still return HTTP 200
            if isinstance(data, dict) and data.get("error"):
                return None
            return data
        except Exception as e:
            last_err = e
            if attempt + 1 >= retry_max:
                break
            base = retry_base_ms / 1000.0
            time.sleep(base + random.random() * base * 0.5)
    _ = last_err
    return None
