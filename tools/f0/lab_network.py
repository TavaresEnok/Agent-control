"""Read-only IPAM preflight and label-verified ownership for disposable labs."""
import ipaddress
import json

LABEL = "agent-control.fixture"


def cidr(value):
    try:
        network = ipaddress.IPv4Network(value, strict=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("Explicit canonical RFC1918 IPv4 CIDR required (/24..28)") from exc
    private = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    if str(network) != value or not 24 <= network.prefixlen <= 28 or not any(
            network.subnet_of(ipaddress.IPv4Network(block)) for block in private):
        raise ValueError("Explicit canonical RFC1918 IPv4 CIDR required (/24..28)")
    return network


def preflight(value, call):
    """call accepts argv; all operations here are read-only and fail closed."""
    network = cidr(value)
    ids = call("docker", "network", "ls", "--quiet").split()
    if ids:
        for existing in json.loads(call("docker", "network", "inspect", *ids)):
            for config in (existing.get("IPAM", {}).get("Config") or []):
                subnet = config.get("Subnet")
                if subnet:
                    allocated = ipaddress.ip_network(subnet, strict=False)
                    if allocated.version == 4 and network.overlaps(allocated):
                        raise ValueError("Laboratory CIDR overlaps Docker IPAM")
    # Include all routing tables, not only main; default routes do not reserve pools.
    for route in json.loads(call("ip", "-j", "-4", "route", "show", "table", "all")):
        destination = route.get("dst")
        if destination in ("default", "0.0.0.0/0"):
            continue
        if not destination:
            raise ValueError("Unrecognized host route")
        if network.overlaps(ipaddress.IPv4Network(destination, strict=False)):
            raise ValueError("Laboratory CIDR overlaps host route")
    return str(network)


class Ownership:
    """Never adopt a name: identify resources by this invocation's random label + ID.

    A daemon may create a resource even when the client loses its response. Probe
    after both success and failure; a foreign name collision remains unowned.
    """
    def __init__(self, call, token):
        self.call, self.token = call, token
        self.resources = {}

    def inspect(self, kind, name):
        data = json.loads(self.call("docker", kind, "inspect", name))[0]
        labels = data.get("Config", {}).get("Labels", {}) if kind == "container" else data.get("Labels", {})
        if (labels or {}).get(LABEL) != self.token:
            raise ValueError("Resource ownership label mismatch")
        identity = data.get("Id") or data.get("ID")
        if kind == "volume":
            identity = data.get("Name")
        if not identity:
            raise ValueError("Missing resource identity")
        return identity, data

    def create(self, kind, name, *args):
        try:
            return self.call("docker", *args)
        finally:
            try:
                identity, _ = self.inspect(kind, name)
                self.resources[(kind, name)] = identity
            except Exception:
                # Do not mask a failed create or claim ownership without evidence.
                pass

    def require(self, kind, name):
        if (kind, name) not in self.resources:
            raise RuntimeError("Creation ownership not confirmed")

    def remove(self, kind, name):
        identity = self.resources[(kind, name)]
        current, _ = self.inspect(kind, identity)
        if current != identity:
            raise ValueError("Resource identity changed")
        if kind == "container":
            self.call("docker", "rm", "-f", identity)
        else:
            self.call("docker", kind, "rm", identity)

    def receipt(self):
        return [{"kind": kind, "name": name, "id": identity}
                for (kind, name), identity in self.resources.items()]


def runtime(data):
    """Allowlist only: never retain Config.Env or a full inspect."""
    return {"id": data["Id"], "NetworkSettings": data["NetworkSettings"], "State": data["State"],
            "limits": {key: data["HostConfig"].get(key) for key in
                       ("Memory", "NanoCpus", "PidsLimit", "PortBindings", "SecurityOpt", "CapDrop")}}
