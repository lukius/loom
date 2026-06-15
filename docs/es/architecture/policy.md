> 🌐 [English](../../architecture/policy.md) · **Español**

# Marco de políticas

El mecanismo de route-map / política de `loom` reside en `src/routing/policy.py`. Este
documento describe lo que está implementado actualmente y lo que está reservado para el
trabajo de BGP que motivó el diseño.

Véase también: [routing-protocol.md](routing-protocol.md) (el punto de flood donde se aplica
la política de salida), [nat.md](nat.md) (por qué el filtrado de prefijos privados importa
para el aislamiento entre tenants).

---

## Por qué existe un marco de políticas

Lo operativamente más significativo que BGP enseña es la **política** —
local-pref, manipulación del AS-path, prefix-lists, route-maps, communities.
La prevención de bucles con path-vector es un párrafo; la política es todo lo demás.

Antes de que `loom` tuviera algún concepto de política, la regla del protocolo
link-state "no anunciar prefijos RFC 1918" era un `continue` hardcodeado en el
bucle de flood. Eso funcionaba para ese caso único pero no establecía ninguna
forma para la política de la era de BGP. El marco introducido aquí:

1. **Elimina el caso especial.** El filtro RFC 1918 es ahora una instancia de
   route-map con una regla (`deny` que coincide con los tres prefijos privados)
   y una acción `permit` por defecto — observable e idéntico al comportamiento
   anterior, estructuralmente una política entre muchas.
2. **Reserva la forma para BGP.** Las cláusulas set, la aplicación entrante,
   los matchers de AS-path y los route-maps por vecino están todos nombrados en
   el diseño pero no implementados; la forma en la que encajan ya está fijada.

---

## Lo que está implementado hoy

Tipos públicos (todos de `routing.policy`):

- `PrefixList(prefixes: list[NetworkAddress])`
  - `matches(candidate) -> bool` — verdadero si alguna entrada contiene al candidato
- `RouteMapRule(match: PrefixList, action: 'permit' | 'deny')`
  - `evaluate(prefix) -> Optional[PolicyDecision]` — `None` cuando la coincidencia falla
- `RouteMap(rules: list[RouteMapRule], default: 'permit' | 'deny')`
  - `apply(prefix) -> PolicyDecision`
- `PolicyDecision`
  - `is_permitted() -> bool`, `is_denied() -> bool`, `prefix()`
  - constructores: `PolicyDecision.permit(prefix)`, `PolicyDecision.deny(prefix)`

`LinkStateProtocol` mantiene un `RouteMap` como política de **salida**, aplicada
a cada prefijo que el router considera anunciar. El valor por defecto es
`RFC1918_OUTBOUND` — denegar los tres rangos RFC 1918, permitir todo lo demás.
Sitio de construcción: `LinkStateProtocol.__init__(router, outbound_policy=None)`.

Flujo de datos:

```
NetworkAddress (prefix)
        │
        ▼  RouteMap.apply(prefix)
   for each RouteMapRule:                    ← first match wins
       PrefixList.matches(prefix)?
            │  yes → PolicyDecision.permit(prefix) or .deny(prefix)
            │  no  → next rule
        ▼ all rules fall through
   default action → PolicyDecision.permit(prefix) or .deny(prefix)
```

---

## Lo que está reservado para el trabajo de BGP

Cada uno de estos encaja en la forma existente sin rediseñarla:

- **Cláusulas set.** Un futuro atributo `RouteMapRule.set_clauses` llevará
  mutaciones a aplicar cuando se active la cláusula de coincidencia: `set
  local-preference 200`, `set as-path prepend 65001 65001`, `set
  community 65001:1234`. `PolicyDecision.prefix()` ya devuelve un objeto de
  prefijo ruteado, por lo que las cláusulas set tienen un lugar donde mutar.
- **Aplicación entrante.** La política de salida se aplica hoy en
  `LSA.from_router` (invocado desde `_emit_lsa_on_up_interfaces` con
  `self._outbound_policy`). El camino de recepción — `_handle_incoming_lsa`
  → `_rebuild_graph_and_recompute` — tiene la ranura obvia para un atributo de
  política entrante; BGP lo usará para filtrado entrante y reescritura de
  atributos al recibir de EBGP.
- **Communities y matchers de AS-path.** `PrefixList` es el único tipo de
  coincidencia modelado. `RouteMapRule.match` se convertirá en una lista de
  cláusulas de coincidencia tipadas (`MatchPrefix`, `MatchCommunity`,
  `MatchASPath`) cuando BGP introduzca coincidencias no basadas en prefijos.
- **Route-maps por vecino.** El link-state hace flooding a broadcast, por lo que
  una política de salida por instancia de protocolo es suficiente. BGP anuncia
  por vecino con route-maps potencialmente distintos por dirección y por peer —
  eso se convierte en un atributo `dict[neighbor_id, RouteMap]` en el protocolo
  BGP cuando llegue.
- **Configuración YAML.** Aún no hay sintaxis YAML para route-maps. Cuando BGP
  esté disponible, el YAML incorporará un bloque `policies:` con alcance de AS y
  referencias por router a dicho bloque.

---

## Selección del mejor camino en BGP

Una vez que BGP sea el segundo protocolo, el orden canónico de desempate del mejor
camino será:

1. **Mayor local-preference** (la palanca principal de la mayoría de los administradores)
2. **AS-path más corto** (prevención de bucles + ingeniería de tráfico)
3. **Menor origin** (IGP < EGP < incomplete)
4. **Menor MED**, opcionalmente solo entre rutas con el mismo primer AS en el AS-path
5. **Menor costo IGP hacia el next hop de BGP**

Esta lógica residirá en una función del futuro módulo de protocolo BGP.
Flujo de control simple; no se necesita jerarquía de clases.

---

## Aclaraciones honestas

Este es un marco de nivel educativo. Omite deliberadamente comportamientos
de producción que no tienen peso pedagógico a la escala de `loom`:

- **Sin semántica `continue` / secuencia numerada en route-map.** Las reglas
  de `RouteMap` se ejecutan en orden de lista con first-match-wins, sin excepciones.
- **Sin filas `permit` en prefix-list.** `PrefixList` es una cláusula de
  coincidencia pura; permit/deny vive en el `RouteMapRule` que la envuelve.
- **Sin restricciones de longitud `le` / `ge` en prefix-list.** Solo
  coincidencia exacta o por contenido.
- **Sin matchers de AS-path por regex.**

Si se incorpora alguna funcionalidad, será porque algo en el programa de BGP la
necesita, no porque Cisco IOS la tenga.

---

## Dónde buscar en el código

| Aspecto | Archivo | Símbolo |
|---|---|---|
| Primitivas de política | `src/routing/policy.py` | `PrefixList`, `RouteMapRule`, `RouteMap`, `PolicyDecision` |
| Política RFC 1918 por defecto | `src/routing/policy.py` | `RFC1918_OUTBOUND` |
| Cableado de política de salida | `src/routing/protocol.py` | `LinkStateProtocol.__init__` |
| Aplicación de política de salida | `src/routing/lsa.py` | `LSA.from_router` (llamado desde `_emit_lsa_on_up_interfaces`) |
| Camino de recepción | `src/routing/protocol.py` | `_handle_incoming_lsa`, `_rebuild_graph_and_recompute` |
