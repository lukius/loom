from .address import *
from .clock import PauseGate  # noqa: F401
from .event import *
from .exception import *
from .host import *
from .interface import *
from .link import Link  # noqa: F401
from .nat import NATTable  # noqa: F401
from .network import *
from .packet import PingReply, PingRequest  # noqa: F401
from .router import *
from .system import *


def __getattr__(name):
    # Lazily re-export symbols from the routing package so that
    # `from entities import RoutingProtocol` works without creating a
    # module-level entities ↔ routing import cycle.
    if name == 'RoutingProtocol':
        from routing import RoutingProtocol  # noqa: PLC0415
        return RoutingProtocol
    raise AttributeError(f"module 'entities' has no attribute {name!r}")

