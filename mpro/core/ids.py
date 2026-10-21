"""UUIDv7 identifiers (RFC 9562): unique across machines and time-ordered for index locality."""

from __future__ import annotations

import os
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = 0
_seq = 0


def uuid7() -> uuid.UUID:
    """Return a UUIDv7. Monotonic within one process (12-bit counter per millisecond)."""
    global _last_ms, _seq
    with _lock:
        ms = time.time_ns() // 1_000_000
        if ms <= _last_ms:
            _seq += 1
            if _seq > 0xFFF:  # counter overflow: borrow the next millisecond
                _last_ms += 1
                _seq = 0
            ms = _last_ms
        else:
            _last_ms = ms
            _seq = int.from_bytes(os.urandom(2), "big") & 0x3FF  # random start, leaves headroom
        seq = _seq
    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    value = (ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= seq << 64
    value |= 0b10 << 62
    value |= rand_b
    return uuid.UUID(int=value)


def uuid7_time_ms(u: uuid.UUID) -> int:
    return u.int >> 80
