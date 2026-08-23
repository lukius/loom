> 🌐 [English](../../user-guide/building-topologies.md) · **Español**

# Construir topologías

Una topología de `loom` se construye a partir de cuatro tipos de entidades:
**redes** (LANs de acceso múltiple), **links** (punto a punto), **hosts** y
**routers**. Esta guía recorre cada uno de ellos, tanto en el _canvas_ como en
YAML.

Con la simulación en `idle` o en pausa están disponibles todas las operaciones
de agregar, renombrar, duplicar y eliminar. Durante la ejecución se pueden
agregar redes, links, hosts y routers directamente en el _canvas_: cada entidad
nueva se incorpora a la simulación en vivo apenas se completa su dirección o su
CIDR (en vivo solo se permite completar la dirección de una entidad nueva;
cambiar la dirección de una interface existente requiere detener la simulación
primero). Renombrar, duplicar y editar direcciones de entidades ya existentes
sigue bloqueado durante la ejecución, así que para eso conviene pausar.

Si se prefiere trabajar directamente con YAML en vez del _canvas_, ir a
[Formato YAML](yaml-format.md) para la referencia del esquema. Ambos enfoques
producen la misma topología, ya que la SPA hace la vuelta completa a través del
parser.

---

## Redes (LANs de acceso múltiple)

Una **red** es una LAN de acceso múltiple. Los hosts y los routers se conectan a
ella a través de sus interfaces, y a cada interface se le asigna una dirección
del prefijo de la red.

### Agregar una

Hacer click en **LAN** en la barra de herramientas (o presionar <kbd>N</kbd>).
Aparece un nuevo _rail_ de red en el centro del _canvas_, con un nombre
provisional y un prefijo `/24`.

![Nueva LAN agregada](../../images/10-add-lan.png)

Hacer click en el _rail_ para seleccionarlo abre el inspector, donde se puede
editar:

- **Name**: debe ser único entre redes **y** links. Se guarda automáticamente.
- **CIDR**: cualquier prefijo IPv4 válido. El parser lo canonicaliza
  (`10.1.2.3/24` pasa a ser `10.1.2.0/24`). Dos LANs no pueden compartir el
  mismo prefijo, salvo que se trate de un rango privado RFC 1918 (`10.0.0.0/8`,
  `172.16.0.0/12` o `192.168.0.0/16`); los prefijos públicos deben ser únicos en
  toda la topología.

Varios inquilinos pueden declarar CIDRs privados superpuestos; por ejemplo, dos
segmentos de LAN independientes pueden usar los dos `192.168.1.0/24`. El tráfico
que se origina en una LAN privada y va hacia una dirección pública recibe
automáticamente source-NAT en el router de egreso, de modo que el lado público
ve la IP pública del propio router y no la dirección privada del host.

### Conectar un dispositivo

Arrastrar un host o un router cerca del _rail_ y soltarlo. La interface se
conecta automáticamente y recibe la próxima IP libre del prefijo. El inspector
muestra la dirección asignada, que puede cambiarse si se quiere una en
particular.

Un dispositivo puede conectarse a una LAN mediante **una o más interfaces**
(solo los routers, en la práctica, ya que los hosts tienen exactamente una).

### Mover y redimensionar el rail

- Arrastrar el cuerpo del _rail_ para desplazarlo.
- Arrastrar el manejador de cualquiera de sus extremos para alargarlo o
  acortarlo. Hay una longitud mínima (aproximadamente el ancho de una etiqueta
  corta) y una máxima (aproximadamente el ancho de la pantalla a zoom normal), y
  el manejador se ajusta a esos límites.

### Eliminar

Click derecho → **Delete**, o bien seleccionar y presionar <kbd>Delete</kbd>. Si
algún host o router todavía tiene una interface en esta LAN, la SPA bloquea la
eliminación con una notificación. Hay que eliminar o reubicar antes esos
dispositivos.

Durante la pausa, la eliminación queda encolada; la baja efectiva del lado del
servidor ocurre al hacer **Resume**.

---

## Hosts

Un **host** es un dispositivo final que puede enviar y recibir datagramas, pero
no puede hacer forwarding. Cada host tiene exactamente **una interface**.

### Agregar uno

Hacer click en **Host** (o presionar <kbd>H</kbd>). Aparece un nuevo ícono de
host en el centro del _canvas_. Se pedirá (o el inspector mostrará) lo
siguiente:

- **Name**: debe ser único entre hosts y routers.
- **Network** o **Link**: la red o el link al que se conecta el host.
- **Address**: debe ser una IP utilizable dentro del prefijo elegido. En los
  links `/30`, las direcciones de red y de broadcast están reservadas.
- **Gateway** (opcional):
  - En una LAN, una IP válida dentro de esa misma LAN. Es necesaria si el host
    tiene que alcanzar algo fuera de ella.
  - En un link, **se completa automáticamente con la IP del peer**. Si se la
    configura a mano, debe coincidir con la del peer: los gateways que no
    coinciden se rechazan.

