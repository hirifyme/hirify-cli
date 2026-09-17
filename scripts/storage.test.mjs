import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createStore } from '../bin/lib/store.js'
import { runProcess } from '../bin/lib/update.js'
const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'hirify storage ')); dirs.push(dir); return { dir, api: 'https://api.example.test' } }
test('Windows credential ACL is current-user-only even without PowerShell modules', { skip: process.platform !== 'win32' }, async () => {
 const config = fixture()
 const code = `import {createStore} from ${JSON.stringify(new URL('../bin/lib/store.js', import.meta.url).href)}; const s=createStore(${JSON.stringify(config)}); await s.commit({kind:'key',access_token:'synthetic'}); await s.commit({kind:'key',access_token:'replacement'});`
 const env = { ...process.env, PSModulePath: join(config.dir, 'no-modules'), HIRIFY_ACL_DIR: config.dir }
 const saved = await runProcess(process.execPath, ['--input-type=module', '-e', code], { env })
 assert.equal(saved.code, 0, saved.stderr)
 const inspect = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $p=$env:HIRIFY_ACL_DIR; foreach($acl in @([System.IO.Directory]::GetAccessControl($p),[System.IO.File]::GetAccessControl([System.IO.Path]::Combine($p,'auth.json')))) {if(!$acl.AreAccessRulesProtected){throw 'Inheritance enabled'};if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Wrong owner'};$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);if($rules.Count -ne 1){throw 'Unexpected access rule'};foreach($rule in $rules){if($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'Unexpected access'}}};[Console]::WriteLine('private')`
 const checked = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inspect, 'utf16le').toString('base64')], { env })
 assert.equal(checked.code, 0, checked.stderr); assert.equal(checked.stdout.trim(), 'private')
})
test('stale writer lock can be recovered without reading a half-written credential', async () => {
 const config = fixture(); const store = createStore(config); await store.commit({ kind: 'key', access_token: 'original' })
 const lock = join(config.dir, '.session.lock'); mkdirSync(lock); const old = new Date(Date.now() - 180000); utimesSync(lock, old, old)
 await store.commit({ kind: 'key', access_token: 'replacement' }); assert.equal(store.read().access_token, 'replacement')
})
test('late login cannot restore credentials after logout', async () => {
 const config = fixture(); const store = createStore(config); const generation = await store.beginLogin()
 await store.logout(); await assert.rejects(store.commit({ kind: 'key', access_token: 'late' }, generation), { code: 'session_changed' }); assert.equal(store.read(), null)
})
test('disk failure before rename keeps the previous credential and removes the partial file', async () => {
 const config = fixture(); const store = createStore(config); await store.commit({ kind: 'key', access_token: 'original' })
 const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {createStore} from ${JSON.stringify(new URL('../bin/lib/store.js', import.meta.url).href)}; fs.renameSync=()=>{const e=new Error('synthetic disk failure');e.code='ENOSPC';throw e};syncBuiltinESMExports();try{await createStore(${JSON.stringify(config)}).commit({kind:'key',access_token:'replacement'})}catch(e){if(e.code==='storage_write_failed')process.exitCode=7;else throw e}`
 const r = await runProcess(process.execPath, ['--input-type=module', '-e', code]); assert.equal(r.code, 7, r.stderr); assert.equal(store.read().access_token, 'original'); assert.ok(!readdirSync(config.dir).some(x => x.endsWith('.tmp')))
})
test('crashed refresh writer leaves an explicit uncertain state, never replays its old token', async () => {
 const config = fixture(); const store = createStore(config); await store.commit({ kind: 'oauth', client_id: 'test', access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 1 })
 const moduleURL = new URL('../bin/lib/store.js', import.meta.url).href
 const code = `import {createStore} from ${JSON.stringify(moduleURL)}; const s=createStore(${JSON.stringify(config)});await s.locked(async()=>{await s.write({...s.readRaw(),refresh_pending:true});console.log('pending');await new Promise(()=>{})})`
 const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', x => stderr += x)
 const closed = new Promise(resolve => child.once('close', resolve))
 await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('writer did not reach pending state: ' + stderr)) }, 30000); child.stdout.once('data', () => { clearTimeout(timer); resolve() }) })
 child.kill('SIGKILL'); await closed
 assert.equal(JSON.parse(readFileSync(store.file)).refresh_pending, true); assert.throws(() => store.read(), { code: 'refresh_uncertain' })
})
