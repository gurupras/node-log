import pino, { ChildLoggerOptions } from 'pino'
import deepmerge from 'deepmerge'
import type PinoPretty from 'pino-pretty'
import type { SonicBoomOpts } from 'sonic-boom'
import { format } from 'date-fns'
import { RotateOpts } from './rotate.js'

// 'HH' (00-23), not 'hh' (01-12) — without a meridiem token a 12-hour clock renders
// 13:00-23:59 identically to 01:00-11:59, and midnight as 12:00.
export const defaultTimeFormat = 'yyyy-MM-dd HH:mm:ss.SSS zzzz'

// pino-pretty `translateTime` pattern (dateformat tokens, not date-fns) that mirrors
// defaultTimeFormat in the console's LOCAL zone. The `SYS:` prefix tells pino-pretty to
// translate the serialized (UTC) timestamp into system-local time for display, so when
// the on-disk `time` is a machine/UTC format the console still reads in local time.
export const defaultStdoutTimeFormat = 'SYS:yyyy-mm-dd HH:MM:ss.l o'

/**
 * How the serialized `time` field is stamped (what lands in files and every transport).
 * The process timezone is never changed — only the log representation.
 *  - `'iso'`   — UTC ISO-8601, e.g. `"2026-07-17T04:12:04.588Z"`. Standard, DST-proof,
 *                and re-rendered to LOCAL time on the pino-pretty console.
 *  - `'epoch'` — UTC epoch milliseconds. Also re-rendered to local on the console.
 *  - `'local'` — legacy human string in the process LOCAL zone
 *                (`"2026-07-16 20:00:00.000 GMT-04:00"`). Not machine-translatable, so
 *                the console shows it verbatim.
 *  - function  — a custom pino timestamp function returning a `,"time":<value>` fragment.
 */
export type TimeOption = 'iso' | 'epoch' | 'local' | (() => string)

// Legacy behavior: format `new Date()` in the process-local zone (with a GMT±HH:MM zone).
function localTimestamp (): string {
  return `,"time":"${format(new Date(), defaultTimeFormat)}"`
}

// Resolve a TimeOption into pino's `timestamp` function plus whether the emitted field is
// a machine format (iso/epoch) that pino-pretty can re-translate for a local console.
function resolveTimestamp (time: TimeOption): { fn: () => string, machine: boolean } {
  if (typeof time === 'function') return { fn: time, machine: false }
  switch (time) {
    case 'iso': return { fn: pino.stdTimeFunctions.isoTime, machine: true }
    case 'epoch': return { fn: pino.stdTimeFunctions.epochTime, machine: true }
    case 'local': return { fn: localTimestamp, machine: false }
    default: throw new Error(`@gurupras/log: unknown \`time\` option: ${String(time)}`)
  }
}

type Level = 'silly' | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

type reverseLog = (msg: string, ...args: any[]) => void

let dummyLogger: pino.Logger

export type Logger = {
  levels: pino.LevelMapping

  silly: reverseLog
  trace: reverseLog
  debug: reverseLog
  info: reverseLog
  warn: reverseLog
  error: reverseLog
  fatal: reverseLog

  child: (...args: Parameters<typeof dummyLogger.child>) => Logger
  on: typeof dummyLogger.on
  addListener: typeof dummyLogger.addListener
  once: typeof dummyLogger.once
  prependListener: typeof dummyLogger.prependListener
  prependOnceListener: typeof dummyLogger.prependOnceListener
  removeListener: typeof dummyLogger.removeListener
  isLevelEnabled: typeof dummyLogger.isLevelEnabled
  bindings: typeof dummyLogger.bindings
  setBindings: typeof dummyLogger.setBindings
  flush: typeof dummyLogger.flush
}

let rootLogger: Logger

