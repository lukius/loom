> 🌐 [English](../../user-guide/web-ui.md) · **Español**

# La interfaz web

Este es un recorrido guiado por la SPA. Se cubren todos los elementos
interactivos, organizados por región.

## Disposición

```
┌────────────────────────────────────────────────────────────────────────┐
│  Toolbar (always visible)                                              │
├──────────┬───────────────────────────────────┬─────────────────────────┤
│          │                                   │                         │
│  Left    │            Canvas                 │   Right pane            │
│  nav     │            (SVG, drag/pan/zoom)   │   (Inspector)           │
│          │                                   │                         │
└──────────┴───────────────────────────────────┴─────────────────────────┘
```

Ambos paneles laterales son redimensionables: basta con arrastrar los
separadores verticales que los delimitan. Los anchos se conservan entre
recargas.

![Disposición de tres paneles: nav, canvas, inspector](../../images/05-layout.png)

## Barra de encabezado

La franja ubicada en la parte superior de la página contiene los controles a
nivel de proyecto:

| Control | Función |
|---|---|
| **Project name** | Nombre de la topología, editable. Se persiste y viaja de ida y vuelta en el YAML. |
| **Save indicator** | Muestra `autosaved` durante la operación normal y `saving…` brevemente después de un cambio. |
| **Theme toggle** | Alternar entre **Light** y **Dark**. La elección se conserva entre recargas. |
| **New** | Limpiar la topología actual y empezar desde un _canvas_ vacío. Pide confirmación antes de hacerlo, y detiene la simulación si hay una en ejecución. |
| **Import** | Abrir un selector con las topologías de ejemplo incluidas; hacer click en una para cargarla, o usar **Browse local file…** para elegir cualquier archivo `.yaml` del equipo. |
| **Export** | Abrir el diálogo de guardado del navegador para elegir carpeta y nombre de archivo para la topología actual. El nombre sugerido se deriva del último archivo cargado, y es `topology.yaml` cuando no hay nada cargado. |

## Barra de herramientas del canvas

La barra de herramientas está encima del _canvas_. De izquierda a derecha:

| Control | Función |
|---|---|
| **LAN** (<kbd>N</kbd>) | Agregar un _rail_ de red en el centro del _canvas_. Disponible en todo momento: al darle un rango durante la ejecución, se suma a la red en vivo. |
| **Host** (<kbd>H</kbd>) | Agregar un host. Disponible en todo momento, pero un host agregado durante la ejecución queda suelto hasta pausar o detener la simulación (ver más abajo). |
| **Router** (<kbd>R</kbd>) | Agregar un router. Igual que **Host**: aparece en el _canvas_, pero recién obtiene interfaces al pausar o detener la simulación. |
| **Fit** (<kbd>F</kbd>) | Ajustar la topología al _canvas_ visible. |
| **Start / Stop** (<kbd>Space</kbd>) | Alternar entre `idle` y en ejecución. |
| **Pause / Resume** (<kbd>P</kbd>) | Alternar entre en ejecución y en pausa. Durante la pausa, la etiqueta indica cuántos cambios hay pendientes. |
| **Reset** | Solo en `idle`: descartar la sesión y volver a clonar desde el YAML original. |
| **Protocol** | Abrir la ventana emergente de configuración del protocolo (intervalo de Hello e intervalo de refresco de LSA). Deshabilitado hasta iniciar la simulación; utilizable durante la ejecución o la pausa. |
| **Packets [speed] ms** | Fija la duración de la animación por hop en milisegundos (200–5000). En pantalla se lee **Packets**, con un campo numérico y la unidad **ms**. |
| **Chatter** | Silenciar o volver a mostrar las animaciones de los paquetes del protocolo de ruteo. |
| **Costs** | Mostrar u ocultar las etiquetas de costo en cada interface de router. |
| **Ifaces** | Mostrar u ocultar las insignias con el nombre y la cantidad de interfaces. |
| **Packets** | Abrir el panel de paquetes, que lista todos los paquetes en tránsito con una insignia numérica en cada uno. Expandir una fila muestra su historial de hops y las traducciones NAT ocurridas en el camino. |

