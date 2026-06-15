> 🌐 [English](../../architecture/server-api.md) · **Español**

# API del servidor

La aplicación FastAPI expone cuatro familias REST y un WebSocket. Todas las rutas
viven en `src/server/routes/` y comparten el estado de la aplicación adjunto
a `request.app.state`:

| Atributo | Tipo | Ciclo de vida |
|---|---|---|
| `app.state.sim_state` | `SimState` | Una por proceso, creada en `create_app()` |
| `app.state.event_bus` | `EventBus` | Una por proceso; loop adjunto en `lifespan` |

`SimState` posee el `AS` activo, la ruta del archivo de sesión y el
lock de la máquina de estados. `EventBus` distribuye los eventos de los
hilos de trabajo a todos los WebSockets conectados.

El bind por defecto es `127.0.0.1:8000` (se puede cambiar con `LOOM_PORT`). La
SPA se sirve desde `/` mediante `StaticFiles(directory="web", html=True)`.

---

## `GET /topology`

Leer la topología actual como YAML.

**Respuesta**

```json
{ "yaml": "internet:\n  name: ...\n..." }
```

Cuando hay una topología cargada (`as_obj is not None`), devuelve el
estado activo re-serializado mediante `SimState._dump_yaml()`, no el contenido
literal del archivo de sesión. Esto significa que cualquier cambio realizado en tiempo
de ejecución mediante `POST /sim/protocol_config` se refleja en la próxima
solicitud, porque `_dump_yaml` lee los timers del protocolo de los objetos router
activos y los escribe en el bloque `<as>.config.protocol`. El diccionario
`internet.config` de nivel superior se emite verbatim (se almacena de forma opaca
y el backend nunca lo interpreta). Cuando no hay ninguna topología cargada, se
devuelve el texto crudo del archivo de sesión.

---

## `POST /topology`

Cargar una nueva topología, reemplazando la actual.

**Solicitud**

```json
{ "yaml": "<full YAML text>" }
```

**Comportamiento**

Parsear-luego-confirmar mediante `SimState.load_from_text()`:

1. Escribir el YAML en un archivo temporal en el mismo directorio que el
   archivo de sesión.
2. `Parser(tmp_path).parse(start_routing=False)` valida y construye el
   AS. Ante cualquier falla de parseo/validación, la excepción se propaga, el
   archivo temporal se elimina y el archivo de sesión permanece intacto.
3. En caso de éxito, el archivo temporal se mueve atómicamente a `session_path`
   (reemplazando cualquier contenido anterior) y el AS activo se intercambia.

Los routers se construyen pero no se inician — `start_routing=False` — por lo que
no se disparan eventos de ruteo hasta que se llame a `/sim/start`.

**Respuestas**

- `200`:
  ```json
  {
    "ok": true,
    "as_name": "test_as",
    "devices": ["h1", "h2", "h3", "r1", "r2", "r3"],
    "networks": ["lan1", "lan2", "lan3"]
  }
  ```
- `400` `{"detail": "..."}` — YAML inválido o falla de parseo/validación.
- `409` `{"detail": "stop the simulation before importing a topology"}` —
  la simulación no está en `idle`.

---

## `GET /topology/source`

Devolver el nombre base del archivo fuente de topología (variable de entorno `LOOM_TOPOLOGY`).

**Respuesta**

```json
{ "name": "sample.yaml" }
```

Los consumidores pueden usar esto como nombre base por defecto (p. ej., para
diálogos de exportación). El valor es `Path.name` del archivo fuente, no una ruta completa.

---

## `POST /topology/reset`

Descartar el archivo de sesión y re-clonar desde el fuente.

**Comportamiento**

- Devuelve `409` si la simulación no está en `idle` (`"stop the simulation before reset"`).
- Re-clona el fuente sobre la ruta de sesión y recarga el AS
  (`start_routing=False`).

**Respuesta**

```json
{ "ok": true, "as_name": "..." }
```

---

## Rutas de archivos de ejemplo: `GET /samples`, `GET /samples/{filename}`

Endpoints de solo lectura que enumeran y sirven archivos `*.yaml` del
directorio de ejemplos configurado (por defecto `<repo>/samples`, modificable mediante
la variable de entorno `LOOM_SAMPLES`). Los clones de sesión (`*.session.yaml`) se filtran.

