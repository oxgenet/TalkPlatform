"""Worker (L Harness) へのイベント送信。失敗しても通話は止めない (best-effort + バッファ)。"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import aiohttp

log = logging.getLogger("talk-agent.worker")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class WorkerClient:
    def __init__(self, base_url: str, secret: str, room: str) -> None:
        self.base_url = base_url
        self.secret = secret
        self.room = room
        self._seq = 0
        self._buf: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self._session: aiohttp.ClientSession | None = None
        self._flush_task: asyncio.Task | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.secret)

    async def start(self) -> None:
        if not self.enabled:
            log.warning("worker client disabled (TALK_WORKER_URL / CALL_AGENT_SECRET unset)")
            return
        self._session = aiohttp.ClientSession(headers={"Authorization": f"Bearer {self.secret}"})
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def close(self) -> None:
        if self._flush_task:
            self._flush_task.cancel()
        await self.flush()
        if self._session:
            await self._session.close()

    def add_transcript(self, role: str, text: str) -> None:
        if not text.strip():
            return
        self._seq += 1
        self._buf.append({"seq": self._seq, "role": role, "text": text, "at": now_iso()})

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(2.0)
            await self.flush()

    async def flush(self) -> None:
        if not self.enabled or not self._buf:
            return
        async with self._lock:
            items, self._buf = self._buf, []
            ok = await self._post({"type": "transcript", "items": items})
            if not ok:
                self._buf = items + self._buf  # 次回再送

    async def handoff_request(self, reason: str, by: str = "agent") -> bool:
        return await self._post({"type": "handoff_request", "reason": reason, "by": by})

    async def resume_ai(self) -> bool:
        return await self._post({"type": "resume_ai"})

    async def summary(self, text: str) -> bool:
        return await self._post({"type": "summary", "text": text})

    async def _post(self, event: dict[str, Any]) -> bool:
        if not self.enabled or not self._session:
            return False
        try:
            async with self._session.post(
                f"{self.base_url}/api/public/calls/agent-event",
                json={"room": self.room, "event": event},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as res:
                if res.status >= 300:
                    log.warning("agent-event %s -> %s %s", event["type"], res.status, await res.text())
                    return False
                return True
        except Exception as e:  # noqa: BLE001
            log.warning("agent-event %s failed: %s", event["type"], e)
            return False
