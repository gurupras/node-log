import moment from 'moment'
import { Writable } from 'stream'
import { transports } from 'winston'
import { createLogger, Logger } from '../src/log'

const tag = 'test-tag'

describe('log', () => {
  let log
  let stream
  let data

  function createTestLogger (objectMode, extraFields) {
    stream = new Writable({
      write (chunk, _, next) {
        data.push(chunk)
        next()
      },
      objectMode
    })
    log = new Logger(tag, 'debug', createLogger({ stream }, transports.Stream), extraFields)
  }

  beforeEach(async () => {
    data = []
  })

  describe('Basic', () => {
    let entry
    beforeEach(() => {
      createTestLogger(true)
      log.info('test')
      entry = data[0]
    })
    test('Contains tag', async () => {
      expect(entry.tag).toEqual(tag)
    })
    test('Contains timestamp', async () => {
      expect(moment(entry.timestamp, 'YYYY-MM-DD hh:mm:ss.SSS ZZ').isValid()).toBeTrue()
    })
    test('Contains level', async () => {
      expect(entry.level).toEqual('info')
    })
    test('Contains message', async () => {
      expect(entry.message).toEqual('test')
    })
  })

  test.each([
    ['console', () => createTestLogger(false), data => data.join('\n')],
    ['stream', () => createTestLogger(true), data => JSON.stringify(data)]
  ])('Error stacks appear in %s', (_, init, stringify) => {
    init()
    const timestamp = Date.now()
    const error = new Error(`Error at: ${timestamp}`)
    log.error('Failure: ', error)
    const str = stringify(data)
    expect(str).toInclude(`Error at: ${timestamp}`)
    expect(str).toIncludeRepeated('at Object.<anonymous>', 1)
    expect(str).toIncludeRepeated('at Object.asyncJestTest', 1)
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
      const str = data.join('\n')
      expect(str).toInclude(JSON.stringify(input))
    })

    test.each(inputs)('%s object arguments show up in stream', async (_, input) => {
      createTestLogger(true)
      const text = 'test log'
      log.info(text, input)
      const [entry] = data
      const obj = JSON.parse(JSON.stringify(entry))
      expect(obj).toMatchObject(input)
    })
  })

  describe('Able to add extra fields', () => {
    const extraFields = {
      hostname: 'testHost',
      ip: '1.2.3.4',
      nested: {
        obj: 1
      },
      array: [1, 2, { c: 3, p: ['0'] }]
    }
    const input = { data: 'unique-string' }

    test('Fields show up in console', async () => {
      createTestLogger(false, extraFields)
      const text = 'test log'
      log.info(text, input)
      const str = data.join('\n')
      expect(str).toInclude('unique-string')
      for (const [k, v] of Object.entries({ ...input, ...extraFields })) {
        expect(str).toInclude(k)
        expect(str).toInclude(JSON.stringify(v))
      }
    })
    test('Fields show up in stream', async () => {
      createTestLogger(true, extraFields)
      const text = 'test log'
      log.info(text, input)
      const [entry] = data
      expect(entry).toMatchObject({
        message: text,
        level: 'info',
        tag,
        timestamp: expect.anything(),
        ...extraFields
      })
    })
  })
})
