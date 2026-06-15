> 🌐 [English](../../user-guide/yaml-format.md) · **Español**

# Formato YAML

La topología se describe en YAML. El mismo formato es utilizado por:

- El ejemplo incluido (`samples/sample.yaml`).
- Los diálogos **Import / Export** del SPA.
- El endpoint `POST /topology` del servidor y el archivo de sesión que
  este persiste internamente (ver [Flujo de guardado y reanudación](#flujo-de-guardado-y-reanudación)).

Existe exactamente un esquema. Todos los consumidores pasan por el mismo
parser.

## Estructura de nivel superior

```yaml
internet:
  name: loom              # optional; defaults to 'loom' when absent
  autonomous_systems:
    main:
      asn: 65000          # preserved across round-trips; not yet used for routing (reserved for BGP)
      networks:
        lan1: "200.100.0.0/24"
        ...
      links:
        p2p1: "10.0.0.0/30"
        ...
      hosts:
        h1:
          network: "lan1"
          address: "200.100.0.10"
          gateway: "200.100.0.1"
        ...
      routers:
        r1:
          interfaces:
            eth0:
              network: "lan1"
              address: "200.100.0.1"
              cost: 10
            ...
```

La clave `internet:` es obligatoria en el nivel superior. Dentro de ella,
un campo opcional `name:` etiqueta la instancia de internet, y
`autonomous_systems:` es un mapping donde cada clave es el nombre corto del
AS y cada valor contiene los bloques de entidades de ese AS (`networks`,
`links`, `routers`, `hosts`). Los nombres dentro de un AS deben ser únicos
entre los tipos que pueden colisionar — ver [Reglas de nombres](#reglas-de-nombres) más abajo.

> **Nota (exportación desde el SPA):** Al hacer **Export** desde el SPA,
> tanto `internet.name` como la clave del sistema autónomo se establecen con
> el nombre de proyecto que se escribió en la barra de encabezado — el SPA
> los mantiene sincronizados. El valor por defecto `loom` solo se aplica
> cuando se escribe YAML manualmente sin campo `name:`.

Las topologías con un único AS colocan una sola entrada bajo
`autonomous_systems:`, llamada convencionalmente `main`. Los AS múltiples
están reservados para el futuro soporte de BGP.

El campo `asn:` se lee y se preserva entre round-trips (Export →
Import y `GET /topology`), pero aún no es utilizado por el protocolo
link-state. Su valor por defecto es 65000 cuando está ausente. Se recomienda
usar algún valor del rango privado 64512–65535; el soporte de BGP es trabajo
futuro.

Una topología mínima válida sin dispositivos:

```yaml
internet:
  autonomous_systems:
    main:
      networks:
        lan1: "10.0.0.0/24"
```

Esta topología carga correctamente pero no hace nada útil — no hay tráfico
que reenviar ni routers que hagan flooding. El validador no requiere que haya
al menos un dispositivo.

## Redes

Una red es una LAN de acceso múltiple. Cada entrada mapea un nombre a un
prefijo CIDR.

```yaml
networks:
  lan1: "200.100.0.0/24"
  lan2: "100.200.0.0/24"
  office_a: "10.10.0.0/16"
```

Reglas:

- El CIDR se **canonicaliza** al momento del parseo — los bits de host se
  ponen en cero. `"10.1.2.3/24"` pasa a ser `10.1.2.0/24`.
- La máscara debe estar entre 0 y 32 (en la práctica los prefijos útiles
  son `/8` hasta `/29`; para `/30` o `/31` usar `links:` en su lugar).
- Dos redes pueden compartir el mismo prefijo solo si corresponde a un
  rango privado RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`). Los prefijos públicos deben permanecer únicos.
- No puede haber dos redes con el mismo nombre.

## Links

Un link es un fabric punto a punto `/30` o `/31` con exactamente dos
endpoints. Se declara bajo `links:`:

```yaml
links:
  p2p1: "10.0.0.0/30"
  p2p2: "192.168.5.0/31"
```

Reglas:

- La máscara debe ser `/30` o `/31`. Cualquier otro valor es rechazado con
  *"link CIDR must be /30 or /31, got /N"*.
- El nombre del link no puede colisionar con el nombre de una red.
- El link debe tener **exactamente dos** endpoints una vez procesado el
  resto del YAML (uno o tres endpoints → error del parser).
- Para links `/30`: solo `.1` y `.2` son direcciones de host utilizables
  (`.0` es la red, `.3` es broadcast).
- Para links `/31`: tanto `.0` como `.1` son utilizables (RFC 3021).

## Routers

Un router es un mapping con un bloque `interfaces:` obligatorio:

```yaml
routers:
  r1:
    interfaces:
      eth0:
        network: "lan1"
        address: "200.100.0.1"
        cost: 10
      eth1:
        link: "p2p1"
        address: "10.0.0.1"
        cost: 5
```

Reglas por interface:

- Debe estar presente exactamente uno de `network:` o `link:`.
- `address:` debe ser válida para el fabric elegido (dentro del prefijo; en
  un link `/30`, no puede ser la dirección de red ni de broadcast).
- `cost:` es opcional; su valor por defecto es `1`. Debe ser un entero
  positivo (≥ 1); `0` es rechazado.
- La red o el link referenciado debe existir (declarado en otro lugar del
  YAML antes de que el parser llegue a este punto).

Dentro de un mismo router, los nombres de interface (`eth0`, `eth1`, ...)
deben ser únicos. En todo el AS, no puede haber dos interfaces en el mismo
fabric que compartan una dirección.

Un router sin interfaces es rechazado: `r1: no interfaces declared`.

## Hosts

```yaml
hosts:
  h1:
    network: "lan1"
    address: "200.100.0.10"
    gateway: "200.100.0.1"
```

O en un link:

```yaml
hosts:
  h2:
    link: "p2p1"
    address: "10.0.0.2"
    # gateway is auto-filled to the peer's IP
```

Reglas:

- Exactamente uno de `network:` o `link:` (mutuamente excluyentes).
- `address:` debe ser válida para el fabric.
- En una **red**, `gateway:` es opcional. Si está presente, debe estar
  dentro de la subred del host. Si está ausente, el host no puede alcanzar
  destinos fuera del link.
- En un **link**, `gateway:` se completa automáticamente con la IP del
  peer. Si se indica uno explícitamente, **debe** coincidir con el peer;
  los gateways que no coincidan son rechazados.
- Los hosts tienen exactamente una interface. No existe sintaxis para un
  host con múltiples interfaces.

## Bloques `config:` opcionales

Dos bloques `config:` opcionales permiten persistir configuraciones junto
con la topología. Ambos son opcionales — omitirlos deja todos los valores
por defecto en su lugar.

### `internet.config` de nivel superior

Se coloca directamente bajo `internet:`, junto a `name:` y
`autonomous_systems:`. Cualquier par clave/valor escrito aquí se almacena
y se reemite de forma literal en **Export** y `GET /topology`. El SPA
actualmente lee `packet_duration_ms` (duración de la animación de paquetes
en milisegundos; por defecto 1800).

```yaml
internet:
  config:
    packet_duration_ms: 2400
  autonomous_systems:
    ...
```

### `config.protocol` por AS

Se coloca dentro de un bloque de AS, bajo `config.protocol:`. Establece
los timers del protocolo de ruteo que se aplican a todos los routers de
ese AS al momento del parseo.

```yaml
autonomous_systems:
  main:
    config:
      protocol:
        hello_interval: 5           # seconds; default 10
        lsa_refresh_interval: 15    # seconds; default 30
    networks:
      ...
```

Reglas:
- Tanto `hello_interval` como `lsa_refresh_interval` deben indicarse
  juntos — especificar solo uno es un error de parseo.
- Ambos deben ser números positivos (entero o flotante). Los booleanos
  son rechazados.
- `dead_interval` (3 × hello) y `max_age` (2 × refresh) permanecen como
  valores derivados y no se escriben en el YAML.

### Ejemplo completo con bloques config

```yaml
internet:
  name: loom
  config:
    packet_duration_ms: 2400
  autonomous_systems:
    main:
      asn: 65000
      config:
        protocol:
          hello_interval: 5
          lsa_refresh_interval: 15
      networks:
        lan1: "100.100.100.0/24"
      routers:
        r1:
          interfaces:
            eth0:
              network: lan1
              address: "100.100.100.1"
              cost: 10
      hosts:
        h1:
          network: lan1
          address: "100.100.100.10"
```

El **Export** del SPA siempre escribe ambos bloques. El **Import** los
restaura, por lo que la duración de los paquetes y los valores de los
timers del protocolo persisten entre sesiones.

## Reglas de nombres

- `networks` y `links` comparten un espacio de nombres — ninguna red puede
  tener el mismo nombre que un link.
- `hosts` y `routers` comparten un espacio de nombres — ningún host puede
  tener el mismo nombre que un router.
- Los nombres son ASCII sensibles a mayúsculas y minúsculas; el parser no
  los sanitiza más allá de las propias reglas de YAML. Evitar espacios.
- La cadena vacía es técnicamente un nombre válido. No usarla.

## Costos

El costo es la métrica del **lado de transmisión** para una interface de
router. El protocolo de ruteo los utiliza como pesos de arista en el grafo
de red.

- Tipo: entero.
- Rango: positivo (se valida al aplicar el cambio; el parser también
  coerciona a entero y rechaza valores no enteros).
- Por defecto: `1`.
- Dirección: **por interface**, no simétrico. Un costo 10 en `r1.eth0` y
  un costo 5 en `r2.eth0` (ambos en `lan1`) significa que las decisiones
  de ruteo favorecen los caminos que salen por `r2.eth0` (más barato)
  sobre los que salen por `r1.eth0` (más caro).

## El orden no importa (entre bloques)

El parser maneja networks → links → routers → hosts como un orden de fases
fijo, pero los mappings YAML dentro de cada fase no tienen orden. Se puede:

```yaml
routers:
  r3: { interfaces: { ... } }
  r1: { interfaces: { ... } }
  r2: { interfaces: { ... } }
```

— y todos cargan igual. Solo hay que asegurarse de no referenciar una red
o link que no haya sido declarado en su propio bloque.

## Ejemplo completo

```yaml
internet:
  autonomous_systems:
    main:
      networks:
        lan1: "200.100.0.0/24"
        lan2: "100.200.0.0/24"
        lan3: "150.10.10.0/24"
      links:
        p2p1: "10.0.0.0/30"
      hosts:
        h1: { network: "lan1", address: "200.100.0.10", gateway: "200.100.0.1" }
        h2: { network: "lan2", address: "100.200.0.20", gateway: "100.200.0.2" }
        h3: { network: "lan3", address: "150.10.10.30", gateway: "150.10.10.1" }
      routers:
        r1:
          interfaces:
            eth0: { network: "lan1", address: "200.100.0.1",   cost: 10 }
            eth1: { network: "lan2", address: "100.200.0.1",   cost: 15 }
            eth2: { link:    "p2p1", address: "10.0.0.1",       cost: 5  }
        r2:
          interfaces:
            eth0: { network: "lan1", address: "200.100.0.254", cost: 5  }
            eth1: { network: "lan2", address: "100.200.0.2",   cost: 8  }
            eth2: { network: "lan3", address: "150.10.10.1",   cost: 15 }
        r3:
          interfaces:
            eth0: { network: "lan2", address: "100.200.0.10",  cost: 20 }
            eth1: { network: "lan3", address: "150.10.10.10",  cost: 5  }
            eth2: { link:    "p2p1", address: "10.0.0.2",      cost: 5  }
```

Este es el `samples/sample.yaml` incluido. Hacer click en **Import** en el
SPA y seleccionar `sample.yaml` de la lista para colocarlo en el canvas;
hacer click en **Export** para guardarlo en disco.

## Flujo de guardado y reanudación

`loom` distingue entre el **archivo fuente** y el **archivo de sesión**:

- **Archivo fuente** — lo que apunta `LOOM_TOPOLOGY` (por defecto
  `samples/sample.yaml`). El simulador nunca escribe en este archivo.
- **Archivo de sesión** — un clon guardado en un directorio temporal
  (`$TMPDIR/loom` en Linux/macOS, configurable mediante `LOOM_SESSION_DIR`),
  con nombre `<stem>.<8-hex-hash>.session.yaml`. El hash desambigua dos
  archivos fuente que comparten el mismo basename. Todas las mutaciones
  en proceso se guardan aquí.

Dado que el archivo de sesión vive fuera del árbol fuente, un directorio
fuente de solo lectura es válido y la carpeta del proyecto permanece limpia.

Ciclo de vida:

| Evento | Efecto sobre el archivo de sesión |
|---|---|
| Primera llamada a `/topology` o `/sim/start` | Se crea (clonado del fuente) si no existe |
| `/sim/resume` con un patch | Se re-serializa a YAML (escritura atómica) |
| `POST /topology` | Se sobreescribe con el nuevo YAML |
| `POST /topology/reset` | Se elimina y se re-clona del fuente |
| Salida de `loom.py` | Sin cambios — persiste entre ejecuciones |

El sistema operativo normalmente limpia `$TMPDIR` al reiniciar (Linux/macOS
monta `/tmp` como tmpfs). Establecer `LOOM_SESSION_DIR` en una ruta estable
si se quiere que los archivos de sesión sobrevivan reinicios.

### Guardar y reanudar el trabajo

Para **guardar** una topología construida en el SPA:

1. **Export** → el diálogo de guardado del navegador se abre con un nombre
   de archivo sugerido derivado del fuente cargado (p. ej. `sample.yaml`;
   el stem `.session` se elimina para que el nombre no crezca en cada
   round-trip). Elegir una carpeta y confirmar.

Para **reanudar** una topología guardada:

1. Apuntar `LOOM_TOPOLOGY` al archivo: `LOOM_TOPOLOGY=/path/to/lab.yaml python loom.py`.
2. O ejecutar `loom` con el fuente por defecto y luego hacer click en
   **Import → Browse local file…** en el SPA y seleccionar el YAML.

Para estabilidad en round-trips:

- **El archivo de sesión es YAML canónico.** `loom` serializa los bloques
  en un orden predecible (`networks` → `hosts` → `routers`) pero no
  preserva comentarios ni formatos inusuales.
- **Las coordenadas no se persisten en el servidor.** Las posiciones `(x, y)`
  de los nodos viven solo en el `localStorage` del SPA. Un import de YAML
  en un navegador nuevo colocará los nodos en el centro del canvas por
  defecto; al reorganizarlos el layout persiste.

### YAML escrito por el SPA

El **Export** del SPA produce la misma estructura que el archivo de sesión
serializado por el servidor. Emite hosts y routers con bloques de interface
completos y omite metadatos de coordenadas. Los dos formatos son
compatibles byte a byte en round-trip, por lo que se puede editar el YAML
offline, hacer **Import**, y el canvas se redibuja sin sorpresas.

### Una nota sobre las comillas

El `sample.yaml` incluido entrecomilla la mayoría de las cadenas
(`"10.0.0.0/24"`). YAML trata `10.0.0.0/24` como cadena de todas formas
por la barra, por lo que las comillas son estéticas; el parser también
acepta formas sin comillas:

```yaml
networks:
  lan1: 10.0.0.0/24       # also valid
```

Elegir un estilo y mantenerlo.
