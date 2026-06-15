> 🌐 [English](../../architecture/packets.md) · **Español**

# Paquetes

`loom` modela dos capas y un payload:

```
┌────────────────────────────────────────────────────┐
│ Frame   (src_addr_L2, dst_addr_L2, payload)        │  ← lo que viaja en un fabric
│   payload = Datagram                               │
└───────────────┬────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────┐
│ Datagram  (src_addr_L3, dst_addr_L3, ttl, payload) │  ← lo que sobrevive el forwarding
│   payload = Message                                │
└───────────────┬────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────┐
│ Message  (subtype-specific fields)                 │  ← los bits de aplicación
└────────────────────────────────────────────────────┘
```

`Frame`, `Message` y sus subclases de usuario/ping viven en
`src/entities/packet.py`. `Datagram` vive en `src/routing/messages.py`
(re-exportado desde `entities/packet.py` por compatibilidad). `RoutingMessage`
es una base abstracta en `src/routing/lsa.py` (también re-exportado).

## `Packet` (base)

```python
class Packet:
    def __init__(self, src_addr, dst_addr, payload):
        self._src_addr = src_addr
        self._dst_addr = dst_addr
        self._payload = payload
```

Cinco accesores/mutadores: `source()`, `destination()`, `payload()`, y los
mutadores NAT `rewrite_source(addr)` / `rewrite_destination(addr)`, que
sobreescriben la dirección almacenada en el lugar. `Frame` hereda directamente
(no agrega nada); `Datagram` lo extiende con TTL.

## `Frame`

El envelope L2. Construido por `Interface.send_to`:

```python
frame = Frame(src_addr=self._address, dst_addr=dst_addr, payload=datagram)
self._out_queue.put(frame)
```

- `src_addr` es **siempre la dirección propia de la interface** — el hop local,
  no el emisor original.
- `dst_addr` es el next hop L2 — ya sea el destino L3 (cuando el
  next hop es "directamente conectado" vía `NullAddress`) o la dirección del
  router de next hop.
- `payload` es el `Datagram`, que transporta los endpoints L3 sin cambios.

La distinción L2/L3 es lo que hace funcionar el ruteo: cada hop
re-encapsula el datagrama con nuevos `src_addr`/`dst_addr` pero no toca
el `Datagram.source()` / `Datagram.destination()` interior.

`Network._dispatch_unicast` entrega según `frame.destination()` — el
next hop L2. `Link._dispatch_packet` usa resolución de pares **estructural**:
entrega a la interface cuya `address()` **no** es `frame.source()`.
Esto es deliberadamente independiente de la dirección, para que dos links
paralelos puedan reutilizar el mismo `/30` sin interferencias.

## `Datagram`

```python
_DEFAULT_TTL = 64

class Datagram(Packet):
    def __init__(self, src_addr, dst_addr, payload, ttl=_DEFAULT_TTL):
        super().__init__(src_addr, dst_addr, payload)
        self._ttl = ttl

    def ttl(self): return self._ttl
    def decrement_ttl(self): self._ttl -= 1
```

El paquete L3. `src_addr` / `dst_addr` son los **endpoints originales**;
no cambian a medida que el datagrama es reenviado.

El manejo del TTL vive en `Router._handle_forwarding`:

```python
packet.decrement_ttl()
if packet.ttl() <= 0:
    _logger.warning("TTL expired: dropping datagram to %s", dst)
    return None
```

Dos consecuencias:

- **Los hosts no decrementan el TTL.** `Host._handle_message` es el receptor
  terminal; el TTL solo se toca en los hops de forwarding.
- **Los paquetes con TTL expirado se descartan silenciosamente** (registrados
  vía el framework estándar de logging). Sin notificación al estilo ICMP.

Cuando una búsqueda de ruta en `_handle_forwarding` falla, el router lanza:

- `NoRouteToHostException` — no hay prefijo coincidente en la tabla de ruteo.
- `NoNATEgressException` — el origen del paquete es privado pero el router
  no tiene una interface pública por la cual hacer egress.

## `Message`

```python
class Message:
    def __init__(self):
        self._id = uuid.uuid4()

    def type(self):
        return self.__class__

    def id(self):
        return self._id

    def flow_key(self) -> str:
        return str(self._id)
```

Un `Message` se identifica mediante un UUID nuevo. Dos instancias de `Message`
son iguales si y solo si tienen la misma clase **y** el mismo `_id` — importante
porque `EventTracer.register_message_event` usa el mensaje como clave de
diccionario, y el protocolo de ruteo usa números de secuencia separados de la
identidad del mensaje.

`flow_key()` devuelve un identificador estable de conversación con clave en el
payload, no en el par de direcciones del paquete. Esto significa que sobrevive
las reescrituras NAT de `src`/`dst` a lo largo del camino. Los subtipos de
solicitud/respuesta (`PingReply`) sobreescriben `flow_key()` para repetir la
clave de la solicitud de origen, de modo que ambas direcciones de una conversación
comparten un mismo id.

