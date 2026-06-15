> 🌐 [English](../../user-guide/running-simulations.md) · **Español**

# Ejecutar simulaciones

Una vez que se construyó (o cargó) una topología, la simulación tiene un ciclo de vida:
inicia, corre, se pausa, se retoma y, eventualmente, se detiene. Esta guía explica
cada transición y qué operaciones son seguras en cada paso.

## Estados

```
                  ┌─────────────────────┐
                  │       idle          │   ← initial state
                  │  no AS in memory    │
                  └──────────┬──────────┘
                             │ Start
                             ▼
                  ┌─────────────────────┐
                  │      running        │
                  │  threads alive,     │
                  │  protocol ticking   │
                  └─────┬───────────┬───┘
              Pause     │           │   Stop
                        ▼           ▼
              ┌──────────────────┐  ┌──────────────────┐
              │     paused       │  │       idle       │
              │  threads parked  │  └──────────────────┘
              │  on PauseGate    │
              └────────┬─────────┘
                       │ Resume (with optional patch)
                       └───►  running
```

La UI refleja esta máquina de estados: en cualquier momento, los botones
**Start/Stop** y **Pause/Resume** de la barra de herramientas reflejan el estado
autoritativo del servidor, alimentado por los eventos WebSocket `sim_state`.

## Start

Hacer click en **Start** (o presionar <kbd>Space</kbd>). La SPA hace, en orden:

1. Verifica que la topología esté completa — que cada LAN y link tenga un rango de
   red, que cada host esté conectado a una red y tenga una dirección, y que cada
   interface de router tenga una dirección. Si falta algo, el Start se cancela, un
   mensaje en inglés indica qué corregir, y el elemento en cuestión queda seleccionado
   para poder ir directo a completarlo.
2. Serializa el canvas actual a YAML.
3. Hace POST a `/topology` — el servidor valida y construye un nuevo sistema autónomo.
   Ante cualquier error de validación, el inicio se cancela y la barra de herramientas
   muestra el error mediante un toast.
4. Hace POST a `/sim/start` — el servidor inicia la simulación y el protocolo de
   ruteo de cada router.

![Start indica qué está incompleto y lo selecciona — aquí una LAN sin rango asignado](../../images/07-start-preflight.png)

Si la topología ya estaba cargada (por ejemplo, se detuvo la simulación y se quiere
iniciarla nuevamente con la misma topología), los pasos 1 y 2 son una sobreescritura
sin efecto del mismo YAML. El archivo de sesión se actualiza de todas formas.

**Mientras la simulación está en ejecución:**

- Los botones **Add LAN / Host / Router** de la barra de herramientas están habilitados
  — se pueden agregar redes, links, hosts y routers directamente en el canvas. Cada
  nueva entidad se aplica al sistema en ejecución en cuanto se le asigna una dirección
  o CIDR válido; un valor incompleto o inválido simplemente queda pendiente hasta que
  se complete. La selección y el viewport se preservan cuando se actualiza la topología.
- **Arrastrar cualquier nodo o etiqueta de link** para reposicionarlo en el canvas —
  hosts, routers, redes y etiquetas de punto medio de links p2p pueden moverse
  libremente mientras la simulación corre. El reposicionamiento es puramente visual y
  no afecta la simulación en ejecución. Las animaciones de paquetes en vuelo siguen a
  los nodos al moverlos. Si se intenta arrastrar un host o router sobre una red o link
  *diferente* mientras la simulación corre, se muestra una señal roja bloqueante en el
  destino y el nodo vuelve a su posición al soltar — para reasignar un dispositivo a
  una red diferente, hay que detener la simulación primero.
- Click derecho → **Rename / Duplicate / Delete** en el canvas está bloqueado.
- Los campos editables del inspector son de solo lectura (la reasignación de
  dirección de interface y de host/red requiere pausar o detener la simulación primero).
- El botón **Protocol** está activo — se pueden ajustar los intervalos de Hello y
  de refresco de LSA en vivo.
- Click derecho sobre un router → **Halt router (graceful)**, **Crash router**, o
  **Resume router** para desconectar un router o volver a conectarlo, sin detener la
  simulación. Un router detenido o caído aparece en gris en el canvas.
- Seleccionar un router → usar los botones **Disable / Fail / Enable** junto a cada
  interface en el inspector para controlar interfaces individuales. La arista de una
  interface caída se convierte en un cable gris sólido con una pequeña ✕ en su punto
  medio, claramente distinto de un link punto a punto (discontinuo). El tráfico enviado
  hacia una interface caída se descarta donde entraría al link — se verá el paquete
  salir del origen y desvanecerse en lugar de llegar al dispositivo.

![Un router detenido y sus links se muestran en gris mientras el resto de la topología sigue en ejecución](../../images/60-router-halted.png)

![Los controles de interface por router en el inspector: una interface caída ofrece Enable; las demás ofrecen Disable y Fail](../../images/61-interface-controls.png)

