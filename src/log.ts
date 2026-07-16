import pino, { ChildLoggerOptions } from 'pino'
import deepmerge from 'deepmerge'
import type PinoPretty from 'pino-pretty'
import type { SonicBoomOpts } from 'sonic-boom'
import { format } from 'date-fns'
import { RotateOpts } from './rotate.js'

// 'HH' (00-23), not 'hh' (01-12) — without a meridiem token a 12-hour clock renders
// 13:00-23:59 identically to 01:00-11:59, and midnight as 12:00.
export const defaultTimeFormat = 'yyyy-MM-dd HH:mm:ss.SSS zzzz'

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
    // A `cause` chain can loop back on itself; recursing would overflow the stack inside
    // the logger and take down the caller over nothing more than a log line.
    return { name: e.name, message: e.message }
  }
  seen.add(e)

  const serialized: Record<string, any> = { name: e.name }
  for (const key of Object.getOwnPropertyNames(e)) {
    const value = (e as any)[key]
    serialized[key] = value instanceof Error ? serializeError(value, seen) : value
  }
  return serialized
}

function isPlainObject (value: any): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

// Only object literals and arrays are walked. Class instances are left alone on purpose:
// copying them would strip their prototype, and spreading a Date/Map/Set yields `{}` —
// destroying the very values we are trying to log.
function isWalkable (value: any): boolean {
  if (value === null || typeof value !== 'object') {
    return false
  }
  if (Array.isArray(value)) {
    return true
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// An Error nested inside a logged object JSON-stringifies to `{}` — message and stack both
// vanish — so they are replaced with serializable objects first. The walk is depth-capped
// rather than cycle-tracked: a self-referential object simply bottoms out at the cap, which
// costs nothing on the hot path and cannot loop.
const MAX_ERROR_SCAN_DEPTH = 4

// Copy-on-write. The caller's object is never mutated (logging must not be observable to the
// code doing the logging), but an object with no Errors in it is returned as-is, so the common
// case allocates nothing.
function replaceErrors (value: any, depth: number): any {
  if (value instanceof Error) {
    return serializeError(value)
  }
  if (depth >= MAX_ERROR_SCAN_DEPTH || !isWalkable(value)) {
    return value
  }

  if (Array.isArray(value)) {
    let copy = value
    for (let i = 0; i < value.length; i++) {
      const next = replaceErrors(value[i], depth + 1)
      if (next !== value[i]) {
        if (copy === value) {
          copy = value.slice()
        }
        copy[i] = next
      }
    }
    return copy
  }

  let copy = value
  for (const key of Object.keys(value)) {
    const next = replaceErrors(value[key], depth + 1)
    if (next !== value[key]) {
      if (copy === value) {
        copy = { ...value }
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
  mixin?: (context: object, level: number) => object
}

function initialize (config: Config = {}) {
  let { level = 'debug', stdout, file, mixin: userMixin } = config

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
        singleLine: true
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
    timestamp () {
      const now = format(new Date(), defaultTimeFormat)
      return `,"time":"${now}"`
    },
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