![Barra de herramientas mostrando todos los controles, incluido el botón Protocol](../../images/toolbar.png)

**Qué significa "disponible durante la ejecución".** Ningún control de esta
barra se deshabilita al iniciar la simulación, pero el _canvas_ igual protege a
la red en vivo de los dispositivos a medio construir. Una LAN o un link punto a
punto están completos apenas tienen un rango válido, así que se suman a la
simulación de inmediato. Un host o un router, en cambio, no están completos
hasta estar conectados a algo, y conectarlos (arrastrarlos sobre una LAN, elegir
una red en el inspector, agregar una interface) se rechaza durante la ejecución:
la LAN muestra una señal roja y el nodo vuelve a su lugar. Conviene entonces
pausar o detener la simulación, conectarlo ahí, y el dispositivo se sumará al
hacer **Resume** o en el próximo **Start**.

### Empezar desde cero

**New** borra la topología entera para poder construir otra desde cero. Como eso
descarta todo lo que hay en el _canvas_, primero pide confirmación; conviene
exportar la topología actual si se la quiere conservar. Al confirmar queda el
_canvas_ vacío, listo para agregar la primera LAN.

![Confirmación antes de que New limpie la topología](../../images/06-new-confirm.png)

### Configuración del protocolo

El botón **Protocol** permanece deshabilitado hasta presionar **Start**: los
timers pertenecen a una simulación en vivo, de modo que no hay nada que ajustar
mientras está en `idle`. Una vez que la simulación está en ejecución (o en
pausa), hacer click en **Protocol** abre la ventana emergente de configuración,
que controla los dos parámetros de temporización de loom-OSPF:

- **Hello interval**: cada cuánto envía cada router un Hello a sus vecinos para
  declararse activo (segundos, 1–300).
- **LSA refresh interval**: cada cuánto vuelve a emitir cada router su anuncio
  link-state completo (segundos, 1–900).

Junto a los campos se muestran dos valores derivados, de solo lectura:

- **Dead interval**: tres veces el intervalo de Hello. Un vecino que permanece
  en silencio durante ese lapso se considera inalcanzable.
- **Max age**: dos veces el intervalo de refresco de LSA. Un LSA más viejo que
  ese valor se elimina de la base de datos link-state.

Presionar **Apply** para enviar los nuevos valores a la simulación en ejecución.
El cambio toma efecto en el siguiente tick del timer del protocolo, sin
necesidad de reiniciar nada.

![Ventana emergente de configuración del protocolo, con los valores derivados Dead interval y Max age](../../images/protocol-popover.png)

Para conocer la mecánica subyacente, ver
[`docs/architecture/routing-protocol.md`](../../architecture/routing-protocol.md).

### Atajos de teclado

| Tecla | Acción |
|---|---|
| <kbd>Space</kbd> | Start / Stop |
| <kbd>P</kbd> | Pause / Resume |
| <kbd>N</kbd> | Agregar LAN |
| <kbd>H</kbd> | Agregar host |
| <kbd>R</kbd> | Agregar router |
| <kbd>F</kbd> | Ajustar vista |
| <kbd>Esc</kbd> | Limpiar selección / cerrar menú contextual |
| <kbd>Delete</kbd> | Eliminar el nodo seleccionado |

Los atajos están **deshabilitados** mientras un campo de texto tiene el foco
(para que escribir en una terminal no dispare accidentalmente **Router**) y
mientras se mantiene presionada alguna tecla modificadora (para que
<kbd>Ctrl+R</kbd> siga siendo la recarga del navegador).

## Canvas

El _canvas_ es un SVG con tres sistemas de coordenadas (mundo / vista /
pantalla). Se interactúa con él mediante estos gestos:

- **Click en un nodo** lo selecciona, y el inspector se completa a la derecha.
- **Arrastrar un nodo** lo mueve. Las coordenadas se persisten.
- **Arrastrar el canvas vacío** desplaza la vista, que también se persiste.
- **Scroll sobre el canvas** hace zoom alrededor del cursor.
- **Click derecho en un nodo** abre el menú contextual (renombrar, duplicar,
  eliminar).
- **Doble click en un host o router** abre su terminal.

