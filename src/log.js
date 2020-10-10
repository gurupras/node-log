const appRoot = require('app-root-path')
const { createLogger: _createLogger, format, transports } = require('winston')
require('winston-daily-rotate-file')
const deepmerge = require('deepmerge')
const moment = require('moment')

const { combine, colorize, timestamp, json, printf, errors } = format
const colorizer = colorize()

const TAG_SYMBOL = Symbol.for('tag')
const SPLAT_SYMBOL = Symbol.for('splat')
const LEVEL_SYMBOL = Symbol.for('level')
const EXTRA_FIELDS_SYMBOL = Symbol.for('extra-fields')

const timestampFormat = 'YYYY-MM-DD hh:mm:ss.SSS ZZ'

const tagFormat = format(info => {
  const { [SPLAT_SYMBOL]: splat = [] } = info

  const tagEntry = splat.slice(-1)[0]
  if (!tagEntry) {
    return info
  }
  const { [TAG_SYMBOL]: tag } = tagEntry
  delete tagEntry[TAG_SYMBOL]
  info.tag = tag
  return info
})

const processFields = msg => {
  const { [SPLAT_SYMBOL]: splat } = msg
  let obj = {}
  let extras
  if (splat) {
    const result = []
    if (Array.isArray(splat)) {
      for (const entry of splat) {
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
      }
    } else {
      console.warn(`splat was not an array: ${JSON.stringify(msg)}`)
    }
    const { [EXTRA_FIELDS_SYMBOL]: extraFields, ...attrs } = obj
    extras = attrs

    if (extraFields) {
      extras = deepmerge(extraFields, extras)
      for (const [k, v] of Object.entries(extraFields)) {
        msg[k] = msg[k] || v
      }
    }
  }
  return {
    msg,
    obj,
    extras
  }
}

function createLogger (config, transportClasses, formatOptions) {
  if (!config || typeof config !== 'object') {
    config = {}
  }
  if (!formatOptions) {
    formatOptions = {}
  }
  const { stream } = config // stream cannot be deepmerged
  if (!Array.isArray(transportClasses)) {
    transportClasses = [transportClasses]
  }

  const defaults = {
    level: 'debug',
    handleExceptions: true,
    json: false,
    colorize: true
  }
  const finalConfig = deepmerge(defaults, config)
  Object.assign(finalConfig, { stream })

  const defaultFormatters = [
    tagFormat(),
    errors({ stack: true }),
    timestamp({
      format: timestamp => moment(timestamp).local().format(timestampFormat)
    })
  ]

  const customPrintf = printf((info) => {
    const { [LEVEL_SYMBOL]: level, [SPLAT_SYMBOL]: splat, tag } = info
    const { msg, obj, extras } = processFields(info)
    delete msg[SPLAT_SYMBOL]
    let string
    if (splat) {
      const result = []
      const { stack } = obj
      result.unshift([
        `${msg.timestamp} - ${(level + ':').padEnd(8, ' ')} ${tag.padEnd(
          20,
          ' '
        )} ${msg.message}`
      ])
      if (stack) {
        result.push(`\n${msg.stack}`)
      }
      if (Object.keys(extras).length > 0) {
        result.push(JSON.stringify(extras))
      }
      string = result.join(' ')
    } else {
      string = msg.message
    }
    if (finalConfig.colorize) {
      return colorizer.colorize(level, string)
    }
    return string
  })

  let { formatters, append = false, addPrintf = true } = formatOptions
  if (append) {
    formatters = [...defaultFormatters, ...formatters]
  }
  if (!formatters) {
    formatters = [...defaultFormatters]
  }
  if (addPrintf) {
    formatters.push(customPrintf)
  }
  const format = combine(...formatters)
  return _createLogger({
    prettyPrint: true,
    format,
    transports: transportClasses.map(Cls => new Cls(finalConfig)),
    exitOnError: false // do not exit on handled exceptions
  })
}

function ConsoleLogger (config) {
  return createLogger(config, transports.Console)
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
  return createLogger(finalConfig, transports.DailyRotateFile, {
    addPrintf: false,
    append: true,
    formatters: [
      format(info => {
        const { msg } = processFields(info)
        return msg
      })(),
      json()
    ]
  })
}

const globalLoggers = []

class Logger {
  constructor (tag, defaultLevel = 'info', loggers = globalLoggers, extraFields = {}) {
    if (!Array.isArray(loggers)) {
      loggers = [loggers]
    }
    Object.assign(this, {
      tag,
      defaultLevel,
      loggers,
      extraFields
    })
  }

  log (...args) {
    this.__log(this.defaultLevel, ...args)
  }

  __log (level, ...args) {
    const { tag, loggers, extraFields } = this
    loggers.forEach((logger) => logger[level](...args, { [TAG_SYMBOL]: tag, [EXTRA_FIELDS_SYMBOL]: extraFields }))
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
  createLogger,
  globalLoggers,
  ConsoleLogger,
  FileLogger
}
