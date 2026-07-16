# @gurupras/log

A thin [pino](https://getpino.io) wrapper with tagged child loggers, pretty stdout, optional file
output with rotation, and error serialization that keeps the parts of an `Error` you actually need.

```js
import { initialize, createLogger } from '@gurupras/log'

initialize({
  level: 'debug',
  stdout: true,
  file: { options: { destination: 'log.txt' } }
})

const log = createLogger('my-service')
log.info('listening', { port: 8080 })
```

## API

### `initialize(config)`

Builds the root logger. Call once, at startup, before `createLogger`.

| Option | Description |
| --- | --- |
| `level` | Minimum level: `silly`, `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default `debug`. |
| `stdout` | `true` for pretty-printed output, or `{ level, options }` ([pino-pretty options](https://github.com/pinojs/pino-pretty#options)). |
| `file` | `true` to write `log.txt`, or `{ level, target, options }`. Use `target: '@gurupras/log/rotate'` for date-rotated files. |
| `mixin` | `(context, level) => object` — extra fields merged into every record. |

### `createLogger(tag, extraFields?, options?)`

A child logger. `tag` is attached to every record; `extraFields` are merged into every record.

### `getRootLogger()`

The root logger created by `initialize`.

## Logging errors

`JSON.stringify(new Error('boom'))` returns `{}` — `message` and `stack` are non-enumerable, so a
plain JSON logger drops exactly the two fields you wanted. This library serializes errors before
they reach the transport, so they survive.

An error passed on its own becomes the `error` field:

```js
log.error('request failed', err)
// { tag, msg: 'request failed', error: { name, message, stack } }
```

An error under any key of the merge object is serialized in place:

```js
log.error('request failed', { requestId, err })
// { tag, msg: 'request failed', requestId, err: { name, message, stack } }
```

### Custom properties are preserved

Own properties survive, whether or not they are enumerable — so `code`, `statusCode` and friends
come through:

```js
log.error('request failed', Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }))
// error: { name, message, stack, code: 'ECONNREFUSED' }
```

### Causes are serialized recursively

Each link keeps its own `message` and `stack`, rather than being flattened into a single string:

```js
log.error('request failed', new Error('outer', { cause: new Error('inner') }))
// error: { name, message: 'outer', stack, cause: { name, message: 'inner', stack } }
```

### Errors in any argument position

pino treats everything after the merge object as printf interpolation arguments, so an error there
is normally discarded unless the message carries a matching format specifier. Errors in third and
later positions are pulled out and merged instead:

```js
log.error('request failed', { requestId }, err)
// { requestId, error: { name, message, stack } }
```

If `error` is already taken, subsequent errors land on `error2`, `error3`, and so on.

### Nesting, and what is left alone

Errors are replaced anywhere in the merge object, including inside arrays, **up to a depth of 4**.
Deeper than that, an error still serializes to `{}` — flatten it, or attach it nearer the top.

Only object literals and arrays are traversed. Class instances — `Date`, `Map`, custom classes — are
passed through untouched, since copying them would strip their prototype and reduce them to `{}`.

Logging never mutates the object you pass in: the error replacement is copy-on-write, and an object
containing no errors is forwarded as-is.

## Performance

The cost of a log call is dominated by V8, not by this library:

> **~4.5µs per call, plus ~31µs for every `Error` stack that gets formatted.**

`.stack` is a lazily-computed getter; the ~31µs is V8 building the string the first time anything
reads it. Measured on Node 24, output to `/dev/null`:

| Call | Stacks formatted | Cost |
| --- | --- | --- |
| `log.info('msg', { a, b })` | 0 | ~4.6µs |
| `log.error('msg', err)` | 1 | ~36µs |
| `log.error('msg', { err })` | 1 | ~36µs |
| `log.error('msg', errWithCause)` | 2 | ~68µs |

Finding the errors to serialize means walking the logged object, which costs **~20ns per node
visited**, to a maximum depth of 4. That is charged on every call, whether or not an error is
found — but it is proportional to what you actually log:

| Merge object | Cost of the walk |
| --- | --- |
| `{ a, b }` | +79ns (+1.8%) |
| 4-deep chain | +226ns (+5%) |
| 8-deep chain | +166ns (+3.6% — the depth cap stops the walk at 4) |
| ~40-node payload | +509ns (+8%) |
| `{ list: [100 numbers] }` | +1.8µs (+35%) |
| `{ list: [50 objects] }` | +4µs (+50%) |

Depth is bounded by the cap; breadth is not. Large arrays are therefore the worst case — if you log
100-element arrays on a hot path and never put errors in them, that walk is pure overhead. It is
still small next to a single error log (~36µs).

Practical consequences:

- **An error with a `cause` costs roughly double** a plain one. That is one extra stack format, not
  overhead; it is the price of keeping the cause's stack.
- **Serializing custom properties is free** relative to the stack format that dominates.
- If you are logging errors fast enough for ~36µs to matter (~28k/sec/core), the stack format is
  the thing to avoid — not this library.
