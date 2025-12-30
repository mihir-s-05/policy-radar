import asyncio
from typing import Optional


class ChatCancellationManager:
    def __init__(self) -> None:
        self._events: dict[str, asyncio.Event] = {}
        self._cancelled: set[str] = set()
        self._lock = asyncio.Lock()

    async def register(self, request_id: str) -> asyncio.Event:
        async with self._lock:
            event = asyncio.Event()
            if request_id in self._cancelled:
                event.set()
                self._cancelled.discard(request_id)
            self._events[request_id] = event
            return event

    async def cancel(self, request_id: str) -> bool:
        async with self._lock:
            event = self._events.get(request_id)
            if event:
                event.set()
                return True
            self._cancelled.add(request_id)
            return True

    async def clear(self, request_id: str) -> None:
        async with self._lock:
            self._events.pop(request_id, None)
            self._cancelled.discard(request_id)

    async def get(self, request_id: str) -> Optional[asyncio.Event]:
        async with self._lock:
            return self._events.get(request_id)


_CANCELLATION_MANAGER: Optional[ChatCancellationManager] = None


def get_chat_cancellation_manager() -> ChatCancellationManager:
    global _CANCELLATION_MANAGER
    if _CANCELLATION_MANAGER is None:
        _CANCELLATION_MANAGER = ChatCancellationManager()
    return _CANCELLATION_MANAGER
