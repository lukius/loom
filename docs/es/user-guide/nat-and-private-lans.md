> 🌐 [English](../../user-guide/nat-and-private-lans.md) · **Español**

# NAT y redes privadas

Una topología puede tener dos tipos de LANs:

- **Públicas** — direcciones a las que cualquier nodo del AS puede rutear.
- **Privadas** — rangos RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`). Los hosts en una red privada son alcanzables solo
  a través de su gateway router; su dirección no es visible para el
  resto del AS.

Esta página explica cómo reconocer las redes privadas en el canvas,
cómo su tráfico llega a destinos públicos y cómo inspeccionar lo que
hace el gateway router.

## Identificar una red privada

Las redes privadas se renderizan en un **tono neutro apagado**. La
etiqueta de la interface del lado del gateway en el router también se
atenúa para coincidir. Las redes públicas se renderizan con el color de
acento habitual. La señal visual marca el límite NAT de un vistazo.

![Las redes privadas (lan_tenant_a, lan_tenant_b) se muestran con tono apagado; la red pública lan_isp mantiene el color de acento](../../images/50-private-lan-tone.png)

Se pueden colocar dos redes privadas que compartan el mismo CIDR (p. ej.
`192.168.1.0/24` en ambos lados) — el simulador permite la superposición
siempre que ambas permanezcan detrás de su propio gateway router. Las
redes públicas no pueden superponerse.

## Cómo el tráfico sale de una red privada

Un host en una red privada que hace ping a un destino público tiene su
**dirección de origen reescrita** por su gateway router con la dirección
pública del router. El resto del AS ve la dirección pública; la respuesta
vuelve al router, que restaura la dirección privada original y la entrega
al host.

Al pausar la simulación y **pasar el cursor sobre un paquete animado**, el
tooltip muestra la traducción, p. ej.:

```
NAT @ r_a: 192.168.1.10 → 198.51.100.1
```

Esto funciona en ambas direcciones:
- En el **tramo de ida**, el origen se reescribe cuando el paquete sale de
  la red privada.
- En el **tramo de respuesta**, el destino se reescribe cuando el paquete
  vuelve a entrar en la red privada.

## Inspeccionar la tabla NAT

Hacer click en el router que se encuentra entre una red privada y una
pública. Debajo del panel de tabla de ruteo, un panel de **tabla NAT**
lista todas las traducciones activas, de la más antigua a la más reciente:

- **Original** — el host privado que inició la conversación.
- **Rewritten** — la dirección pública a la que el router lo tradujo.
- **Destination** — la dirección pública con la que habla el host.
- **Flow ID** — un identificador por conversación; truncado en la columna,
  pasar el cursor para ver el valor completo.

![Tabla NAT en r_a después de un ping de h_a a h_public — una entrada de traducción, con el origen privado reescrito a la dirección pública de r_a](../../images/51-nat-panel.png)

El panel se actualiza en el momento en que la animación del paquete llega
al router (no cuando el host lo envía), por lo que el estado de la tabla
se mantiene sincronizado con lo que se ve en el canvas.

La tabla tiene un **tamaño máximo**: cuando se llena, se expulsa la entrada
menos usada recientemente. No hay expiración basada en tiempo — las entradas
persisten mientras están en uso.

## Por qué dos pings desde la misma red pueden estar en NAT al mismo tiempo

Cada ping obtiene su propio identificador de conversación internamente, por
lo que dos hosts en la misma red privada que hacen ping al mismo destino
público al mismo tiempo obtienen cada uno su propia fila en la tabla NAT.
Sus respuestas se traducen inversamente de forma independiente y llegan al
host correcto.

## Reglas de topología que mantienen la coherencia

- Un host privado no puede salir de la red privada a menos que su gateway
  router tenga al menos una interface pública.
- Dos hosts privados en redes privadas diferentes que comparten el mismo
  CIDR no pueden comunicarse entre sí por dirección — cada uno cree que el
  otro vive en su propia red (entrega local), pero la dirección no está allí.
- Los routers no anuncian sus prefijos privados a sus vecinos, por lo que
  el protocolo de ruteo se mantiene limpio entre tenants.

Para las herramientas del SPA en torno a NAT (bus de eventos, panel del
inspector) ver [web-ui.md](web-ui.md). Para el modelo arquitectural y las
decisiones de diseño, ver [la página de arquitectura NAT](../architecture/nat.md).
