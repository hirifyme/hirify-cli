// Publication is a separate, explicitly authorized operation. No skip switches.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { runProcess } from '../bin/lib/update.js'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fail = message => { throw Error('Publish stopped: ' + message) }
if (process.env.HIRIFY_PUBLISH_APPROVED !== '1') fail('explicit operator authorization is required')
const manifest = JSON.parse(readFileSync(join(root, '.artifacts/release-manifest.json')))
const receipt = JSON.parse(readFileSync(process.env.HIRIFY_RELEASE_RECEIPT || join(root, '.artifacts/acceptance.json')))
const head = await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'])
const status = await runProcess('git', ['-C', root, 'status', '--porcelain'])
const publicHead = await runProcess('git', ['-C', root, 'ls-remote', 'origin', 'refs/heads/main'])
if (status.stdout.trim() || manifest.source_dirty || manifest.source_commit !== head.stdout.trim() || publicHead.stdout.split(/\s/)[0] !== head.stdout.trim()) fail('clean source must match the built artifact and public main')
if (receipt.source_commit !== manifest.source_commit || receipt.sha256 !== manifest.sha256 || !['windows', 'macos', 'linux', 'browser', 'consent'].every(x => receipt.passed?.includes(x))) fail('missing artifact-specific platform/browser/consent acceptance')
if (createHash('sha256').update(readFileSync(join(root, '.artifacts', manifest.filename))).digest('hex') !== manifest.sha256) fail('artifact hash changed')
for (const [file, hash] of Object.entries(manifest.files)) if (createHash('sha256').update(readFileSync(join(root, file))).digest('hex') !== hash) fail('source differs from tested artifact: ' + file)
const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000)
try {
 const response = await fetch('https://api.github.com/repos/hirifyme/hirify-cli', { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hirify-release-check' } })
 if (!response.ok || (await response.json()).private !== false) fail('public repository visibility was not confirmed')
} finally { clearTimeout(timer) }
console.log('Publication checks passed. Publish the verified tarball, never rebuild it during release.')
