const appRoot = require('app-root-path')
const { createLogger, format, transports } = require('winston')
require('winston-daily-rotate-file')
const deepmerge = require('deepmerge')
const moment = require('moment')

const { combine, colorize, simple, printf, errors } = format
const colorizer = colorize()

const TAG_SYMBOL = '__tag__'

function ConsoleLogger (config) {
  if (!config || typeof config !== 'object') {
    config = {}
  }
  const defaults = {
    level: 'debug',
    handleExceptions: true,
    json: false,
    colorize: true
  }
  const finalConfig = deepmerge(defaults, config)

  return createLogger({
    prettyPrint: true,
    format: combine(
      errors({ stack: true }),
      simple(),
      printf((msg) => {
        // Update msg.timestamp to be local
        msg.timestamp = moment().local().format('YYYY-MM-DD hh:mm:ss.SSS ZZ')

        const splat = msg[Symbol.for('splat')]
        let string
        if (splat) {
          let obj = {}
          const result = []
          if (Array.isArray(splat)) {
            splat.forEach((entry) => {
              if (typeof entry === 'object') {
                if (entry.stack) {
                  const { message, stack } = entry
                  obj = deepmerge(obj, { message, stack })
                } else {
                  obj = deepmerge(obj, entry)
                }
              } else {
                result.push(entry)
              }
            })
          } else {
            console.warn(`splat was not an array: ${JSON.stringify(msg)}`)
          }
          const { [TAG_SYMBOL]: tag } = obj
          delete obj[TAG_SYMBOL]
          result.unshift([
            `${msg.timestamp} - ${(msg.level + ':').padEnd(8, ' ')} ${tag.padEnd(
              20,
              ' '
            )} ${msg.message}`
          ])
          if (Object.keys(obj).length > 0) {
            result.push(JSON.stringify(obj))
          }
          string = result.join(' ')
        } else {
          string = msg.message
        }
        if (msg.stack) {
          string += `\n${msg.stack}`
        }
        return colorizer.colorize(msg.level, string)
      })
    ),
    transports: [new transports.Console(finalConfig)],
    exitOnError: false // do not exit on handled exceptions
  })
}

function FileLogger (config) {
  if (!config || typeof config !== 'object') {
    config = {}
  }
  const defaults = {
    level: 'debug',
    dirname: `${appRoot}/logs`,
    filename: 'log-%DATE%.log',
    handleExceptions: true,
    json: true,
    zippedArchive: true,
    maxsize: 10 * 1024 * 1024, // 10MB
    colorize: false
  }
  const finalConfig = deepmerge(defaults, config)
  return createLogger({
    transports: [new transports.DailyRotateFile(finalConfig)]
  })
}

const globalLoggers = []

class Logger {
  constructor (tag, defaultLevel = 'info', loggers = globalLoggers) {
    Object.assign(this, {
      tag,
      defaultLevel,
      loggers
    })
  }

  log (...args) {
    this.__log(this.defaultLevel, ...args)
  }

  __log (level, ...args) {
    const { tag, loggers } = this
    loggers.forEach((logger) => logger[level](...args, { [TAG_SYMBOL]: tag }))
  }

  error (...args) {
    this.__log('error', ...args)
  }

  warn (...args) {
    this.__log('warn', ...args)
  }

  info (...args) {
    this.__log('info', ...args)
  }

  verbose (...args) {
    this.__log('verbose', ...args)
  }

  debug (...args) {
    this.__log('debug', ...args)
  }

  silly (...args) {
    this.__log('silly', ...args)
  }
}

module.exports = {
  Logger,
  globalLoggers,
  ConsoleLogger,
  FileLogger
}