### Qué se ve

- Los **hosts** aparecen como íconos de estación de trabajo.
- Los **routers** aparecen como íconos de cubo.
- Las **LANs (redes de acceso múltiple)** aparecen como _rails_ horizontales o
  verticales, con extremos marcados y una marca por cada interface conectada.
  Arrastrar el manejador del _rail_ lo alarga; arrastrar su cuerpo lo mueve.
- Los **links punto a punto** aparecen como aristas directas entre los dos
  extremos, con una etiqueta arrastrable en el punto medio que lleva el nombre
  del link y su CIDR.
- Las **etiquetas de interface** (cuando **Interfaces** está activado) muestran
  el nombre y la dirección de la interface en cada punto de conexión.
- Las **etiquetas de costo** (cuando **Costs** está activado) muestran la
  métrica en cada interface de router.

La selección se indica con un anillo de resaltado alrededor del nodo.

### LANs privadas

Las redes cuyo CIDR cae en un rango privado RFC 1918 (`10.0.0.0/8`,
`172.16.0.0/12` o `192.168.0.0/16`) se dibujan en un **tono neutro atenuado** en
lugar del color de acento predeterminado. La misma atenuación se aplica a las
etiquetas de interface del lado del router de esas LANs. Esta señal visual
permite ubicar el límite del NAT de un vistazo: atenuado significa detrás del
NAT, y con color significa ruteado directamente.

![Las LANs privadas se dibujan en tono atenuado; la LAN pública conserva el color de acento](../../images/50-private-lan-tone.png)

Los hosts, las aristas y los íconos de router conservan la saturación completa:
solo cambian de tono el _rail_ de la LAN y sus etiquetas de interface del lado
del router. Los estilos de selección y de cursor encima se siguen aplicando, de
modo que una LAN privada seleccionada continúa claramente resaltada.

Ver [NAT y LANs privadas](nat-and-private-lans.md) para entender cómo cruza el
tráfico ese límite y cómo inspeccionar la tabla NAT del router de egreso.

## Animaciones de paquetes

Cada datagrama que atraviesa una LAN o un link se dibuja como un pequeño
rectángulo de color que viaja entre sus extremos. El color codifica el tipo de
paquete (`user_datagram`, `routing_flood`, `ping_request`, `ping_reply`), y el
botón **Chatter** de la barra de herramientas filtra los paquetes del protocolo
de ruteo cuando se busca un _canvas_ más tranquilo.

### Inspeccionar el contenido de los paquetes

#### Pausar y pasar el cursor

**Pausar la simulación y luego pasar el cursor sobre cualquier paquete
congelado: aparece un _tooltip_ con el contenido del paquete.** Pausar congela
en el lugar las animaciones de los paquetes en vuelo, de modo que el _canvas_
funciona como un depurador paso a paso.

El _tooltip_ muestra:

- El **tipo de paquete** (`user_datagram` / `routing_flood` / `ping_request` /
  `ping_reply` / `unknown`).
- Los **extremos originales** de la conversación, es decir, el origen y el
  destino L3 tal como estaban cuando se creó el paquete.
- Una segunda línea **`hop:`**, únicamente cuando el tramo de animación actual
  transcurre entre direcciones distintas de los extremos originales, o sea,
  cuando un router está haciendo forwarding de un datagrama. Los paquetes de un
  solo hop y los de broadcast no muestran esta línea.

![Pasar el cursor sobre un paquete pausado para inspeccionar sus extremos](../../images/40-packet-tooltip.png)

Esta es la maniobra canónica de depuración cuando se quiere rastrear por dónde
va realmente el tráfico: pausar, pasar el cursor sobre cada paquete congelado en
orden y leer el recorrido hop por hop. Mientras la simulación está en ejecución,
los paquetes se mueven demasiado rápido como para que el _tooltip_ se pose sobre
ellos de manera confiable, así que conviene pausar primero.

#### Panel de paquetes

Para seguir varios paquetes a la vez, o para mantener el contexto mientras la
simulación sigue en ejecución, hacer click en **Packets** en la barra de
herramientas. Un panel se desliza desde la derecha y muestra:

