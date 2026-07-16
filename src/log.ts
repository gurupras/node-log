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
  file?: FileConfig
}

function initialize (config: Config = {}) {
  let { level = 'debug', stdout, file } = config

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
      return { levelLabel: rootLogger.levels.labels[level] }
    },
    timestamp () {
      const now = format(new Date(), defaultTimeFormat)
      return `,"time":"${now}"`
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
        if (args.length >= 2) {
          const arg1 = args.shift()
          let arg2 = args.shift()
          if (arg2 instanceof Error) {
            arg2 = { error: { message: arg2.message, stack: arg2.stack } }
          } else if (typeof arg2 === 'object' && arg2 !== null) {
            // Find any error objects and replace them
            for (const key in arg2) {
              if (Object.prototype.hasOwnProperty.call(arg2, key)) {
                const value = arg2[key]
                if (value instanceof Error) {
                  arg2[key] = { message: value.message, stack: value.stack }
                }
              }
            }
          }
          return method.apply(this, [arg2, arg1, ...args])
        }
        return method.apply(this, args)
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