Cuatro subclases viven junto a la base.

### `UserMessage`

El payload de un `send` a nivel de usuario:

```python
class UserMessage(Message):
    def __init__(self, payload):
        super().__init__()
        self._payload = payload

    def payload(self):
        return self._payload
```

Creado por `Host.send_message_to` y por `cmd_send` en el terminal del host.
El `payload` es un único token de cadena. El terminal usa `shlex.split`,
por lo que se admiten comillas: `send h2 "hello world"` produce un payload de
`hello world`.

### `RoutingMessage`

`RoutingMessage` es ahora una base abstracta (`src/routing/lsa.py`). Dos
subclases concretas transportan el tráfico wire del protocolo: `LSA` y `Hello`.

#### `LSA`

```python
class LSA(RoutingMessage):
    @classmethod
    def from_router(cls, router, seq, policy) -> 'LSA': ...
    @classmethod
    def withdrawal(cls, router, seq) -> 'LSA': ...
    def __init__(self, origin, seq, is_withdrawal=False): ...
    def origin(self): return self._origin
    def seq(self): return self._seq
    def links(self): return dict(self._links)   # NetworkAddress -> cost
    def add_link(self, prefix, cost): self._links[prefix] = cost
    def is_withdrawal(self): return self._is_withdrawal
    def is_newer_than(self, other): return self._seq > other.seq()
    def has_same_links_as(self, other): return self._links == other._links
```

Originación: `LinkStateProtocol._emit_lsa_on_up_interfaces` construye
**un `LSA` compartido** por ciclo vía `LSA.from_router(router, seq,
policy)`, lo instala en el LSDB local y luego envía ese **mismo objeto**
por cada interface activa — de modo que todas las N emisiones llevan el mismo `seq`.

#### `Hello`

```python
class Hello(RoutingMessage):
    def __init__(self, originator, neighbors_heard): ...
    def originator(self): return self._originator
    def neighbors_heard(self): return list(self._neighbors_heard)
```

`_emit_hello_on_up_interfaces` construye **un `Hello` por interface**
(cada uno lleva la lista `neighbors_heard` por-fabric de esa interface).

**`seq` es por origen (un contador por router), no por interface.**
Los receptores deduplicarán en el LSDB por `(origin_router, seq)` vía
`is_newer_than`. Un refresh con los mismos links se acepta y se
re-inunda (para que los pares de aguas abajo también refresquen), pero NO
activa el recómputo SPF (`InstallResult.changed_graph()` devuelve `False`).

**Ver [`routing-protocol.md`](routing-protocol.md)** para las reglas
completas de flooding.

### `PingRequest` y `PingReply`

```python
class PingRequest(Message):
    def __init__(self, seq: int):
        super().__init__()
        self._seq = seq
        self._sent_at = _time.monotonic()
    # exposes .seq and .sent_at as @property

class PingReply(Message):
    def __init__(self, seq: int, request_ts: float, request_id=None):
        super().__init__()
        self._seq = seq
        self._request_ts = request_ts
        self._request_id = request_id
    # exposes .seq, .request_ts, .request_id as @property

    def flow_key(self) -> str:
        # Echo the originating request's UUID so request + reply share
        # one conversation key. Falls back to self._id when request_id
        # is None.
        if self._request_id is None:
            return super().flow_key()
        return str(self._request_id)
```

El flujo:

1. `Host.ping(dst, timeout)` asigna `seq = next(self._ping_seq)`,
   registra un `(str(dst), seq) → threading.Event` en `_pending_pings`,
   envía un `Datagram(payload=PingRequest(seq))`.
2. El `_handle_message` del host destino recibe un `PingRequest` y envía
   de vuelta un `PingReply(seq, request_ts=msg.sent_at)`.
3. El `_handle_message` del host originante hace coincidir la respuesta por
   `(str(packet.source()), msg.seq)`, registra
   `_ping_results[key] = time.monotonic() - msg.request_ts`, activa el evento.
4. La llamada a `ping` se despierta desde `evt.wait`, extrae el evento/resultado
   y devuelve el RTT (o `None` en caso de timeout).

**La respuesta lleva el valor `sent_at` de la solicitud** como `request_ts`.
Esto es importante: el host destino no mantiene estado por ping; simplemente
repite el timestamp de la solicitud para que el originante pueda calcular el RTT
localmente sin problemas de sincronización de reloj.

Si un host no tiene gateway y el destino está fuera de su red, `ping` lanza
`ValueError("no route to host: no gateway configured")` *antes* de enviar
nada (y la entrada en los pings pendientes se revierte).

## Clasificación de paquetes

`Interface.send_to` emite un evento `packet` con un campo `type`.
La clasificación se hace por `type(payload).__name__`:

