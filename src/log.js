const pino = require('pino')
const deepmerge = require('deepmerge')
const moment = require('moment')

const timestampFormat = 'YYYY-MM-DD hh:mm:ss.SSS ZZ'

/** @type {pino.Logger} */
let rootLogger

function reverseLogMethods (logger) {
  const methods = [
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal'
  ]
  for (const method of methods) {
    const origFn = logger[method].bind(logger)
    logger[method] = (msg, obj) => {
      if (!obj) {
        return origFn(msg)
      }
      return origFn(obj, msg)
    }
  }
  return logger
}

function createLogger (tag, extraFields) {
  return reverseLogMethods(rootLogger.child({ ...extraFields, tag }))
}

function initialize (config = {}) {
  let { level = 'debug', stdout = true, file } = config

  const targets = []
  if (file) {
    const defaultFileOpts = {
      level,
      target: 'pino/file',
      options: {
        destination: config.file.name
      }
    }
    if (typeof file === 'boolean') {
      file = defaultFileOpts
    }
    targets.push(deepmerge(defaultFileOpts, file))
  }

  if (stdout) {
    const defaultStdoutOpts = {
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
      const now = moment().local().format(timestampFormat)
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

module.exports = {
  createLogger,
  initialize
}
