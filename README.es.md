> 🌐 [English](README.md) · **Español**

<div align="center">
  <img src="web/favicon.svg" width="80" alt="loom">
</div>

# loom

Un simulador Python para un **sistema autónomo** IPv4 — hosts, routers,
redes y links punto a punto interconectados mediante un **protocolo de ruteo
link-state** — dirigido por una topología YAML y una interfaz web interactiva.

`loom` está construido para la enseñanza y la exploración. Se describe una red en
YAML (o se dibuja en el canvas), se presiona **Start** y se observa cómo el protocolo
de ruteo converge, los datagramas saltan entre routers y las tablas de ruteo se
actualizan en tiempo real. El código fuente es pequeño, con threads y con pocas
dependencias por diseño.

## Alcance

`loom` es deliberadamente solo L3. No hay L2 (sin MAC, sin ARP, sin STP —
los frames son sobres abstractos) ni L4 (sin TCP/UDP, sin puertos, sin estado
de transporte). El objetivo es hacer observable la convergencia del ruteo y el
forwarding, no modelar una pila de red completa. Para trabajo de mayor fidelidad,
ver [ns-3](https://www.nsnam.org/), [mininet](https://mininet.org/),
[Containerlab](https://containerlab.dev/) o [GNS3](https://www.gns3.com/).

## Características

- **Simulación IPv4 multirouter** — Hosts, routers, LAN multiacceso y links
  punto a punto `/30` / `/31`, todo interconectado mediante threads reales por
  interface y por fabric. Las decisiones de forwarding usan longest-prefix match
  sobre una tabla de ruteo por router.
- **Protocolo link-state loom-OSPF** — Flooding con número de secuencia, thread
  de keepalive por router con intervalos Hello y LSA-refresh configurables
  (ajustables en vivo desde el popover Protocol de la barra de herramientas),
  cómputo de camino más corto con Dijkstra que se vuelve a ejecutar solo cuando
  el grafo realmente cambia.
- **Desactivación de interface en vivo y halt/crash de router** — Se puede subir
  o bajar una interface individual (re-flood de LSA graceful), hacer halt de un
  router (LSA de retiro + vecinos convergen de inmediato), o inyectar un crash
  silencioso (`POST /devices/{name}/fail`). `ping` admite `-c N` para sondeos
  repetidos con una línea de resumen.
- **Interfaz web interactiva** — Arrastrar redes, hosts y routers sobre un canvas
  SVG; editar interfaces y costos en el panel derecho; hacer doble click en
  cualquier dispositivo para abrir un terminal con `ping`, `send`, `route`,
  `ifconfig`, `neighbors`, `update_cost`, `set_gateway`.
- **Ediciones de topología sin reinicio** — Agregar redes, hosts y routers
  directamente en el canvas mientras la simulación está en ejecución; cada edición
  se aplica en vivo en cuanto se ingresa una dirección válida. O pausar, acumular
  un conjunto de cambios y reanudar — las ediciones se acumulan como una lista de
  patches y se aplican atómicamente.
- **Animaciones de paquetes** — Datagramas, ping y paquetes del protocolo de ruteo
  se animan en el canvas mientras fluyen; los controles de la barra de herramientas
  regulan la velocidad y la visibilidad del chatter.
- **NAT y LAN privadas** — Source-NAT reescribe las direcciones privadas (RFC 1918)
  al salir hacia redes públicas, con tablas de reescritura por flujo y traducción
  inversa en el tráfico de retorno. La política de ruteo mantiene los prefijos
  privados locales — nunca se anuncian a routers vecinos.
- **Importación / exportación YAML** — La topología es la fuente de verdad. Se puede
  arrastrar un archivo YAML al diálogo de importación, copiar el canvas de vuelta,
  persistir o compartir.
- **Sin estado externo** — Sin base de datos, sin autenticación, sin llamadas a la
  red. Todo vive en memoria más un clon de sesión YAML en disco.

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Núcleo del simulador | Python 3.11+, threads + queues, `PauseGate` propio |
| Servidor web | FastAPI + Uvicorn, mount SPA estático, REST + WebSocket |
| Interfaz web | Módulos ES nativos + SVG (sin framework, sin bundler) |
| Topología | YAML (PyYAML), con validador estructural |
| Tests | `pytest` (526+), `pytest-asyncio`, `vitest`, Playwright |
| Lint / formato | `ruff` |

Dependencias externas: ninguna más allá de los cuatro paquetes anteriores. Sin base de
datos, sin message broker, sin APIs de terceros.

## Inicio rápido

**Requisitos previos:** Python 3.11+

```bash
git clone git@gitlab.com:lukius/netrouting.git
cd netrouting

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cd src
python loom.py
```

Abrir [http://127.0.0.1:8000](http://127.0.0.1:8000). Se verá el canvas precargado con
la topología de ejemplo incluida (3 hosts, 3 routers, 3 LAN, 1 link punto a punto).
Presionar **Start** en la barra de herramientas y observar cómo el protocolo de ruteo converge.

### Fuente de la topología

Por defecto `loom` lee `samples/sample.yaml`. Se puede sobreescribir con
`LOOM_TOPOLOGY`:

```bash
LOOM_TOPOLOGY=/path/to/topology.yaml python loom.py
```

Las ediciones realizadas a través de la interfaz se guardan en `<source>.session.yaml`;
el archivo fuente nunca se modifica. Usar el botón **Reset** de la barra de herramientas
(o `POST /topology/reset`) para borrar la sesión y re-clonar desde el origen.

### Puerto

El servidor escucha en `127.0.0.1:8000` por defecto. Para sobreescribir:

```bash
LOOM_PORT=8123 python loom.py
```

## Documentación

El conjunto completo de documentación se encuentra bajo [`docs/`](docs/).

### Guía de usuario

Empezar aquí para **usar** el simulador.

| Archivo | Tema |
|---|---|
| [`docs/es/user-guide/getting-started.md`](docs/es/user-guide/getting-started.md) | Instalación, ejecutar la interfaz, primer ping |
| [`docs/es/user-guide/web-ui.md`](docs/es/user-guide/web-ui.md) | Barra de herramientas, canvas, inspector, terminales — recorrido guiado |
| [`docs/es/user-guide/building-topologies.md`](docs/es/user-guide/building-topologies.md) | Agregar LAN, hosts, routers, links punto a punto |
| [`docs/es/user-guide/running-simulations.md`](docs/es/user-guide/running-simulations.md) | Start / Pause / Resume / Reset, ediciones en pausa, intervalo de keepalive |
| [`docs/es/user-guide/routing-tables.md`](docs/es/user-guide/routing-tables.md) | Inspección de tablas de ruteo, vecinos, costos |
| [`docs/es/user-guide/terminals.md`](docs/es/user-guide/terminals.md) | Terminales por dispositivo: `ping`, `send`, `ifconfig`, ... |
| [`docs/es/user-guide/yaml-format.md`](docs/es/user-guide/yaml-format.md) | Referencia del esquema YAML, flujo de trabajo guardar / reanudar |
| [`docs/es/user-guide/nat-and-private-lans.md`](docs/es/user-guide/nat-and-private-lans.md) | NAT, LAN privadas, reescritura de dirección de origen |

### Arquitectura / Referencia técnica

Empezar aquí para **modificar** el simulador o entender cómo funciona.

| Archivo | Tema |
|---|---|
| [`docs/es/architecture/overview.md`](docs/es/architecture/overview.md) | El panorama general — componentes, capas, flujo de datos |
| [`docs/es/architecture/entities.md`](docs/es/architecture/entities.md) | `AS`, `Router`, `Host`, `Network`, `Link`, `Interface`, `Address` |
| [`docs/es/architecture/packets.md`](docs/es/architecture/packets.md) | `Frame`, `Datagram`, `Message` (usuario / ruteo / ping) |
| [`docs/es/architecture/routing-protocol.md`](docs/es/architecture/routing-protocol.md) | Protocolo link-state, flooding, Dijkstra, diagramas de secuencia |
| [`docs/es/architecture/concurrency.md`](docs/es/architecture/concurrency.md) | Threads, queues, `PauseGate`, ciclo de vida |
| [`docs/es/architecture/parser.md`](docs/es/architecture/parser.md) | Parser YAML, validadores, caminos de error |
| [`docs/es/architecture/nat.md`](docs/es/architecture/nat.md) | Source-NAT, tablas de reescritura por flujo, eventos NAT |
| [`docs/es/architecture/policy.md`](docs/es/architecture/policy.md) | Política de ruteo, filtro de salida RFC 1918 |
| [`docs/es/architecture/web-spa.md`](docs/es/architecture/web-spa.md) | Mapa de módulos de la SPA y contrato del bus de eventos |
| [`docs/es/architecture/server-api.md`](docs/es/architecture/server-api.md) | Referencia HTTP + WebSocket |

### Otros archivos en la raíz

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — configuración de desarrollo, flujo de trabajo TDD, proceso de MR
- [`CHANGELOG.md`](CHANGELOG.md) — historial de versiones
- [`CLAUDE.md`](CLAUDE.md) — contexto no obvio del proyecto para asistentes de IA y nuevos contribuidores
- [`LICENSE`](LICENSE) — MIT

## Estructura del proyecto

```
loom/
├── src/
│   ├── loom.py            # Entry point — starts the web UI
│   ├── entities/          # AS, Router, Host, Network, Link, Interface, Address, Packet, Event, nat.py, PauseGate
│   ├── routing/           # RoutingProtocol (loom-OSPF link-state) + LSDB → NetworkGraph (Dijkstra)
│   ├── parser/            # YAML topology loader + SystemValidator
│   └── server/            # FastAPI app, routes, sim state machine, persistence, command dispatch
├── test/                  # pytest suite (526+ tests) + invalid YAML fixtures under resources/
├── samples/               # sample.yaml — the bundled example topology
├── web/                   # SPA: ES modules, styles, favicon, vitest tests
├── e2e/                   # Playwright/Chromium smoke suite
├── docs/                  # User guide + architecture reference (this directory)
├── pyproject.toml         # ruff + pytest config (pythonpath = ["src"], testpaths = ["test"])
├── requirements.txt       # Runtime deps (PyYAML, FastAPI, uvicorn)
├── requirements-dev.txt   # Dev deps (pytest, pytest-asyncio, ruff, httpx)
├── playwright.config.js   # E2E config (chromium-only, LOOM_PORT=8766)
├── vitest.config.js       # JS unit tests config
└── package.json           # npm scripts: test (vitest), test:e2e (playwright)
```

## Ejecución de tests

```bash
# Python
pytest                              # suite completa
ruff check src/ test/               # lint

# JavaScript
npm test                            # suite de unidad vitest
npm run test:e2e                    # Playwright + Chromium real (bind LOOM_PORT=8766)
```

Ver [`CONTRIBUTING.md`](CONTRIBUTING.md) para el flujo de trabajo TDD completo.

## Desarrollo asistido por IA

`loom` es accesible para asistentes de IA de manera directa. Dos archivos
cargan con el trabajo:

- **`CLAUDE.md`** — resumen breve de contexto no obvio del proyecto:
  entry points, decisiones de diseño clave, trampas. Deliberadamente bajo las 200 líneas
  — leer esto primero para evitar los errores comunes.
- **`docs/`** — la referencia detallada. Las páginas de arquitectura
  (`docs/architecture/`) cubren componentes, el protocolo link-state,
  concurrencia, el parser, la API HTTP/WS y el mapa de módulos de la SPA.
  Las páginas del user guide (`docs/user-guide/`) cubren la interfaz web,
  los terminales y el formato YAML.

Un asistente de IA orientado a `CLAUDE.md` más la página relevante de
`docs/architecture/` puede planificar y ejecutar la mayoría de los cambios directamente.

Los contribuidores humanos no necesitan usar ninguna herramienta de IA — todas las
convenciones aplican por igual. Ver [CONTRIBUTING.md](CONTRIBUTING.md#ai-assisted-development)
para las directrices sobre el mantenimiento de `CLAUDE.md` y el conjunto de documentación
a medida que el proyecto evoluciona.

## Contribuir

Este proyecto se desarrolla test-first. Ver [`CONTRIBUTING.md`](CONTRIBUTING.md)
para la configuración de desarrollo, el ciclo red → verde → refactor, la disciplina
de documentación, las convenciones de commits y el proceso de merge-request. El proyecto
está alojado en GitLab — usar `glab` o la interfaz web para los MR.

## Licencia

[MIT](LICENSE)
