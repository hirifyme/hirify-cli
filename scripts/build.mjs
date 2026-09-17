import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { runProcess } from '../bin/lib/update.js'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json')))
const lock = JSON.parse(readFileSync(join(root, 'npm-shrinkwrap.json')))
const assert = (ok, message) => { if (!ok) throw Error(message) }
assert(pkg.name === 'hirify-cli' && pkg.bin.hirify === 'bin/hirify.js', 'Package and executable identity mismatch')
assert(pkg.version === lock.version && pkg.version === lock.packages[''].version && lock.name === pkg.name, 'Release metadata mismatch')
assert(JSON.stringify(pkg.dependencies) === JSON.stringify(lock.packages[''].dependencies), 'Dependencies differ from shrinkwrap')
assert(readFileSync(join(root, 'skills/hirify/SKILL.md')).length <= 8192, 'Skill exceeds 8192 bytes')
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) }
for (const file of files(join(root, 'bin')).filter(x => x.endsWith('.js'))) {
 const checked = await runProcess(process.execPath, ['--check', file]); assert(checked.code === 0, 'Syntax error: ' + file)
}
const out = join(root, '.artifacts'); mkdirSync(out, { recursive: true })
const packed = await runProcess('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], { cwd: root })
assert(packed.code === 0, 'npm pack failed')
const [info] = JSON.parse(packed.stdout)
const paths = info.files.map(f => f.path)
for (const path of paths) {
 assert(/^(bin\/|skills\/|README.md$|NOTICE$|LICENSE$|package.json$|npm-shrinkwrap.json$)/.test(path), 'Unexpected packaged path: ' + path)
 if (/\.(js|md|json)$/.test(path)) assert(!/\/home\/igora|CLAUDE\.md|eco mail/.test(readFileSync(join(root, path), 'utf8')), 'Internal information in artifact: ' + path)
}
for (const file of ['bin/lib/main.js', 'bin/lib/auth.js', 'npm-shrinkwrap.json', 'LICENSE', 'NOTICE']) assert(paths.includes(file), 'Missing runtime/license file: ' + file)
const git = await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'])
const tracked = await runProcess('git', ['-C', root, 'ls-files'])
for (const path of tracked.stdout.trim().split('\n')) assert(/^(bin\/|skills\/|scripts\/|\.github\/|README.md$|NOTICE$|LICENSE$|package.json$|npm-shrinkwrap.json$|\.gitignore$)/.test(path), 'Unexpected public repository path: ' + path)
const ancestry = await runProcess('git', ['-C', root, 'merge-base', '--is-ancestor', 'fce36993a7a7b23d8fcc7fa5c59b40d5ca1e495f', 'HEAD'])
assert(ancestry.code === 0, 'Candidate must descend from verified public history')
const dirty = await runProcess('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal'])
const manifest = { schema_version: 1, name: pkg.name, version: pkg.version, source_commit: git.stdout.trim(), source_dirty: Boolean(dirty.stdout.trim()), filename: info.filename, integrity: info.integrity, sha256: createHash('sha256').update(readFileSync(join(out, info.filename))).digest('hex'), files: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])) }
writeFileSync(join(out, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ version: pkg.version, files: paths.length, artifact: info.filename, source_dirty: manifest.source_dirty }))
