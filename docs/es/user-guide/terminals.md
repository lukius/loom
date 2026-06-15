> 🌐 [English](../../user-guide/terminals.md) · **Español**

# Terminales

Cada host y router en `loom` tiene un terminal. El terminal es la forma de
interactuar con un dispositivo individual: consultar sus interfaces, enviar un
datagrama, hacer ping, ver su tabla de ruteo, ajustar sus costos o configurar un
gateway por defecto.

## Abrir y cerrar un terminal

- **Abrir.** Hacer doble click en cualquier host o router en el canvas. Se abre una
  ventana emergente con el nombre del dispositivo como título.
- **Cerrar.** Hacer click en la **X** de la ventana emergente, o presionar
  <kbd>Ctrl+D</kbd> cuando el prompt esté vacío.
- **Múltiples terminales.** Se pueden abrir tantos como se quiera. Cada uno es
  independiente.
- **Posición y tamaño.** Arrastrar la barra de título para mover; arrastrar las
  esquinas para redimensionar. La posición y el tamaño se persisten por dispositivo.

![Dos terminales abiertos simultáneamente](../../images/30-two-terminals.png)

## Teclado

| Tecla | Acción |
|---|---|
| <kbd>Enter</kbd> | Enviar el comando escrito |
| <kbd>Ctrl+L</kbd> | Limpiar el área de salida |
| <kbd>Ctrl+D</kbd> | Cerrar el terminal (solo cuando el prompt está vacío) |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Navegar el historial de comandos |
| <kbd>Tab</kbd> | Completado de comandos (básico) |

El terminal no captura los atajos normales del navegador a menos que el prompt tenga
el foco, por lo que <kbd>Ctrl+R</kbd> sigue siendo recargar la página.

## Conjunto de comandos

Los comandos disponibles dependen de si el terminal está conectado a un host o a un
router. Ambos tipos comparten `ifconfig`, `route` y `help`.

### Comunes a hosts y routers

#### `ifconfig`

Mostrar la configuración de interfaces.

```
ifconfig
```

Para un **host** (una interface más un gateway opcional):

```
iface_h1: addr=200.100.0.10 net=lan1 (200.100.0.0/24) cost=0
  gateway: 200.100.0.1
```

Para un **router** (una línea por interface, sin línea de gateway):

```
eth0: addr=200.100.0.1 net=lan1 (200.100.0.0/24) cost=10 up
eth1: addr=100.200.0.1 net=lan2 (100.200.0.0/24) cost=15 up
eth2: addr=10.0.0.1 net=p2p1 (10.0.0.0/30) cost=5 up
```

Cada línea termina con `up` o `down` para reflejar el estado administrativo actual de
esa interface. Usar `ifconfig <iface> up|down` para cambiarlo.

El costo en la interface de un host siempre es `0` — los costos son un concepto del
protocolo de ruteo y solo importan en los routers.

#### `route`

En un **router**: mostrar la tabla de ruteo.

```
route
```

```
prefix               next_hop        iface
200.100.0.0/24       0.0.0.0         eth0
100.200.0.0/24       0.0.0.0         eth1
150.10.10.0/24       100.200.0.10    eth1
```

`0.0.0.0` como next-hop significa que el destino está directamente conectado en la
interface indicada. `lan3` se alcanza vía `r3` (`100.200.0.10` en `eth1`) en lugar
del propio `eth2` de `r2`, porque el camino por `lan2` hasta `r3` es más barato
(costo 8+5=13) que el link directo de `r2` a `lan3` (costo 15).

En un **host**: mostrar el gateway por defecto configurado.

```
route
```

```
gateway: 200.100.0.1
```

Si no hay gateway configurado:

```
gateway: (none)
```

#### `help`

Listar los comandos disponibles para este tipo de dispositivo.

```
# host:
available: ifconfig, send <dst> <msg>, ping <dst> [-W t] [-c n] [-i s], route, set_gateway <ip>, help
terminal: clear, Ctrl+L (clear), Ctrl+D (close)

# router:
available: route, update_cost <iface> <cost>, ifconfig [<iface> up|down], halt, resume, neighbors, help
terminal: clear, Ctrl+L (clear), Ctrl+D (close)
```

---

### Comandos exclusivos de hosts

#### `send <dst> <message>`

Enviar un mensaje de datos desde este host hacia `<dst>`. `<dst>` puede ser un nombre
de host (resuelto via la tabla de hosts del AS) o una IP literal.

```
send h2 hello
```

```
sent 5 bytes to 100.200.0.20
```

O con comillas (el terminal usa comillas estilo shell, por lo que un mensaje de
varias palabras puede encerrarse entre comillas dobles):

```
send h2 "hello world"
```

```
sent 11 bytes to 100.200.0.20
```

El host de destino recibe el mensaje silenciosamente — no aparece ninguna
notificación de "mensaje recibido" en la UI por defecto.

#### `ping <dst> [-W <seconds>] [-c <count>] [-i <seconds>]`

Enviar un echo request y esperar una respuesta (timeout por defecto 3 s).

```
ping h3
```

```
seq=0 150.10.10.30: time=12.34 ms
--- h3 ping statistics ---
1 sent, 1 received, 0% loss
```

Modificar el timeout:

```
ping h3 -W 0.5
```

Si no hay respuesta (ningún host responde el ping):

```
seq=0 200.100.0.99: timeout
--- 200.100.0.99 ping statistics ---
1 sent, 0 received, 100% loss
```

Errores:

```
ping h2: no route to host: no gateway configured
```

