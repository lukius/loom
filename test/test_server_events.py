import asyncio

import pytest

from server.events import EventBus


@pytest.mark.asyncio
async def test_subscribe_and_emit_delivers_event():
    bus = EventBus(loop=asyncio.get_running_loop())
    q = bus.subscribe()
    bus.emit({"kind": "x"})
    event = await asyncio.wait_for(q.get(), timeout=0.5)
    assert event == {"kind": "x"}


@pytest.mark.asyncio
async def test_two_subscribers_receive_both():
    bus = EventBus(loop=asyncio.get_running_loop())
    q1 = bus.subscribe()
    q2 = bus.subscribe()
    bus.emit({"kind": "e"})
    e1 = await asyncio.wait_for(q1.get(), timeout=0.5)
    e2 = await asyncio.wait_for(q2.get(), timeout=0.5)
    assert e1 == e2 == {"kind": "e"}


@pytest.mark.asyncio
async def test_overflow_drops_oldest():
    bus = EventBus(loop=asyncio.get_running_loop(), max_queue=2)
    q = bus.subscribe()
    bus.emit({"i": 1})
    bus.emit({"i": 2})
    bus.emit({"i": 3})  # should drop {"i":1}
    await asyncio.sleep(0.05)
    items = []
    while not q.empty():
        items.append(q.get_nowait())
    # tolerate ordering: at least the newest must be present, oldest dropped
    assert {"i": 3} in items
    assert {"i": 1} not in items


@pytest.mark.asyncio
async def test_unsubscribe_removes_queue():
    bus = EventBus(loop=asyncio.get_running_loop())
    q = bus.subscribe()
    bus.unsubscribe(q)
    bus.emit({"kind": "y"})
    await asyncio.sleep(0.05)
    assert q.empty()
