> 🌐 [English](README.md) · **Español**

<div align="center">
  <img src="web/favicon.svg" width="80" alt="loom">
</div>

# loom

Un simulador Python para un sistema autónomo IPv4, controlado por una
interfaz web interactiva y una topología YAML subyacente: hosts, routers,
redes y links punto a punto interconectados mediante un protocolo de ruteo
link-state similar a OSPF.

`loom` está orientado principalmente a la exploración y la didáctica.
Las redes se dibujan en la pantalla y, una vez iniciada la simulación, el
protocolo de ruteo converge en vivo: los datagramas viajan de router en
router y las tablas de ruteo se actualizan en tiempo real.

## Alcance

`loom` es deliberadamente un simulador L3. No abarca L2 (los frames son
contenedores abstractos) ni L4 (omite TCP/UDP, puertos y estado de nivel
de transporte en general). El objetivo es hacer observable la convergencia
del ruteo y el forwarding, y no modelar un _stack_ de red completo. Para
trabajos de mayor alcance, recomendamos ver [ns-3](https://www.nsnam.org/), [mininet](https://mininet.org/),
[Containerlab](https://containerlab.dev/) o [GNS3](https://www.gns3.com/).

## Características

- **Interfaz web interactiva** — Emplazar redes, hosts y routers en un
  _canvas_ SVG; editar interfaces y costos; hacer doble click en
  cualquier dispositivo para abrir una terminal con comandos como
  `ping`, `route` e `ifconfig`.
- **Ediciones de topología sin reinicio** — Agregar redes, hosts y routers
  mientras la simulación está en ejecución, o pausar, acumular un conjunto
  de cambios y reanudar atómicamente.
- **Simulación IPv4 multirouter** — Hosts, routers, LANs multiacceso y links
  punto a punto `/30` / `/31`, todo interconectado mediante threads
  por interface y por estructura (link/LAN). Las decisiones de forwarding
  usan matching de prefijo más largo sobre una tabla de ruteo por router.
- **Protocolo link-state loom-OSPF** — _Flooding_ con número de secuencia,
  thread de _keepalive_ por router con intervalos Hello y LSA-refresh
  configurables y cálculo de camino más corto con Dijkstra (que se vuelve
  a ejecutar solo cuando el grafo cambia).
- **Desactivación de interfaces en vivo y _halt_/_crash_ de router** — Prender o
  apagar una interface individual, detener un router o inyectar un
  _crash_ silencioso, y luego observar en vivo cómo cambia el estado de ruteo
  de la red.
- **Animaciones de paquetes** — Los datagramas, pings y paquetes del protocolo de
  ruteo se animan en la pantalla mientras fluyen, con posibilidad de regular
  velocidad y visibilidad de los paquetes.
- **NAT y LANs privadas** — Source-NAT reescribe las direcciones privadas
  (RFC 1918) al salir hacia redes públicas, con tablas de reescritura
  por flujo y traducción inversa para el tráfico entrante. La política de
  ruteo preserva los prefijos privados locales (nunca se anuncian a routers
  vecinos).
- **Importación / exportación YAML** — La topología es la fuente de verdad.
  La web permite importar archivos YAML y exportarlos para reutilizarlos.
- **Sin estado externo** — Todo vive en memoria, existiendo además en disco
  un clon YAML de la sesión.

## Stack tecnológico

| Capa               | Tecnología |
|--------------------|---|
| Core del simulador | Python 3.11+, threads + queues |
| Servidor web       | FastAPI + Uvicorn, mount SPA estático, REST + WebSocket |
| Interfaz web       | Módulos ES nativos + SVG (sin framework, sin bundler) |
| Topología          | YAML (PyYAML), con validador estructural |
| Tests              | `pytest` (526+), `pytest-asyncio`, `vitest`, Playwright |
| Lint / formato     | `ruff` |

Sin dependencias de runtime más allá de PyYAML, FastAPI y Uvicorn (el
resto de la tabla son herramientas de desarrollo).

## Cómo empezar

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

Abrir [http://127.0.0.1:8000](http://127.0.0.1:8000). Se verá el _canvas_ precargado con
la topología de ejemplo incluida (3 hosts, 3 routers, 3 LAN, 1 link punto a punto).
Presionar **Start** en la barra de herramientas y observar cómo el protocolo de ruteo converge.

### Origen de la topología

Por defecto `loom` lee `samples/sample.yaml`. Se puede sobreescribir con
`LOOM_TOPOLOGY`:

```bash
LOOM_TOPOLOGY=/path/to/topology.yaml python loom.py
```

Las ediciones realizadas a través de la web se guardan en `<source>.session.yaml`;
el archivo fuente nunca se modifica. Usar el botón **Reset** de la barra de herramientas
(o `POST /topology/reset`) para borrar la sesión y re-clonar desde el origen.

### Puerto

El servidor escucha en `127.0.0.1:8000` por defecto. Para modificarlo:

```bash
LOOM_PORT=8123 python loom.py
```

## Documentación

Toda la documentación se encuentra bajo [`docs/`](docs/).

### Guía de usuario

Empezar aquí para **usar** el simulador.

| Archivo | Tema                                                                       |
|---|----------------------------------------------------------------------------|
| [`docs/es/user-guide/getting-started.md`](docs/es/user-guide/getting-started.md) | Instalación, ejecutar la interfaz, primer ping                             |
| [`docs/es/user-guide/web-ui.md`](docs/es/user-guide/web-ui.md) | Barra de herramientas, _canvas_, inspector, terminales                     |
| [`docs/es/user-guide/building-topologies.md`](docs/es/user-guide/building-topologies.md) | Agregar LANs, hosts, routers, links punto a punto                          |
| [`docs/es/user-guide/running-simulations.md`](docs/es/user-guide/running-simulations.md) | Start / Pause / Resume / Reset, ediciones en pausa, intervalo de keepalive |
| [`docs/es/user-guide/routing-tables.md`](docs/es/user-guide/routing-tables.md) | Inspección de tablas de ruteo, vecinos, costos                             |
| [`docs/es/user-guide/terminals.md`](docs/es/user-guide/terminals.md) | Terminales por dispositivo: `ping`, `send`, `ifconfig`, ...                |
| [`docs/es/user-guide/yaml-format.md`](docs/es/user-guide/yaml-format.md) | Referencia del esquema YAML, flujo de trabajo (guardar / reanudar)         |
| [`docs/es/user-guide/nat-and-private-lans.md`](docs/es/user-guide/nat-and-private-lans.md) | NAT, LANs privadas, reescritura de dirección de origen                     |

### Arquitectura / Referencia técnica

Empezar aquí para **modificar** el simulador o entender cómo funciona.

| Archivo | Tema                                                              |
|---|-------------------------------------------------------------------|
| [`docs/es/architecture/overview.md`](docs/es/architecture/overview.md) | El panorama general: componentes, capas, flujo de datos           |
| [`docs/es/architecture/entities.md`](docs/es/architecture/entities.md) | `AS`, `Router`, `Host`, `Network`, `Link`, `Interface`, `Address` |
| [`docs/es/architecture/packets.md`](docs/es/architecture/packets.md) | `Frame`, `Datagram`, `Message` (usuario / ruteo / ping)           |
| [`docs/es/architecture/routing-protocol.md`](docs/es/architecture/routing-protocol.md) | Protocolo link-state, flooding, Dijkstra, diagramas de secuencia  |
| [`docs/es/architecture/concurrency.md`](docs/es/architecture/concurrency.md) | Threads, queues, `PauseGate`, ciclo de vida                       |
| [`docs/es/architecture/parser.md`](docs/es/architecture/parser.md) | Parser YAML, validadores, flujos de error                         |
| [`docs/es/architecture/nat.md`](docs/es/architecture/nat.md) | Source-NAT, tablas de reescritura por flujo, eventos NAT          |
| [`docs/es/architecture/policy.md`](docs/es/architecture/policy.md) | Política de ruteo, filtro de salida RFC 1918                      |
| [`docs/es/architecture/web-spa.md`](docs/es/architecture/web-spa.md) | Mapa de módulos de la SPA y contrato del bus de eventos           |
| [`docs/es/architecture/server-api.md`](docs/es/architecture/server-api.md) | Referencia HTTP + WebSocket                                       |

### Otros archivos

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
├── docs/                  # User guide + architecture reference
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
principales:

- **`CLAUDE.md`** — resumen breve de contexto no obvio del proyecto:
  entry points, decisiones de diseño clave, trampas. Deliberadamente bajo las 200 líneas
  — leer esto primero para evitar errores comunes.
- **`docs/`** — la referencia detallada. Las páginas de arquitectura
  (`docs/architecture/`) cubren componentes, el protocolo link-state,
  concurrencia, el parser, la API HTTP/WS y el mapa de módulos de la SPA.
  Las páginas de la guía de usuario (`docs/user-guide/`) cubren la interfaz web,
  las terminales y el formato YAML.

Un asistente de IA apuntado a `CLAUDE.md` más la página relevante de
`docs/architecture/` debería ser capaz de planificar y ejecutar la mayoría de los
cambios directamente.

Los contribuidores humanos no necesitan usar ninguna herramienta de IA; todas las
convenciones aplican por igual. Ver [CONTRIBUTING.md](CONTRIBUTING.md#ai-assisted-development)
para las directrices sobre el mantenimiento de `CLAUDE.md` y la documentación
a medida que el proyecto evoluciona.

## Cómo contribuir

Este proyecto sigue una metodología _test-first_. Ver [`CONTRIBUTING.md`](CONTRIBUTING.md)
para los lineamientos sobre la configuración del ambiente de desarrollo, el ciclo
rojo → verde → refactor, la disciplina de documentación, las convenciones de
escritura de commits y el proceso de merge-request. El proyecto está alojado en
GitLab: usar `glab` o la interfaz web para crear los MRs.

## Licencia

[MIT](LICENSE)
