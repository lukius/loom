> 🌐 [English](../../architecture/entities.md) · **Español**

# Entidades

El modelo de dominio del simulador reside en `src/entities/`. Cada clase aquí
es un objeto Python normal — no hay ORM, ni esquema, ni framework. La instancia
`AS` es la raíz única que posee todo lo demás.

```
Entity (base.py)
├── AS                  (system.py)        ── contenedor raíz
├── NetworkDevice       (device.py)
│   ├── Router          (router.py)        ── reenvía datagrams
│   └── Host            (host.py)          ── endpoint; no puede hacer forwarding
├── _FabricBase         (_fabric.py)       ── base privada para fabrics de paquetes
│   ├── Network         (network.py)       ── LAN multi-acceso
│   └── Link            (link.py)          ── punto a punto /30 o /31
└── Interface           (interface.py)     ── conecta un dispositivo a un fabric

Address / NetworkAddress (address.py)     ── primitivas IPv4 + CIDR
NullAddress              (constant)        ── centinela "directamente conectado"
```

El resto de este documento recorre cada clase — propósito, métodos clave,
invariantes y las trampas en las que se cae si se las ignora.

---

## `Entity` (`base.py`)

```python
class Entity:
    def __init__(self, name):
        self._name = name

    def name(self):
        return self._name
```

La clase base más simple posible. Solo le da un nombre a todo. No extenderla
con magia de metaclases — la mitad del código asume que `obj.name()` es barato
y nunca lanza excepciones.

---

## `AS` (`system.py`)

El sistema autónomo. Uno por proceso. Posee:

- `_networks`, `_links`, `_routers`, `_hosts` — dicts identificados por nombre
  de entidad.
- `_gate: PauseGate` — el **único** pause gate en el que bloquea cada hilo
  worker de este AS.

Métodos de búsqueda:

| Método | Comportamiento |
|---|---|
| `network(name)` | Lanza `NetworkNotFoundException` si no existe |
| `link(name)` | Lanza `LinkNotFoundException` |
| `router(name)` | Lanza `RouterNotFoundException` |
| `host(name)` | Lanza `HostNotFoundException` |
| `device(name)` | Intenta `host(name)`, recurre a `router(name)` — usado por las rutas `/devices/{name}` de la API |

Mutación:

- `add_network`, `add_link`, `add_host` — directos.
- `add_router(r)` — también inyecta `r._as_gate = self._gate` para que el hilo
  de protocolo del router haga gate en el mismo `PauseGate` que el resto.

Ciclo de vida:

- `stop()` en cascada: señaliza el gate como detenido, detiene cada red, link
  y router. Cada router detiene su hilo `LinkStateProtocol`.

El AS nunca sabe nada del servidor FastAPI ni del bus de eventos.
`SimState` lo envuelve, pero el AS en sí es un objeto Python puro que se puede
instanciar en un test unitario.

---

## `Address` y `NetworkAddress` (`address.py`)

`BaseAddress` parsea la notación dotted-quad en `self._octets`. `Address` es
la forma de host; `NetworkAddress(address)` parsea `"a.b.c.d/M"` y
**canonicaliza** los octetos — los bits de host se ponen a cero en la
construcción:

```python
NetworkAddress("10.1.2.3/24")  # canonicalized to 10.1.2.0/24
```

Métodos importantes de `Address`:

- `is_private()` — `True` si y solo si la dirección cae dentro de un rango
  RFC 1918 (10/8, 172.16/12, 192.168/16).

Métodos importantes de `NetworkAddress`:

- `mask()` — la longitud del prefijo (`int`).
- `matches(addr)` / `contains(addr)` — `True` si `addr` está dentro de este
  prefijo. (Son idénticos; existen ambos nombres.)
- `broadcast()` — devuelve la `Address` de broadcast
  (`NetworkAddress("10.1.2.0/24").broadcast()` → `Address("10.1.2.255")`).
- `is_private()` — mismo test RFC 1918, aplicado a la dirección de red en sí.

