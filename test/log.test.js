import fs from 'fs'
import tmp, { file } from 'tmp'
import moment from 'moment'
import { Writable } from 'stream'
import { createLogger, initialize } from '../src/log'

const tag = 'test-tag'

describe('log', () => {
  let log
  let stream
  let data
  let stdoutObj
  let fileObj

  function createTestLogger (objectMode, extraFields) {
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
    await log.flush()
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
    let entry
    beforeEach(async () => {
      createTestLogger(true)
      log.info('test')
      await sync()
      entry = data[0]
    })
    test('Contains tag', async () => {
      expect(entry.tag).toEqual(tag)
    })
    test('Contains time', async () => {
      expect(moment(entry.time, 'YYYY-MM-DD hh:mm:ss.SSS ZZ').isValid()).toBeTrue()
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
      ['console', () => stdoutObj, () => createTestLogger(false), data => data.join('\n')],
      ['stream', () => fileObj, () => createTestLogger(true), data => JSON.stringify(data)]
    ])('Error stacks appear in %s', async (_, objFn, init, stringify) => {
      init()
      const timestamp = Date.now()
      const error = new Error(`Error at: ${timestamp}`)
      log.error('Failure: ', { err: error })
      await sync(objFn())
      const str = stringify(data)
      expect(str).toInclude(`Error at: ${timestamp}`)
      expect(str).toInclude('log.test.js:96')
      expect(str).toInclude('at Object.<anonymous>')
    })
  })

  describe('Object arguments', () => {
    const inputs = [
      ['Simple', { a: 1, b: 2, c: 3, d: [1, 2, 'test'] }],
      ['Complex', { a: 1, b: 2, c: 3, d: { a: 1, b: 2, c: 3 }, e: [1, 2, 'test', { e: 1 }] }]
    ]
    test.each(inputs)('%s object arguments show up in console', async (_, input) => {
      createTestLogger(false)
      const text = 'test log'
      log.info(text, input)
      await sync(stdoutObj, false)
      const str = data.join('\n')
      expect(str).toInclude(JSON.stringify(input).slice(1, -1))
    })

    test.each(inputs)('%s object arguments show up in stream', async (_, input) => {
      createTestLogger(true)
      const text = 'test log'
      log.info(text, input)
      await sync(fileObj, true)
      const [entry] = data
      const obj = JSON.parse(JSON.stringify(entry))
      expect(obj).toMatchObject(input)
    })
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
      createTestLogger(stdoutObj, extraFields)
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
      createTestLogger(fileObj, extraFields)
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
