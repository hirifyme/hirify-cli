import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { runProcess } from '../bin/lib/update.js'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifacts = resolve(process.argv[2] || join(root, '.artifacts'))
const manifest = JSON.parse(readFileSync(join(artifacts, 'release-manifest.json')))
const tarball = join(artifacts, manifest.filename)
if (createHash('sha256').update(readFileSync(tarball)).digest('hex') !== manifest.sha256) throw Error('Artifact hash mismatch')
const dir = mkdtempSync(join(tmpdir(), 'hirify package '))
const prefix = join(dir, 'prefix with spaces')
let keep = false
try {
 const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), HIRIFY_NO_AUTO_UPDATE: '1', HIRIFY_API: 'http://127.0.0.1:1', HIRIFY_KEY: '', HIRIFY_VERSION_PIN: '' }
 const installed = await runProcess('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], { env, timeout: 180000 })
 if (installed.code !== 0) throw Error('Isolated npm install failed: ' + installed.stderr)
 const npmRoot = await runProcess('npm', ['root', '--global', '--prefix', prefix], { env })
 const installedRoot = join(npmRoot.stdout.trim(), 'hirify-cli')
 for (const [file, hash] of Object.entries(manifest.files)) if (createHash('sha256').update(readFileSync(join(installedRoot, file))).digest('hex') !== hash) throw Error('Installed file differs: ' + file)
 const executable = process.platform === 'win32' ? join(prefix, 'hirify.cmd') : join(prefix, 'bin', 'hirify')
 for (const args of [['version'], ['--help'], ['auth', 'status', '--json'], ['doctor']]) {
  const res = await runProcess(executable, args, { env })
  if (res.code !== 0) throw Error('Installed command failed: ' + args.join(' ') + '\n' + res.stderr)
  if (args[0] === 'version' && res.stdout.trim() !== manifest.version) throw Error('Installed version differs')
 }
 if (process.env.GITHUB_ENV) {
  writeFileSync(process.env.GITHUB_ENV, `HIRIFY_TEST_CLI=${join(installedRoot, 'bin', 'hirify.js')}\nHIRIFY_TEST_PREFIX=${dir}\n`, { flag: 'a' }); keep = true
 }
 console.log(JSON.stringify({ installed: manifest.version, platform: process.platform, shim: 'passed', verified_files: Object.keys(manifest.files).length }))
} finally { if (!keep) rmSync(dir, { recursive: true, force: true }) }
