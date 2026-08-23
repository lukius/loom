> 🌐 [English](../../user-guide/routing-tables.md) · **Español**

# Tablas de ruteo, vecinos y costos

Esta guía explica qué contiene la tabla de ruteo de un router, cómo
inspeccionarla y cómo hace el protocolo link-state **loom-OSPF** para
completarla.

Acá se incluye una explicación breve del protocolo desde el punto de vista de
quien lo usa; el detalle profundo vive en
[`docs/architecture/routing-protocol.md`](../../architecture/routing-protocol.md).
Para ajustar los intervalos de Hello y de refresco de LSA está el botón
**Protocol** de la barra de herramientas; ver
[Interfaz web: configuración del protocolo](web-ui.md#configuración-del-protocolo).

## Cómo aparecen las rutas

Al presionar **Start**, cada router empieza a inundar con anuncios link-state
todas sus interfaces, una vez por intervalo de refresco de LSA (30 s por
defecto, ajustable en vivo desde la ventana emergente **Protocol**). Cada
anuncio lista los pares `(prefijo, costo)` que el router tiene directamente
conectados.

Un router que recibe uno de esos anuncios:

1. Lo vuelve a inundar por todas las demás interfaces.
2. Actualiza su visión local del grafo de la red.
3. Si el grafo cambió, recalcula con Dijkstra los caminos más cortos desde sí
   mismo hacia cada prefijo conocido.
4. Reescribe su tabla de ruteo a partir de esos caminos.

El ciclo completo es **observable**: cada reconstrucción de la tabla de ruteo
dispara un redibujado de la sección correspondiente en la SPA.

## Inspeccionar una tabla de ruteo

### Desde la SPA

Hacer click en un router del _canvas_. En el panel derecho, el inspector muestra
juntas las interfaces del router y su tabla de ruteo actual, sin necesidad de
cambiar de pestaña.

![Tabla de ruteo del router r2 después de converger](../../images/20-routes.png)

Las columnas son:

- **Prefix**: la red de destino (un CIDR IPv4).
- **Next hop**: la IP del router siguiente, o `0.0.0.0` si el destino está
  directamente conectado.
- **Iface**: cuál de las interfaces de este router hace forwarding del tráfico
  para ese prefijo.

La tabla se **reconstruye desde cero** ante cada cambio relevante del grafo, así
que se ven filas aparecer, desaparecer o cambiar de interface a medida que el
protocolo converge o que se modifican los costos.

### Desde una terminal

Hacer doble click en el router para abrir una terminal y escribir:

```
route
```

```
prefix               next_hop        iface
200.100.0.0/24       0.0.0.0         eth0
100.200.0.0/24       0.0.0.0         eth1
150.10.10.0/24       100.200.0.10    eth1
```

Esta es la tabla de `r2` en la topología de ejemplo. `lan1` y `lan2` están
directamente conectadas (`0.0.0.0`). El tráfico hacia `lan3` (`150.10.10.0/24`)
se reenvía a `r3` (`100.200.0.10`) por `eth1`: aun cuando `r2` tiene su propia
`eth2` sobre `lan3` (costo 15), el camino por `lan2` hasta `r3` (costo 8 + 5 =
13) resulta más barato. loom-OSPF calcula las rutas puramente a partir de los
caminos más cortos de Dijkstra y no les da preferencia automática a las redes
directamente conectadas, de modo que gana el camino indirecto más económico.

El link punto a punto `p2p1` (`10.0.0.0/30`) directamente no aparece en la tabla
de `r2`: se trata de un rango privado (RFC 1918), y los routers no anuncian
prefijos privados a sus vecinos, así que `r2` nunca aprende una ruta hacia él.
Solo `r1` y `r3`, que están directamente sobre `p2p1`, tienen una ruta hacia ese
prefijo.

Ese ocultamiento se refiere a los *destinos*, no al link en sí. `r1` y `r3`
siguen anunciando que están conectados a él, con lo cual el link participa del
cálculo de caminos más cortos de todos los routers y transporta tráfico
destinado a redes que están más allá. Una red privada, sea link o LAN, es
invisible como lugar **al cual** enviar paquetes, pero nunca como camino **por
el cual** enviarlos.

## Qué significa `0.0.0.0`

El simulador usa `0.0.0.0` como valor centinela, con el significado de *"el
destino está en una red directamente conectada"*.

Cuando un paquete matchea una regla cuyo next hop es `0.0.0.0`:

- El **destino L3** del paquete es también su **próximo salto de L2** (el router
  que hace forwarding arma el frame de salida dirigido al destino final, y no a
  otro router).
- Eso entrega el paquete directamente al destino, a través de la LAN o el link
  local.

Es decir, ver `0.0.0.0` en una tabla de ruteo significa **entrega directa**, y no
una falla del protocolo de ruteo.

## Costos y caminos

Cada interface de router tiene un **costo**, una métrica entera positiva. El
protocolo de ruteo calcula los caminos más cortos de Dijkstra ponderados por
esos costos.

El costo es el de la interface **del lado de la transmisión**, es decir, aquella
desde la cual se origina el anuncio. Así, en la topología de ejemplo, la `eth0`
de `r1` (sobre `lan1`) tiene costo 10, lo que significa que *salir por `r1.eth0`
cuesta 10*. El router que recibe el anuncio registra esa arista como
`r1 ↔ lan1` con peso 10.

Para inclinar el tráfico hacia un camino:

1. Abrir la terminal del router que origina el anuncio.
2. Ejecutar `update_cost <iface> <nuevo_costo>`.

Por ejemplo, para desalentar el ruteo a través de `r1` en `lan1`:

```
# terminal de r1
update_cost eth0 100
```

También puede hacerse desde el panel del inspector del router (la lista de
interfaces tiene editores de **Cost** en el lugar). Cualquiera de las dos vías
invoca la misma operación de actualización de costo en el backend.

El cambio se propaga en el siguiente _flood_ de LSA. Dentro de un intervalo de
refresco de LSA por hop, todos los routers tienen el grafo nuevo y ya
recalcularon sus rutas.

## Convergencia

El tiempo de convergencia está dominado por dos factores:

1. **El intervalo de refresco de LSA.** Los routers nuevos o los costos
   modificados solo se inundan una vez por intervalo. Un intervalo de 30 s
   implica que cada hop puede demorar hasta 30 s en propagar el cambio.
2. **El diámetro de la red.** Un cambio en un extremo de una cadena de N hops
   tarda, en el peor caso, hasta N intervalos de refresco en llegar al otro
   extremo (cada "próximo hop" regula la propagación del _flood_ según su propio
   reloj).

En la topología de ejemplo (de diámetro 3), la convergencia con el intervalo de
refresco de LSA por defecto de 30 s demora hasta unos 90 s tras un cambio. Al
bajar el **LSA refresh interval** a 1 s en la ventana emergente **Protocol**,
ese mismo cambio converge en menos de 3 s.

El protocolo **sí detecta fallas**. Si un router deja de enviar mensajes de
descubrimiento de vecinos (por ejemplo, porque se lo hizo caer), sus vecinos
notan el silencio. Después de tres intervalos consecutivos sin novedades (el
**dead interval**, igual a 3 × el intervalo de Hello, o sea 30 s por defecto),
la adyacencia se marca como caída. Después de dos intervalos completos de
refresco de LSA (el temporizador de **max age**, 60 s por defecto), el anuncio
del router muerto se purga del grafo de la red y todos los routers recalculan
sus rutas automáticamente.

Con los valores por defecto de 10 s para Hello y 30 s para el refresco de LSA,
el ciclo completo desde la caída hasta la reconvergencia lleva del orden de
decenas de segundos (hasta 30 s para declarar muerto al vecino, y luego hasta
60 s para que expire el anuncio viejo). Bajar esos intervalos en la ventana
emergente **Protocol** permite ver la convergencia en apenas unos segundos.

## Vecinos

### Desde la terminal

Un router puede listar sus **vecinos directamente conectados**, es decir, los
otros routers que están sobre la misma LAN o link.

En la terminal:

```
neighbors
```

```
  r1     via lan1     (200.100.0.1)  cost=10
  r1     via lan2     (100.200.0.1)  cost=15
  r3     via lan2     (100.200.0.10) cost=20
  r3     via lan3     (150.10.10.10) cost=5
```

(Esos son los vecinos de `r2` en la topología de ejemplo: `r1` y `r3`,
conectados por varias LANs distintas y con costos distintos).

Cada fila es una **adyacencia**: una LAN o link compartido, una interface y un
costo. Un router puede tener varias adyacencias con el mismo vecino si
comparten más de una LAN o link.

El comando `neighbors` es una vista de solo lectura de lo que el router ve
localmente de la red. Se actualiza a medida que se suman routers nuevos, pero
recién después de que haya llegado su primer anuncio. Si un router no muestra
ningún vecino, puede ser porque:

- No tiene routers pares (se lo conectó únicamente a hosts), o
- Todavía no completó un ciclo de Hello (hay que darle un intervalo).

### Desde el inspector

Hacer click en un router del _canvas_. La sección **Neighbors** del inspector
(debajo de la tabla de ruteo) muestra cada interface y el estado de adyacencia
con cada peer sobre esa interface:

| Estado | Significado |
|---|---|
| **TWO_WAY** | Bidireccional: ambos routers escucharon el Hello del otro y se listaron mutuamente como vecinos. Las rutas se intercambian normalmente. |
| **INIT** | Unidireccional: este router escuchó un Hello del peer, pero el Hello del peer todavía no lo lista a él. Suele ser un estado transitorio que se resuelve dentro de un intervalo de Hello. |
| **DOWN** | Se espera un peer (hay otro router conectado a la misma LAN o link) pero no llegó ningún Hello reciente. Aparece tras una caída o cuando venció el dead interval del peer. |
| **no other routers** | La interface conecta únicamente con hosts, así que no hay con quién establecer vecindad. Es lo normal en una interface _stub_. |

La línea de resumen (por ejemplo, *2 peers · 3 adjacencies · 2 TWO_WAY ·
1 DOWN*) permite ver de un vistazo si el router convergió del todo o si todavía
está esperando que un peer se levante.

## Leer un camino

Al hacer `ping h3` desde `h1` en la topología de ejemplo, los routers del camino
pueden leerse directamente de sus tablas de ruteo:

- `h1` (en `lan1`, con gateway `200.100.0.1`) envía el paquete a `r1.eth0`.
- La tabla de `r1` dice `150.10.10.0/24 → 10.0.0.2 / eth2`: a través del link
  `p2p1`, con next hop `r3`.
- La tabla de `r3` dice `150.10.10.0/24 → 0.0.0.0 / eth1` (directamente
  conectada).
- `r3.eth1` (`150.10.10.10`) entrega el paquete a `h3` en `lan3`.

La respuesta es otro conjunto de consultas, y toma un camino diferente. El
gateway de `h3` es `r2` (`150.10.10.1`), y `r2` tiene `lan1` directamente
conectada, de modo que la respuesta llega a `h1` sin tocar nunca `p2p1`. El
forwarding se decide hop por hop y dirección por dirección: nada ata una
respuesta al camino que tomó su pedido.

Notar que `r1` rutea *a través de* `p2p1` mientras que ningún otro router tiene
una ruta *hacia* `10.0.0.0/30`. Ser privado mantiene al link fuera de las tablas
de los demás routers como destino, pero no le impide transportar tráfico de
tránsito para los routers de ambos extremos.

La animación de los paquetes en el _canvas_ sigue ese mismo camino. Si se sube
el costo de `r1.eth2` de 5 a 99, el link deja de valer la pena: después de
reconverger, el siguiente ping sale de `r1` por `eth1` hacia `lan2` rumbo a `r3`
(`100.200.0.10`), y el cambio de camino se ve en la animación.

## Resolución de problemas

**"Mi ruta apareció y desapareció."** El servidor emite eventos de actualización
de la tabla de ruteo en **cada** recálculo, incluidos los estados intermedios y
transitorios de la convergencia. Mirando con atención durante las primeras
rondas de _flooding_ link-state, se ven las rutas acomodarse en dos o tres
pasadas: el protocolo va aprendiendo el grafo de a un _flood_ por vez.

**"Los costos no son simétricos."** No tienen por qué serlo. Cada interface
tiene su propio costo; que `r1.eth0` valga 10 y `r2.eth0` valga 5 significa que
el triángulo `r1 ↔ lan1 ↔ r2` tiene dos pesos distintos según la dirección (10
desde el lado de r1, 5 desde el lado de r2). La búsqueda de Dijkstra elige el
camino más barato, asimetrías incluidas.

**"¿Por qué mi camino no usa el salto más corto y evidente?"** Hay que mirar
todos los costos intermedios, y no solo el primero. La menor *cantidad de hops*
no implica el menor *costo de camino*. En la topología de ejemplo, `r3` llega a
`lan1` **sin** usar su link directo con `r1`, que costaría 5 (el link) + 10 (la
interface de `r1` hacia `lan1`) = 15, sino pasando por `r2` a través de `lan3`,
con un costo de 5 + 5 = 10. El link directo es un solo hop y aun así pierde.

**"Mi tabla de ruteo está vacía."** O bien el simulador todavía no dio su primer
tick (hay que darle un momento), o bien el router no tiene routers pares
(conviene revisarlo con `neighbors`). Un router aislado igual obtiene reglas con
`0.0.0.0` para sus redes directamente conectadas apenas hace su primer tick, así
que una tabla realmente vacía significa que no tiene *ninguna* red conectada.