**Los primeros pings pueden perderse mientras la red converge.** Luego de hacer
click en Start, hay que darle a los routers unos segundos para intercambiar rutas
antes de hacer ping. Hasta que todos los routers hayan escuchado a sus vecinos, algunos
paquetes — especialmente entre hosts en redes diferentes — serán descartados. Si el
primer ping da timeout, hay que esperar un momento y volver a intentar. (El intervalo
de Hello por defecto es 10 s; se puede bajar el **Hello interval** en el popover de
**Protocol** a 1 s si se quiere descubrir vecinos más rápido.)

### Salida de ping en streaming

Cuando se ejecuta `ping` desde el terminal de un dispositivo mientras la simulación
está en ejecución, cada respuesta ICMP (o timeout) aparece en el terminal **a medida
que llega**, línea por línea — no hay que esperar a que terminen todas las sondas
para ver los resultados. El resumen final se imprime igualmente al final. Si el
terminal está cerrado, los resultados se descartan silenciosamente.

Con `ping -c N` en un terminal de dispositivo, las sondas se animan **de a un
viaje de ida y vuelta a la vez**: cada solicitud viaja hacia el destino y su respuesta
regresa, luego el terminal espera un segundo (como el `ping` real) antes de enviar la
siguiente sonda. Se puede seguir cada una individualmente en lugar de ver todos los
`N` paquetes recorrer el cable a la vez.

Dado que cada sonda se envía **solo después de que la anterior terminó de animarse**,
esa pausa es una ventana real para observar **cómo el tráfico se re-rutea en vivo**: mientras
corre un ping contado, se puede deshabilitar una interface o detener un router en la
ruta durante la pausa. La siguiente sonda se envía entonces sin estado previo, por lo
que una vez que la red reconverge se reenvía por la ruta recalculada y su animación
sigue ese nuevo camino — sin importar cuán larga sea la ruta. El tamaño de la pausa
se ajusta con `-i <seconds>` (por ejemplo, `-i 2` para más tiempo de edición, `-i 0`
para ninguna). La pausa termina cuando se hace Stop.

## Pause

Hacer click en **Pause** (o presionar <kbd>P</kbd>). La SPA hace POST a `/sim/pause`;
el servidor pausa todos los threads del simulador en su próximo punto seguro.

Efectos observables en el canvas:

- Las animaciones de paquetes se congelan (los frames en vuelo quedan estacionados en
  el cable).
- Los mensajes periódicos de Hello y LSA del protocolo de ruteo se detienen.
- El botón **Pause** se convierte en **Resume**.

Pause también es el complemento natural del panel Packets (ver [web-ui.md](web-ui.md))
— las animaciones congeladas facilitan la lectura del mapeo de badge a fila.

**Mientras está pausado, se puede editar:**

- Agregar una LAN, host o router.
- Duplicar una LAN, host, router o link.
- Eliminar cualquiera de los anteriores.
- Actualizar el costo de una interface.
- Editar nombres y direcciones (con las mismas reglas de unicidad y validez que aplica
  el validador).

Cada mutación aparece en el botón **Resume** como un contador:
*Resume (3 edits)*. Estas operaciones se acumulan en la cola de ediciones pendientes
de la SPA; nada se aplica al servidor hasta que se haga Resume.

Mientras está pausado, no se puede hacer **Start** (ya iniciado) ni **Stop** a través
de la barra de herramientas sin antes detener la simulación subyacente (Stop está
permitido desde paused, pero descarta el parche en cola).

## Resume

Hacer click en **Resume**. La SPA:

1. Reconcilia la cola de ediciones pendientes con el canvas actual: las operaciones
   `add_*` se reescriben con los valores más recientes (así, una red que se agregó y
   luego se renombró se envía con su nombre actual), y cualquier operación cuyo
   destino fue eliminado entre Pause y Resume se descarta.
2. Hace POST del parche reconciliado a `/sim/resume`.

El servidor valida el parche completo de forma atómica:

- Si alguna operación falla la validación, **todo el parche es rechazado** con un
  `400 Bad Request` y una descripción de la operación fallida. La simulación
  permanece pausada; el parche se mantiene en la SPA para que se pueda corregir el
  problema.
- Si la validación pasa, cada operación se aplica en orden, luego se retoma el gate
  y el protocolo de ruteo continúa desde donde se quedó.

Errores comunes de validación del parche:

| Error | Causa |
|---|---|
| `duplicate_name` | `add_*` con un nombre que ya está en uso. |
| `address_in_use` | `add_host` / `add_router` lleva una IP ya usada por otro host o interface de router en la misma red. |
| `network_in_use` | `remove_network` para una LAN que aún tiene un host o router conectado. |
| `network_not_found` | `add_host` / `add_router` referencia una red inexistente. |
| `interface_not_found` | `update_cost` para un router que no tiene esa interface. |
| `invalid_cost` | El costo no es numérico o no es positivo. |

El paso de reconciliación es lo que hace que "pausar → agregar → renombrar → retomar"
se sienta natural: no hay que pensar en el formato del parche, solo en la forma final
deseada.

## Stop

Hacer click en **Stop** (o presionar <kbd>Space</kbd> nuevamente). La SPA hace POST a
`/sim/stop`; el servidor desmonta la simulación:

