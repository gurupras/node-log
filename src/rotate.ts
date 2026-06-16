import build from 'pino-abstract-transport'
import zlib from 'zlib'
import fs from 'fs'
import path from 'path'
import * as FileStreamRotator from 'file-stream-rotator'
import type { FileStreamRotatorOptions } from 'file-stream-rotator/lib/types.js'

export type RotateOpts = Omit<FileStreamRotatorOptions, 'frequency'> & {
  frequency: 'daily' | 'test',
  compress: boolean
}

// Best-effort, synchronous creation of the directory that will hold `file`.
// Used both up-front and during error recovery so a missing log directory can
// never crash the transport worker.
function ensureDirFor (file: string) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch (err) {
    console.error(`[@gurupras/log/rotate] failed to ensure log directory for ${file}`, err)
  }
}

export default async function (opts: RotateOpts) {
  const defaultOpts: RotateOpts = {
    filename: 'logs/log-%DATE%',
    frequency: 'daily',
    date_format: 'YYYY-MM-DD',
    audit_file: 'logs/audit.json',
    extension: '.log',
    create_symlink: false,
    compress: true
  }

  const finalOpts = Object.assign({}, defaultOpts, opts)

  // Make sure the log directory exists before the rotator opens its first stream.
  ensureDirFor(finalOpts.filename as string)

  const out = FileStreamRotator.getStream(finalOpts)

  // A transient filesystem error during rotation -- most commonly the log
  // directory disappearing at the rotation boundary (an external logrotate /
  // deploy, a removed mount) -- surfaces as an 'error' event on the rotating
  // stream: file-stream-rotator forwards the underlying write-stream error here
  // via its bubbleEvents() handler. With no listener, Node treats it as an
  // unhandled 'error' on an EventEmitter and throws, which kills the pino
  // transport worker and brings the entire process down. Handle it instead:
  // log it and best-effort recreate the directory so the next rotation recovers
  // rather than the app crashing.
  out.on('error', (err: NodeJS.ErrnoException) => {
    console.error('[@gurupras/log/rotate] log rotation stream error', err)
    ensureDirFor(err && err.path ? err.path : (finalOpts.filename as string))
  })

  if (finalOpts.compress) {
    out.on('rotate', (oldFile) => {
      // TODO: Handle auditing
      const gzip = zlib.createGzip()
      const input = fs.createReadStream(oldFile)
      const output = fs.createWriteStream(`${oldFile}.gz`)
      // Every stream in this pipeline is an EventEmitter, so an unhandled
      // 'error' (e.g. the old file already gone) would likewise crash the
      // transport worker. Swallow + log each stage.
      const onError = (stage: string) => (err: unknown) => {
        console.error(`[@gurupras/log/rotate] failed to compress ${oldFile} (${stage})`, err)
      }
      input.on('error', onError('read'))
      gzip.on('error', onError('gzip'))
      output.on('error', onError('write'))
      input.pipe(gzip).pipe(output).on('finish', () => {
        fs.unlink(oldFile, (err) => {
          if (err) {
            console.error(err)
          }
        })
      })
    })
  }

  return build(source => {
    source.on('data', data => {
      out.write(`${JSON.stringify(data)}\n`)
    })
    source.on('end', (data: any) => {
      out.end(data)
    })
  })
}
