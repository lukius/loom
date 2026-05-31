import random
import statistics

from routing.scheduler import Scheduler  # _Scheduler exported as Scheduler


def test_schedule_records_interval_and_initial_deadline():
    s = Scheduler(jitter_range=(0.75, 1.25))
    s.schedule('hello', base_interval=10.0, fire_at=10.0)
    assert s.next_deadline() == 10.0


def test_next_deadline_returns_min_across_timers():
    s = Scheduler(jitter_range=(0.75, 1.25))
    s.schedule('hello', base_interval=10.0, fire_at=20.0)
    s.schedule('refresh', base_interval=30.0, fire_at=15.0)
    s.schedule('sweep', base_interval=10.0, fire_at=25.0)
    assert s.next_deadline() == 15.0


def test_elapsed_returns_due_names_and_reschedules_with_jitter():
    rng = random.Random(42)
    s = Scheduler(jitter_range=(0.75, 1.25), rng=rng)
    s.schedule('a', base_interval=10.0, fire_at=10.0)
    s.schedule('b', base_interval=20.0, fire_at=20.0)
    due = s.elapsed(now=15.0)
    assert due == ['a']
    # 'a' should be rescheduled to now + 10 * random.uniform(0.75, 1.25)
    # in (15 + 7.5, 15 + 12.5) range.
    next_a = s._deadlines['a']  # noqa: SLF001
    assert 15.0 + 7.5 <= next_a <= 15.0 + 12.5


def test_elapsed_returns_multiple_due_when_clock_jumped():
    s = Scheduler(jitter_range=(1.0, 1.0))  # no jitter
    s.schedule('a', base_interval=10.0, fire_at=10.0)
    s.schedule('b', base_interval=10.0, fire_at=15.0)
    due = s.elapsed(now=20.0)
    assert set(due) == {'a', 'b'}


def test_jitter_envelope_bounds_hold_across_many_samples():
    rng = random.Random(0)
    s = Scheduler(jitter_range=(0.75, 1.25), rng=rng)
    s.schedule('t', base_interval=10.0, fire_at=10.0)
    previous = 10.0
    deltas = []
    for i in range(1000):
        s.elapsed(now=previous)
        new = s._deadlines['t']  # noqa: SLF001
        deltas.append(new - previous)
        previous = new
    assert min(deltas) >= 7.5 - 1e-9
    assert max(deltas) <= 12.5 + 1e-9
    assert statistics.stdev(deltas) > 0  # actually has jitter


def test_seeded_rng_is_deterministic():
    s1 = Scheduler(jitter_range=(0.75, 1.25), rng=random.Random(123))
    s2 = Scheduler(jitter_range=(0.75, 1.25), rng=random.Random(123))
    s1.schedule('x', base_interval=10.0, fire_at=10.0)
    s2.schedule('x', base_interval=10.0, fire_at=10.0)
    d1, d2 = [], []
    for i in range(20):
        s1.elapsed(now=s1._deadlines['x'])  # noqa: SLF001
        s2.elapsed(now=s2._deadlines['x'])  # noqa: SLF001
        d1.append(s1._deadlines['x'])  # noqa: SLF001
        d2.append(s2._deadlines['x'])  # noqa: SLF001
    assert d1 == d2


def test_jitter_range_no_jitter_disables_randomisation():
    """jitter_range=(1.0, 1.0) is a useful test mode — every interval
    fires at exactly base_interval."""
    s = Scheduler(jitter_range=(1.0, 1.0))
    s.schedule('t', base_interval=10.0, fire_at=10.0)
    for i in range(5):
        now = s._deadlines['t']  # noqa: SLF001
        s.elapsed(now=now)
    # After 5 elapses from fire_at=10, deadline should be 10 + 5*10 = 60.
    assert s._deadlines['t'] == 60.0  # noqa: SLF001