// `message`/`stack` are non-enumerable on Error, so a spread yields `{}` for a stock error.
// Own-property names catch them along with custom fields (`code`, `statusCode`, ...) whether
// or not those are enumerable; `name` lives on the prototype, so it is copied separately.
function serializeError (e: Error, seen = new Set<Error>()): Record<string, any> {
  if (seen.has(e)) {
    // Already on the path being serialized: a `cause` chain that loops back on itself.
    // Recursing would overflow the stack inside the logger and take down the caller over
    // nothing more than a log line.
    return { name: e.name, message: e.message }
  }
  seen.add(e)

  const serialized: Record<string, any> = { name: e.name }
  for (const key of Object.getOwnPropertyNames(e)) {
    let value: any
    try {
      value = (e as any)[key]
    } catch (readError) {
      // This read invokes own accessors, and some clients attach lazily-computed ones that
      // throw. Reporting an error must not raise a second one out of the caller's catch.
      serialized[key] = `<unreadable: ${(readError as Error)?.message ?? readError}>`
      continue
    }
    // Errors hide inside containers too -- AggregateError keeps its sub-errors in `errors`,
    // and those carry the whole diagnostic payload of a Promise.any failure.
    serialized[key] = replaceErrors(value, 0, seen)
  }

  // Unwind: `seen` tracks the current path, not every error ever visited. Leaving `e` in it
  // would make a second, non-cyclic reference to the same error -- the same root under both
  // `cause` and `originalError`, say -- look like a cycle and silently lose its stack.
  seen.delete(e)
  return serialized
}

function isPlainObject (value: any): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

// Anything object-shaped is walked, so an Error cannot hide inside a class instance used as
// context. Two exceptions: a value defining its own JSON form (Date, Buffer, ...) must reach
// the transport intact, since copying it would strip the toJSON that produces that form; and
// a typed array is index-keyed and cannot hold an Error, so walking it would visit every
// element to find nothing.
function isWalkable (value: any): boolean {
  if (value === null || typeof value !== 'object') {
    return false
  }
  if (Array.isArray(value)) {
    return true
  }
  return typeof value.toJSON !== 'function' && !ArrayBuffer.isView(value)
}

// Class instances collapse to plain objects rather than being cloned through their prototype.
// Only own enumerable properties survive JSON serialization, so the emitted record is
// identical, and rebuilding the prototype risks assigning through an accessor with no setter.
function shallowCopy (value: any): any {
  return Array.isArray(value) ? value.slice() : { ...value }
}

// An Error nested inside a logged object JSON-stringifies to `{}` — message and stack both
// vanish — so they are replaced with serializable objects first. The walk is depth-capped
// rather than cycle-tracked: a self-referential object bottoms out at the cap, which cannot
// loop and costs nothing on the hot path. An Error is serialized before the cap is consulted,
// so the cap only strands one nested deeper than this — deep enough for realistic context
// objects, and the ceiling is documented rather than silent.
const MAX_ERROR_SCAN_DEPTH = 8

// Copy-on-write. The caller's object is never mutated (logging must not be observable to the
// code doing the logging), but an object with no Errors in it is returned as-is, so the common
// case allocates nothing -- including `seen`, which only materializes once an Error is found.
function replaceErrors (value: any, depth: number, seen?: Set<Error>): any {
  if (value instanceof Error) {
    return serializeError(value, seen)
  }
  if (depth >= MAX_ERROR_SCAN_DEPTH || !isWalkable(value)) {
    return value
  }

  if (Array.isArray(value)) {
    let copy = value
    for (let i = 0; i < value.length; i++) {
      const next = replaceErrors(value[i], depth + 1, seen)
      if (next !== value[i]) {
        if (copy === value) {
          copy = shallowCopy(value)
        }
        copy[i] = next
      }
    }
    return copy
  }

  let copy = value
  for (const key of Object.keys(value)) {
    const next = replaceErrors(value[key], depth + 1, seen)
    if (next !== value[key]) {
      if (copy === value) {
        copy = shallowCopy(value)
      }
      copy[key] = next
    }
  }
  return copy
}

function createLogger (tag: string, extraFields?: any, options?: ChildLoggerOptions) {
  return rootLogger.child({ ...extraFields, tag }, options)
}

type FileConfig = {
  level?: Level,
} & ({
  target?: '@gurupras/log/rotate',
  options?: RotateOpts
} | {
  target?: 'pino/file',
  options?: Omit<SonicBoomOpts, 'dest'> & { destination: string | number }
} | boolean)