Soltar el host cerca del _rail_ de una LAN lo conecta a esa LAN; soltarlo cerca
del extremo de un link lo conecta allí.

### Configurar un gateway

Si el host está en una LAN, el inspector muestra un campo **Gateway**. Ahí se
elige la IP del router que debe hacer forwarding del tráfico hacia afuera de la
red. Sin gateway, los `ping` y `send` hacia afuera fallan con
*"no route to host: no gateway configured."*

Si el host está en un link, el gateway es la IP del peer. No hace falta
escribirla: el parser la completa y el inspector la muestra como solo lectura.

### ¿Hosts multi-homed?

No. `loom` modela deliberadamente los hosts como dispositivos de una sola
interface. Si se necesita un dispositivo con varias interfaces, hay que usar un
router. El parser rechaza un host YAML con más de una interface, y la SPA ni
siquiera permite dibujarlo.

---

## Routers

Un **router** tiene una o más interfaces y ejecuta el protocolo de ruteo
link-state. Sus interfaces pueden conectarse a LANs, a links punto a punto o a
ambos.

### Agregar uno

Hacer click en **Router** (o presionar <kbd>R</kbd>). Aparece un router nuevo en
el centro del _canvas_, sin interfaces.

Al abrir el inspector, la sección **Interfaces** del router muestra un botón
**+ Add interface**. Para cada interface hay que indicar:

- **Name**: único dentro de este router (`eth0`, `eth1`, …).
- **Network** o **Link**: elegir uno; nunca los dos.
- **Address**: debe ser válida para la red o el link elegido.
- **Cost**: la métrica que usa el protocolo de ruteo. Conviene fijarla
  explícitamente. Cuanto más alto, menos preferida. Se admiten enteros
  positivos.

Un router puede conectarse a tantas LANs y links como se quiera, siempre que
cada nombre de interface sea único dentro del router y que no haya dos
interfaces de router con la misma dirección sobre la misma LAN o link.

![Router con tres interfaces](../../images/12-router-interfaces.png)

### Cambiar un costo

El inspector permite editar la columna **Cost** en el lugar. El cambio se
comporta así:

- En `idle`, se guarda en el navegador y se aplica la próxima vez que se cargue
  la topología.
- Durante la ejecución, la barra de herramientas no admite ediciones directas de
  costo, así que hay que pausar primero.
- En pausa, el cambio de costo queda encolado. Al hacer **Resume**, el servidor
  lo aplica y el protocolo de ruteo lo toma en el siguiente _flood_ de LSA.

También se puede editar un costo desde la terminal del router:

```
update_cost eth0 25
```

Esto no pasa por el inspector y actualiza el router directamente. Cualquiera de
las dos vías sirve: ambas invocan la misma operación de actualización de costo
en el backend.

### Eliminar

Click derecho → **Delete**. Eliminar un router del que dependen otros para rutear
hará que algunas rutas desaparezcan de los vecinos, y eso es intencional. Sus
grafos van a seguir haciendo referencia al router eliminado hasta que reciban un
anuncio nuevo que ya no lo mencione (lo que, en este protocolo, ocurre porque
las aristas del router eliminado *dejan de anunciarse*). En la práctica, conviene
reiniciar o hacer un reset para ver un estado limpio.

---

## Links punto a punto

Un **link** es un `/30` o un `/31` con exactamente **dos** extremos. Cada
extremo puede ser un router o un host (router–router, router–host o host–host).
No hay dominio de broadcast: los frames van directamente al peer.

### Agregar uno

Hay dos maneras de crear un link directamente en la aplicación:

**Asistente con click derecho**: hacer click derecho sobre cualquier host o
router y elegir **New p2p link…**. Aparece un cartel pidiendo elegir el otro
extremo. Al hacer click sobre el dispositivo peer en el _canvas_, el link se
crea con ambos extremos conectados y aparece de inmediato. El link arranca sin
CIDR, así que hay que seleccionarlo y configurar en el inspector tanto el CIDR
como las IPs de los extremos.

**Botón del inspector**: seleccionar un host o un router en el inspector,
buscar una interface cuyo tipo esté configurado como **Link** y hacer click en
**+ New link**, al lado del selector. Se crea un link nuevo y la interface queda
conectada a él; después puede conectarse una segunda interface (de cualquier
dispositivo) para completar el par.

También se pueden describir los links en YAML e importar el archivo mediante
**Import → Browse local file…**, si se prefiere escribir la topología como
texto. Ver [Formato YAML](yaml-format.md) para el esquema.

### Reglas

- La máscara debe ser `/30` o `/31`. Cualquier otra cosa se rechaza al parsear,
  con *"link CIDR must be /30 or /31, got /N"*.