```python
_PACKET_KIND = {
    "Hello":       "hello",
    "LSA":         "routing_flood",
    "UserMessage": "user_datagram",
    "PingRequest": "ping_request",
    "PingReply":   "ping_reply",
}
```

Las clases desconocidas reciben `"unknown"`.

Dos ids de correlación acompañan cada evento de paquete:

- `payload_id` = `str(message.id())` — identifica la dirección única de
  un flujo. Una solicitud ping y su respuesta tienen **diferentes** `payload_id`.
- `flow` = `payload.flow_key()` — el UUID estable de conversación de extremo a extremo.
  El par ping comparte el mismo `flow` (porque `PingReply.flow_key()`
  repite el UUID de la solicitud), de modo que los suscriptores pueden agrupar
  ambas direcciones. Este valor sobrevive las reescrituras NAT de `src`/`dst`
  a lo largo del camino.

Cada evento también lleva un diccionario `payload` con metadatos por subclase de Message:

| `type`          | claves de `payload`                          |
|-----------------|-----------------------------------------|
| `user_datagram` | `{"bytes": <int>}` siempre; `"text": <str>` cuando el cuerpo es una cadena |
| `ping_request`  | `{"seq": <int>}`                        |
| `ping_reply`    | `{"seq": <int>, "request_ts": <float>}` |
| `routing_flood` | `{"seq": <int>, "originator": <str>, "destinations": [{"prefix": <str>, "cost": <int>}, ...]}` |
| `hello`         | `{"originator": <str>, "neighbors_heard": [<str>, ...]}` |
| cualquier otro  | `{}`                                    |

La forma es intencionalmente libre — los tipos de mensaje futuros agregan sus
propias claves sin coordinar con los suscriptores.

### `kind: "nat"`

Emitido por un router en cada hop donde NAT reescribe las direcciones del datagrama.
Dos direcciones:

- **`outbound`** — NAT de origen en un hop de egress. Lleva `router`,
  `direction`, `original_src`, `rewritten_src`, `dst`, `flow_id` y
  `payload_id` (el UUID del mensaje interior).
- **`inbound`** — NAT de destino en un hop de ingress. Lleva `router`,
  `direction`, `rewritten_dst`, `original_dst`, `src`, `flow_id` y
  `payload_id`.

### `kind: "nat_table_changed"`

Emitido por un router después de cada registro en la tabla NAT. Lleva `device`
y `entries` — una lista de diccionarios `{rewritten_src, dst, flow_id, original_src}`
en orden LRU, el más antiguo primero.

### `kind: "router_intercept"`

Emitido por un router cuando responde a un `PingRequest` dirigido a una de
sus propias IPs de interface (vía `_reply_to_ping`). Lleva `router`,
`originator` (dirección del emisor), `pinged_address`, `received_on`
(nombre de interface por la que llegó la solicitud), `owning_iface` (nombre
de interface propietaria de la dirección pingueada, o `None`) y `payload_id`
(el UUID de la respuesta). Ver [`server-api.md`](server-api.md) para el
contrato completo del evento.

### `kind: "ping_result"`

Emitido por un host después de que cada llamada a `ping()` completa (haya
llegado la respuesta o se haya agotado el tiempo de espera). Lleva `device`
(nombre del host), `dst`, `seq` y `rtt_ms` (`float` en caso de éxito, `null`
en caso de timeout). Ver [`server-api.md`](server-api.md) para el contrato
completo del evento.

## Tiempo de vida de una entrada NAT

Las entradas NAT persisten hasta ser eliminadas por LRU al alcanzar la capacidad
(por defecto 1024 por router). No hay expiración por tiempo ni eliminación al
recibir una coincidencia entrante. Sin una capa de transporte no existe la noción
de "conexión" o "tiempo de inactividad" contra la que el simulador pudiera hacer
timeout; el LRU con el límite configurado mantiene la memoria acotada siendo
predecible. Reiniciar la simulación limpia todas las entradas.

## Multiplexación de flujos

Los flujos concurrentes desde múltiples hosts privados hacia el mismo destino
público se multiplexan mediante `nat.flow_id(payload)`, que llama a
`payload.flow_key()` — el mismo UUID de conversación usado en los eventos `packet`.
Dado que `PingReply` repite el UUID de su solicitud, solicitud y respuesta
comparten la misma entrada NAT incluso a través de reescrituras NAT.

Los tipos de mensaje sin soporte de `flow_key` (objetos arbitrarios) reciben
`flow_id=None` y comparten un único slot NAT por `(rewritten_src,
original_dst)`. Como no tienen respuesta, esto es inofensivo. Los nuevos subtipos
de mensaje solicitud/respuesta deben sobreescribir `flow_key()` para que la tabla
NAT pueda desambiguar flujos concurrentes correctamente — no depender de un
atributo `seq`.