### `GET /samples`

```json
{ "files": ["sample.yaml", "small.yaml"] }
```

Devuelve una lista ordenada alfabéticamente de nombres de archivo simples. Devuelve
`{"files": []}` cuando el directorio de ejemplos no existe o está vacío.

### `GET /samples/{filename}`

```json
{ "yaml": "<full YAML text>" }
```

Los nombres que contienen `/` o `\`, o iguales a `""`, `"."` o `".."` devuelven
`400`; un `.` dentro de un nombre está permitido (por lo que `sample.yaml` carga normalmente).
Un nombre bien formado que no existe en el directorio de ejemplos devuelve
`404`. Notar que `GET /samples` lista archivos con extensiones tanto `.yaml` como `.yml`.

---

## Ciclo de vida de la simulación: `POST /sim/{start,pause,resume,stop}`

La máquina de estados vive en `SimState`:

```
idle ──/sim/start──► running ──/sim/pause──► paused
                       ▲                       │
                       │                       │
                       └────/sim/resume◄───────┘
running, paused ─────/sim/stop─────► idle
```

`/sim/start`, `/sim/pause`, `/sim/resume` y `/sim/stop` devuelven cada uno
`{"state": <new>}` y emiten un evento `{"kind": "sim_state", "state": <new>}`
en el WebSocket. `/sim/edit` (más adelante) no cambia el estado y no emite
`sim_state`. `/sim/stop` desde `idle` es una operación sin efecto que
devuelve `200 {"state": "idle"}` y emite `sim_state` por consistencia.

Ante una violación de la máquina de estados (p. ej., pausar desde `idle`), los endpoints
de ciclo de vida devuelven `409 Conflict` con el mensaje subyacente de
`InvalidStateTransition`.

### `POST /sim/start`

`idle → running`. Reanuda el `PauseGate` e inicia el hilo de protocolo de cada router.
Da error `409` si no está en idle o si no hay ninguna topología cargada.

### `POST /sim/pause`

`running → paused`. Llama a `PauseGate.pause()`. Los workers se bloquean en su
próxima espera en el gate; los frames en tránsito quedan en cola.

### `POST /sim/resume`

`paused → running`. Acepta un **patch** opcional en el cuerpo:

```json
{ "patch": [
    {"op": "add_network", "name": "lan4", "address": "10.0.0.0/24"},
    {"op": "add_link",    "name": "lnk1", "address": "10.0.0.0/30"},
    {"op": "add_host",    "name": "h4",   "network": "lan4", "address": "10.0.0.10", "gateway": "10.0.0.1"},
    {"op": "add_router",  "name": "r4",   "interfaces": [
        {"name": "eth0", "network": "lan4", "address": "10.0.0.1", "cost": 5}
    ]},
    {"op": "update_cost", "router": "r1", "iface": "eth0", "cost": 25},
    {"op": "remove_host",   "name": "hX"},
    {"op": "remove_router", "name": "rX"},
    {"op": "remove_network","name": "lanX"}
] }
```

Los patches se aplican en **dos fases**:

1. Se llama a `_validate_op` para cada op. Cualquier falla genera `400
   Bad Request` con el motivo subyacente — y **no se aplica ningún op**.
2. Se llama a `_apply_op` para cada op. Si ocurre una falla en la fase 2
   (raro, ya que la fase 1 validó todo), el patch se aplica parcialmente
   — esa es una clase de bug que el validador está destinado a prevenir.

Reglas de código de estado (ver `routes/sim.py`):

- `409` si la simulación no está en estado `paused` (violación real de la máquina de estados).
- `400` para errores de validación del patch — estos usan nombres de pseudo-estado
  (`"network_in_use"`, `"duplicate_name"`, etc.) que el dispatcher
  mapea a `400`.

### `POST /sim/edit`

Aplicar un patch de topología a una simulación **en ejecución** sin pausar.

**Solicitud**

```json
{ "patch": [
    {"op": "add_network", "name": "lan4", "address": "10.0.0.0/24"},
    {"op": "add_link",    "name": "lnk1", "address": "10.0.0.0/30"},
    {"op": "add_host",    "name": "h4",   "network": "lan4", "address": "10.0.0.10", "gateway": "10.0.0.1"},
    {"op": "add_router",  "name": "r4",   "interfaces": [
        {"name": "eth0", "network": "lan4", "address": "10.0.0.1", "cost": 5}
    ]},
    {"op": "update_cost", "router": "r1", "iface": "eth0", "cost": 25},
    {"op": "remove_host",    "name": "hX"},
    {"op": "remove_router",  "name": "rX"},
    {"op": "remove_network", "name": "lanX"}
] }
```

El mismo conjunto de ops que el parámetro patch de `/sim/resume`. Todos los ops son
validados antes de que se aplique alguno (validar-todo-luego-aplicar-todo).

**Comportamiento**

`SimState.edit(patch)` adquiere `_edit_lock`, valida cada op
con `_validate_op` y luego aplica cada op con `_apply_op`. El
lock se libera en caso de éxito o ante cualquier falla. Las rutas críticas de
dispatch del fabric leen snapshots de interfaces (`list(self._interfaces.values())`) para
que una edición concurrente nunca pueda generar un error de "dict changed size".

En caso de éxito, se difunde un evento `topology_changed` en el WebSocket (ver
[`WS /ws/events`](#ws-wsevents)).

**Códigos de estado**

- `200 {"state": "running"}` — patch aplicado.
- `400 {"detail": "..."}` — uno o más ops fallaron la validación; no se
  aplicó ningún op.
- `409 {"detail": "invalid transition: <state> -> edit"}` — la simulación no
  está en estado `running` (el mensaje sigue el formato estándar de
  `InvalidStateTransition`).

---

### `POST /sim/stop`

Cualquier estado → `idle`. Descarta el AS por completo. El próximo `/sim/start` requiere
una nueva carga de `/topology` (o la sesión existente si no se recargó). Si ya está en
`idle`, devuelve `200` sin error.

### `GET /sim/state`

```json
{ "state": "running", "as_name": "test_as" }
```

`as_name` es `null` cuando no hay ninguna topología cargada.

### `POST /sim/protocol_config`

Cambiar los timers del protocolo de ruteo **en vivo** — sin necesidad de reiniciar.

**Solicitud**

```json
{ "hello_interval": 5, "lsa_refresh_interval": 15 }
```

- Tanto `hello_interval` como `lsa_refresh_interval` son requeridos.
- Ambos deben ser números positivos (int o float, no bool). `400` para
  valores inválidos o no positivos.
- Requiere `as_obj is not None` (la simulación debe estar cargada), de lo contrario `409
  {"detail": "no system loaded"}`.

Se aplica mediante `proto.set_timers(hello_interval=..., lsa_refresh_interval=...)`
en la instancia `LinkStateProtocol` de cada router. El cambio toma efecto
en el próximo límite de sleep del hilo de protocolo de cada router.

**Respuesta**

```json
{ "ok": true, "hello_interval": 5.0, "lsa_refresh_interval": 15.0 }
```

Los valores actualizados se reflejan en la próxima respuesta de `GET /topology`.

---

## Rutas de dispositivos: `/devices/{name}/...`

Cinco endpoints, todos con ámbito de dispositivo. Cada uno comienza con una búsqueda
del dispositivo bajo `_lock` mediante `SimState.device_under_lock()` — la verificación de
`None` y la llamada a `device()` son atómicas, por lo que un `stop()` concurrente no puede
poner `_as` en null entre ellas:

- `409 {"detail": "no topology loaded"}` — `_as is None`.
- `404 {"detail": "unknown device: <name>"}` — `device(name)` generó
  `EntityException` (cubre tanto `HostNotFoundException` como
  `RouterNotFoundException`).

`AS.device(name)` prueba primero hosts y luego routers; cualquier coincidencia funciona.

### `POST /devices/{name}/command`

El endpoint de terminal. Despacha comandos similares a shell a un dispositivo.

**Solicitud**

```json
{ "cmd": "ping h2 -W 2" }
```

**Respuesta**

```json
{ "ok": true,  "output": "ping h2 (100.200.0.20): time=2.34 ms" }
```

o

```json
{ "ok": false, "output": "unknown command: foo" }
```

El dispatch vive en `server/command/dispatch.py`. El campo `cmd` se
divide con `shlex.split`, el primer token es el nombre del comando y el resto
son argumentos. El handler se resuelve a `server.command.host` (para hosts)
o `server.command.router` (para routers) y llama a
`cmd_<name>(device, args, as_obj)`.

Comandos soportados por tipo de dispositivo:

| Dispositivo | Comandos |
|---|---|
| Host | `ifconfig`, `send <dst> <msg>`, `ping <dst> [-W <seconds>] [-c <n>] [-i <seconds>]`, `route`, `set_gateway <ip>`, `help` |
| Router | `ifconfig [<iface> up\|down]`, `route`, `update_cost <iface> <cost>`, `neighbors`, `halt`, `resume`, `help` |

**`ifconfig [<iface> up|down]` (router)**

Sin argumentos, muestra todos los interfaces. Con `<iface> up` o `<iface> down`, cambia el estado
de administración de esa interface: bajarla detiene el tráfico en ambas
direcciones y dispara un re-flooding graceful del LSA omitiendo el link; volver a subirlo
re-anuncia el link de inmediato.

**`halt` (router)**

Deshabilita graciosamente todos los interfaces — hace flooding de un LSA de retiro para que los
vecinos purguen el router de inmediato — y marca el router como detenido. No se reenvía
tráfico.

**`resume` (router)**

Re-habilita todos los interfaces previamente detenidos y re-anuncia los links del router
mediante un nuevo flood de LSA. Simétrico a `halt`.

**`ping <dst> [-W <seconds>] [-c <n>] [-i <seconds>]` (host)**

Envía un `PingRequest` por sonda. `-W` establece el timeout por sonda (por defecto 3 s);
`-c` establece la cantidad de sondas (por defecto 1, máximo 100); `-i` establece el intervalo
entre sondas en segundos (por defecto 1, como el ping real; máximo 60; usar `-i 0` para una
ráfaga consecutiva). La espera del intervalo pasa por el `PauseGate` del AS, por lo que
pausa con la simulación y se interrumpe al detenerla. El endpoint devuelve solo el resumen;
las líneas por sonda se difunden como eventos `ping_result`. Resumen de salida:

```
h2 (100.200.0.20): time=2.34 ms
h2 (100.200.0.20): time=1.87 ms
--- h2 ping statistics ---
2 sent, 2 received, 0% loss
```

`<dst>` en los comandos de host acepta un nombre de host (resuelto mediante
`as_obj.host(dst).address()`) o una IP literal. Volver a una IP literal es
lo que hace que `ping 10.0.0.1` funcione aunque ningún host tenga ese nombre.

Los comandos desconocidos devuelven `{"ok": false, "output": "unknown command: ..."}`
con HTTP 200 — la falla está en el payload, no en el código de estado.

### `GET /devices/{name}/interfaces`

```json
{
  "halted": false,
  "interfaces": [
    { "name": "eth0", "address": "200.100.0.1", "network": "lan1", "cost": 10, "up": true },
    { "name": "eth1", "address": "100.200.0.1", "network": "lan2", "cost": 15, "up": false },
    ...
  ]
}
```

`halted` es `true` cuando un router ha sido detenido (todos los interfaces forzosamente
bajados mediante el comando `halt` o una detención graceful). `up` refleja el estado
de administración por interface: `false` significa que la interface fue bajada
(ya sea individualmente o como parte de un halt). Para hosts, `halted` es
siempre `false` y `up` es siempre `true`.

### `POST /devices/{name}/fail`

Simular un crash — mata el dispositivo silenciosamente sin un retiro graceful del LSA.
Los vecinos se enteran de que el router desapareció solo mediante el dead
interval de Hello o la expiración del max-age del LSA.

**Solicitud** (cuerpo opcional)

```json
{ "interface": "eth0" }
```

Sin cuerpo (o interface `null`), se falla el router completo (todos los
interfaces se bajan). Con un nombre de `interface`, solo esa interface
falla.

**Códigos de error**

- `400` — el dispositivo es un host (los hosts no pueden ser fallados).
- `404` — nombre de dispositivo desconocido, o nombre de interface desconocido en el router.

**Respuesta**

```json
{ "ok": true }
```

Este endpoint no está expuesto como comando de terminal. Está destinado a
escenarios de inyección de fallos — scripts de prueba y automatización futura.

### `GET /devices/{name}/routes`

```json
{ "rules": [
    { "prefix": "200.100.0.0/24", "next_hop": "0.0.0.0", "iface": "eth0" },
    ...
] }
```

Para hosts, devuelve `{"rules": []}`.
Para routers, las reglas se vuelcan tal como las mantiene actualmente
`router.routing_table()`. `next_hop` es `"0.0.0.0"` para prefijos directamente
conectados (`NullAddress` se serializa a ese valor).

### `GET /devices/{name}/nat-table`

```json
{
  "entries": [
    {
      "rewritten_src": "203.0.113.1",
      "dst": "100.200.0.20",
      "flow_id": "3f7e...",
      "original_src": "10.0.0.10"
    },
    ...
  ]
}
```

Devuelve el snapshot actual de la tabla NAT para un router. Las entradas se ordenan
de la más antigua a la más nueva (LRU). Para hosts, devuelve `{"entries": []}`.

Dado que los eventos en el bus solo llevan cambios incrementales, un suscriptor
sin historial previo de eventos necesita este endpoint para recuperar el estado
actual de la tabla.

---

## `WS /ws/events`

El stream de eventos.

**Ciclo de vida de la conexión**

1. El cliente se conecta, el servidor hace `accept()`.
2. El servidor suscribe una nueva `asyncio.Queue` al `EventBus`.
3. El servidor itera: `event = await queue.get(); ws.send_json(event)`.
4. El cliente se desconecta → `WebSocketDisconnect` → el servidor cancela la
   suscripción de la cola y cierra.

**Formas de los eventos**

```json
{ "kind": "sim_state", "state": "running" }
```

```json
{
  "kind": "packet",
  "type": "user_datagram" | "routing_flood" | "ping_request" | "ping_reply" | "hello" | "unknown",
  "payload_id": "0d7c...e9",
  "payload_src": "200.100.0.10",
  "payload_dst": "100.200.0.20",
  "flow": "<conversation-uuid>",
  "src":  { "device": "h1", "iface": "iface_h1", "address": "200.100.0.10" },
  "dst":  { "address": "200.100.0.1" },
  "network": "lan1",
  "payload": { ... }
}
```

`flow` es una cadena UUID — la clave de conversación reportada por
`payload.flow_key()`. Es estable ante las reescrituras de dirección NAT y se
comparte entre un `PingRequest` y su correspondiente `PingReply` (la
respuesta repite el id de la solicitud). `payload` es un dict resumen por tipo:

| `type` | campos de `payload` |
|---|---|
| `user_datagram` | `{"bytes": <n>, "text": "<body>"}` (text solo cuando el payload es str) |
| `ping_request` | `{"seq": <n>}` |
| `ping_reply` | `{"seq": <n>, "request_ts": <float>}` |
| `hello` | `{"originator": "<router>", "neighbors_heard": ["<r1>", ...]}` |
| `routing_flood` | `{"seq": <n>, "originator": "<router>", "destinations": [{"prefix": "<cidr>", "cost": <n>}, ...]}` |
| `unknown` | `{}` |

```json
{
  "kind": "routing_table_changed",
  "device": "r1",
  "rules": [
    { "prefix": "200.100.0.0/24", "next_hop": "0.0.0.0", "iface": "eth0" },
    ...
  ]
}
```

```json
{ "kind": "interface_state_changed", "device": "r1", "interface": "eth0", "up": false }
```

Se emite cada vez que cambia el estado de administración de una interface (arriba o abajo),
ya sea disparado por `ifconfig <iface> down/up`, `halt`, `resume` o
`POST /devices/{name}/fail`.

```json
{ "kind": "device_state_changed", "device": "r1", "up": false }
```

Se emite cuando el estado a nivel de router cambia (halt pone `up: false`;
resume pone `up: true`). Un solo `halt` emite un `device_state_changed`
más un `interface_state_changed` por interface.

```json
{ "kind": "ping_result", "device": "h1", "dst": "100.200.0.20", "seq": 1, "rtt_ms": 2.34 }
```

Se emite una vez por sonda desde `Host.ping`. `rtt_ms` es `null` ante timeout.
`seq` es un contador basado en 1 que se reinicia en cada llamada a `ping`.

```json
{
  "kind": "topology_changed",
  "ops": [
    {"op": "add_network", "name": "lan4", "address": "10.0.0.0/24"},
    ...
  ]
}
```

Se emite por `SimState.edit()` tras un patch de edición en vivo exitoso. `ops`
es la lista exacta de ops que se aplicó.

```json
{
  "kind": "neighbor_state_changed",
  "device": "r1",
  "interface": "eth0",
  "peer": "r2",
  "state": "two_way",
  "last_hello_at": 1234567890.123,
  "peer_acked_at": 1234567890.456
}
```

Se emite por `LinkStateProtocol` cada vez que un vecino transiciona entre
estados de adyacencia (los valores emitidos son en minúsculas: `"down"`, `"init"`,
`"two_way"`; los nombres de enum en `NeighborState` son en mayúsculas). `last_hello_at` es la
marca de tiempo monótona del último Hello escuchado de este vecino (o `null`
antes del primer Hello); `peer_acked_at` es cuando el vecino listó por última
vez a este router en su propia lista `neighbors_heard` (o `null` si aún no fue
reconocido).

```json
{
  "kind": "lsdb_changed",
  "device": "r1",
  "rules": [
    { "prefix": "200.100.0.0/24", "next_hop": "0.0.0.0", "iface": "eth0" },
    ...
  ]
}
```

Se emite por `LinkStateProtocol._emit_rule_change_events` cada vez que la
recomputación del grafo link-state produce una nueva tabla de ruteo. `rules`
tiene la misma forma que `routing_table_changed`. `lsdb_changed` se dispara
en el nivel de protocolo (uno por `LinkStateProtocol`); `routing_table_changed`
se dispara inmediatamente después desde el mismo método, en el nivel RIB.

```json
{
  "kind": "nat",
  "router": "r1",
  "direction": "outbound",
  "original_src": "10.0.0.10",
  "rewritten_src": "203.0.113.1",
  "dst": "100.200.0.20",
  "flow_id": "3f7e...",
  "payload_id": "a1b2..."
}
```

```json
{
  "kind": "nat",
  "router": "r1",
  "direction": "inbound",
  "rewritten_dst": "203.0.113.1",
  "original_dst": "10.0.0.10",
  "src": "100.200.0.20",
  "flow_id": "3f7e...",
  "payload_id": "a1b2..."
}
```

Se emite una vez por paquete en cada reescritura NAT. `direction: "outbound"`
se dispara desde `Router._apply_source_nat` cuando un paquete con origen privado
cruza hacia una salida pública. `direction: "inbound"` se dispara desde
`Router._reverse_inbound_nat` cuando el destino de un paquete de retorno se
reescribe de vuelta a la dirección privada original. `flow_id` es
`payload.flow_key()` — el UUID de conversación compartido entre solicitud y
respuesta. `payload_id` identifica esta instancia específica de `Message`.

```json
{
  "kind": "nat_table_changed",
  "device": "r1",
  "entries": [
    {
      "rewritten_src": "203.0.113.1",
      "dst": "100.200.0.20",
      "flow_id": "3f7e...",
      "original_src": "10.0.0.10"
    },
    ...
  ]
}
```

Se emite inmediatamente después de cada reescritura NAT de salida (desde
`Router._apply_source_nat`). `entries` es el snapshot completo de la tabla en
orden LRU (el más antiguo primero). Los suscriptores que necesitan el estado NAT actual
sin consultar `GET /devices/{name}/nat-table` pueden mantener una copia local
aplicando cada evento `nat_table_changed`.

```json
{
  "kind": "router_intercept",
  "router": "r1",
  "originator": "10.0.0.10",
  "pinged_address": "200.100.0.1",
  "received_on": "eth0",
  "owning_iface": "eth1",
  "payload_id": "a1b2..."
}
```

Se emite por un router cuando responde a un echo ICMP (`PingRequest`)
dirigido a una de sus propias IPs de interface. `router` es el nombre del
router. `originator` es la dirección IP del remitente. `pinged_address` es
la IP de destino de la solicitud entrante (la dirección propia del router
que fue el objetivo). `received_on` es el nombre de la interface por la que llegó
la solicitud. `owning_iface` es el nombre de la interface que posee `pinged_address`
(puede diferir de `received_on` cuando la solicitud llegó por una interface
distinta a la que tiene la dirección testeada), o `null` si no se encontró.
`payload_id` es el UUID de la instancia `Message` de la respuesta.

Notas:

- `payload_id` identifica **una sola dirección** de un flujo (una sola
  instancia de `Message`); un `PingRequest` y su `PingReply` tienen
  distintos `payload_id`.
- `flow` en los eventos `packet` es un UUID (el propio `flow_key()` del payload).
  Solicitud y respuesta comparten el mismo valor de `flow`.
- `src.device` puede ser `null` si la interface aún no fue adjuntada
  a un dispositivo (una breve ventana durante la carga de topología — raro en
  uso normal).

**Comportamiento ante desbordamiento**

Cada cola suscrita tiene un límite de 1000 eventos. Al desbordarse, **se descarta el
evento más antiguo** y se incrementa `EventBus.overflow_count`. No hay ninguna
señal de desbordamiento en el wire — un suscriptor lento simplemente pierde eventos
antiguos. Los eventos de tabla de ruteo y de estado de simulación se emiten con mucha menos
frecuencia y raramente se desbordan.

---

## Referencia de ops de patch

El mismo conjunto de ops es aceptado por `/sim/resume` (body `patch:`) y
`/sim/edit` (body `patch:`). Todos los ops son validados antes de que se aplique alguno.

| Op | Campos requeridos | Notas |
|---|---|---|
| `add_network` | `name`, `address` | `address` es un CIDR (p. ej. `"10.0.0.0/24"`) |
| `add_link` | `name`, `address` | `address` debe ser `/30` o `/31` |
| `remove_network` | `name` | Falla con `network_in_use` si algún interface de host/router está en ella |
| `add_host` | `name`, `address`, exactamente uno de `network:` o `link:` | `gateway` opcional |
| `remove_host` | `name` | |
| `add_router` | `name`, `interfaces` | Cada entrada de interface debe llevar exactamente uno de `network:` o `link:` |
| `remove_router` | `name` | Detiene el hilo de protocolo y desconecta todos los interfaces |
| `update_cost` | `router`, `iface`, `cost` | `cost` debe ser un entero positivo |

Las entradas de interface de `add_host` y `add_router` requieren exactamente uno de
`network:` o `link:` — proporcionar ambos o ninguno genera `invalid_patch`.

---

## Ejemplo de uso de extremo a extremo

```bash
# Cargar una topología
curl -X POST http://127.0.0.1:8000/topology \
     -H 'Content-Type: application/json' \
     -d '{"yaml": "internet:\n  autonomous_systems:\n    tiny:\n      networks:\n        lan1: \"10.0.0.0/24\"\n      hosts:\n        h1: { network: lan1, address: \"10.0.0.10\" }\n"}'

# Iniciar la simulación
curl -X POST http://127.0.0.1:8000/sim/start

# Inspeccionar el ruteo
curl http://127.0.0.1:8000/devices/h1/interfaces
curl http://127.0.0.1:8000/devices/h1/routes

# Ejecutar un comando en el dispositivo
curl -X POST http://127.0.0.1:8000/devices/h1/command \
     -H 'Content-Type: application/json' \
     -d '{"cmd": "ping 10.0.0.10"}'

# Detener
curl -X POST http://127.0.0.1:8000/sim/stop
```

Para el flujo de patch mientras está pausado:

```bash
curl -X POST http://127.0.0.1:8000/sim/pause
curl -X POST http://127.0.0.1:8000/sim/resume \
     -H 'Content-Type: application/json' \
     -d '{"patch": [{"op": "update_cost", "router": "r1", "iface": "eth0", "cost": 99}]}'
```

Para una edición en vivo mientras está en ejecución:

```bash
curl -X POST http://127.0.0.1:8000/sim/edit \
     -H 'Content-Type: application/json' \
     -d '{"patch": [{"op": "update_cost", "router": "r1", "iface": "eth0", "cost": 99}]}'
```
