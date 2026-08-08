> 🌐 [English](../../user-guide/yaml-format.md) · **Español**

# Formato YAML

La topología se describe en YAML. El mismo formato lo usan:

- El ejemplo incluido (`samples/sample.yaml`).
- Los diálogos de **Import** y **Export**.
- La copia de trabajo que el simulador mantiene (ver
  [Flujo de guardado y reanudación](#flujo-de-guardado-y-reanudación)).

Hay un único esquema, y todos los consumidores pasan por el mismo parser.

## Estructura de nivel superior

```yaml
internet:
  name: loom              # opcional; por defecto es 'loom' si no está
  config:                 # opcional; ver "Bloques config: opcionales" más abajo
    packet_duration_ms: 1800
  autonomous_systems:
    main:
      asn: 65000          # opcional; por defecto es 65000
      config:             # opcional; ver "Bloques config: opcionales" más abajo
        protocol:
          hello_interval: 10
          lsa_refresh_interval: 30
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

La clave `internet:` es obligatoria en el nivel superior. Dentro de ella, un
campo opcional `name:` le pone nombre a la instancia de internet, y
`autonomous_systems:` es un mapeo en el que cada clave es el nombre corto de un
AS y cada valor contiene los bloques de entidades de ese AS (`networks`,
`links`, `routers`, `hosts`). Los nombres dentro de un AS deben ser únicos entre
los tipos con los que colisionan; ver [Reglas de nombres](#reglas-de-nombres)
más abajo.

> **Nota (exportación desde la SPA):** al hacer **Export** desde la SPA, tanto
> `internet.name` como la clave del sistema autónomo toman el nombre de proyecto
> escrito en la barra de encabezado, ya que la SPA los mantiene sincronizados. El
> valor por defecto `loom` solo se aplica al escribir el YAML a mano sin un campo
> `name:`.

**Una topología contiene exactamente un sistema autónomo.** Debe haber una única
entrada bajo `autonomous_systems:`, llamada `main` por convención; más de una se
rechaza.

El campo `asn:` se lee y se conserva en el viaje de ida y vuelta entre Export e
Import, pero todavía no hay nada del protocolo de ruteo que lo use. Su valor por
defecto es 65000.

Una topología mínima válida, sin dispositivos:

```yaml
internet:
  autonomous_systems:
    main:
      networks:
        lan1: "10.0.0.0/24"
```

Esto carga, aunque no hace nada útil: no hay tráfico que rutear ni routers que
inunden anuncios. El validador no exige que haya al menos un dispositivo.

## Redes

Una red es una LAN de acceso múltiple. Cada entrada asocia un nombre con un
prefijo CIDR.

```yaml
networks:
  lan1: "200.100.0.0/24"
  lan2: "100.200.0.0/24"
  office_a: "10.10.0.0/16"
```

Reglas:

- El CIDR se **canonicaliza** al parsear, poniendo en cero los bits de host.
  `"10.1.2.3/24"` pasa a ser `10.1.2.0/24`.
- La máscara va entre 0 y 32 (en la práctica, los prefijos útiles van de `/8` a
  `/29`; para `/30` o `/31` corresponde usar `links:`).
- Dos redes pueden compartir el mismo prefijo solo si se trata de un rango
  privado RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`). Los
  prefijos públicos deben seguir siendo únicos.
- No puede haber dos redes con el mismo nombre.

## Links

Un link es una conexión punto a punto `/30` o `/31` con exactamente dos
extremos. Se declara bajo `links:`:

```yaml
links:
  p2p1: "10.0.0.0/30"
  p2p2: "192.168.5.0/31"
```

Reglas:

- La máscara debe ser `/30` o `/31`. Cualquier otra cosa se rechaza con
  *"link CIDR must be /30 or /31, got /N"*.
- El nombre del link no puede colisionar con el de una red.
- El link debe tener **exactamente dos** extremos una vez procesado el resto del
  YAML (uno o tres extremos son un error del parser).
- En los links `/30`, las únicas direcciones de host utilizables son `.1` y `.2`
  (`.0` es la red y `.3` es el broadcast).
- En los links `/31`, tanto `.0` como `.1` son utilizables (RFC 3021).

## Routers

Un router es un mapeo con un bloque `interfaces:` obligatorio:

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
- `address:` debe ser válida para la red o link elegido (dentro del prefijo y,
  en un link `/30`, distinta de la dirección de red y de broadcast).
- `cost:` es opcional y vale `1` por defecto. Debe ser un entero positivo (≥ 1);
  `0` se rechaza.
- La red o el link nombrado debe existir (declarado en otra parte del YAML antes
  de que el parseo llegue a este punto).

Dentro de un mismo router, los nombres de interface (`eth0`, `eth1`, …) deben
ser únicos. En todo el AS, no puede haber dos interfaces sobre la misma red o
link que compartan una dirección.

Un router sin interfaces se rechaza: `r1: no interfaces declared`.

## Hosts

```yaml
hosts:
  h1:
    network: "lan1"
    address: "200.100.0.10"
    gateway: "200.100.0.1"
```

O bien sobre un link:

```yaml
hosts:
  h2:
    link: "p2p1"
    address: "10.0.0.2"
    # el gateway se completa automáticamente con la IP del peer
```

Reglas:

- Exactamente uno de `network:` o `link:` (son mutuamente excluyentes).
- `address:` debe ser válida para la red o link correspondiente.
- Sobre una **red**, `gateway:` es opcional. Si está presente, debe estar dentro
  de la subred del host. Si no está, el host no puede alcanzar destinos fuera de
  su red.
- Sobre un **link**, `gateway:` se completa automáticamente con la IP del peer.
  Si se lo indica explícitamente, **debe** coincidir con la del peer; los
  gateways que no coinciden se rechazan.
- Los hosts tienen exactamente una interface. No hay sintaxis para un host
  multi-homed.

## Bloques `config:` opcionales

Hay dos bloques `config:` opcionales que permiten persistir configuración junto
con la topología. Si se omite cualquiera de ellos, se aplican sus valores por
defecto.

### `internet.config` de nivel superior

Va directamente bajo `internet:`, junto a `name:` y `autonomous_systems:`.
Cualquier par clave/valor que se escriba ahí se almacena y se vuelve a escribir
tal cual al hacer **Export**. Hoy el único que tiene efecto es
`packet_duration_ms`: la duración de la animación de los paquetes en
milisegundos, 1800 por defecto.

```yaml
internet:
  config:
    packet_duration_ms: 2400
  autonomous_systems:
    ...
```

### `config.protocol` por AS

Va dentro del bloque de un AS, bajo `config.protocol:`. Fija los timers del
protocolo de ruteo que se aplican a todos los routers de ese AS al momento de
parsear.

```yaml
autonomous_systems:
  main:
    config:
      protocol:
        hello_interval: 5           # segundos; por defecto 10
        lsa_refresh_interval: 15    # segundos; por defecto 30
    networks:
      ...
```

Reglas:
- `hello_interval` y `lsa_refresh_interval` deben indicarse juntos: especificar
  uno solo es un error de parseo.
- Ambos deben ser números positivos (enteros o de punto flotante).
- `dead_interval` (3 × hello) y `max_age` (2 × refresco) siguen siendo valores
  derivados y no se escriben en el YAML.

El **Export** de la SPA siempre escribe ambos bloques, y el **Import** los
restaura, de modo que la duración de los paquetes y los timers del protocolo se
conservan entre sesiones.

## Reglas de nombres

- `networks` y `links` comparten un espacio de nombres: ninguna red puede
  llamarse igual que un link.
- `hosts` y `routers` comparten un espacio de nombres: ningún host puede
  llamarse igual que un router.
- Los nombres son ASCII y distinguen mayúsculas de minúsculas; el parser no los
  sanea más allá de las reglas propias de YAML. Conviene evitar espacios.
- Técnicamente se admite la cadena vacía como nombre (no se recomienda).

## Costos

El costo es la métrica **del lado de la transmisión** de una interface de
router. El protocolo de ruteo los usa como pesos de las aristas del grafo de la
red.

- Tipo: entero.
- Rango: positivo (se valida al aplicar el cambio; el parser además convierte a
  entero y rechaza los valores que no lo son).
- Valor por defecto: `1`.
- Dirección: **por interface**, no simétrico. Que `r1.eth0` tenga costo 10 y
  `r2.eth0` costo 5 (ambas sobre `lan1`) significa que las decisiones de ruteo
  van a favorecer los caminos que salen por `r2.eth0` (más barata) por sobre los
  que salen por `r1.eth0` (más cara).

## El orden no importa (entre bloques)

El parser procesa redes → links → routers → hosts en un orden de fases fijo,
pero los mapeos YAML dentro de cada fase no están ordenados. Es decir, esto:

```yaml
routers:
  r3: { interfaces: { ... } }
  r1: { interfaces: { ... } }
  r2: { interfaces: { ... } }
```

carga exactamente igual. Lo único que no hay que hacer es referenciar una red o
un link que todavía no fue declarado en su propio bloque.

## Ejemplo completo

Este es el `samples/sample.yaml` incluido, tal cual: tres LANs, un link punto a
punto, tres routers y tres hosts.

```yaml
internet:
  name: loom
  autonomous_systems:
    main:
      asn: 65000
      networks:
        lan1: 200.100.0.0/24
        lan2: 100.200.0.0/24
        lan3: 150.10.10.0/24
      links:
        p2p1: 10.0.0.0/30
      hosts:
        h1:
          network: lan1
          address: 200.100.0.10
          gateway: 200.100.0.1
        h2:
          network: lan2
          address: 100.200.0.20
          gateway: 100.200.0.2
        h3:
          network: lan3
          address: 150.10.10.30
          gateway: 150.10.10.1
      routers:
        r1:
          interfaces:
            eth0:
              network: lan1
              address: 200.100.0.1
              cost: 10
            eth1:
              network: lan2
              address: 100.200.0.1
              cost: 15
            eth2:
              link: p2p1
              address: 10.0.0.1
              cost: 5
        r2:
          interfaces:
            eth0:
              network: lan1
              address: 200.100.0.254
              cost: 5
            eth1:
              network: lan2
              address: 100.200.0.2
              cost: 8
            eth2:
              network: lan3
              address: 150.10.10.1
              cost: 15
        r3:
          interfaces:
            eth0:
              network: lan2
              address: 100.200.0.10
              cost: 20
            eth1:
              network: lan3
              address: 150.10.10.10
              cost: 5
            eth2:
              link: p2p1
              address: 10.0.0.2
              cost: 5
```

Hacer click en **Import** en la SPA y elegir `sample.yaml` de la lista lo carga
en el _canvas_; **Export** lo guarda de vuelta en disco. Acá no aparece ninguno
de los dos bloques `config:`, porque ambos son opcionales y, al faltar, rigen
los valores por defecto.

## Flujo de guardado y reanudación

`loom` distingue entre el **archivo original** y el **archivo de sesión**:

- **Archivo original** — aquel al que apunta `LOOM_TOPOLOGY` (por defecto,
  `samples/sample.yaml`). El simulador nunca escribe en él.
- **Archivo de sesión** — un clon guardado en un directorio temporal
  (`$TMPDIR/loom` en Linux y macOS, modificable con `LOOM_SESSION_DIR`), llamado
  `<stem>.<hash-de-8-hex>.session.yaml`. El hash desambigua dos archivos
  originales que compartan nombre de base. Todas las modificaciones hechas
  durante la ejecución terminan acá.

Como el archivo de sesión vive fuera del árbol de fuentes, no hay problema en
que el directorio original sea de solo lectura, y la carpeta del proyecto queda
limpia.

Ciclo de vida:

| Qué se hace | Efecto sobre el archivo de sesión |
|---|---|
| Presionar **Start** por primera vez | Se crea, clonado desde el original, si todavía no existe |
| Hacer **Resume** con ediciones pendientes | Se reescribe para reflejar la topología editada |
| Hacer **Import** de una topología | Se sobrescribe con lo importado |
| Presionar **Reset** | Se elimina y se vuelve a clonar desde el original |
| Salir de `loom` | Queda intacto: sigue ahí en la próxima ejecución |

El sistema operativo suele limpiar `$TMPDIR` al reiniciar (Linux y macOS montan
`/tmp` como tmpfs). Si se quiere que los archivos de sesión sobrevivan a un
reinicio, conviene apuntar `LOOM_SESSION_DIR` a una ruta estable.

### Guardar y reanudar el trabajo

Para **guardar** una topología construida en la SPA:

1. **Export** abre el diálogo de guardado del navegador, con un nombre de
   archivo sugerido derivado del original cargado (por ejemplo, `sample.yaml`; se
   quita el `.session` de la raíz del nombre para que este no crezca en cada
   vuelta). Elegir una carpeta y confirmar.

Para **reanudar** una topología guardada:

1. Apuntar `LOOM_TOPOLOGY` al archivo:
   `LOOM_TOPOLOGY=/path/to/lab.yaml python loom.py`.
2. O bien ejecutar `loom` con el original por defecto y luego, en la SPA, hacer
   click en **Import → Browse local file…** y elegir el YAML propio.

Para que el ida y vuelta sea estable:

- **El archivo de sesión es YAML canónico.** `loom` serializa los bloques en un
  orden predecible (`networks` → `hosts` → `routers`), pero no preserva los
  comentarios ni las disposiciones inusuales.
- **Las coordenadas no se persisten del lado del servidor.** El `(x, y)` de cada
  nodo vive únicamente en el almacenamiento local de la SPA. Al importar un YAML
  en un navegador nuevo, los nodos se ubican en las posiciones por defecto del
  centro del _canvas_; una vez reacomodados, la disposición se conserva.

### YAML escrito por la SPA

El **Export** de la SPA produce la misma estructura que el archivo de sesión
serializado por el servidor. Emite los hosts y routers con sus bloques de
interfaces completos y omite los metadatos de coordenadas. Los dos formatos son
compatibles byte a byte en el ida y vuelta, así que se puede editar el YAML sin
conexión, hacer **Import**, y el _canvas_ se redibuja sin sorpresas.

### Una nota sobre las comillas

El `sample.yaml` incluido deja las direcciones sin comillas. YAML interpreta
`10.0.0.0/24` como cadena de todos modos, por la barra, así que las comillas son
puramente una cuestión de gusto: ambas formas se parsean igual.

```yaml
networks:
  lan1: 10.0.0.0/24       # como en el ejemplo incluido
  lan2: "10.0.1.0/24"     # igualmente válido
```

Conviene elegir una y ser consistente.