- Cada red, link, router e interface recibe la señal de detención y sus threads
  trabajadores salen limpiamente.
- La simulación se descarta.
- El estado vuelve a `idle`.

Qué sobrevive:

- El **archivo YAML de sesión** (`<source>.session.yaml`). El próximo Start lo
  volverá a leer.
- El estado del canvas de la SPA. Al hacer Stop y Start sin modificar la topología
  se vuelve exactamente al mismo punto.
- Los terminales en pantalla — siguen haciendo referencia a una simulación que ya no
  existe. Los comandos enviados a una simulación detenida devuelven `409 no
  topology loaded`. Cerrar y volver a abrir el terminal después de hacer Start da
  una sesión limpia.

Si se estuvo editando el canvas mientras estaba idle (después de un Stop, pero antes
del próximo Start), esas ediciones **no están** en el servidor aún — viven en el
estado local de la SPA y en `localStorage`. El próximo Start las serializa a YAML y
las envía vía `/topology`.

## Reset

Hacer click en **Reset** (solo habilitado cuando está idle). Esto:

1. Elimina `<source>.session.yaml`.
2. Vuelve a clonar desde el archivo fuente (`samples/sample.yaml` por defecto, o
   lo que apunte `LOOM_TOPOLOGY`).
3. Vuelve a parsear la fuente en un nuevo sistema autónomo.
4. La SPA obtiene el nuevo YAML y reemplaza el canvas.

Usar Reset cuando la sesión divergió de la fuente y se quiere revertir. El archivo
fuente **nunca es modificado** por la SPA — Reset descarta solo el clon de sesión.

## Ajustar los intervalos del protocolo

Hacer click en **Protocol** en la barra de herramientas para abrir el popover de
configuración del protocolo. Dos campos son ajustables:

- **Hello interval** — con qué frecuencia los routers envían mensajes de
  descubrimiento de vecinos (por defecto 10 s). Menor = vecinos detectados y
  declarados activos más rápido; mayor = más silencioso, pero más lento para detectar
  nuevos vecinos.
- **LSA refresh interval** — con qué frecuencia los routers re-anuncian su estado
  de link completo (por defecto 30 s). Menor = las rutas se re-anuncian con más
  frecuencia, convergencia más rápida ante un cambio; mayor = canvas más silencioso.

Los cambios se aplican a cada router en el momento en que se hace click en **Apply**.
El nuevo valor toma efecto en el próximo límite de intervalo de cada router, por lo
que el retraso máximo es el valor del intervalo *anterior*.

Para acelerar la convergencia inicial al explorar: bajar el **Hello interval** a
1 s. Para hacer que una simulación en ejecución re-anuncie rutas más agresivamente:
bajar el **LSA refresh interval**. Bajar cualquiera de los dos a 1 s hace que el
protocolo sea visiblemente ruidoso en el canvas, a razón de aproximadamente un ciclo
por segundo.

## Ediciones en idle vs. paused vs. running: comparación

| Acción | Idle (simulación no iniciada) | Paused (simulación cargada) | Running |
|---|---|---|---|
| Dónde vive la edición | Estado local de la SPA + `localStorage` | Estado local de la SPA + cola de ediciones pendientes | Se aplica inmediatamente al AS en ejecución |
| Cuándo lo ve el servidor | En el próximo **Start** (YAML completo) | En **Resume** (parche incremental) | En cada add/change completado |
| Validación | Re-parseo completo al iniciar | Validación por operación al retomar | Validación por operación en cada commit |
| Si falla | Start se cancela; la topología queda sin cargar | Resume rechazado; parche preservado para editar | Edición rechazada; canvas resincronizado desde el servidor |
| Impacto en convergencia | Los routers comienzan desde cero | El estado de ruteo existente se preserva; las nuevas aristas se incorporan | Las nuevas aristas y dispositivos se incorporan sin tiempo de inactividad |

Si se está prototipando ("¿funciona este CIDR?"), las ediciones en idle + Start
son suficientes — el parser responde en segundos. Si se está probando convergencia
incremental ("¿qué pasa cuando levanto r4 *mientras corre*?"), se puede agregar en
vivo sin pausar — o pausar, hacer varios cambios relacionados a la vez y retomar
atómicamente.

## Consejos

- **Bajar el Hello interval al explorar.** El valor por defecto de 10 s es realista
  pero lento para el descubrimiento de vecinos. Bajarlo a 1 s mientras se explora,
  luego restaurarlo cuando se quiere un canvas más silencioso.
- **Pausar antes de ediciones masivas.** La lista de parches se procesa eficientemente;
  un solo round-trip al servidor es más económico que iniciar y detener la simulación
  por cada cambio.
- **Usar Reset, no Stop+Start, cuando la sesión se desordenó.** Stop solo descarga
  el AS; Reset descarta la sesión y comienza desde la fuente.
- **El archivo de sesión está en el mismo directorio que la fuente.** Si se apuntó
  `LOOM_TOPOLOGY` a `/path/to/lab.yaml`, la sesión vive en
  `/path/to/lab.session.yaml`. Ambos son YAML plano; se puede hacer `git
  diff` entre ellos.
