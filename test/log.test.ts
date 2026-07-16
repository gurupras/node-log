import fs from 'fs'
import tmp from 'tmp'
import { Writable } from 'stream'
import { createLogger, initialize, getRootLogger, defaultTimeFormat } from '../src/log.js'
import type { Config, Logger } from '../src/log.js'
import { describe, test, beforeEach, afterEach, expect } from 'vitest'
import { format, isValid, parse } from 'date-fns'

const tag = 'test-tag'

describe('log', () => {
  let log: Logger
  let stream: Writable
  let data: (Record<string, any> | string)[]
  let stdoutObj: ReturnType<typeof tmp.fileSync>
  let fileObj: ReturnType<typeof tmp.fileSync>

  function createTestLogger (objectMode: boolean, extraFields?: any, extraConfig?: Partial<Config>) {
    stream = new Writable({
      write (chunk, _, next) {
        data.push(chunk)
        next()
      },
      objectMode
    })
    stdoutObj = tmp.fileSync()
    fileObj = tmp.fileSync()
    initialize({
      level: 'silly',
      stdout: {
        options: {
          destination: stdoutObj.fd,
          colorize: false,
          hideObject: false
        }
      },
      file: {
        options: {
          destination: fileObj.fd
        }
      },
      ...extraConfig
    })
    log = createLogger(tag, extraFields)
  }

  async function sync (tmpObj = fileObj, objectMode = true) {
    await new Promise<void>((resolve, reject) => log.flush((err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    }))
    await new Promise(resolve => setTimeout(resolve, 200))
    let content = fs.readFileSync(tmpObj.name, 'utf-8')
    if (objectMode) {
      try {
        content = JSON.parse(content)
      } catch (e) {
      }
    }
    stream.write(content)
  }

  beforeEach(async () => {
    data = []
  })

  afterEach(async () => {
    stdoutObj.removeCallback()
    fileObj.removeCallback()
  })

  describe('Basic', () => {
    let entry: LogMessage
    beforeEach(async () => {
      createTestLogger(true)
      log.info('test')
      await sync()
      entry = data[0] as LogMessage
    })
    test('Contains tag', async () => {
      expect(entry.tag).toEqual(tag)
    })
    test('Contains time', async () => {
      // date-fns cannot parse the 'zzzz' zone ('GMT-04:00') that defaultTimeFormat emits,
      // so assert on the datetime portion; the zone suffix is covered by the format itself.
      const [datetime] = entry.time.split(' GMT')
      const parsed = parse(datetime, 'yyyy-MM-dd HH:mm:ss.SSS', new Date())
      expect(isValid(parsed)).toBe(true)
    })

    test('Renders the hour on a 24-hour clock', () => {
      // A 12-hour clock ('hh') with no meridiem token renders 23:03 as '11:03' and
      // midnight as '12:05', which silently corrupts every afternoon/evening timestamp
      // and makes logs impossible to correlate across services.
      expect(format(new Date(2026, 6, 14, 23, 3, 21), defaultTimeFormat)).toContain('2026-07-14 23:03:21')
      expect(format(new Date(2026, 6, 15, 0, 5, 0), defaultTimeFormat)).toContain('2026-07-15 00:05:00')
      expect(format(new Date(2026, 6, 15, 12, 5, 0), defaultTimeFormat)).toContain('2026-07-15 12:05:00')
    })
    test('Contains levelLabel', async () => {
      expect(entry.levelLabel).toEqual('info')
    })
    test('Contains msg', async () => {
      expect(entry.msg).toEqual('test')
    })
  })

  describe('error stacks', () => {
    test.each([
      ['console', () => stdoutObj, () => createTestLogger(false), (data: string[]) => data.join('\n')],
      ['stream', () => fileObj, () => createTestLogger(true), (data: Record<string, any>) => JSON.stringify(data)]
    ])('Error stacks appear in %s', async (_, objFn, init, stringify) => {
      init()
      const timestamp = Date.now()
      const error = new Error(`Error at: ${timestamp}`)
      log.error('Failure: ', { err: error })
      await sync(objFn())
      const str = stringify(data as any)
      expect(str).toInclude(`Error at: ${timestamp}`)
      expect(str).toInclude('log.test.ts')
    })
  })

  describe('Object arguments', () => {
    const inputs = [
      ['Simple', { a: 1, b: 2, c: 3, d: [1, 2, 'test'] }],
      ['Complex', { a: 1, b: 2, c: 3, d: { a: 1, b: 2, c: 3 }, e: [1, 2, 'test', { e: 1 }] }]
    ]
    test.each(inputs)('%s object arguments show up in console', (async (_: string, input: any) => {
      createTestLogger(false)
      const text = 'test log'
      log.info(text, input)
      await sync(stdoutObj, false)
      const str = data.join('\n')
      expect(str).toInclude(JSON.stringify(input).slice(1, -1))
    }) as any)

    test.each(inputs)('%s object arguments show up in stream', (async (_: string, input: any) => {
      createTestLogger(true)
      const text = 'test log'
      log.info(text, input)
      await sync(fileObj, true)
      const [entry] = data
      const obj = JSON.parse(JSON.stringify(entry))
      expect(obj).toMatchObject(input)
    }) as any)
  })

  describe('Able to add extra fields', () => {
    const extraFields = {
      host: 'testHost',
      ip: '1.2.3.4',
      nested: {
        obj: 1
      },
      array: [1, 2, { c: 3, p: ['0'] }]
    }
    const input = { data: 'unique-string' }

    test('Fields show up in console', async () => {
      createTestLogger(true, extraFields)
      const text = 'test log'
      log.info(text, input)
      await sync(stdoutObj, false)
      const str = data.join('\n')
      expect(str).toInclude('unique-string')
      for (const [k, v] of Object.entries({ ...input, ...extraFields })) {
        expect(str).toInclude(k)
        expect(str).toInclude(JSON.stringify(v).slice(1, -1))
      }
    })
    test('Fields show up in stream', async () => {
      createTestLogger(true, extraFields)
      const text = 'test log'
      log.info(text, input)
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        msg: text,
        levelLabel: 'info',
        tag,
        time: expect.anything(),
        ...extraFields
      })
    })
    test('Multiple arguments are all logged', async () => {
      createTestLogger(true, extraFields)
      const fields = { a: 1, b: 2 }
      const error = new Error(`timeout at ${Date.now()}`)
      const text = 'test log'
      log.error(text, { ...fields, err: error })
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        msg: text,
        levelLabel: 'error',
        tag,
        time: expect.anything(),
        ...extraFields,
        ...fields,
        err: { message: error.message, stack: error.stack }
      })
    })
  })

  describe('Errors', () => {
    test('Able to log simple errors', async () => {
      createTestLogger(true)
      const error = new Error('simple error')
      log.error('my error', error)
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        tag,
        msg: 'my error',
        levelLabel: 'error',
        error: { message: error.message, stack: error.stack },
      })
    })

    test('Errors are properly logged even if they are third or higher arg', async () => {
      createTestLogger(true)
      const error = new Error('simple error')
      log.error('my error', { foo: 'bar' }, error)
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        tag,
        msg: 'my error',
        levelLabel: 'error',
        foo: 'bar',
        error: { message: error.message, stack: error.stack },
      })
    })

    test('Custom properties on an error are preserved', async () => {
      createTestLogger(true)
      const error = Object.assign(new Error('request failed'), { code: 'ECONNREFUSED', statusCode: 502 })
      log.error('my error', error)
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        error: {
          name: 'Error',
          message: 'request failed',
          stack: error.stack,
          code: 'ECONNREFUSED',
          statusCode: 502
        }
      })
    })

    test('Error causes are serialized recursively', async () => {
      createTestLogger(true)
      const root = new Error('socket closed')
      const error = new Error('request failed', { cause: root })
      log.error('my error', error)
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        error: {
          message: 'request failed',
          cause: { message: 'socket closed', stack: root.stack }
        }
      })
    })

    test('A self-referential cause chain does not overflow the stack', async () => {
      createTestLogger(true)
      const error = new Error('loops')
      ;(error as any).cause = error
      expect(() => log.error('my error', error)).not.toThrow()
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        msg: 'my error',
        error: { message: 'loops', cause: { message: 'loops' } }
      })
    })

    test('A bare error logged as the only argument keeps its stack', async () => {
      createTestLogger(true)
      const error = Object.assign(new Error('single arg'), { code: 'E_SINGLE' })
      // args.length < 2, so the logMethod hook never sees this: pino wraps it as `err`
      // and applies the serializer directly.
      log.error(error)
      await sync()
      const [entry] = data as any[]
      expect(entry.err).toMatchObject({
        name: 'Error',
        message: 'single arg',
        stack: error.stack,
        code: 'E_SINGLE'
      })
    })

    test('An error bound into a child logger keeps its stack', async () => {
      createTestLogger(true)
      const error = new Error('bound error')
      // Child bindings bypass the logMethod hook entirely.
      const child = createLogger('child-tag', { err: error })
      child.info('bound')
      await sync()
      const [entry] = data as any[]
      expect(entry.err).toMatchObject({ name: 'Error', message: 'bound error', stack: error.stack })
    })

    test('Errors nested deeper than one level are serialized', async () => {
      createTestLogger(true)
      const error = new Error('deep error')
      log.error('my error', { meta: { inner: { err: error } } })
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        meta: { inner: { err: { message: 'deep error', stack: error.stack } } }
      })
    })

    test('Errors inside arrays are serialized', async () => {
      createTestLogger(true)
      const error = new Error('array error')
      log.error('my error', { list: [{ err: error }] })
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        list: [{ err: { message: 'array error', stack: error.stack } }]
      })
    })

    test('An error under the `err` key keeps its cause and is not relabelled', async () => {
      createTestLogger(true)
      const root = new Error('socket closed')
      const error = new Error('request failed', { cause: root })
      log.error('my error', { err: error })
      await sync()
      const [entry] = data as any[]
      expect(entry.err).toMatchObject({
        name: 'Error',
        message: 'request failed',
        cause: { message: 'socket closed', stack: root.stack }
      })
      // pino's default `err` serializer flattens the chain to 'request failed: socket closed'
      // and stamps type: 'Object'; neither should survive.
      expect(entry.err.type).toBeUndefined()
      expect(entry.err.message).toBe('request failed')
    })

    test('Logging does not mutate the caller\'s object', async () => {
      createTestLogger(true)
      const error = new Error('boom')
      const arg = { a: 1, err: error, nested: { deep: error } }
      log.error('my error', arg)
      await sync()
      expect(arg.err).toBe(error)
      expect(arg.err).toBeInstanceOf(Error)
      expect(arg.nested.deep).toBeInstanceOf(Error)
    })

    test('Non-plain objects are passed through intact', async () => {
      createTestLogger(true)
      const date = new Date('2026-07-15T00:00:00.000Z')
      log.error('my error', { when: date, list: [1, 2] })
      await sync()
      const [entry] = data as any[]
      // Spreading a Date would yield {}, destroying the value.
      expect(entry.when).toBe('2026-07-15T00:00:00.000Z')
      expect(entry.list).toEqual([1, 2])
    })

    test('A self-referential object does not hang the logger', async () => {
      createTestLogger(true)
      const arg: any = { a: 1 }
      arg.self = arg
      expect(() => log.error('my error', arg)).not.toThrow()
      await sync()
      const [entry] = data as any[]
      expect(entry).toMatchObject({ msg: 'my error', a: 1 })
    })

    test('Able to log error within object', async () => {
      createTestLogger(true)
      const error = new Error('simple error')
      const msg = 'message'
      const args = {
        uniqIdx: 1,
        foo: 'bar',
        args: [1, 4, '--test'],
        e: error
      }
      log.error(msg, args)
      await sync()
      const [entry] = data
      expect(entry).toMatchObject({
        msg,
        ...args,
        e: {
          message: error.message,
          stack: error.stack
        },
        levelLabel: 'error',
        tag
      })
    })
  })

  describe('mixin', () => {
    test('Fields from a user-supplied mixin are merged into every record', async () => {
      createTestLogger(true, undefined, { mixin: () => ({ requestId: 'abc-123' }) })
      log.info('test')
      await sync()
      const [entry] = data
      // The built-in levelLabel must survive alongside the user's fields.
      expect(entry).toMatchObject({ msg: 'test', levelLabel: 'info', requestId: 'abc-123' })
    })

    test('A user-supplied mixin receives the level', async () => {
      const levels: number[] = []
      createTestLogger(true, undefined, { mixin: (_context, level) => { levels.push(level); return {} } })
      log.error('test')
      await sync()
      expect(levels).toContain(50)
    })
  })

  describe('getRootLogger', () => {
    test('returns the root logger instance', async () => {
      createTestLogger(true)
      const rootLogger = getRootLogger()
      expect(rootLogger).toBeDefined()
      expect(rootLogger).toHaveProperty('info')
      expect(rootLogger).toHaveProperty('error')
    })
  })
})

interface LogMessage extends Record<string, any> {
  tag: string
  time: string
  msg: string
  level: number
  levelLabel: string
}