- Exactamente dos extremos. El post-procesamiento del parser rechaza un link que
  queda con cero o un extremo (por ejemplo, al referenciar un dispositivo no
  declarado).
- Un link `/30` tiene dos direcciones de host utilizables (`.1` y `.2`); `.0`
  (red) y `.3` (broadcast) están reservadas.
- Un link `/31` tiene dos direcciones de host utilizables (`.0` y `.1`), según
  la RFC 3021.
- Un host en un link hereda automáticamente la IP del peer como gateway.

### ¿Por qué solo `/30` y `/31`?

Una LAN de acceso múltiple ya tiene su propio modelo en `loom`, con semántica de
broadcast. Un link punto a punto es la **excepción** que permite conectar dos
dispositivos sin un bus LAN en el medio. Cualquier prefijo más grande que `/30`
sería ambiguo: ¿se trata de una LAN con dos hosts o de un link? El parser
resuelve la cuestión restringiendo los links a los dos prefijos que admiten una
interpretación punto a punto sin ambigüedades.

### Reutilización de IPs entre links

Dos links paralelos pueden reutilizar el mismo `/30` sin que la entrega se vea
afectada. Un link entrega cada frame al extremo que no es el remitente, y no
busca el destino por dirección, de modo que las coincidencias entre links no
relacionados no producen interferencia. Esto vuelve seguro copiar y pegar una
topología pequeña de laboratorio.

---

## Un recorrido completo

Para construir la topología de ejemplo desde cero:

1. **LAN** tres veces. Renombrar y configurar los CIDRs:
   - `lan1` → `200.100.0.0/24`
   - `lan2` → `100.200.0.0/24`
   - `lan3` → `150.10.10.0/24`
2. **Host** tres veces. Conectar y direccionar:
   - `h1` en `lan1` con `200.100.0.10`, gateway `200.100.0.1`
   - `h2` en `lan2` con `100.200.0.20`, gateway `100.200.0.2`
   - `h3` en `lan3` con `150.10.10.30`, gateway `150.10.10.1`
3. **Router** tres veces. Conectar las interfaces:
   - `r1`: eth0 en `lan1` (`200.100.0.1`, costo 10), eth1 en `lan2`
     (`100.200.0.1`, costo 15).
   - `r2`: eth0 en `lan1` (`200.100.0.254`, costo 5), eth1 en `lan2`
     (`100.200.0.2`, costo 8), eth2 en `lan3` (`150.10.10.1`, costo 15).
   - `r3`: eth0 en `lan2` (`100.200.0.10`, costo 20), eth1 en `lan3`
     (`150.10.10.10`, costo 5).
4. Agregar el link `p2p1: "10.0.0.0/30"` con **New p2p link…**: hacer click
   derecho en `r1`, elegir **New p2p link…** y luego hacer click en `r3` en el
   _canvas_. Seleccionar el link nuevo y fijar su CIDR en `10.0.0.0/30`. Después,
   configurar los costos en el inspector:
   - `r1.eth2` en `p2p1` (`10.0.0.1`, costo 5)
   - `r3.eth2` en `p2p1` (`10.0.0.2`, costo 5)

Al hacer click en **Export** y elegir carpeta y nombre en el diálogo de
guardado, el archivo resultante debería coincidir con el contenido de
`samples/sample.yaml` (salvo por los metadatos de coordenadas, que la SPA
guarda localmente).

---

## Errores de validación

Al hacer click en **Start** o al importar un YAML, el servidor ejecuta el
validador completo. Estos son los fallos más comunes:

| Error | Significado |
|---|---|
| `missing "internet" key at YAML root` | El YAML de nivel superior no tiene una clave `internet:`. |
| `missing "autonomous_systems" in internet block` | El bloque `internet:` no contiene un mapeo `autonomous_systems:`. |
| `<dev>: <iface>: declares both network and link` | Una misma interface solo puede conectarse a una red o a un link, nunca a ambos. |
| `<dev>: <iface>: address already in use by <other>` | Dos interfaces sobre la misma red o link comparten una IP. |
| `<host>: gateway address not in host network` | La IP del gateway no está dentro de la subred del host. |
| `<host>: gateway mismatch: expected X, got Y` | El host está en un link y el gateway explícito no coincide con la IP del peer. |
| `<link>: link CIDR must be /30 or /31, got /N` | Los links deben ser `/30` o `/31`. |
| `<link>: link must have exactly two endpoints (got N)` | Un link tiene cero, uno, o tres o más extremos. |
| `<link>: invalid address for link <name>` | En un `/30`, se intentó usar `.0` o `.3`. |
| `<dev>: <iface>: invalid cost` | El costo no es un entero. |

El diálogo de error nombra la entidad problemática: el parser se ocupa de dar
contexto suficiente como para poder ubicar la línea en el YAML o la entidad en
el _canvas_.
