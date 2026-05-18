class EntityException(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message

    def __str__(self) -> str:
        return self.message


class HostNotFoundException(EntityException):

    def __init__(self, message: str):
        message = f'host not found: {message}'
        super().__init__(message)


class RouterNotFoundException(EntityException):

    def __init__(self, message: str):
        message = f'router not found: {message}'
        super().__init__(message)


class NetworkNotFoundException(EntityException):

    def __init__(self, message: str):
        message = f'network not found: {message}'
        super().__init__(message)


class LinkNotFoundException(EntityException):

    def __init__(self, message: str):
        message = f'link not found: {message}'
        super().__init__(message)


class InvalidInterfaceException(EntityException):

    def __init__(self, dev, iface_name):
        message = f'{dev.name()}: invalid interface {iface_name}'
        super().__init__(message)


class TooManyEndpointsException(EntityException):
    """Raised when a third interface is added to a Link (max two endpoints)."""

    def __init__(self, link_name, iface):
        message = (
            f'{link_name}: cannot add interface {iface.name()}'
            ' — link already has two endpoints'
        )
        super().__init__(message)


class HostsCannotForwardException(EntityException):
    """Raised when something tries to invoke L3 forwarding on a Host.

    Hosts have a single interface and do not participate in routing.
    See docs/architecture/entities.md for the host vs router split.
    """

    def __init__(self, message: str):
        super().__init__(message)


class ASNotFoundException(EntityException):
    """Raised when Internet.autonomous_system(name) is called with an
    unknown AS name."""

    def __init__(self, message: str):
        message = f'AS not found: {message}'
        super().__init__(message)


class AddressNotInNetworkException(EntityException):
    """Raised when a lookup for an interface by address fails inside a Network.

    Indicates an invariant violation: the caller expected the address to be
    attached to this network but it is not registered.
    """

    def __init__(self, address, network_name):
        message = f'{address} not in {network_name}'
        super().__init__(message)


class InterfaceNotReadyException(EntityException):
    """Raised when an Interface tries to dispatch a frame but its device
    has not been attached yet (device is None).

    Indicates an invariant violation: frames should not arrive before the
    interface is fully wired to a device.
    """

    def __init__(self):
        super().__init__('interface not ready')

