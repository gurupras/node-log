import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// Holder for the fake rotating stream, referenced from inside the (hoisted) mock.
const hoisted = vi.hoisted(() => ({ out: null as any }))

vi.mock('file-stream-rotator', () => ({
  getStream: () => hoisted.out
}))

// Imported after the mock is registered.
import rotate from '../src/rotate.js'

// A controllable stand-in for file-stream-rotator's FileStreamRotator, which is
// an EventEmitter that forwards underlying write-stream errors via 'error'.
class FakeRotator extends EventEmitter {
  written: string[] = []
  ended = false
  write (str: string) { this.written.push(str) }
  end () { this.ended = true }
}

describe('rotate transport error handling', () => {
  let tmpDir: string
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    hoisted.out = new FakeRotator()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-test-'))
    // The transport reports rotation errors via console.error. These tests trigger those
    // errors deliberately, so let the spy capture the report rather than printing it —
    // stderr noise from a passing test is indistinguishable from a real failure.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  test('creates the log directory up front', async () => {
    const logDir = path.join(tmpDir, 'logs')
    expect(fs.existsSync(logDir)).toBe(false)
    await rotate({ filename: path.join(logDir, '%DATE%'), frequency: 'daily', compress: false } as any)
    expect(fs.existsSync(logDir)).toBe(true)
  })

  test('does not crash when the rotating stream emits an error', async () => {
    await rotate({ filename: path.join(tmpDir, 'logs', '%DATE%'), frequency: 'daily', compress: false } as any)
    // An EventEmitter with no 'error' listener throws on emit. With the fix a
    // listener is attached, so this must not throw.
    const err = Object.assign(new Error('boom'), { code: 'EACCES' })
    expect(() => hoisted.out.emit('error', err)).not.toThrow()
    // Handled means reported, not swallowed.
    expect(errorSpy).toHaveBeenCalledWith('[@gurupras/log/rotate] log rotation stream error', err)
  })

  test('recreates the log directory on an ENOENT during rotation', async () => {
    const logDir = path.join(tmpDir, 'logs')
    const missingFile = path.join(logDir, '2026-06-07.log')
    await rotate({ filename: path.join(logDir, '%DATE%'), frequency: 'daily', compress: false } as any)

    // Simulate the directory disappearing at the rotation boundary.
    fs.rmSync(logDir, { recursive: true, force: true })
    expect(fs.existsSync(logDir)).toBe(false)

    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: missingFile })
    expect(() => hoisted.out.emit('error', err)).not.toThrow()
    expect(fs.existsSync(logDir)).toBe(true)
    expect(errorSpy).toHaveBeenCalledWith('[@gurupras/log/rotate] log rotation stream error', err)
  })

  test('compress pipeline errors on a missing old file do not crash', async () => {
    await rotate({ filename: path.join(tmpDir, 'logs', '%DATE%'), frequency: 'daily', compress: true } as any)

    const missingOldFile = path.join(tmpDir, 'logs', 'does-not-exist.log')
    expect(() => hoisted.out.emit('rotate', missingOldFile)).not.toThrow()
    // Let the asynchronous read-stream 'error' fire; it must be handled, not thrown.
    await new Promise(resolve => setTimeout(resolve, 50))
  })

  test('compress is non-destructive and idempotent (re-rotate must not lose data)', async () => {
    const logDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const oldFile = path.join(logDir, '2026-06-17.log')
    fs.writeFileSync(oldFile, 'real log data\n'.repeat(500))

    await rotate({ filename: path.join(logDir, '%DATE%'), frequency: 'daily', compress: true } as any)

    // First rotation: compresses + removes the source.
    hoisted.out.emit('rotate', oldFile)
    await new Promise(resolve => setTimeout(resolve, 80))
    const gz = `${oldFile}.gz`
    expect(fs.existsSync(gz)).toBe(true)
    const goodSize = fs.statSync(gz).size
    expect(goodSize).toBeGreaterThan(0)
    expect(fs.existsSync(oldFile)).toBe(false)

    // Second rotation for the SAME (already-compressed, unlinked) file must be
    // a no-op -- the good .gz must survive, NOT get truncated to 0 bytes.
    expect(() => hoisted.out.emit('rotate', oldFile)).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(fs.existsSync(gz)).toBe(true)
    expect(fs.statSync(gz).size).toBe(goodSize)
  })

  test('compress skips empty source files (no .gz, no error)', async () => {
    const logDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const emptyFile = path.join(logDir, '2026-06-18.log')
    fs.writeFileSync(emptyFile, '')

    await rotate({ filename: path.join(logDir, '%DATE%'), frequency: 'daily', compress: true } as any)
    expect(() => hoisted.out.emit('rotate', emptyFile)).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fs.existsSync(`${emptyFile}.gz`)).toBe(false)
  })
})
