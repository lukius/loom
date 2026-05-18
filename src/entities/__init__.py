from .address import Address as Address
from .address import NetworkAddress as NetworkAddress
from .address import NullAddress as NullAddress
from .clock import PauseGate as PauseGate
from .device import NetworkDevice as NetworkDevice
from .event import Event as Event
from .event import EventLog as EventLog
from .event import EventTracer as EventTracer
from .event import MessageEvent as MessageEvent
from .exception import ASNotFoundException as ASNotFoundException
from .exception import EntityException as EntityException
from .exception import HostNotFoundException as HostNotFoundException
from .exception import HostsCannotForwardException as HostsCannotForwardException
from .exception import LinkNotFoundException as LinkNotFoundException
from .exception import NetworkNotFoundException as NetworkNotFoundException
from .exception import RouterNotFoundException as RouterNotFoundException
from .exception import TooManyEndpointsException as TooManyEndpointsException
from .host import Host as Host
from .interface import Interface as Interface
from .link import Link as Link
from .nat import NATTable as NATTable
from .nat import flow_id as flow_id
from .network import Network as Network
from .packet import Datagram as Datagram
from .packet import Frame as Frame
from .packet import Message as Message
from .packet import Packet as Packet
from .packet import PingReply as PingReply
from .packet import PingRequest as PingRequest
from .packet import RoutingMessage as RoutingMessage
from .packet import UserMessage as UserMessage
from .router import MatchingResult as MatchingResult
from .router import Router as Router
from .router import RoutingRule as RoutingRule
from .router import RoutingTable as RoutingTable
from .system import AS as AS
from .system import Internet as Internet


# BGP-FOLLOWUP: this PEP 562 lazy lookup is paired with the deferred import
# in entities/router.py's Router.__init__. Remove both together once protocol
# construction moves out of Router.__init__ — see entities/router.py for the
# fix plan.
def __getattr__(name):
    # Lazily re-export symbols from the routing package so that
    # `from entities import RoutingProtocol` works without creating a
    # module-level entities ↔ routing import cycle.
    if name == 'RoutingProtocol':
        from routing import RoutingProtocol  # noqa: PLC0415
        return RoutingProtocol
    raise AttributeError(f"module 'entities' has no attribute {name!r}")