`NullAddress = Address('0.0.0.0')` es un **centinela a nivel de módulo** usado
por `RoutingTable` para indicar "este destino está en una red directamente
conectada — entregar a `packet.destination()` directamente, sin next-hop
de indirección". No comparar con `is`; el operador `Address.__eq__` lo maneja.

---

## `NetworkDevice` (`device.py`)

Base común para `Host` y `Router`. Mantiene `self._interfaces` identificado
por `iface.name()` (dentro de un dispositivo, nombres como `eth0` son únicos).

Método clave: **`handle_packet(packet, interface)`** — llamado por el loop de
paquetes del `Interface`. Descarta paquetes que llegan por una interface
admin-down, luego decide si el paquete es *para mí* o necesita forwarding:

```python
def handle_packet(self, packet, interface):
    if not interface.is_up():
        return  # ingress interface administratively down — drop
    dst = packet.destination()
    net_broadcast_addr = interface.network().broadcast_address()
    own_addresses = {iface.address() for iface in list(self._interfaces.values())}
    if dst in own_addresses or dst == net_broadcast_addr:
        self._handle_message(packet.payload(), interface, packet)
    else:
        self._handle_forwarding(packet)
```

El conjunto `own_addresses` compara el destino con **cualquiera** de las
interfaces del dispositivo, no solo aquella por la que llegó el paquete — así
es como un `PingRequest` dirigido a la IP del lado lejano de un router llega
a `_handle_message` en lugar de ser reenviado de vuelta hacia sí mismo.
La verificación de dirección broadcast permite que los floods del protocolo de
ruteo lleguen a `_handle_message` en lugar de ser reenviados recursivamente.

La igualdad se basa en `(class, name)` — `Host('h1') != Router('h1')`.

---

## `Router` (`router.py`)

Un `NetworkDevice` más un `RoutingTable` más un `LinkStateProtocol`. Cuatro
responsabilidades:

1. **Reenviar datagrams.** `_handle_forwarding(packet)`:
   - Decrementar TTL; descartar via `_logger.warning(...)` si `<= 0`.
   - `routing_table.match(dst)` → `MatchingResult`.
   - Si no hay coincidencia, lanza `NoRouteToHostException`, o
     `NoNATEgressException` cuando el origen es privado pero el router no tiene
     una interface pública por la que salir.
   - Si `next_hop is NullAddress`, sustituir `packet.destination()` como el
     next hop real (el destino está en la red directamente conectada).
   - Entregar el datagram a `out_iface.send_to(packet, next_hop)` y emitir
     `EventTracer.datagram_forwarded`.

2. **Aplicar NAT de origen/destino** en los límites privado↔público. En
   salida (origen privado cruzando a una egress pública), reescribe el origen
   y registra el flujo en el `NATTable` por router; emite eventos `nat`
   (salida) y `nat_table_changed`. En entrada (destino público llegando desde
   una interface pública), revierte la reescritura usando la tabla NAT; emite
   `nat` (entrada). Ver [`packets.md`](packets.md) para las formas de los
   eventos.

3. **Hablar el protocolo de ruteo.** `_handle_routing_message` itera
   `self.protocols()` (cada uno un `LinkStateProtocol`) y llama a
   `handle_incoming_message`. Un `PingRequest` dirigido a cualquiera de las
   IPs de interface propias del router es respondido por `_reply_to_ping`,
   que emite un evento `router_intercept` y envía de vuelta un `PingReply`.
   `PingReply` se descarta silenciosamente — los routers no inician pings.

4. **Ejecutar el protocolo.** `start()` y `stop()` iteran `self.protocols()`
   y conmutan el hilo de cada protocolo. `halt(graceful=True)` floodea un LSA
   de retiro (graceful) o silenciosamente desactiva todas las interfaces
   (crash), luego emite `device_state_changed`. `resume()` reactiva interfaces,
   re-anuncia mediante cada protocolo y emite `device_state_changed`.
   `disable_interface(name)` / `enable_interface(name)` activan o desactivan
   interfaces individuales (con re-anuncio graceful opcional).

