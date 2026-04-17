# Proximos Pasos de Nix Query

Este documento define el plan de evolucion para `@deijose/nix-query` siguiendo una convencion CQRS clara:

- Lectura: `createQuery`
- Escritura: `createCommand`

## Roadmap

Estado actual:

- v1.1: completada
- v1.2: completada
- v1.3: completada (experimental)

### v1.1

`createCommand` minimo, robusto y sin optimistic updates.

#### Contrato concreto v1.1

- Estado: `idle | pending | success | error`
- API: `execute`, `executeAsync`, `reset`, `cancel`
- Concurrencia: `mode: "latest" | "queue" | "parallel"`
- Proteccion movil: `dedupeWindowMs`
- Integracion query: `invalidate` al `onSuccess` o `onSettled`
- Retry: `retry` y `retryDelay`, con guia oficial por tipo de error

### v1.2

Cache writes + optimistic/rollback explicito.

#### Contrato concreto v1.2

- Agregar `getQueryData`, `setQueryData`, `updateQueryData`
- `onMutate` devuelve `context` con `previousData`
- Rollback explicito con `setQueryData(key, context.previousData)`
- Documentar colisiones de comandos optimistas simultaneos y orden de rollback

### v1.3

Offline queue como experimental.

#### Contrato concreto v1.3

- Marcar explicitamente como `advanced/experimental`
- Requisitos backend: idempotency real en servidor
- Requisitos cliente: payload serializable, politica de replay y storage definido
- Integracion solo mediante adaptador (sin storage opinionated dentro del core)

Implementado en v1.3:

- Nuevo `mode: "queueOffline"` en `createCommand`
- Estado extendido: `queued`
- Nuevas señales/metodos: `queuedCount`, `isQueued`, `replayQueue`, `clearQueue`
- Error explicito para cola offline: `CommandQueuedError`
- Contrato de adaptador obligatorio para persistencia:
	- `enqueue(entry)`
	- `list(commandKey?)`
	- `update(entry)`
	- `remove(id)`
- Hooks de ciclo offline:
	- `onEnqueue`
	- `onReplaySuccess`
	- `onReplayError`
	- `shouldEnqueue` (defer por politica)

Nota de diseno:

- El core no asume `localStorage`, `IndexedDB` ni plugins moviles.
- Cada app define su propia estrategia de cola con un adaptador.

## Matriz de Retry Recomendada

- Errores 4xx de negocio/validacion: no retry
- Errores 5xx y fallos transitorios de red: retry acotado

Patron oficial recomendado:

```ts
retry: (count, err) => isTransient(err) && count < 3
```

Donde `isTransient(err)` debe mapear de forma explicita estados HTTP y errores de red.

## Resumen de Decision

- Esta estrategia reduce riesgo de scope y evita complejidad prematura.
- La decision correcta es entregar valor fuerte en v1.1 y v1.2.
- v1.3 debe mantenerse opcional/experimental hasta tener un caso real que guie el diseno.
