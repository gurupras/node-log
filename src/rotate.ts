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
    // Flush the old stream on rotation instead of destroy()-ing it, so the
    // last buffered chunk of the day's log is written to disk before we
    // compress it (file-stream-rotator defaults end_stream to false == destroy).
    end_stream: true,
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
      // Only compress a source that exists and has content. This makes the
      // handler idempotent: if 'rotate' fires again for an already-compressed
      // (and therefore unlinked) file -- e.g. overlapping processes sharing one
      // log dir, or a re-run rotation -- we skip instead of truncating the good
      // .gz to 0 bytes and losing the day's logs.
      let size: number
      try {
        size = fs.statSync(oldFile).size
      } catch {
        return // source gone -> nothing to compress
      }
      if (size === 0) {
        return // empty -> nothing worth compressing
      }

      // Compress to a temp file and only move it into place on success, so we
      // never clobber an existing good .gz and never leave a 0-byte one behind.
      const tmp = `${oldFile}.gz.tmp`
      const gzip = zlib.createGzip()
      const input = fs.createReadStream(oldFile)
      const output = fs.createWriteStream(tmp)
      // Every stream here is an EventEmitter, so an unhandled 'error' would
      // crash the transport worker. Swallow + log each stage and clean up the
      // partial temp file; the source .log is left untouched (recoverable).
      const onError = (stage: string) => (err: unknown) => {
        console.error(`[@gurupras/log/rotate] failed to compress ${oldFile} (${stage})`, err)
        fs.unlink(tmp, () => {})
      }
      input.on('error', onError('read'))
      gzip.on('error', onError('gzip'))
      output.on('error', onError('write'))
      input.pipe(gzip).pipe(output).on('finish', () => {
        // The compressed data is now fully written. Atomically move it into
        // place, then -- and only then -- remove the source.
        fs.rename(tmp, `${oldFile}.gz`, (renameErr) => {
          if (renameErr) {
            console.error(`[@gurupras/log/rotate] failed to finalize ${oldFile}.gz`, renameErr)
            fs.unlink(tmp, () => {})
            return
          }
          fs.unlink(oldFile, (err) => {
            if (err) {
              console.error(err)
            }
          })
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
