from collections import defaultdict

from entities import Network, Router, Host


class ValidationResult(object):

    def ok(self):
        raise NotImplementedError

    def reason(self):
        raise NotImplementedError


class ValidationFailure(ValidationResult):

    def __init__(self, reason):
        self._reason = reason

    def ok(self):
        return False

    def reason(self):
        return self._reason


class ValidationSuccess(ValidationResult):

    def ok(self):
        return True


class SystemValidator(object):

    def __init__(self, system):
        self._addr_validator = AddressValidator(system)
        self._net_validator = NetworkValidator(system)
        self._router_validator = RouterValidator(system)
        self._host_validator = HostValidator(system)

    def validate_address(self, address: str) -> ValidationResult:
        return self._addr_validator.validate(address)

    def validate_network(self, net: Network) -> ValidationResult:
        return self._net_validator.validate(net)

    def validate_router(self, router: Router) -> ValidationResult:
        return self._router_validator.validate(router)

    def validate_host(self, host: Host) -> ValidationResult:
        return self._host_validator.validate(host)


class Validator(object):

    def __init__(self, system):
        self._system = system

    def validate(self, obj) -> ValidationResult:
        raise NotImplementedError


class AddressValidator(Validator):

    def validate(self, address: str) -> ValidationResult:
        octets = address.split('.')
        msg = f'invalid address {address}'
        if len(octets) != 4:
            return ValidationFailure(msg)

        try:
            octets[0] = int(octets[0])
            octets[1] = int(octets[1])
            octets[2] = int(octets[2])
            octets[3] = int(octets[3])
        except ValueError:
            return ValidationFailure(msg)

        for i in range(4):
            if octets[i] < 0 or octets[i] > 255:
                return ValidationFailure(msg)

        return ValidationSuccess()


class NetworkValidator(Validator):

    def validate(self, net: Network) -> ValidationResult:
        for _, sys_net in self._system.networks():
            if sys_net.name() == net.name():
                return ValidationFailure(f'network already exists')

            if sys_net.address() == net.address():
                return ValidationFailure(f'network address already exists')

        return ValidationSuccess()


class RouterValidator(Validator):

    def validate(self, router: Router) -> ValidationResult:
        addrs_by_net = defaultdict(lambda: set())

        for iface in router.interfaces().values():
            net = iface.network()
            addr = iface.address()

            if not net.contains(addr):
                return ValidationFailure(f'invalid address for network {net.name()}')

            if self._addr_already_used(addrs_by_net, iface):
                return ValidationFailure(f'address already in use by {iface.name()}')

            addrs_by_net[iface.network().name()].add(iface.address())

        for other in self._system.routers().values():
            for iface in other.interfaces().values():
                if self._addr_already_used(addrs_by_net, iface):
                    return ValidationFailure(f'address already in use by {other.name()}')

        for host in self._system.hosts().values():
            if self._addr_already_used(addrs_by_net, host):
                return ValidationFailure(f'address already in use by {host.name()}')

        return ValidationSuccess()

    def _addr_already_used(self, addrs_by_net, entity):
        net_name = entity.network().name()
        addr = entity.address()
        return addr in addrs_by_net[net_name]


class HostValidator(Validator):

    def validate(self, host: Host) -> ValidationResult:
        pass