El `RoutingTable` (definido en el mismo archivo) es una lista de
`RoutingRule(prefix, next_hop, interface)` con cuatro operaciones bajo un único
`Lock`: `add_rule`, `clear`, `remove_rule`, `rules()`, y **`match`** que hace
longest-prefix-match lineal. Lineal está bien para la escala del simulador;
no introducir un trie a menos que el profiling lo indique.

`match` devuelve un `MatchingResult`. Construir via
`MatchingResult.matched(next_hop, interface)` (acierto) o
`MatchingResult.not_matched()` (fallo); consultar via `is_matched()`.
Los accesores `next_hop()` e `interface()` devuelven `None` en caso de fallo.

---

## `Host` (`host.py`)

Un `NetworkDevice` con **exactamente una** `Interface` y un `Address` de
gateway opcional. No puede hacer forwarding — `_handle_forwarding` lanza
excepción.

Los métodos interesantes:

- **`send_message_to(msg, addr)`** — envuelve `msg` en un `Datagram` con
  TTL=64, elige el destino L2 (el destino en sí si está en la misma red,
  de lo contrario el gateway), lo empuja a la interface y emite
  `EventTracer.message_sent`.
- **`set_gateway(addr)`** — debe estar dentro de la red del host, si no
  lanza `ValueError`. El comando `set_gateway` del terminal pasa por aquí.
- **`ping(dst_addr, timeout=3.0)`** — síncrono desde el punto de vista del
  caller:
  1. Asigna una clave por flujo `(dst, seq)`, registra un
     `threading.Event`, envía un `PingRequest`.
  2. Llama a `evt.wait(timeout)`.
  3. Cuando llega el `PingReply` correspondiente, `_handle_message` registra
     `rtt = time.monotonic() - request_ts` y activa el evento.
  4. Devuelve el RTT o `None` en caso de timeout.

  El estado por flujo reside en `_pending_pings` y `_ping_results`, ambos
  protegidos por `_ping_lock`. `_ping_seq` es un `itertools.count` para que
  los números de secuencia aumenten monotónicamente entre llamadas.

Si un host no tiene gateway y el destino está fuera de su red,
`send_message_to` y `ping` lanzan
`ValueError("no route to host: no gateway configured")`.

---

## `Interface` (`interface.py`)

Una `Interface` conecta un `NetworkDevice` a un `_FabricBase` (una `Network`
o `Link`). Posee:

- `_address`, `_cost`, `_net` (el fabric), `_device` (configurado luego por
  el dispositivo).
- `_in_queue` — frames que llegan **desde** el fabric.
- `_out_queue` — frames que van **hacia** el fabric (configurado por el fabric
  en `add_interface`).
- `_pkt_thread` — daemon que vacía `_in_queue` y despacha a
  `_device.handle_packet`.

Ciclo de vida en el hilo entrante (`_pkt_loop`):

1. `frame = self._in_queue.get()` (bloqueante)
2. Si `frame is None` → marcar como detenido y salir.
3. Llamar a `_await_gate_running()` (delega a `clock.wait_for_gate`);
   si devuelve `False` → marcar como detenido y salir.
4. Si `self._device is None` → lanzar `InterfaceNotReadyException`.
5. `device.handle_packet(frame.payload(), self)`.
   Las excepciones se capturan y registran para que el loop sobreviva frames
   incorrectos.

`_await_gate_running()` sondea `wait_for_gate(self._gate, self._stop_event)`:
devuelve `True` para continuar, `False` para salir. Este es el patrón
**dequeue-then-gate** — no gate-then-dequeue — por lo que un frame que ya fue
extraído de la cola se procesa cuando el gate se reabre, en lugar de volver a
encolarse.

Ciclo de vida en el lado saliente (`send_to`):

```python
def send_to(self, datagram: Datagram, dst_addr: Address):
    if not self._up:
        return  # administratively down — do not transmit
    frame = Frame(src_addr=self._address, dst_addr=dst_addr, payload=datagram)
    self._out_queue.put(frame)
    # plus: emit EventTracer "packet" event (see below)
```

