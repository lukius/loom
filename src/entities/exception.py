class EntityException(Exception):
    def __init__(self, message: str):
        self.message = message


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

