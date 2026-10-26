"""Realtime push to open browsers (0.6.0, r269). Owned by the messaging workstream (F2).

Contract used by every module:

    publish(org_id, topic, payload, user_ids=None)

`topic` is a string such as "wo:<id>", "conv:<id>", "user:<id>", "requests" or "org". Only signed-in members of
`org_id` who may see the topic receive it; `user_ids` narrows it further. Publishing never raises and never blocks
the caller's transaction: call it after commit (or from an event consumer). Until F2 lands this is a no-op.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any


def publish(
    org_id: uuid.UUID | None, topic: str, payload: dict[str, Any], user_ids: Iterable[uuid.UUID] | None = None
) -> None:
    return None