— ocurre cuando el destino está fuera del link y el host no tiene gateway configurado.

`ping` mide el tiempo de ida y vuelta usando un reloj monotónico — los RTT reflejan
el tiempo real de reloj de pared que tardó el simulador en rutear el paquete por la
topología. Con un simulador ocupado (mucho chatter de ruteo o muchos flujos de ping
corriendo en paralelo), se esperan RTT de un solo dígito en milisegundos en topologías
pequeñas.

Usar `-c <count>` para enviar esa cantidad de sondas. El terminal las envía **de a
una**, esperando a que el viaje de ida y vuelta de cada sonda termine de animarse
antes de enviar la siguiente, luego pausando un segundo (como el `ping` real) entre
ellas. Cada línea de respuesta aparece cuando su respuesta regresa en el canvas,
y al final se imprime una línea de resumen:

```
ping h2 -c 4 -W 1.5
```

```
seq=0 100.200.0.20: time=3.21 ms
seq=1 100.200.0.20: time=2.88 ms
seq=2 100.200.0.20: time=3.05 ms
seq=3 100.200.0.20: time=2.94 ms
--- h2 ping statistics ---
4 sent, 4 received, 0% loss
```

![Un ping contado transmite cada respuesta al terminal a medida que llega, luego imprime un resumen](../../images/62-ping-count.png)

Dado que la siguiente sonda no se envía hasta que la animación de la anterior terminó,
esa pausa es una ventana real para cambiar la topología a mitad de secuencia y
observar el efecto. Deshabilitar una interface (o detener un router) en la ruta
durante la pausa — la siguiente sonda se envía entonces sin estado previo, por lo que
una vez que la red reconverge se reenvía por la ruta recalculada y su animación sigue
ese nuevo camino.

Usar `-i <seconds>` para ajustar la pausa — hacerla más larga si se necesita más
tiempo para editar, o `-i 0` para enviar cada sonda inmediatamente después de que
la anterior termina (igual de a una, solo sin pausa):

```
ping h3 -c 8 -i 2
```

La pausa termina de inmediato si se hace Stop a la simulación.

#### `set_gateway <ip>`

Actualizar el gateway por defecto del host.

```
set_gateway 200.100.0.254
```

```
gateway set to 200.100.0.254
```

El nuevo gateway debe estar dentro de la red del host; de lo contrario:

```
gateway 10.0.0.1 not in host network
```

Para hosts en un link `/30` o `/31`, el gateway es la IP del peer y el parser lo
configura automáticamente. `set_gateway` para esos hosts está permitido pero no tiene
efecto útil — cambiar el cableado del link si se quiere un peer diferente.

---

### Comandos exclusivos de routers

#### `update_cost <iface> <cost>`

Establecer el costo de una interface. El nuevo valor se propaga en el próximo
flooding de LSA.

```
update_cost eth0 25
```

```
cost of eth0 set to 25
```

`<cost>` debe ser un entero positivo.

```
update_cost eth0 -5
```

```
cost must be positive
```

```
update_cost eth9 1
```

```
r1: invalid interface eth9
```

#### `neighbors`

Listar los vecinos directamente conectados del router.

```
neighbors
```

```
  r1     via lan1     (200.100.0.1)  cost=10
  r1     via lan2     (100.200.0.1)  cost=15
  r3     via lan2     (100.200.0.10) cost=20
  r3     via lan3     (150.10.10.10) cost=5
```

La vista se construye a partir del grafo local del protocolo del router, por lo que
solo muestra los vecinos de los que este router *tuvo noticias*. Un nuevo vecino tarda
hasta un intervalo de Hello en aparecer aquí.

Si el router no tiene routers peers, o no completó su primer intercambio de Hello:

```
(no neighbors yet)
```

#### `halt`

Desconectar el router de forma controlada: hace flooding de un LSA de retiro para que
los vecinos lo eliminen de sus grafos de inmediato, luego detiene el forwarding.

```
halt
```

```
r1 halted
```

#### `resume`

Volver a conectar un router detenido. Re-anuncia sus links y retoma el forwarding.

```
resume
```

```
r1 resumed
```

#### `ifconfig <iface> up|down`

Levantar o bajar una interface individual sin detener todo el router.
Bajar una interface retira ese link de los anuncios del protocolo de ruteo de forma
controlada; levantarla de nuevo lo re-anuncia.

```
ifconfig eth0 down
```

```
eth0 down
```

```
ifconfig eth0 up
```

```
eth0 up
```

---

## Comando no encontrado

Los comandos desconocidos responden con el mismo envelope `ok: false` que los
errores:

```
foo bar
```

```
unknown command: foo
```

No hay pipe ni redirección a nivel de shell — cada comando es una línea, una respuesta
renderizada verbatim.

## Qué ocurre internamente

Cada comando envía:

```
POST /devices/{name}/command
{ "cmd": "<line>" }
```

El servidor parsea la línea (comillas estilo shell), la enruta al dispositivo
indicado, ejecuta el comando correspondiente y devuelve:

```json
{ "ok": true, "output": "..." }
```

El conjunto completo de comandos por dispositivo está en
[`server-api.md`](../architecture/server-api.md#post-devicesnamecommand).

## Cuando la simulación está idle o detenida

Los terminales permanecen abiertos luego de un Stop, pero los comandos enviados a
una simulación detenida devuelven `409 no topology loaded`:

```
ping h3
```

```
no topology loaded
```

Hacer click en **Start** y el mismo comando vuelve a funcionar — mismo terminal, misma
posición de ventana. No hay que reabrir nada.