El dict de evento incluye tanto un **`payload_id`** (identifica de forma única
una instancia de Message — una dirección) como una clave **`flow`** (el
identificador de conversación end-to-end reportado por el payload via
`Message.flow_key()`). El flujo es un **UUID de conversación estable** con
clave en el payload — no en los números de secuencia del paquete ni en el par
de direcciones del paquete — por lo que sobrevive a las reescrituras NAT de
src/dst al cruzar los límites privado↔público. `PingReply` sobreescribe
`flow_key` para repetir el id del `PingRequest` que lo originó, de modo que
un único ping (request + reply, incluso a través de NAT) reporta un único
flujo. El mismo valor es el discriminador de la tabla NAT (ver
`entities/nat.py::flow_id`), de modo que dos hosts privados con números de
secuencia colisionantes cada uno obtiene su propia entrada NAT.

Dos campos se derivan para que `Frame.source()` sea válido en el código de
resolución de peers del fabric:

- `frame.source()` es **siempre** la dirección propia de la interface — el
  hop L2, no el origen L3 original.
- `frame.destination()` es el next-hop L2, no el destino L3.
- `frame.payload() = Datagram` lleva el origen / destino L3 reales.

Por eso `Network._dispatch_unicast` usa `dst_addr` como clave (que es el
next-hop L2) y `Link._dispatch_packet` usa "el que no es el origen"
(resolución estructural de peers, inmune a colisiones de IP entre diferentes
links — ver [`link.py:75`](../../../src/entities/link.py)).

---

## `_FabricBase` (`_fabric.py`) — privada

Base compartida para `Network` y `Link`. Posee:

- `_interfaces` — identificada por **dirección IP de interface**, no por
  `iface.name()`. Los nombres de interface solo son únicos por dispositivo
  (`r1.eth0` y `r2.eth0` pueden estar en la misma LAN); identificar por nombre
  colisionaría con peers.
- `_in_queue` — frames que llegan desde la outbound queue de cualquier
  interface conectada.
- `_pkt_thread` — daemon que vacía y llama a `_dispatch_packet`.

El `_pkt_loop` es **gate-then-dequeue**: verifica el gate primero, luego
intenta un dequeue con timeout corto. Si el gate fue pausado entre la
verificación y el dequeue, el paquete se vuelve a poner en la cola para que
permanezca en ella mientras la simulación está pausada — no se emiten eventos
`packet` para frames que aún no fueron despachados.

Las subclases deben implementar `_dispatch_packet(packet)`.

---

## `Network` (`network.py`)

Una LAN multi-acceso. `_dispatch_packet` examina el destino L2 del frame:

- Dirección broadcast → `_dispatch_broadcast`: entrega a todas las interfaces.
- Cualquier otra cosa → `_dispatch_unicast`: busca la interface por IP y
  entrega solo allí.

Lanza excepción si la dirección no se encuentra en `_interfaces` — eso es un
bug en el emisor, no una condición normal.

`devices()` devuelve `{name: NetworkDevice}` derivado de las interfaces
conectadas; útil para herramientas que necesitan "todo lo que está en esta LAN".

---

## `Link` (`link.py`)

Un fabric punto a punto `/30` o `/31` — exactamente dos endpoints.
Verificación estricta en tiempo de construcción:

```python
if mask not in (30, 31):
    raise ValueError(f"Link requires /30 or /31 CIDR, got /{mask}")
```

`add_interface` impone `MAX_ENDPOINTS = 2`, lanzando
`TooManyEndpointsException` en el tercer intento.

`_dispatch_packet` **no** busca el destino por dirección — eso rompería cuando
dos links paralelos reusan el mismo `/30` (el espacio de nombres de direcciones
es local al fabric, no global). En su lugar, recorre `_interfaces` y entrega
al que tenga `address()` diferente de `frame.source()`. Si solo un endpoint
se ha conectado (race de construcción durante la aplicación de un parche), el
frame se descarta silenciosamente.