- **In flight: user traffic.** Una fila por cada paquete que está cruzando la
  red, con una insignia numérica (`#1`, `#2`, …). Esa misma insignia viaja sobre
  el punto correspondiente en el _canvas_, de manera que una fila y su paquete
  siempre quedan emparejados a la vista. Al expandir una fila se ven el
  historial de hops del paquete y las traducciones NAT ocurridas en el camino.
- **In flight: routing chatter.** Los paquetes del protocolo de ruteo se
  resumen por defecto en una sola línea, para mantener la lista legible. Al
  expandir el resumen se ve cada uno por separado, con su propia insignia `#R1`,
  `#R2`, … y una etiqueta **Hello** / **LSA** que deja claro de un vistazo el
  tipo de mensaje, algo muy útil al enseñar cómo el protocolo propaga sus
  actualizaciones. El _flooding_ de LSA se escalona hop por hop: primero se
  anima la emisión del originador, y cada reenvío posterior recién empieza a
  moverse cuando el hop entrante llegó visualmente a quien lo reenvía, de modo
  que el _flood_ se propaga como una onda por la topología en vez de aparecer
  todo a la vez.
- **Recent.** Los últimos diez paquetes de tráfico de usuario que completaron su
  recorrido, descartando siempre el más antiguo. Vale el mismo comportamiento de
  expandir para ver el detalle.

El panel funciona igual de bien con la simulación en pausa: las insignias
congeladas quedan sobre los cables, al lado de las filas del panel, lo que hace
muy fácil leer la correspondencia entre unas y otras.

![Panel de paquetes mostrando tráfico de usuario en vuelo con insignias numéricas](../../images/41-packets-panel.png)

![Una fila expandida mostrando el historial de hops](../../images/42-packets-panel-expanded.png)

### Anotaciones NAT

Los paquetes que atravesaron un hop con NAT muestran la traducción en su
_tooltip_. Pausar la simulación y pasar el cursor sobre el paquete para ver
líneas como `NAT @ r_a: 192.168.1.10 → 198.51.100.1`. Al seleccionar el router
de egreso, el inspector abre un panel con la tabla NAT y sus entradas activas:
cada fila muestra el origen privado original, el origen público reescrito, el
destino y el flow ID (abreviado para que entre; pasar el cursor por encima
revela el valor completo). La tabla crece a medida que fluye el tráfico, y la
cantidad de entradas se acota descartando las menos usadas recientemente.

![Panel del inspector para un router de egreso, mostrando una traducción NAT activa](../../images/51-nat-panel.png)

Ver [NAT y LANs privadas](nat-and-private-lans.md) para el flujo de trabajo
completo.

## Panel izquierdo (navegación)

El panel izquierdo lista todas las entidades agrupadas por tipo: redes, links,
hosts y routers. Hacer click en un nombre lo selecciona, y el **+** que está al
lado del título de cada sección agrega una nueva entidad de ese tipo. El menú
contextual vive en el _canvas_, no acá. La selección se comparte con el
_canvas_, así que ambos paneles coinciden siempre en qué hay seleccionado.

El indicador de **Save state** (`autosaved` durante la operación normal,
`saving…` por un instante después de una modificación) está en la **barra de
encabezado**, junto al nombre editable del proyecto.

## Panel derecho (inspector)

El inspector dibuja **un panel por cada nodo seleccionado**, con secciones que
varían según el tipo de nodo. El panel se ve entero de una vez: no hay pestañas
entre las que alternar.

Para cualquier tipo de nodo:

- **Identifier / name**: editable. Los cambios de nombre se validan para
  garantizar unicidad.
- **Properties**: dirección, pertenencia a una red o link, y gateway (solo en
  hosts).
- **Duplicate / Delete**: al final del panel. Duplicate clona el nodo con un
  nombre nuevo, y Delete lo elimina.

Secciones específicas según el tipo:

| Selección | Secciones adicionales |
|---|---|
| Red | CIDR, más un botón **Orientation** que alterna el _rail_ entre horizontal y vertical |
| Link | (solo CIDR) |
| Host | Tipo de conexión, red o link, IP y gateway por defecto |
| Router | Lista de interfaces (una fila expandible por interface), Neighbors, tabla de ruteo y, una vez que el router tradujo algo, una tabla NAT |

