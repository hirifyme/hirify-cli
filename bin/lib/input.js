import { readFileSync, statSync } from 'node:fs'
import { CliError, aborted } from './errors.js'
const LIMIT = 1024 * 1024
async function readInput(path, signal) {
  aborted(signal)
  if (path !== '-') {
    try { if (!statSync(path).isFile() || statSync(path).size > LIMIT) throw new Error(); return readFileSync(path, 'utf8') }
    catch { throw new CliError('input_file', 'Could not read the input file. Use a regular UTF-8 file no larger than 1 MiB.') }
  }
  if (process.stdin.isTTY) throw new CliError('interaction_required', 'Pipe the input to stdin, or use a file path.')
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    const clean = () => { process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', error); signal?.removeEventListener('abort', cancel); process.stdin.pause() }
    const error = () => { clean(); reject(new CliError('input_file', 'Could not read standard input.')) }
    const data = chunk => { size += chunk.length; if (size > LIMIT) { clean(); reject(new CliError('input_too_large', 'Standard input exceeds 1 MiB.')) } else chunks.push(chunk) }
    const end = () => { clean(); resolve(Buffer.concat(chunks).toString('utf8')) }
    const cancel = () => { clean(); reject(signal.reason) }
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', error); signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}
export async function prepareInput(command, signal) {
  for (const [source, target] of [['data-file', 'data'], ['cover-file', 'cover']]) {
    if (command.values[source] !== undefined) {
      const text = await readInput(command.values[source], signal)
      if (target === 'data') {
        let data; try { data = JSON.parse(text) } catch { throw new CliError('invalid_arguments', 'The input file must contain a JSON object.') }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CliError('invalid_arguments', 'The input file must contain a JSON object.')
      }
      command.args = command.args.filter(v => !v.startsWith(`--${source}=`)); command.args.push(`--${target}=${text}`)
    }
  }
  if (command.name === 'auth' && command.values.stdin) command.words = [(await readInput('-', signal)).trim()]
  if (command.name === 'auth' && (!command.words[0]?.trim() || /[\r\n]/.test(command.words[0]))) throw new CliError('invalid_arguments', 'Provide one nonempty API key.')
}