export interface Config {
  level?: Level,
  stdout?: {
    level?: Level
    target?: string,
    options: PinoPretty.PrettyOptions
  } | boolean,
  file?: FileConfig,
  mixin?: (context: object, level: number) => object,
  /**
   * How the serialized `time` field is stamped. Defaults to `'iso'` (UTC ISO-8601) so
   * files/transports carry a standard, DST-proof timestamp regardless of the process
   * timezone; the pino-pretty console is auto-configured to display it in local time.
   * Set `'local'` to keep the legacy local-zone human string. See {@link TimeOption}.
   */
  time?: TimeOption
}

function initialize (config: Config = {}) {
  let { level = 'debug', stdout, file, mixin: userMixin, time = 'iso' } = config
  const { fn: timestampFn, machine: timeIsMachine } = resolveTimestamp(time)

  const targets = []
  if (file) {
    const defaultFileOpts: typeof config.file = {
      level,
      target: 'pino/file',
      options: {
        destination: 'log.txt'
      }
    }
    if (typeof file === 'boolean') {
      file = defaultFileOpts
    }
    targets.push(deepmerge(defaultFileOpts, file as any))
  }

  if (stdout) {
    const defaultStdoutOpts: typeof config.stdout = {
      level,
      target: 'pino-pretty',
      options: {
        singleLine: true,
        // The on-disk `time` is UTC for machine formats (iso/epoch); translate it back to
        // system-local time for humans watching the console. For 'local'/custom formats the
        // field is already a display string, so leave it untouched. A caller-supplied
        // translateTime (via stdout.options) still wins through the deepmerge below.
        ...(timeIsMachine ? { translateTime: defaultStdoutTimeFormat } : {})
      }
    }
    if (typeof stdout === 'boolean') {
      stdout = defaultStdoutOpts
    }
    targets.push(deepmerge(defaultStdoutOpts, stdout))
  }
  const logger = pino({
    mixin (_context, level) {
      const base = { levelLabel: rootLogger.levels.labels[level] }
      if (userMixin) {
        return { ...base, ...userMixin(_context, level) }
      }
      return base
    },
    timestamp: timestampFn,
    serializers: {
      // pino's default `err` serializer would re-process what the logMethod hook already
      // serialized, flattening the cause chain into the message ('outer: inner'), dropping
      // the cause object, and labelling it `type: 'Object'` — so it cannot be used as-is.
      //
      // But it cannot simply be replaced with a passthrough either: the hook does not see
      // every Error that reaches pino. Single-argument calls (`log.error(err)`) return early
      // from the hook, and child-logger bindings (`createLogger(tag, { err })`) bypass it
      // altogether. Both arrive here still raw, and a passthrough would JSON-stringify them
      // to `{}`. Serialize whatever is still an Error; leave the hook's output alone.
      err: value => value instanceof Error ? serializeError(value) : value
    },
    transport: {
      targets
    },
    customLevels: {
      silly: 5,
      trace: 10,
      debug: 20,
      info: 30,
      warn: 40,
      error: 50,
      fatal: 60
    },
    level,
    hooks: {
      logMethod (args, method) {
        if (args.length < 2) {
          return method.apply(this, args)
        }
        const msg = args.shift()
        const rawMergeObj = args.shift()

        // A bare Error becomes the `error` field rather than the merge object itself,
        // which would otherwise splatter `message`/`stack`/`name` onto the log record.
        let mergeObj = rawMergeObj instanceof Error
          ? { error: serializeError(rawMergeObj) }
          : replaceErrors(rawMergeObj, 0)

        // pino treats everything past the merge object as printf interpolation args, so an
        // Error here is dropped unless the message happens to carry a format specifier.
        const rest = []
        for (const arg of args) {
          if (arg instanceof Error && isPlainObject(mergeObj)) {
            if (mergeObj === rawMergeObj) {
              mergeObj = { ...mergeObj }
            }
            let key = 'error'
            for (let i = 2; key in mergeObj; i++) {
              key = `error${i}`
            }
            mergeObj[key] = serializeError(arg)
          } else {
            rest.push(arg)
          }
        }
        return method.apply(this, [mergeObj, msg, ...rest])
      }
    }
  })
  rootLogger = logger as any as Logger
}

function getRootLogger () {
  return rootLogger
}

export {
  createLogger,
  initialize,
  getRootLogger
}