`is_valid_host_address(addr)`:

- `/30`: rechaza la dirección de red (`.0`) y la de broadcast (`.3`) — solo
  `.1` / `.2` son utilizables.
- `/31`: según RFC 3021, ambas direcciones son hosts válidos.

`peer_of(interface)` devuelve el `Interface` del otro endpoint, o `None` si
aún no se ha unido. El `_post_pass_links` del parser usa esto para completar
automáticamente el gateway de un host con la IP de su peer.

---

## `Event` y `EventTracer` (`event.py`)

`EventTracer` es un bus de eventos **por instancia de `Internet`**. Los
métodos de nivel de clase (`EventTracer._broadcast(...)`, `subscribe()`, etc.)
delegan a la instancia actualmente activa configurada via `set_current()`.
Cuando `set_current()` reemplaza un tracer por otro, los suscriptores
registrados en el tracer anterior se transfieren al nuevo, de modo que los
suscriptores de larga duración (por ejemplo, el bridge de eventos del servidor
registrado al arrancar) permanecen activos a través de recargas de topología.

Es dos cosas a la vez:

1. **Un registro de callbacks tipado** para el ciclo de vida de mensajes:
   registrar un `MessageEvent` identificado por la identidad del mensaje, y
   luego cualquier hilo puede llamar a `message_sent`, `message_received` o
   `datagram_forwarded` para disparar el callback correspondiente. Permite a
   un caller observar el ciclo de vida completo de una sola invocación de
   `send`.

2. **Un bus pub/sub broadcast.**
   `EventTracer.subscribe(fn)` registra un callback que recibe **cada**
   llamada a `_broadcast(event_dict)`. Los broadcasts toman un snapshot de la
   lista de suscriptores bajo un breve lock de instancia, luego lo liberan
   antes del fan-out, de modo que los suscriptores no puedan causar deadlock
   en el bus. Las excepciones de los suscriptores se registran y se capturan
   para que un suscriptor defectuoso no pueda detener al resto.

Ambos modos coexisten por diseño: el registro de callbacks está identificado
por la identidad del mensaje; el bus broadcast es a nivel de instancia. Los
dos no se ven entre sí.

---

## `PauseGate` (`clock.py`)

Un gate de dos estados con tres señales: running, paused, stopped. Ver
[`concurrency.md`](concurrency.md) para el ciclo de vida completo. El
contrato relevante aquí:

- `wait_or_stop(timeout=None) → (running, stopped)` — bloquear hasta
  running, stopped, o timeout.
- `sleep(duration) → (ticked, stopped)` — dormir, retornando antes solo
  al detenerse.

Cada hilo worker del simulador debe usar uno de estos (o ambos).
`time.sleep` directamente está prohibido en workers — ignora stop y pause.

---

## `Packet` y sus subclases

Se tratan en detalle en [`packets.md`](packets.md). La versión corta:

- `Frame` — el sobre L2 (`src_addr`, `dst_addr`, `payload`); reside en
  `entities/packet.py`.
- `Datagram` — el paquete L3 (TTL=64 por defecto, decrementado por hop);
  su hogar canónico es `routing/messages.py`, re-exportado desde
  `entities/packet.py`.
- `Message` — el payload dentro del datagram (`entities/packet.py`).
  Subclases:
  - `UserMessage(payload)` — envío a nivel de usuario.
  - `RoutingMessage` — base abstracta en `routing/lsa.py`; los tipos wire
    concretos son `LSA(origin, seq, is_withdrawal=False)` (link-state
    advertisement) y `Hello(originator, neighbors_heard)` (liveness),
    ambos en el paquete `routing/`.
  - `PingRequest(seq)` / `PingReply(seq, request_ts, request_id=None)` —
    par de ping. `PingReply` expone `.request_id` y sobreescribe `flow_key()`
    para repetir el id del `PingRequest` que lo originó, de modo que request y
    reply comparten una única clave de conversación.
