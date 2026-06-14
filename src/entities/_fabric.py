import queue
import threading
import traceback
from typing import Optional

from .base import Entity
from .exception import TooManyEndpointsException

# How often (seconds) a gate-parked worker re-checks its own stop flag so
# that stop() is noticed within one poll interval rather than after the full
# join timeout.  Mirrors LinkStateProtocol._PAUSE_POLL_INTERVAL.
_PAUSE_POLL_INTERVAL = 0.1


class _FabricBase(Entity):
    """Private base class for queue-backed packet-forwarding fabrics.

    Owns the inbound queue, the gate-aware dispatch loop, and the
    lifecycle primitives (stop/join) shared by Network and future
    fabric types (e.g. Link).  Subclasses must implement
    _dispatch_packet(packet).
    """

    MAX_ENDPOINTS: Optional[int] = None

    def __init__(self, name, gate=None):
        super().__init__(name)
        self._gate = gate
        # Keyed by interface IP address (unique per fabric), not by iface.name().
        # Interface names are only unique per-device — e.g. r1.eth0 and r2.eth0
        # both sit on the same LAN — so keying by name would clobber siblings.
        self._interfaces = dict()
        self._in_queue = queue.Queue()

        self._stopped = False
        self._stop_event = threading.Event()
        self._pkt_thread = threading.Thread(target=self._pkt_loop, daemon=True)
        self._pkt_thread.start()

    def add_interface(self, interface):
        cap = self.MAX_ENDPOINTS
        if cap is not None and len(self._interfaces) >= cap:
            raise TooManyEndpointsException(self._name, interface)
        self._interfaces[interface.address()] = interface
        interface._set_out_queue(self._in_queue)

    def endpoint_count(self) -> int:
        """Return the number of interfaces (endpoints) attached to this fabric."""
        return len(self._interfaces)

    def remove_interface(self, address) -> None:
        """Detach the interface with `address` from this fabric, if present.

        Single-statement dict delete is atomic under the GIL, so this is
        safe against concurrent snapshot-reads on the dispatch hot path.
        """
        self._interfaces.pop(address, None)

    def stop(self):
        # Set the stop event BEFORE the sentinel so a gate-parked worker's
        # next poll sees the flag and exits without waiting for the gate to
        # resume.  The None sentinel wakes a worker blocked on queue.get().
        self._stop_event.set()
        for iface in list(self._interfaces.values()):
            iface.stop()
        self._in_queue.put(None)
        self._pkt_thread.join(timeout=2.0)

    def join(self):
        self._pkt_thread.join()

    def _await_gate_running(self) -> bool:
        """Block until the gate is RUNNING, or until this fabric is stopped.

        Returns True when the loop should proceed (gate running or no gate),
        False when it should exit (gate stopped, or stop() was called on this
        fabric).

        When the gate is PAUSED, polls every _PAUSE_POLL_INTERVAL seconds and
        re-checks _stop_event each time, so stop() is noticed within one poll
        interval instead of after the full join timeout.
        """
        if self._gate is None:
            return True
        while not self._stop_event.is_set():
            running, stopped = self._gate.wait_or_stop(timeout=_PAUSE_POLL_INTERVAL)
            if stopped:
                return False        # AS gate stopped
            if running:
                return True         # gate resumed — proceed
            # (False, False): timeout while paused — re-check _stop_event
        return False                # stop() set _stop_event

    def _pkt_loop(self):
        while not self._stopped:
            if not self._await_gate_running():
                self._stopped = True
                continue
            try:
                packet = self._in_queue.get(timeout=0.05)
            except queue.Empty:
                continue
            if packet is None:
                self._stopped = True
                continue
            if self._gate is not None and not self._gate.is_running():
                # Gate was paused between the check above and the dequeue:
                # put the packet back so it stays observable in the queue.
                self._in_queue.put(packet)
                continue
            try:
                self._dispatch_packet(packet)
            except Exception:
                traceback.print_exc()
