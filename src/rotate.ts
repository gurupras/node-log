import build from 'pino-abstract-transport'
import zlib from 'zlib'
import fs from 'fs'
import * as FileStreamRotator from 'file-stream-rotator'
import type { FileStreamRotatorOptions } from 'file-stream-rotator/lib/types';

export type RotateOpts = Omit<FileStreamRotatorOptions, 'frequency'> & {
  frequency: 'daily' | 'test',
  compress: boolean
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
  const out = FileStreamRotator.getStream(finalOpts)
  if (finalOpts.compress) {
    out.on('rotate', (oldFile) => {
      // TODO: Handle auditing
      const gzip = zlib.createGzip()
      const input = fs.createReadStream(oldFile)
      const output = fs.createWriteStream(`${oldFile}.gz`)
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
