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
    // The transport worker writes asynchronously even after flush() resolves, so a fixed
    // sleep (formerly 200 ms) flaked under CPU contention. Poll until the file has content
    // and has stopped growing between consecutive reads; every sync() caller logs at least
    // one line, so waiting for non-empty cannot hang.
    let content = ''
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      const next = fs.readFileSync(tmpObj.name, 'utf-8')
      if (next.length > 0 && next === content) {
        break
      }
      content = next
    }
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
    test('Contains time (UTC ISO-8601 by default)', async () => {
      // The default `time` option is 'iso': serialized as UTC ISO-8601 ("...Z").
      expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(isValid(new Date(entry.time))).toBe(true)
      // ...and it is the current instant, not a stale/wrong-zone value.
      expect(Math.abs(new Date(entry.time).getTime() - Date.now())).toBeLessThan(60_000)
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

    test('A 50,000-link cause chain cannot overflow the stack or escape the call', async () => {
      createTestLogger(true)
      let chain = new Error('leaf')
      for (let i = 0; i < 50_000; i++) {
        chain = new Error(`link ${i}`, { cause: chain })
      }
      const start = Date.now()
      // The realistic source is a retry loop wrapping its last failure as `cause` for
      // hours; the log call must neither throw (RangeError into the caller) nor hang.
      expect(() => log.error('deep chain', chain)).not.toThrow()
      expect(Date.now() - start).toBeLessThan(2_000)
      await sync()
      const [entry] = data as any[]
      expect(entry.error).toMatchObject({ message: 'link 49999' })
      // The chain is cut at the node budget with an explicit marker, not silently.
      expect(JSON.stringify(entry)).toContain('"truncated":true')
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
      // args.length < 2, so the logMethod hook never sees this: pino wraps it via
      // errorKey ('error' — the same key the hook uses) and applies the serializer.
      log.error(error)
      await sync()
      const [entry] = data as any[]
      expect(entry.error).toMatchObject({
        name: 'Error',
        message: 'single arg',
        stack: error.stack,
        code: 'E_SINGLE'
      })
      // The old split schema (`err` for single-arg, `error` everywhere else) must not return.
      expect(entry.err).toBeUndefined()
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

    test('AggregateError sub-errors are serialized', async () => {
      createTestLogger(true)
      const sub1 = new Error('sub1')
      const sub2 = new Error('sub2')
      log.error('agg', new AggregateError([sub1, sub2], 'all failed'))
      await sync()
      const [entry] = data as any[]
      // The sub-errors are the entire diagnostic payload of a Promise.any failure.
      expect(entry.error.message).toBe('all failed')
      expect(entry.error.errors).toMatchObject([
        { message: 'sub1', stack: sub1.stack },
        { message: 'sub2', stack: sub2.stack }
      ])
    })

    test('Errors held by a class instance are serialized', async () => {
      createTestLogger(true)
      const error = new Error('inside class')
      class Ctx {
        reason = error
        id = 7
      }
      log.error('my error', new Ctx())
      await sync()
      const [entry] = data as any[]
      expect(entry.id).toBe(7)
      expect(entry.reason).toMatchObject({ message: 'inside class', stack: error.stack })
    })

    test('The same error referenced twice keeps its stack both times', async () => {
      createTestLogger(true)
      const root = new Error('root cause')
      const error = new Error('outer', { cause: root })
      ;(error as any).originalError = root
      log.error('my error', error)
      await sync()
      const [entry] = data as any[]
      // A diamond is not a cycle: the second reference must not be truncated.
      expect(entry.error.cause).toMatchObject({ message: 'root cause', stack: root.stack })
      expect(entry.error.originalError).toMatchObject({ message: 'root cause', stack: root.stack })
    })

    test('A throwing getter on an error does not escape the log call', async () => {
      createTestLogger(true)
      const error = new Error('with bad getter')
      Object.defineProperty(error, 'detail', {
        enumerable: true,
        get () { throw new Error('unavailable') }
      })
      expect(() => log.error('my error', error)).not.toThrow()
      await sync()
      const [entry] = data as any[]
      expect(entry.error.message).toBe('with bad getter')
      expect(entry.error.detail).toContain('unreadable')
    })

    test('Values defining their own JSON form are left intact', async () => {
      createTestLogger(true)
      const error = new Error('boom')
      const date = new Date('2026-07-15T00:00:00.000Z')
      // The error forces the copy-on-write path; the Date must still survive it.
      log.error('my error', { when: date, err: error })
      await sync()
      const [entry] = data as any[]
      expect(entry.when).toBe('2026-07-15T00:00:00.000Z')
      expect(entry.err).toMatchObject({ message: 'boom', stack: error.stack })
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

  describe('printf interpolation', () => {
    test('A primitive second argument interpolates instead of replacing the message', async () => {
      createTestLogger(true)
      log.info('hello %s', 'world')
      await sync()
      const [entry] = data as any[]
      expect(entry.msg).toBe('hello world')
    })

    test('Numbers interpolate', async () => {
      createTestLogger(true)
      log.info('count is %d of %d', 3, 10)
      await sync()
      const [entry] = data as any[]
      expect(entry.msg).toBe('count is 3 of 10')
    })

    test('A primitive second argument with no matching token never becomes the message', async () => {
      createTestLogger(true)
      log.info('no tokens here', 'world')
      await sync()
      const [entry] = data as any[]
      // pino discards the unmatched arg; the message must survive.
      expect(entry.msg).toBe('no tokens here')
    })

    test('An error filling a format token is interpolated, not swept', async () => {
      createTestLogger(true)
      const error = new Error('token-fill')
      log.error('failed: %s', { a: 1 }, error)
      await sync()
      const [entry] = data as any[]
      expect(entry.msg).toBe(`failed: ${String(error)}`)
      expect(entry.a).toBe(1)
      expect(entry.error).toBeUndefined()
    })

    test('Errors beyond the message tokens are swept into the record', async () => {
      createTestLogger(true)
      const error = new Error('surplus')
      log.error('op %s failed', 'fetch', error)
      await sync()
      const [entry] = data as any[]
      expect(entry.msg).toBe('op fetch failed')
      expect(entry.error).toMatchObject({ message: 'surplus', stack: error.stack })
    })

    test('An object second argument takes the merge slot; tokens are fed from the third arg on', async () => {
      createTestLogger(true)
      // The second-arg-is-context rule wins over interpolation: this is the library's
      // core signature, so '%j' here stays literal and the object becomes fields...
      log.info('config: %j', { port: 8080 })
      // ...and the documented escape hatch is an explicit (even empty) context first.
      log.info('config: %j', {}, { port: 8080 })
      await sync(fileObj, false)
      const lines = (data.join('') as string).trim().split('\n').map(l => JSON.parse(l))
      expect(lines[0].msg).toBe('config: %j')
      expect(lines[0].port).toBe(8080)
      expect(lines[1].msg).toBe('config: {"port":8080}')
      expect(lines[1].port).toBeUndefined()
    })

    test('%% is an escaped literal, not a token', async () => {
      createTestLogger(true)
      const error = new Error('escaped')
      // One real token ('%s' after stripping '%%'); the error is surplus and swept.
      log.error('progress 100%% on %s', 'sync', error)
      await sync()
      const [entry] = data as any[]
      expect(entry.msg).toBe('progress 100% on sync')
      expect(entry.error).toMatchObject({ message: 'escaped' })
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

  describe('time (representation / timezone)', () => {
    test("default 'iso' — serialized time is UTC ISO-8601", async () => {
      createTestLogger(true)
      log.info('iso-default')
      await sync()
      const entry = data[0] as LogMessage
      expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(Math.abs(new Date(entry.time).getTime() - Date.now())).toBeLessThan(60_000)
    })

    test("'epoch' — serialized time is UTC epoch milliseconds", async () => {
      createTestLogger(true, undefined, { time: 'epoch' })
      log.info('epoch')
      await sync()
      const entry = data[0] as LogMessage
      const t = entry.time as unknown as number
      expect(typeof t).toBe('number')
      expect(Math.abs(t - Date.now())).toBeLessThan(60_000)
    })

    test("'local' — serialized time is the legacy local-zone human string", async () => {
      createTestLogger(true, undefined, { time: 'local' })
      log.info('local')
      await sync()
      const entry = data[0] as LogMessage
      // e.g. "2026-07-16 20:00:00.000 GMT-04:00"
      expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} GMT[+-]\d{2}:\d{2}$/)
      const [datetime] = entry.time.split(' GMT')
      expect(isValid(parse(datetime, 'yyyy-MM-dd HH:mm:ss.SSS', new Date()))).toBe(true)
    })

    test('custom function is used verbatim', async () => {
      createTestLogger(true, undefined, { time: () => ',"time":"CUSTOM-TS"' })
      log.info('custom')
      await sync()
      const entry = data[0] as LogMessage
      expect(entry.time).toBe('CUSTOM-TS')
    })

    test('unknown option throws', () => {
      // @ts-expect-error deliberately invalid option
      expect(() => initialize({ time: 'pacific' })).toThrow(/unknown `time` option/)
    })

    test('the split: file stores UTC, stdout renders the same instant in LOCAL time', async () => {
      createTestLogger(true, undefined, { time: 'iso' })
      log.info('split')
      await sync() // flushes all transports; reads the FILE into data[0]
      const fileEntry = data[0] as LogMessage
      expect(fileEntry.time).toMatch(/Z$/) // file: UTC ISO
      const fileUtcMs = new Date(fileEntry.time).getTime()

      // stdout: pino-pretty translateTime('SYS:...') renders it in the process-local zone
      const consoleOut = fs.readFileSync(stdoutObj.name, 'utf-8')
      const m = consoleOut.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/)
      expect(m).not.toBeNull()
      // same instant, but formatted in local time (not the raw ISO 'T...Z')
      expect(m![1]).toBe(format(new Date(fileUtcMs), 'yyyy-MM-dd HH:mm:ss.SSS'))
      expect(consoleOut).not.toContain(fileEntry.time)
    })

    test("'local' — console shows the same local time-of-day as the file", async () => {
      // pino-pretty always prettifies the console timestamp (its own default format); for
      // 'local' we don't impose SYS translation, but the wall-clock time-of-day must still
      // line up with the local string the file stores (no accidental double-shift).
      createTestLogger(true, undefined, { time: 'local' })
      log.info('local-console')
      await sync()
      const fileEntry = data[0] as LogMessage
      const consoleOut = fs.readFileSync(stdoutObj.name, 'utf-8')
      const fileLocalTimeOfDay = fileEntry.time.split(' ')[1].slice(0, 12) // "HH:MM:ss.mmm"
      expect(consoleOut).toContain(fileLocalTimeOfDay)
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
