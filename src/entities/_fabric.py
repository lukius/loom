import queue
import threading
import traceback

from .base import Entity


class _FabricBase(Entity):
    """Private base class for queue-backed packet-forwarding fabrics.

    Owns the inbound queue, the gate-aware dispatch loop, and the
    lifecycle primitives (stop/join) shared by Network and future
    fabric types (e.g. Link).  Subclasses must implement
    _dispatch_packet(packet).
    """

    def __init__(self, name, gate=None):
        super().__init__(name)
        self._gate = gate
        # Keyed by interface IP address (unique per fabric), not by iface.name().
        # Interface names are only unique per-device — e.g. r1.eth0 and r2.eth0
        # both sit on the same LAN — so keying by name would clobber siblings.
        self._interfaces = dict()
        self._in_queue = queue.Queue()

        self._stopped = False
        self._pkt_thread = threading.Thread(target=self._pkt_loop, daemon=True)
        self._pkt_thread.start()

    def add_interface(self, interface):
        self._interfaces[interface.address()] = interface
        interface._set_out_queue(self._in_queue)

    def stop(self):
        for iface in self._interfaces.values():
            iface.stop()
        self._in_queue.put(None)

    def join(self):
        self._pkt_thread.join()

    def _pkt_loop(self):
        while not self._stopped:
            if self._gate is not None:
                running, stopped = self._gate.wait_or_stop()
                if stopped:
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
