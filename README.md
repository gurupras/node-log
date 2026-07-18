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

An error passed on its own becomes the `error` field — with or without a message:

```js
log.error('request failed', err)
// { tag, msg: 'request failed', error: { name, message, stack } }

log.error(err)
// { tag, msg: err.message, error: { name, message, stack } }
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

One log call serializes at most **256 error nodes**, however they are linked — causes,
`AggregateError` trees, error-valued properties. Links beyond that collapse to
`{ name, message, truncated: true }`. The bound is what makes a log call unable to overflow the
stack no matter what is thrown at it; a chain that hits it means something is wrapping errors in a
loop, which the marker itself tells you.

### Printf interpolation

Format tokens use pino's set — `%s` `%d` `%f` `%i` `%o` `%O` `%j`, with `%%` as an escaped
literal:

```js
log.info('listening on %s:%d', host, port)
// msg: 'listening on 0.0.0.0:8080'
```

One positional rule: an object or Error as the **second argument** always takes the merge-object
(or `error`) slot — that is this library's core signature — so tokens are fed from the third
argument on. To interpolate an object into the message, pass context (even `{}`) first:

```js
log.info('config: %j', config)     // config becomes fields; '%j' stays literal
log.info('config: %j', {}, config) // msg: 'config: {...}'
```

### Errors in any argument position

pino discards any argument past the message's format tokens, so a trailing error would normally
vanish. Errors beyond the tokens are pulled out and merged instead:

```js
log.error('request failed', { requestId }, err)
// { requestId, error: { name, message, stack } }
```

If `error` is already taken, subsequent errors land on `error2`, `error3`, and so on. An error
*filling* a token is interpolated as asked: `log.error('failed: %s', {}, err)` renders the error
into the message and does not duplicate it into `error`.

### Aggregated errors

`AggregateError`'s sub-errors — the whole diagnostic payload of a `Promise.any` failure — are
serialized too, rather than collapsing to `[{}]`:

```js
log.error('all upstreams failed', new AggregateError([e1, e2], 'all failed'))
// error: { name: 'AggregateError', message: 'all failed', errors: [ {...}, {...} ] }
```

An error referenced twice (say the same root under both `cause` and `originalError`) is serialized
in full both times; only a genuine cycle is collapsed, to `{ name, message }`.

### Nesting, and what is left alone

Errors are replaced anywhere in the merge object, including inside arrays and class instances,
**up to a depth of 8**. Deeper than that an error still serializes to `{}` — flatten it, or attach
it nearer the top.

Values that define their own JSON form (`Date`, `Buffer`, anything with a `toJSON`) are passed
through untouched, so they reach the transport intact. Typed arrays are skipped as well: they are
index-keyed and cannot contain an error. Everything else object-shaped is traversed, so an error
cannot hide inside a context object.

Logging never mutates the object you pass in: the error replacement is copy-on-write, and an object
containing no errors is forwarded as-is. A class instance containing an error is copied to a plain
object — only own enumerable properties survive JSON serialization, so the emitted record is the
same either way.

A property whose getter throws is recorded as `<unreadable: ...>` rather than raising out of the
log call: reporting an error must not raise a second one from inside the caller's catch block.

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
visited**, to a maximum depth of 8. That is charged on every call, whether or not an error is
found — but it is proportional to what you actually log:

| Merge object | Cost of the walk |
| --- | --- |
| `{ a, b }` | not measurable |
| ~40-node payload | +700ns (+11%) |
| `{ list: [50 objects] }` | +3.7µs (+47%) |

Depth is bounded by the cap; breadth is not. Large arrays are therefore the worst case — if you log
100-element arrays on a hot path and never put errors in them, that walk is pure overhead. It is
still small next to a single error log (~36µs).

Practical consequences:

- **An error with a `cause` costs roughly double** a plain one. That is one extra stack format, not
  overhead; it is the price of keeping the cause's stack.
- **Serializing custom properties is free** relative to the stack format that dominates.
- If you are logging errors fast enough for ~36µs to matter (~28k/sec/core), the stack format is
  the thing to avoid — not this library.
