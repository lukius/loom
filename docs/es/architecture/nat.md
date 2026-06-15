> 🌐 [English](../../architecture/nat.md) · **Español**

# Diseño de NAT

El NAT de `loom` es con estado, por router, y de tipo source-NAT (conocido en el mundo real
como **NAPT/PAT**, sin puertos L4 — véase "Clave de conversación" más abajo). Cada router
mantiene su propia `NATTable`; la traducción se activa en el límite privado↔público en el
**camino de forwarding**, no en el host receptor.

Véase también: [routing-protocol.md](routing-protocol.md) (filtro de anuncio de prefijos
privados), [entities.md](entities.md#interface-interfacepy) (el campo `flow` en los eventos `packet`),
[web-spa.md](web-spa.md) (formas de los eventos `sim:nat` y `sim:nat-table-changed`).

## Por qué NAT vive en el simulador

El protocolo de ruteo filtra los prefijos RFC 1918 de cada LSA anunciado, por lo que las
LAN privadas son invisibles para los routers vecinos. Esto hace que las LAN
`192.168.1.0/24` superpuestas sean seguras entre tenants, pero también significa que un
host privado no tiene una dirección globalmente alcanzable. La traducción en el router de
egreso le da a esos paquetes un origen público que el resto del AS ya sabe rutear, y
permite que la respuesta regrese.

## Traducción de salida (`Router._handle_forwarding`)

Cuando un router está a punto de reenviar un paquete cuyo origen pertenece a un rango
RFC 1918 *y* cuya interface de egreso está en una red no privada, reescribe el origen
con la dirección propia de la interface de egreso y registra la traducción en la tabla NAT
del router:

```
key   = (rewritten_src, original_dst, flow_id)
value = original_src
```

Dos eventos se disparan en el bus del EventTracer inmediatamente después de la mutación
de la tabla:

- `nat` (`direction=outbound`) — lleva `{router, original_src,
  rewritten_src, dst, flow_id, payload_id}`. Los suscriptores reciben este
  evento por cada traducción de salida.
- `nat_table_changed` — lleva `{device, entries}` (el snapshot completo
  en orden LRU). Los suscriptores reciben este evento para actualizar su vista
  de la tabla NAT.

Si el router no tiene una interface pública pero el origen es privado,
`_handle_forwarding` lanza un error "no NAT egress" en lugar de reenviar tráfico
de origen privado por una interface privada. Esto evita que el tráfico de un
tenant se filtre hacia la LAN de otro tenant.

## Traducción entrante (`Router.handle_packet`)

En el camino de respuesta, el destino público no conoce la dirección privada original
— ve y responde a la dirección de egreso NAT. Cuando llega un paquete cuyo destino
coincide con una de las direcciones de interface pública del router, este busca
`(rewritten_dst, src, flow_id)` en su tabla NAT. Si hay coincidencia, reescribe el
destino de vuelta a la dirección privada original y reingresa al forwarding. Si no hay
coincidencia, el paquete pasa a `_handle_message` (está efectivamente dirigido al propio
router, por ejemplo un mensaje del protocolo de ruteo en broadcast). Se dispara un evento
`nat` de tipo `inbound` ante una coincidencia, para que los suscriptores puedan observar
la traducción inversa. No se genera un segundo `nat_table_changed` en la respuesta — el
estado de la tabla no cambia en la búsqueda entrante.

## La clave de conversación (`flow_id`)

Sin puertos L4, la tabla NAT necesita otro discriminador para que dos hosts privados
detrás de un router que hacen ping al mismo destino público no colapsen en una sola
entrada. El discriminador es el **UUID de conversación**, calculado de la siguiente manera:

- Para un `Message` con su propio `flow_key()` (el valor por defecto),
  `str(self._id)` — un `uuid.uuid4()` asignado en el momento de construcción.
- Para un `PingReply`, `str(request_id)` — el UUID del `PingRequest` originador,
  repetido por `Host._handle_message` para que la búsqueda inversa encuentre el
  registro de la dirección de envío.
- Para payloads arbitrarios sin `flow_key`, `None` — una ranura única compartida
  por `(rewritten_src, original_dst)`, adecuada para flujos fire-and-forget.

Este es el *mismo valor* que se lleva como campo `flow` en los eventos `packet`
(usado por los suscriptores para agrupar los hops de una conversación) y como `flow_id`
en los eventos `nat`. Tres preocupaciones distintas, una única fuente de verdad.

## Desalojo LRU

`NATTable` tiene capacidad limitada (1024 entradas por defecto). Cuando un `register`
superaría la capacidad, se desaloja la entrada menos recientemente usada. Un `register`
de una clave existente refresca su posición LRU. No hay expiración basada en tiempo —
las entradas persisten hasta ser desalojadas. Los flujos de corta duración (ping) y los
de larga duración (un stream de UserMessage) compiten en el mismo LRU; las simulaciones
largas no hacen crecer la tabla indefinidamente.

## Concurrencia

La tabla protege todas las mutaciones y búsquedas con un único `threading.Lock`
(véase [concurrency.md](concurrency.md)). El tráfico de dirección directa e inversa
que fluye por el mismo router no genera condiciones de carrera en la tabla.

## Referencia cruzada: indicación visual

En la SPA, las LAN RFC 1918 se renderizan en un tono neutro atenuado, y la etiqueta de
interface del lado del router en el límite privado también aparece atenuada para
coincidir. Véase [la página del user guide](../user-guide/nat-and-private-lans.md)
para la descripción orientada al usuario. La lógica de detección reside en
`web/utils.js::isPrivateCidr` y refleja `entities/address.py::is_private`.

## Omisiones deliberadas

El NAT de `loom` modela la mecánica de la traducción de direcciones — la reescritura,
la tabla de flujos y la detección del límite público/privado. Omite deliberadamente
comportamientos cuyo rol es operativo más que conceptual:

- **Sin envejecimiento basado en tiempo.** El NAT real aplica tiempos de espera de
  inactividad por protocolo (TCP mucho mayor que UDP — los valores por defecto típicos
  son 24h vs 30s) para que los flujos abandonados o semiabiertos liberen sus entradas
  de tabla por sí solos. La `NATTable` de `loom` desaloja solo por LRU al llegar al
  límite `max_entries`. El envejecimiento es la parte operativamente más significativa
  del comportamiento real del NAT y el punto de partida de toda historia de resolución
  de problemas de NAT; se omite aquí porque a la escala del simulador (pocos flujos
  durante segundos a minutos) la política basada en capacidad es indistinguible.
- **Sin conciencia por protocolo.** El NAT real aplica políticas distintas a TCP, UDP,
  ICMP, etc. `loom` indexa todos los flujos por `flow_id` (un UUID de conversación)
  independientemente del tipo de payload. La misma razón de omisión que el punto
  anterior: el simulador no modela L4 en absoluto.
- **Sin hairpinning / NAT-loopback.** El tráfico desde un host privado hacia la dirección
  pública de su propio NAT no se maneja de forma especial. No es relevante para las
  topologías que `loom` contempla.

Si se necesita enseñar o resolver problemas de comportamiento de envejecimiento NAT,
ns-3 o un router real son las herramientas adecuadas — véase la
[declaración de alcance](../user-guide/getting-started.md#alcance).
