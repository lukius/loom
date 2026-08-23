> 🌐 [English](../../user-guide/getting-started.md) · **Español**

# Primeros pasos

Esta guía recorre el camino que va desde un clon recién hecho del repositorio
hasta una simulación en vivo, con un ping entre dos hosts.

## Alcance

`loom` es un simulador de ruteo: modela únicamente conceptos de L3, tales como
forwarding IPv4, direccionamiento, tablas de ruteo y convergencia link-state.
No abarca L2 ni L4. Los frames son contenedores abstractos, y los payloads son
objetos de tipo mensaje que se entregan intactos.

## Instalación

```bash
git clone git@github.com:lukius/loom.git
cd loom

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`loom` tiene tres dependencias de ejecución y no requiere ningún prerequisito
del sistema más allá de Python 3.11+.

## Ejecutar la interfaz web

El punto de entrada predeterminado inicia el servidor FastAPI y sirve la SPA:

```bash
cd src
python loom.py
```

Se debería ver:

```
INFO:     Started server process [...]
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

Abrir [http://127.0.0.1:8000](http://127.0.0.1:8000). En la primera visita, el
_canvas_ aparece precargado con la topología de ejemplo: tres hosts (`h1`,
`h2`, `h3`), tres LANs (`lan1`, `lan2`, `lan3`), tres routers (`r1`, `r2`,
`r3`) y un link punto a punto `/30` (`p2p1`) entre `r1` y `r3`:

![Canvas inicial con la topología de ejemplo cargada](../../images/01-canvas-initial.png)

El estado de la página (posición, zoom, topología actual, tema y botones de la
barra de herramientas) se persiste en el almacenamiento local del navegador. Al
recargar se retoma el trabajo donde había quedado, editando la topología propia
y ya no la de ejemplo.

## Presionar Start

Hacer click en el botón verde **Start** de la barra de herramientas (o presionar
<kbd>Space</kbd>).

Lo que ocurre, en orden:

1. Se revisa el _canvas_ en busca de elementos incompletos: una LAN sin rango,
   un host sin dirección. Si falta algo, el inicio se cancela y se selecciona el
   elemento en cuestión para poder completarlo.
2. La topología se entrega al simulador, que levanta cada dispositivo e inicia
   el protocolo de ruteo de cada router.
3. En unos pocos cientos de milisegundos, los paquetes del protocolo de ruteo
   empiezan a propagarse por el _canvas_: son los paquetes pequeños de color
   índigo pálido (el _chatter_).
4. A medida que los routers convergen, sus tablas de ruteo se van completando;
   basta hacer click en cualquier router para verlo. En la barra de herramientas
   aparece el botón **Pause**, mientras que **Reset** permanece deshabilitado
   hasta detener la simulación.

![Simulación en ejecución, con el chatter del protocolo de ruteo visible](../../images/02-running.png)

Se puede seguir construyendo la topología mientras la simulación corre: al
agregar una LAN o un link punto a punto y darle un rango válido, este se
incorpora a la red en vivo de inmediato. Lo que sí espera es la conexión de
dispositivos, ya que los hosts y routers agregados durante la ejecución quedan
sueltos hasta pausar o detener la simulación; lo mismo ocurre al renombrar o
redireccionar algo ya existente.

Si no se ve el _chatter_, hacer click en el botón **Chatter** de la barra de
herramientas: activa y desactiva las animaciones del protocolo de ruteo.

## El primer ping

Hacer doble click en `h1` para abrir su terminal. La ventana emergente tiene
este aspecto:

![Ventana emergente de la terminal de h1](../../images/03-terminal.png)

Escribir:

```
ifconfig
```

Se verá la única interface del host (`iface_h1`), su dirección
(`200.100.0.10`), la red a la que pertenece (`lan1`) y su gateway
(`200.100.0.1`).

Ahora hacer ping a `h3`:

```
ping h3
```

Salida:

```
seq=0 150.10.10.30: time=12.34 ms
--- h3 ping statistics ---
1 sent, 1 received, 0% loss
```

En el _canvas_ puede seguirse el viaje del pedido, `h1` → `r1` → `r3` → `h3`:
`h1` se lo entrega a su gateway por defecto `r1`, que lo reenvía directamente a
`r3` a través del link `p2p1`, y este último lo entrega en `lan3`. Esa ruta
tiene un costo de 5 + 5 = 10; el camino largo, pasando por `lan2`, habría
costado 15 + 5.

La respuesta no rehace ese camino. `h3` se la entrega a su propio gateway,
`r2`, que está directamente conectado a `lan1` y se la entrega a `h1` en un solo
hop, sin tocar siquiera el link por el que llegó el pedido. Nada de esto es un
error: cada dispositivo hace forwarding de manera independiente usando su propia
tabla de ruteo, de modo que el ruteo no tiene por qué ser simétrico. El
camino que toma un paquete no dice nada acerca del camino que tomará su
respuesta.

Algo que no va a aparecer en la tabla de ruteo de nadie más es el rango propio
de `p2p1`, `10.0.0.0/30`. Los routers no anuncian rangos privados a sus vecinos,
así que solo `r1` y `r3` (los dos extremos) tienen una ruta hacia él. El link
igual transporta tráfico en beneficio de todos los demás; simplemente no es un
destino que alguien de afuera pueda nombrar. Ver
[NAT y LANs privadas](nat-and-private-lans.md) para el caso donde esa regla más
importa.

Probar con un host inexistente:

```
ping h99
```

```
ping: invalid destination: h99
```

O con una dirección routable que no existe:

```
ping 200.100.0.99
```

Expira tras los 3 segundos predeterminados e imprime:

```
seq=0 200.100.0.99: timeout
--- 200.100.0.99 ping statistics ---
1 sent, 0 received, 100% loss
```

## Inspeccionar una tabla de ruteo

Hacer click en cualquier router del _canvas_, por ejemplo `r2`. El panel derecho
muestra juntas las interfaces del router y su tabla de ruteo actual:

![Tabla de ruteo de r2](../../images/04-routes.png)

Cada fila es una regla: un prefijo de destino, la dirección IP del next hop (o
`0.0.0.0` si está directamente conectado) y el nombre de la interface de salida.
La tabla se actualiza sola cada vez que cambia la visión que el router tiene de
la red, ya sea por la llegada de una actualización de ruteo, la edición de un
costo o el agregado o la eliminación de un dispositivo. Vale la pena mirar la
tabla de `r2` después del ping anterior: es el router que llevó la respuesta de
vuelta hacia `lan1`.

## Detener la simulación

Hacer click en el botón rojo **Stop** (que reemplaza a **Start**) o presionar
<kbd>Space</kbd>. La simulación vuelve al estado `idle`: los routers dejan de
intercambiar mensajes de ruteo y la red se desarma, aunque la topología
permanece en el _canvas_. **Reset** vuelve a estar disponible y **Protocol** se
deshabilita.

También se puede **pausar** (presionando <kbd>P</kbd>), lo que congela la
simulación entera sin descartarla. Durante la pausa se pueden agregar o quitar
dispositivos y cambiar costos de interfaces; esas ediciones quedan retenidas
hasta hacer click en **Resume**, momento en el cual se aplican todas juntas. Ver
[Ejecutar simulaciones](running-simulations.md) para el ciclo de vida completo.

## Qué hacer a continuación

- [Interfaz web](web-ui.md): recorrido completo de la barra de herramientas, el
  _canvas_, el inspector y las terminales.
- [Construir topologías](building-topologies.md): agregar LANs, hosts, routers
  y links punto a punto propios.
- [Formato YAML](yaml-format.md): escribir topologías a mano o importarlas, y
  entender cómo la SPA guarda y reanuda.

## Resolución de problemas

**"Address already in use" en el puerto 8000.** Ya hay otro proceso de `loom` en
ejecución, o algún otro servicio está ocupando el puerto. Se puede cerrarlo o
bien iniciar en un puerto diferente: `LOOM_PORT=8765 python loom.py`.

**El canvas está vacío.** La topología de ejemplo se carga sola en la primera
visita, pero al recargar el navegador se recupera lo último que hubiera en el
_canvas_, incluso si estaba vacío por haberlo limpiado con **New**. Hacer click
en **Import topology…** en el estado vacío y elegir `sample.yaml` de la lista
para recuperar el ejemplo.

**Los paquetes no se animan.** Verificar que la simulación esté en estado
`running` (y no en pausa o en `idle`), y que el botón **Chatter** no esté
silenciando todos los paquetes. El campo **Packet speed** controla la velocidad
de la animación (en milisegundos por hop, 200–5000).

**Un router recién agregado todavía no tiene rutas.** Los routers se saludan a
intervalos regulares, así que un dispositivo agregado a una simulación en
ejecución recién se detecta en la siguiente ronda de saludos, lo que puede
demorar hasta un **Hello interval** (10 s por defecto). Conviene reducir el
**Hello interval** a `1` s en la ventana emergente **Protocol** para acelerar el
descubrimiento de vecinos mientras se explora.

**Un cambio en el YAML no tomó efecto.** Después del arranque, el simulador
trabaja sobre una copia privada de la topología, y no sobre el archivo editado
en disco. Detener la simulación y hacer click en **Reset** en la barra de
herramientas para descartar esa copia y volver a leer el original, o bien
reiniciar `loom.py`. El archivo original se indica mediante `LOOM_TOPOLOGY` (por
defecto, `samples/sample.yaml`).
