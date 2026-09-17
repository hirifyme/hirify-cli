import { CliError, redact, safeText } from './errors.js'
const ARGUMENTS = { auth: '[<key>]', update: '[<version>]', 'vacancy search': '[<query>]', 'vacancy read': '<slug>', 'vacancy reveal': '<slug>', 'vacancy apply': '<slug>', 'feed show': '<id>', 'feed create': '<name>', 'feed deliver': '<id>', 'webhook create': '<name> <url>', 'feedback send': '<bug|feature> <title>', 'api call': '<capability>', 'capabilities show': '<capability>' }
const GLOBAL = ['json', 'fields', 'error-format', 'debug', 'timeout', 'help']
export const BOOLEAN_FLAGS = new Set(['json', 'debug', 'help', 'force', 'no-browser', 'stdin', 'telegram', 'no-telegram', 'no-webhook', 'check', 'rollback'])
export const COMMANDS = {
  intro: { args: [0, 0], description: 'what this can do, and in what order' },
  version: { args: [0, 0], description: 'installed version' },
  skill: { args: [0, 0], description: 'install the working rules for your agent' },
  login: { args: [0, 0], flags: ['force', 'no-browser', 'callback-port'], description: 'sign in through your browser' },
  logout: { args: [0, 0], description: 'sign out on this computer' },
  auth: { args: [0, 1], flags: ['stdin'], description: 'save an API key; use --stdin to keep it out of shell history' },
  'auth status': { args: [0, 0], description: 'show the local sign-in source without contacting the server' },
  doctor: { args: [0, 0], description: 'show local diagnostic information without credentials' },
  update: { args: [0, 1], flags: ['check', 'rollback'], description: 'check for an update or install an exact version' },
  'account show': { args: [0, 0], description: 'your plan and allowances' },
  'vacancy search': { args: [0, Infinity], flags: ['limit', 'page'], passthrough: true, description: 'search the board; server filter names are supported' },
  'vacancy read': { args: [1, 1], description: 'read one vacancy in full; uses a vacancy open' },
  'vacancy reveal': { args: [1, 1], description: 'get the contact or link to apply; uses a reveal' },
  'vacancy apply': { args: [1, 1], flags: ['profile', 'cover', 'cover-file'], description: 'send a real application; ask the person first' },
  'feed list': { args: [0, 0], description: 'your saved feeds' },
  'feed show': { args: [1, 1], flags: ['limit', 'page'], description: 'vacancies in a feed' },
  'feed create': { args: [1, 1], flags: ['filters', 'telegram', 'no-telegram', 'webhook'], description: 'save a search and its delivery settings' },
  'feed deliver': { args: [1, 1], flags: ['telegram', 'no-telegram', 'webhook', 'no-webhook'], description: 'change delivery settings' },
  'profile list': { args: [0, 0], description: 'profiles you can apply with' },
  'webhook list': { args: [0, 0], description: 'your delivery endpoints' },
  'webhook create': { args: [2, 2], description: 'create an endpoint: <name> <url>' },
  'filter guide': { args: [0, 0], description: 'supported search filters, from the server' },
  'feedback send': { args: [2, 2], flags: ['body', 'vacancy', 'idempotency-key'], description: 'send bug or feature feedback: <kind> <title> --body <text>' },
  'api call': { args: [1, 1], flags: ['data', 'data-file'], description: 'invoke a capability with a JSON object of inputs' },
  'capabilities list': { args: [0, 0], description: 'list the server capability catalogue' },
  'capabilities show': { args: [1, 1], description: 'show the inputs, effects and metering of a capability' },
}
export const CLI_ONLY = new Set([...GLOBAL, 'data-file', 'cover-file'])
export function tokenize(args) {
  const words = [], options = new Map(); let literal = false
  for (let i = 0; i < args.length; i++) {
    let word = args[i]
    if (literal) { words.push(word); continue }
    if (word === '--') { literal = true; continue }
    if (word === '-h') word = '--help'
    if (word === '--version') { words.push('version'); continue }
    if (!word.startsWith('--')) {
      if (word.startsWith('-') && word !== '-') throw new CliError('invalid_arguments', `Unknown option: ${word}. Use -- before a value beginning with a hyphen.`)
      words.push(word); continue
    }
    const at = word.indexOf('='); const name = word.slice(2, at < 0 ? undefined : at)
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) throw new CliError('invalid_arguments', 'Invalid option name.')
    let value
    if (BOOLEAN_FLAGS.has(name)) {
      if (at >= 0) throw new CliError('invalid_arguments', `--${name} does not take a value.`)
      value = true
    } else {
      value = at >= 0 ? word.slice(at + 1) : args[++i]
      if (value === undefined || (at < 0 && value.startsWith('-'))) throw new CliError('invalid_arguments', `--${name} requires a value. Use --${name}=<value> for a value beginning with a hyphen.`)
    }
    const values = options.get(name) || []; values.push(value); options.set(name, values)
  }
  return { words, options }
}
export const positional = args => tokenize(args).words
export const flag = (args, name) => tokenize(args).options.get(name.replace(/^--/, ''))?.[0] ?? null
export const options = args => new Map([...tokenize(args).options].map(([k, values]) => [k, values.join(',')]))
export function parse(argv) {
  // Help is resolved before parsing values, reading config or initializing effects.
  const boundary = argv.indexOf('--'); const before = boundary < 0 ? argv : argv.slice(0, boundary)
  if (!argv.length || before.some(x => ['--help', '-h'].includes(x)) || argv[0] === 'help') return { help: true, topic: argv.filter(x => !x.startsWith('-')).slice(0, 2).join(' ') }
  const parsed = tokenize(argv)
  let name = parsed.words[0]
  if (Object.hasOwn(COMMANDS, `${name} ${parsed.words[1]}`)) name += ` ${parsed.words[1]}`
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null
  if (!spec) {
    const verbs = Object.keys(COMMANDS).filter(x => x.startsWith(`${name} `)).map(x => x.split(' ')[1])
    throw new CliError('invalid_arguments', verbs.length ? `${parsed.words[1] ? `hirify ${name} has no verb "${parsed.words[1]}".\n` : ''}hirify ${name} takes a verb: ${verbs.join(', ')}` : `unknown command: ${name}. Run hirify --help.`)
  }
  const words = parsed.words.slice(name.split(' ').length)
  if (words.length < spec.args[0] || words.length > spec.args[1]) throw new CliError('invalid_arguments', `hirify ${name} needs ${spec.args[0] === spec.args[1] ? spec.args[0] : `${spec.args[0]} to ${spec.args[1]}`} argument(s). Run hirify ${name} --help.`)
  const known = new Set([...GLOBAL, ...(spec.flags || [])])
  for (const [key, values] of parsed.options) {
    if (!known.has(key) && !spec.passthrough) throw new CliError('invalid_arguments', `Unknown option for ${name}: --${key}.`)
    if (known.has(key) && values.length > 1) throw new CliError('invalid_arguments', `--${key} can be given only once.`)
  }
  const value = key => parsed.options.get(key)?.[0]
  for (const [a, b] of [['telegram', 'no-telegram'], ['webhook', 'no-webhook'], ['cover', 'cover-file'], ['data', 'data-file']]) if (parsed.options.has(a) && parsed.options.has(b)) throw new CliError('invalid_arguments', `Choose either --${a} or --${b}.`)
  for (const key of ['limit', 'page', 'profile', 'webhook', 'callback-port', 'timeout']) {
    if (value(key) !== undefined && (!/^\d+$/.test(value(key)) || !Number.isSafeInteger(Number(value(key))) || Number(value(key)) < 1 || (key === 'callback-port' && Number(value(key)) > 65535) || (key === 'timeout' && Number(value(key)) > 3600))) throw new CliError('invalid_arguments', `--${key} requires a positive whole number${key === 'callback-port' ? ' up to 65535' : ''}.`)
  }
  for (const key of ['filters', 'data']) if (value(key) !== undefined) {
    let obj; try { obj = JSON.parse(value(key)) } catch { throw new CliError('invalid_arguments', `--${key} expects JSON.`) }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new CliError('invalid_arguments', `--${key} expects a JSON object.`)
  }
  if (value('error-format') && !['json', 'text'].includes(value('error-format'))) throw new CliError('invalid_arguments', '--error-format must be json or text.')
  if (name === 'update' && value('rollback') && (words.length || value('check'))) throw new CliError('invalid_arguments', 'Use --rollback by itself.')
  if (name === 'auth' && Boolean(words.length) === Boolean(value('stdin'))) throw new CliError('invalid_arguments', 'Use hirify auth <key> or hirify auth --stdin.')
  if (name === 'feedback send' && (!['bug', 'feature'].includes(words[0]) || !value('body'))) throw new CliError('invalid_arguments', 'Use hirify feedback send bug|feature <title> --body <text>.')
  const args = [...parsed.options].flatMap(([key, values]) => values.map(v => v === true ? `--${key}` : `--${key}=${v}`))
  return { name, words, args, values: Object.fromEntries([...parsed.options].map(([k, v]) => [k, v[0]])), json: Boolean(value('json')), errorJSON: value('error-format') === 'json', timeout: Number(value('timeout') || (name === 'login' ? 360 : name === 'update' ? 300 : 30)) * 1000 }
}
export function help(topic = '') {
  const entries = Object.entries(COMMANDS).filter(([name]) => !topic || name === topic || name.startsWith(topic + ' '))
  return `hirify - job search for AI agents\n\n${(entries.length ? entries : Object.entries(COMMANDS)).map(([name, spec]) => `  hirify ${(name + (ARGUMENTS[name] ? ' ' + ARGUMENTS[name] : '')).padEnd(35)} ${spec.description}${spec.flags?.length ? `\n    ${spec.flags.map(f => '--' + f + (BOOLEAN_FLAGS.has(f) ? '' : ' <value>')).join('  ')}` : ''}`).join('\n')}\n\nGlobal options: --json, --fields a,b, --error-format json|text, --timeout <seconds>, --debug, --help.\nUse -- to end options; --name=value and --name value are supported.\nLists and search are free. Vacancy read, reveal and apply have separate allowances.\nCheck them with hirify account show. Apply sends a real application: ask the person first.\nHeadless/CI: HIRIFY_KEY or hirify auth --stdin. Manual login: --no-browser.\nSSH: forward the chosen --callback-port to the same loopback port on the CLI host.\nRules for your agent: npx skills add hirifyme/hirify-cli\n`
}
export function createOutput({ stdout = process.stdout, stderr = process.stderr, json = false, errorJSON = false, secrets = new Set() } = {}) {
  let closed = false
  const errors = []
  const onError = error => { if (error.code === 'EPIPE') closed = true; else errors.push(error) }
  stdout.on('error', onError); stderr.on('error', onError)
  const write = (stream, value, secret = false) => { if (!closed) stream.write((secret ? safeText(value) : redact(value, [...secrets])) + '\n') }
  const output = {
    jsonMode: json, errorJSON,
    console: { log: (...v) => write(stdout, v.map(String).join(' ')), error: (...v) => write(stderr, v.map(String).join(' ')) },
    json: value => { if (!closed) stdout.write(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item, [...secrets], false) : item, 2) + '\n') },
    dispose: () => { stdout.off('error', onError); stderr.off('error', onError) },
    progress: (value, { secret = false } = {}) => write(stderr, value, secret),
    error: error => {
      const e = error instanceof CliError ? error : new CliError('internal_error', 'The command could not complete. Run hirify doctor and include its output when contacting support.')
      const payload = { schema_version: 1, error: { code: e.code, message: redact(e.message, [...secrets]), retryable: e.retryable, ...(e.status ? { status: e.status } : {}), ...(e.requestId ? { request_id: safeText(e.requestId).slice(0, 128) } : {}) } }
      write(stderr, errorJSON ? JSON.stringify(payload) : `hirify: ${payload.error.message}`)
      return e.exitCode
    },
    flush: async () => { if (!closed) await Promise.all([stdout, stderr].map(stream => new Promise(resolve => stream.write('', resolve)))); if (errors.length) throw errors[0] },
  }
  return output
}
