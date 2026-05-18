import pytest

from entities.event import EventTracer


@pytest.fixture(autouse=True)
def fresh_event_tracer():
    EventTracer.set_current(EventTracer())
    yield
    EventTracer.set_current(None)   # next test re-initialises lazily via current()
