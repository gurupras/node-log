import fs from 'fs'
import tmp from 'tmp'
import { Writable } from 'stream'
import { createLogger, initialize } from '../src/log'
import type { Logger } from '../src/log'
import { describe, test, beforeEach, afterEach, expect } from 'vitest'
import { parse } from 'date-fns'

const tag = 'test-tag'

describe('log', () => {
  let log: Logger
  let stream: Writable
  let data: (Record<string, any> | string)[]
  let stdoutObj: ReturnType<typeof tmp.fileSync>
  let fileObj: ReturnType<typeof tmp.fileSync>

  function createTestLogger (objectMode: boolean, extraFields?: any) {
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
      }
    })
    log = createLogger(tag, extraFields)
  }

  async function sync (tmpObj = fileObj, objectMode = true) {
    log.flush()
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
      console.log(entry.time)
      expect(() => parse(entry.time, 'yyyy-MM-dd hh:mm:ss.SSS xxxx', new Date())).not.toThrow()
    })
    test('Contains levelLabel', async () => {
      expect(entry.levelLabel).toEqual('info')
    })
    test('Contains msg', async () => {
      debugger
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