### Inspector de router

Con un router seleccionado, el inspector incluye tanto la lista de interfaces
(nombre · red · dirección · costo, más `+ Add interface`) **como** la tabla de
ruteo actual. Esta última se actualiza automáticamente al seleccionar el router
y cada vez que llega una actualización de ruteo para ese dispositivo. Sus
columnas son: prefijo, next hop e interface.

Una ruta directamente conectada muestra `0.0.0.0` como next hop: es el valor
centinela del simulador, que significa "entregar al destino del paquete por esta
interface". Ver [Tablas de ruteo](routing-tables.md) para saber cómo
interpretarlo.

El inspector del router también muestra una sección **Neighbors**, que lista,
por interface, cada vecino descubierto y su estado de adyacencia (`TWO_WAY`,
`INIT` o `DOWN`). La línea de resumen cuenta los routers vecinos distintos, el
total de adyacencias y un desglose por estado; ver
[Conteo de vecinos](#conteo-de-vecinos) más abajo para la diferencia entre
vecinos y adyacencias.

![Inspector de router mostrando el panel Neighbors y la sección colapsable de tabla de ruteo](../../images/inspector-router.png)

### Conteo de vecinos

Un router completamente convergido muestra, por ejemplo,
`(2 peers · 4 adjacencies · 4 TWO_WAY)`, mientras que uno que todavía se está
acomodando o que tiene algunos links inalcanzables podría mostrar
`(2 peers · 4 adjacencies · 3 TWO_WAY · 1 INIT)`. Los dos conteos miden cosas
distintas:

- **Peers**: la cantidad de *routers vecinos distintos* que este router
  descubrió, sin importar en cuántas LANs o links compartidos se encuentren.
- **Adjacencies**: una entrada por cada interface desde la cual un vecino es
  alcanzable. Dos routers que comparten `lan1` y `lan2` cuentan como **un peer y
  dos adyacencias**, porque cada LAN forma su propia adyacencia.

Los totales `TWO_WAY`, `INIT` y `DOWN` son estados por adyacencia (ni los peers
ni las adyacencias son estados). Los conteos de estado que dan cero se omiten
para mantener la línea compacta.

Una interface conectada a una LAN o link donde no hay ningún otro router (un
_stub_, como una LAN que sirve solo a hosts) se muestra como
`no other routers` y *no* se cuenta como una adyacencia `DOWN`: no hay nada
del otro lado con quien establecer vecindad, así que marcarla como DOWN sería
engañoso. El caso DOWN real, el que sí suma al conteo, es el de una interface
que *debería* tener un vecino pero todavía no escuchó ninguno (o cuyos Hellos
del vecino dejaron de llegar).

## Terminales

Hacer doble click en cualquier host o router abre una terminal flotante. Cada
terminal es una ventana emergente autónoma que tiene:

- Una barra de título con el nombre del dispositivo.
- Un área de salida con scroll.
- Un prompt con `#`.
- Manejadores para arrastrarla y, en las esquinas, para redimensionarla.

La posición y el tamaño se persisten por dispositivo.

Teclado dentro de una terminal:

| Tecla | Acción |
|---|---|
| <kbd>Enter</kbd> | Enviar el comando escrito |
| <kbd>Ctrl+L</kbd> | Limpiar el área de salida |
| <kbd>Ctrl+D</kbd> | Cerrar la terminal (con el prompt vacío) |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Historial de comandos |

Se pueden tener varias terminales abiertas a la vez. Los comandos y sus salidas
están aislados por terminal; no se comparte nada entre ellas.

Para el conjunto completo de comandos, ver [Terminales](terminals.md).

## Menú contextual (click derecho)

Hacer click derecho sobre un nodo, ya sea en el _canvas_ o en el panel de
navegación, abre el menú contextual.

### En cualquier nodo

| Ítem | Comportamiento |
|---|---|
| **Edit** | Selecciona el nodo y enfoca el inspector, listo para renombrarlo o cambiar sus propiedades (equivale a hacer doble click). |
| **Duplicate** | Clona el nodo con un nombre nuevo; resulta útil para routers. Deshabilitado durante la ejecución. |
| **Delete** | Elimina el nodo. Ver [Eliminar durante la ejecución](#eliminar-durante-la-ejecución) más abajo. |

### En una LAN

| Ítem | Comportamiento |
|---|---|
| **Add host here** | Crea un host nuevo y lo conecta a esta LAN en la posición del cursor. |
| **Add router here** | Crea un router nuevo y lo conecta a esta LAN en la posición del cursor. |

### En un host

| Ítem | Comportamiento |
|---|---|
| **New p2p link…** | Abre el asistente de creación de links para conectar este host directamente a otro dispositivo mediante un link punto a punto. |
| **Move to LAN…** | Mueve la interface de este host a otra LAN (el submenú lista las LANs disponibles). |
| **Detach from LAN** | Desconecta este host de su LAN actual sin eliminarlo. |

### En un router

| Ítem | Comportamiento |
|---|---|
| **New p2p link…** | Abre el asistente de creación de links para conectar este router directamente a otro dispositivo mediante un link punto a punto. |
| **Connect to LAN…** | Agrega en este router una nueva interface conectada a una LAN existente (el submenú lista las LANs a las que todavía no está conectado). |

### En el canvas vacío

Hacer click derecho sobre un espacio vacío ofrece atajos para crear una LAN, un
host o un router en la posición del cursor, ajustar la vista o importar una
topología.

El menú se cierra haciendo click en cualquier lugar fuera de él o presionando
<kbd>Esc</kbd>.

### Eliminar durante la ejecución

| Tipo de nodo | Durante la ejecución |
|---|---|
| **Host** | Se elimina de inmediato (edición en vivo). |
| **Router** | Se elimina de inmediato (edición en vivo). |
| **LAN (sin uso)** | Se elimina de inmediato (edición en vivo). |
| **LAN (con dispositivos conectados)** | Bloqueado: primero hay que desconectar o eliminar los dispositivos. |
| **Link** | Bloqueado: primero hay que detener la simulación. |

### Acciones de administración del router

Con la simulación en ejecución, hacer click derecho sobre un **router** agrega
tres ítems extra por encima del grupo de modificación de la topología:

- **Halt router (graceful)**: apaga el router de manera ordenada antes de
  dejarlo fuera de línea.
- **Crash router**: lo hace fallar abruptamente, sin ningún cierre ordenado,
  simulando un _crash_ real.
- **Resume router**: se muestra en lugar de los dos anteriores cuando el router
  ya está detenido, y lo vuelve a poner en línea.

Un router detenido o caído se ve atenuado en el _canvas_ (oscurecido y
desaturado). Los routers vecinos detectan la pérdida por vencimiento de los
Hello y actualizan sus tablas de ruteo en consecuencia.

### Controles por interface

Con un router seleccionado y la simulación en ejecución, la lista de interfaces
del inspector muestra botones de acción junto a cada una:

- **Disable**: baja la interface de manera ordenada (apagado administrativo).
- **Fail**: la hace fallar de golpe, sin cierre ordenado.
- **Enable**: vuelve a habilitar una interface deshabilitada.

En el _canvas_, la arista de una interface caída se convierte en un cable gris
sólido con una pequeña ✕ en su punto medio, distinto del estilo punteado que
usan los links punto a punto activos. Los paquetes dirigidos a una interface
caída se descartan al entrar al link: salen del origen y se desvanecen sin
llegar al dispositivo. El botón alterna entre Disable/Fail y Enable a medida que
cambia el estado de la interface.

## Indicadores de estado

- **Save state** (barra de encabezado, junto al nombre del proyecto):
  `autosaved` / `saving…`.
- **Sim state** está implícito en la barra de herramientas: la etiqueta del
  botón Start alterna entre **Start** y **Stop**, y la de Pause alterna entre
  **Pause** y **Resume (N edits)**.
- **Connection banner**: si el WebSocket se desconecta, aparece una franja
  amarilla en la parte inferior con el mensaje *"connection lost — retrying"*.
  La reconexión es automática (con backoff exponencial, hasta un máximo de 8 s).
