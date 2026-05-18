from collections import defaultdict

from entities import Host, Link, Network, NetworkDevice, Router


class ValidationResult:
    """Outcome of a validator run. `ok()` is the predicate; `reason()`
    returns the failure reason (empty string on success)."""

    @classmethod
    def valid(cls) -> 'ValidationResult':
        result = cls.__new__(cls)
        result._ok = True
        result._reason = ''
        return result

    @classmethod
    def invalid(cls, reason: str) -> 'ValidationResult':
        result = cls.__new__(cls)
        result._ok = False
        result._reason = reason
        return result

    def ok(self) -> bool:
        return self._ok

    def reason(self) -> str:
        return self._reason


class SystemValidator:

    def __init__(self, system):
        self._addr_validator = AddressValidator(system)
        self._net_validator = NetworkValidator(system)
        self._link_validator = LinkValidator(system)
        self._router_validator = DeviceValidator(system)
        self._host_validator = HostValidator(system)

    def validate_address(self, address: str) -> ValidationResult:
        return self._addr_validator.validate(address)

    def validate_network(self, net: Network) -> ValidationResult:
        return self._net_validator.validate(net)

    def validate_link(self, link) -> ValidationResult:
        return self._link_validator.validate(link)

    def validate_router(self, router: Router) -> ValidationResult:
        return self._router_validator.validate(router)

    def validate_host(self, host: Host) -> ValidationResult:
        return self._host_validator.validate(host)


class Validator:

    def __init__(self, system):
        self._system = system

    def validate(self, obj) -> ValidationResult:
        raise NotImplementedError


class AddressValidator(Validator):

    def validate(self, address: str) -> ValidationResult:
        octets = address.split('.')
        msg = f'invalid address {address}'
        if len(octets) != 4:
            return ValidationResult.invalid(msg)

        try:
            octets[0] = int(octets[0])
            octets[1] = int(octets[1])
            octets[2] = int(octets[2])
            octets[3] = int(octets[3])
        except ValueError:
            return ValidationResult.invalid(msg)

        for i in range(4):
            if octets[i] < 0 or octets[i] > 255:
                return ValidationResult.invalid(msg)

        return ValidationResult.valid()


class NetworkValidator(Validator):

    def validate(self, net: Network) -> ValidationResult:
        for _, sys_net in self._system.networks().items():
            if sys_net.name() == net.name():
                return ValidationResult.invalid('network already exists')

            if sys_net.address() == net.address():
                if not net.address().is_private():
                    return ValidationResult.invalid('network address already exists')
                # Private CIDRs are allowed to repeat; downstream NAT handles them.

        return ValidationResult.valid()


class LinkValidator(Validator):

    def validate(self, link) -> ValidationResult:
        mask = link.address().mask()
        if mask not in (30, 31):
            return ValidationResult.invalid(
                f'link CIDR must be /30 or /31, got /{mask}'
            )

        name = link.name()
        if name in self._system.networks():
            return ValidationResult.invalid('already exists as a network')

        if name in self._system.links():
            return ValidationResult.invalid('link already exists')

        return ValidationResult.valid()


class DeviceValidator(Validator):

    def validate(self, device: NetworkDevice) -> ValidationResult:
        addrs_by_net = defaultdict(lambda: set())

        for iface in device.interfaces().values():
            net = iface.network()
            addr = iface.address()

            valid = (
                net.is_valid_host_address(addr)
                if isinstance(net, Link)
                else net.contains_address(addr)
            )
            if not valid:
                return ValidationResult.invalid(
                    f'invalid address for network {net.name()}'
                )

            if self._addr_already_used(addrs_by_net, iface):
                return ValidationResult.invalid(
                    f'address already in use by {iface.name()}'
                )

            addrs_by_net[iface.network().name()].add(iface.address())

        for other in self._system.routers().values():
            for iface in other.interfaces().values():
                if self._addr_already_used(addrs_by_net, iface):
                    return ValidationResult.invalid(
                        f'address already in use by {other.name()}'
                    )

        for host in self._system.hosts().values():
            if self._addr_already_used(addrs_by_net, host):
                return ValidationResult.invalid(
                    f'address already in use by {host.name()}'
                )

        return ValidationResult.valid()

    def _addr_already_used(self, addrs_by_net, entity):
        net_name = entity.network().name()
        addr = entity.address()
        return addr in addrs_by_net[net_name]


class HostValidator(DeviceValidator):

    def validate(self, host: Host) -> ValidationResult:
        result = super().validate(host)
        if not result.ok():
            return result

        network = host.network()
        gw_address = host.gateway()
        if gw_address is not None and not network.contains_address(gw_address):
            return ValidationResult.invalid('gateway address not in host network')

        return ValidationResult.valid()
