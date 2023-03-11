import pino from 'pino'
import deepmerge from 'deepmerge'
import type PinoPretty from 'pino-pretty'
import type { SonicBoomOpts } from 'sonic-boom'
import { format } from 'date-fns'


export const defaultTimeFormat = 'yyyy-MM-dd hh:mm:ss.SSS zzzz'

type Level = 'silly' | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

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

function reverseLogMethods (logger: Logger | pino.Logger): Logger {
  const methods: Level[] = [
    'silly',
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal'
  ]
  for (const method of methods) {
    const origFn = (logger as Logger)[method].bind(logger)
    ;(logger as Logger)[method] = (msg: string, obj: any) => {
      if (!obj) {
        return origFn(msg)
      }
      return origFn(obj, msg)
    }
  }
  return logger as Logger
}

function createLogger (tag: string, extraFields?: any) {
  return reverseLogMethods(rootLogger.child({ ...extraFields, tag }))
}

let dummyTargetOpts: pino.TransportTargetOptions<Record<string, any>>

export interface Config {
  level?: Level,
  stdout?: {
    level?: Level
    target?: string,
    options: PinoPretty.PrettyOptions
  } | boolean,
  file?: {
    level?: Level,
    target?: string,
    options: Omit<SonicBoomOpts, 'dest'> & { destination: string | number }
  } | boolean
}

function initialize (config: Config = {}) {
  let { level = 'debug', stdout = true, file } = config

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
    targets.push(deepmerge(defaultFileOpts, file))
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
      silly: 5
    },
    level
  })
  rootLogger = reverseLogMethods(logger)
}

function getRootLogger () {
  return rootLogger
}

export {
  createLogger,
  initialize,
  getRootLogger
}
