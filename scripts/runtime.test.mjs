import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { parse, COMMANDS } from '../bin/lib/cli.js'
import { createStore } from '../bin/lib/store.js'
import { validateManifest } from '../bin/lib/api.js'
import { tokenResponse } from '../bin/lib/auth.js'
import { startCallbackServer } from '../bin/lib/loopback.js'
import { createHttp, retryDelay } from '../bin/lib/http.js'
import { environment, openBrowser } from '../bin/lib/browser.js'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = process.env.HIRIFY_TEST_CLI || join(ROOT, 'bin/hirify.js')
const temps = []
function temp() { const path = mkdtempSync(join(tmpdir(), 'hirify-runtime-')); temps.push(path); return path }
after(() => { for (const path of temps) rmSync(path, { recursive: true, force: true }) })
const cleanEnv = { ...process.env, HIRIFY_KEY: '', HIRIFY_API: 'http://127.0.0.1:1', HIRIFY_NO_AUTO_UPDATE: '1', HIRIFY_DEBUG: '', HIRIFY_INTERNAL_REEXEC: '', HIRIFY_VERSION_PIN: '', SSH_CONNECTION: '', SSH_TTY: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '', NODE_OPTIONS: '', NODE_TLS_REJECT_UNAUTHORIZED: '1' }
function launch(args, { api, cfg = temp(), key = '', env = {}, nodeArgs = [], input, observe, timeout = process.platform === 'win32' ? 60000 : 10000 } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, CLI, ...args], { env: { ...cleanEnv, XDG_CONFIG_HOME: cfg, ...(api ? { HIRIFY_API: api } : {}), HIRIFY_KEY: key, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', killed = false
  child.stdout.on('data', v => { stdout += v; observe?.(stdout, stderr, child) })
  child.stderr.on('data', v => { stderr += v; observe?.(stdout, stderr, child) })
  child.stdin.end(input)
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, timeout)
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, killed }) }) })
  return { child, done, cfg }
}
const run = (args, opts) => launch(args, opts).done
function json(res, body, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
async function server(handler) {
  const requests = []
  const http = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; requests.push({ method: req.method, url: req.url, headers: req.headers, body }); try { await handler(req, res, body) } catch { res.destroy() } })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return { http, requests, url: `http://127.0.0.1:${http.address().port}`, close: () => new Promise(resolve => { http.closeAllConnections(); http.close(resolve) }) }
}
const caps = [ ['account.status','GET','/account'], ['feeds.list','GET','/feeds'], ['vacancies.search','GET','/search'], ['applications.apply','POST','/apply/{slug}'] ]
function manifest(rows = caps) { return { schema_version: 1, capabilities: rows.map(([id, method, path]) => ({ id, method, path, meter: 'none' })) } }
async function apiFixture(reply, { document = manifest(), discovery } = {}) {
  let s
  s = await server((req, res, body) => {
    if (req.url === '/.well-known/hirify-agent') return json(res, discovery || { manifest_url: `${s.url}/meta` })
    if (req.url === '/meta') return json(res, typeof document === 'function' ? document() : document)
    return reply(req, res, body)
  }); return s
}
function authFile(cfg, state) { mkdirSync(join(cfg, 'hirify'), { recursive: true }); writeFileSync(join(cfg, 'hirify/auth.json'), JSON.stringify(state), { mode: 0o600 }) }
function state(cfg) { return JSON.parse(readFileSync(join(cfg, 'hirify/auth.json'), 'utf8')) }
function oauth(issuer, extra = {}) { return { kind: 'oauth', issuer, access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', client_id: 'synthetic-client', token_endpoint: issuer + '/token', expires_at: 1, ...extra } }

for (const name of Object.keys(COMMANDS)) test(`help is inert: ${name}`, async () => {
  const cfg = temp(); const path = join(cfg, 'hirify/auth.json'); authFile(cfg, { kind: 'key', access_token: 'synthetic-secret' }); const before = readFileSync(path, 'utf8')
  const r = await run([...name.split(' '), '--help'], { cfg, env: { XDG_CONFIG_HOME: 'deliberately-relative', HIRIFY_API: 'not a URL', HIRIFY_NO_AUTO_UPDATE: '' } })
  assert.equal(r.code, 0, r.stderr); assert.equal(readFileSync(path, 'utf8'), before); assert.match(r.stdout, /hirify/)
})
test('parser accepts equals, --, flags before verbs and search passthrough without losing words', () => {
  assert.deepEqual(parse(['vacancy', 'search', '--limit=2', 'golang']).words, ['golang'])
  assert.deepEqual(parse(['vacancy', 'search', '--', '--literal']).words, ['--literal'])
  assert.equal(parse(['--json', 'feed', '--page=2', 'show', '7']).name, 'feed show')
  assert.deepEqual(parse(['vacancy', 'search', '--future-filter', 'one', '--future-filter=two', 'go']).words, ['go'])
})
for (const args of [ ['feed','deliver','1'], ['auth',''], ['account','show','--error-format='], ['vacancy','apply','demo','--cover','--json'], ['feed','create','demo','--filters','[]'], ['feed','deliver','7','--telegram','--no-telegram'], ['auth','--stdin','key'], ['toString'], ['constructor'], ['feed','list','--typo'], ['account','show','extra'], ['vacancy','apply','demo','--profile=9007199254740993'] ]) test(`malformed arguments have no network effects: ${args.join(' ')}`, async () => {
  const s = await apiFixture((_, res) => json(res, { data: [] }))
  try { const r = await run([...args, '--error-format=json'], { api: s.url, key: 'synthetic' }); assert.equal(r.code, 1); assert.equal(JSON.parse(r.stderr).error.code, 'invalid_arguments'); assert.equal(s.requests.length, 0) } finally { await s.close() }
})
test('search sends the exact phrase with equals and literal separator', async () => {
  const s = await apiFixture((_, res) => json(res, { data: [] }))
  try { assert.equal((await run(['vacancy','search','--limit=2','golang'], { api: s.url, key: 'synthetic' })).code, 0); assert.match(s.requests.at(-1).url, /search=golang/); assert.match(s.requests.at(-1).url, /per_page=2/) } finally { await s.close() }
})
for (const malformed of [null, {}, {data:null}, {data:[]}, {data:{}}]) test(`apply cannot invent success for ${JSON.stringify(malformed)}`, async () => {
  const s = await apiFixture((_, res) => json(res, malformed, 201))
  try { const r = await run(['vacancy','apply','demo','--error-format=json'], { api:s.url, key:'synthetic' }); assert.equal(r.code, 1); assert.equal(JSON.parse(r.stderr).error.code, 'outcome_unknown'); assert.doesNotMatch(r.stdout,/Applied/); assert.equal(s.requests.filter(x=>x.method==='POST').length,1) } finally { await s.close() }
})
test('HTML success fails and HTML generic refusal stays a documented raw response', async () => {
  const s = await apiFixture((_, res) => { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<html>error</html>') })
  try { const r = await run(['feed','list','--json','--error-format=json'], {api:s.url,key:'synthetic'}); assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'protocol_error');assert.equal(r.stdout,'') } finally { await s.close() }
})
test('manifest remains one immutable snapshot even if the server changes method', async () => {
  let reads=0;const s=await apiFixture((_,res)=>json(res,{data:{}}),{document:()=>manifest([['test.op',++reads===1?'GET':'POST',reads===1?'/read':'/write']])})
  try {const r=await run(['api','call','test.op','--data={"v":"x"}','--json'],{api:s.url,key:'synthetic'});assert.equal(r.code,0,r.stderr);assert.equal(reads,1);assert.equal(s.requests.at(-1).method,'GET');assert.match(s.requests.at(-1).url,/\/read\?v=x/)}finally{await s.close()}
})
test('schema v1 empty input maps serialized as arrays do not block account reads or catalogue', async () => {
 const document = manifest([['account.status','GET','/account']])
 document.capabilities[0].inputs = { schema: { type: 'object', properties: [], additionalProperties: false }, locations: [] }
 const s = await apiFixture((_, res) => json(res, { data: { plan: 'test' } }), { document })
 try {
  const account = await run(['account','show','--json'], { api: s.url, key: 'synthetic' })
  assert.equal(account.code, 0, account.stderr); assert.equal(JSON.parse(account.stdout).data.plan, 'test')
  const catalogue = await run(['capabilities','list','--json'], { api: s.url, key: 'synthetic' })
  assert.equal(catalogue.code, 0, catalogue.stderr); assert.match(catalogue.stdout, /account.status/)
 } finally { await s.close() }
})
for (const locations of [null, ['query'], [{ name: 'query' }], { name: 'header' }]) test(`nonempty invalid input locations are refused: ${JSON.stringify(locations)}`, () => {
 const document = manifest(); document.capabilities[0].inputs = { locations }
 assert.throws(() => validateManifest(document, 'https://api.example.test'), { code: 'manifest_invalid' })
})
for (const doc of [{schema_version:-1,capabilities:[]},{schema_version:1.5,capabilities:[]},manifest([['a','GET','//evil.test/path']]),manifest([['a','PUT','/a'],['a','GET','/b']]),manifest([['a','get','/a']])]) test('invalid manifest routing is refused',()=>assert.throws(()=>validateManifest(doc,'https://api.example'),{name:'CliError'}))
test('cross-origin manifest never receives credentials',async()=>{
  const foreign=await server((_,res)=>json(res,manifest()));const s=await apiFixture((_,res)=>json(res,{}),{discovery:{manifest_url:foreign.url+'/meta'}})
  try{const r=await run(['account','show','--error-format=json'],{api:s.url,key:'synthetic'});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'untrusted_url');assert.equal(foreign.requests.length,0)}finally{await s.close();await foreign.close()}
})
test('stored issuer mismatch is rejected before sending any bearer',async()=>{
  const cfg=temp();authFile(cfg,oauth('https://production.example',{expires_at:9999999999}));const s=await apiFixture((_,res)=>json(res,{data:{}}))
  try{const r=await run(['account','show','--error-format=json'],{api:s.url,cfg});assert.equal(JSON.parse(r.stderr).error.code,'issuer_mismatch');assert.ok(s.requests.every(q=>!q.headers.authorization))}finally{await s.close()}
})
test('corrupt new state does not fall back to a legacy key',async()=>{
  const cfg=temp();authFile(cfg,{kind:'key',access_token:'new'});writeFileSync(join(cfg,'hirify/auth.json'),'{');writeFileSync(join(cfg,'hirify/key'),'old-synthetic');const r=await run(['auth','status','--error-format=json'],{cfg});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'state_corrupt')
})
test('auth stdin keeps secrets out of output and repairs existing POSIX mode',async()=>{
  const cfg=temp();authFile(cfg,{kind:'key',access_token:'old'});chmodSync(join(cfg,'hirify/auth.json'),0o644)
  const r=await run(['auth','--stdin','--json'],{cfg,input:'synthetic-private-canary\n'});assert.equal(r.code,0,r.stderr);assert.doesNotMatch(r.stdout+r.stderr,/synthetic-private-canary/);assert.equal(state(cfg).access_token,'synthetic-private-canary');if(process.platform!=='win32'){assert.equal(statSync(join(cfg,'hirify/auth.json')).mode&0o777,0o600);assert.equal(statSync(join(cfg,'hirify')).mode&0o777,0o700)}
})
test('forced login and logout can replace a corrupt state without using legacy credentials',async()=>{
  const cfg=temp();authFile(cfg,{kind:'key',access_token:'old'});writeFileSync(join(cfg,'hirify/auth.json'),'{');const r=await run(['logout','--json'],{cfg});assert.equal(r.code,0,r.stderr);assert.equal(state(cfg).kind,'signed-out')
})
test('symlink credential target is refused and unchanged', {skip:process.platform==='win32'}, async()=>{
  const cfg=temp();mkdirSync(join(cfg,'hirify'));const target=join(cfg,'target');writeFileSync(target,'private');symlinkSync(target,join(cfg,'hirify/auth.json'));const r=await run(['auth','key','--error-format=json'],{cfg});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'unsafe_storage');assert.equal(readFileSync(target,'utf8'),'private')
})
test('twenty processes share one rotating refresh transaction', {timeout:process.platform === 'win32' ? 180000 : 60000}, async()=>{
  let renewals=0;const s=await apiFixture(async(req,res)=>{if(req.url==='/token'){renewals++;await new Promise(r=>setTimeout(r,100));return json(res,{access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,token_type:'Bearer'})}json(res,{data:{plan:'test'}})})
  const cfg=temp();authFile(cfg,oauth(s.url))
  try{const results=await Promise.all(Array.from({length:20},()=>run(['account','show','--json'],{api:s.url,cfg,timeout:45000})));for(const r of results)assert.equal(r.code,0,r.stderr);assert.equal(renewals,1);assert.equal(state(cfg).refresh_token,'new-refresh')}finally{await s.close()}
})
test('logout wins over an in-flight refresh and leaves a generation tombstone',async()=>{
  let started;const first=new Promise(r=>started=r);const s=await apiFixture(async(req,res)=>{if(req.url==='/token'){started();await new Promise(r=>setTimeout(r,250));return json(res,{access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,token_type:'Bearer'})}json(res,{data:{plan:'test'}})})
  const cfg=temp();authFile(cfg,oauth(s.url))
  try{const reading=run(['account','show'],{api:s.url,cfg});await Promise.race([first,reading.then(r=>{throw Error('Reader exited before refresh: '+r.stderr)})]);const logout=await run(['logout'],{api:s.url,cfg});await reading;assert.equal(logout.code,0,logout.stderr);assert.equal(state(cfg).kind,'signed-out');assert.ok(state(cfg).generation)}finally{await s.close()}
})
test('lost refresh response is not replayed by the next process',async()=>{
  let count=0;const s=await apiFixture((req,res)=>{if(req.url==='/token'){count++;return req.socket.destroy()}json(res,{data:{}})});const cfg=temp();authFile(cfg,oauth(s.url))
  try{for(let i=0;i<2;i++){const r=await run(['account','show','--error-format=json'],{api:s.url,cfg});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'refresh_uncertain')}assert.equal(count,1)}finally{await s.close()}
})
test('redirect from token endpoint cannot forward the refresh body',async()=>{
  const foreign=await server((_,res)=>json(res,{}));const s=await apiFixture((req,res)=>{if(req.url==='/token'){res.writeHead(307,{Location:foreign.url+'/token'});return res.end()}json(res,{data:{}})});const cfg=temp();authFile(cfg,oauth(s.url))
  try{const r=await run(['account','show'],{api:s.url,cfg});assert.equal(r.code,1);assert.equal(foreign.requests.length,0)}finally{await s.close();await foreign.close()}
})
async function loginFixture({observe,accountFailure=false}={}){
  const cfg=temp();let pkce=false,callback,nonce,verifierChallenge;const s=await server((req,res,body)=>{
    if(req.url==='/.well-known/oauth-authorization-server')return json(res,{issuer:s.url,authorization_endpoint:s.url+'/authorize',registration_endpoint:s.url+'/register',token_endpoint:s.url+'/token',scopes_supported:['agent:read','offline_access','unrelated:admin'],code_challenge_methods_supported:['S256']})
    if(req.url==='/register'){callback=JSON.parse(body).redirect_uris[0];return json(res,{client_id:'synthetic-client'})}
    if(req.url==='/token'){const form=new URLSearchParams(body);pkce=createHash('sha256').update(form.get('code_verifier')).digest('base64url')===verifierChallenge;return json(res,{access_token:'synthetic-login-access',refresh_token:'synthetic-login-refresh',token_type:'Bearer',expires_in:3600})}
    return json(res,{error:'unavailable'},accountFailure?503:404)
  });let handled=false, observation=Promise.resolve()
  const task=launch(['login','--no-browser','--json','--error-format=json','--timeout=5'],{api:s.url,cfg,observe:(_,stderr,child)=>{
    const found=stderr.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/);if(!found||handled)return;handled=true;const u=new URL(found[0]);nonce=u.searchParams.get('state');verifierChallenge=u.searchParams.get('code_challenge');observation=Promise.resolve(observe?observe({callback,state:nonce,child,url:u,cfg}):fetch(callback+'?code=synthetic-code&state='+nonce));observation.catch(()=>{})
  }});
  const done=task.done;task.done=done.then(async result=>{await observation;return result})
  return {cfg,s,task,pkce:()=>pkce}
}
test('PKCE browser login succeeds and requests only client scopes, without optional account dependency',async()=>{
  const f=await loginFixture({accountFailure:true,observe:async({callback,state,url})=>{assert.equal(url.searchParams.get('scope'),'agent:read offline_access');await fetch(callback+'?code=synthetic-code&state='+state)}})
  try{const r=await f.task.done;assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(r.stdout).signed_in,true);assert.ok(f.pkce());assert.equal(state(f.cfg).access_token,'synthetic-login-access');assert.equal(f.s.requests.length,3)}finally{await f.s.close()}
})
test('invalid callback, error without state and malformed target do not settle login; active socket is cleaned',async()=>{
  let socket
  const f=await loginFixture({observe:async({callback,state})=>{
    const invalid=await fetch(callback+'?error=access_denied');assert.equal(invalid.status,400)
    assert.equal((await fetch(callback+'?code=x&state=wrong')).status,400)
    assert.equal((await fetch(callback+'?code=x&state='+state+'&state='+state)).status,400)
    assert.equal((await fetch(callback+'?code=x&state='+state,{method:'POST'})).status,405)
    const u=new URL(callback);const malformed=connect(Number(u.port),'127.0.0.1');malformed.on('error',()=>{});await new Promise(r=>malformed.on('connect',r));malformed.write('GET http://[ HTTP/1.1\r\nHost: '+u.host+'\r\n\r\n');malformed.end()
    socket=connect(Number(u.port),'127.0.0.1');socket.on('error',()=>{});await new Promise(r=>socket.on('connect',r));socket.write('GET /hold HTTP/1.1\r\nHost: '+u.host+'\r\nX-Hold: ')
    await fetch(callback+'?code=synthetic-code&state='+state)
  }})
  try{const r=await f.task.done;assert.equal(r.code,0,r.stderr);assert.equal(r.killed,false);assert.ok(f.pkce())}finally{socket?.destroy();await f.s.close()}
})
test('cancelled login closes callback and does not save credentials', {skip:process.platform==='win32'},async()=>{
  let callback
  const f=await loginFixture({observe:async(x)=>{callback=x.callback;x.child.kill('SIGINT')}})
  try{const r=await f.task.done;assert.equal(r.code,130,r.stderr);assert.equal(JSON.parse(r.stderr.trim().split('\n').at(-1)).error.code,'cancelled');assert.ok(!existsSync(join(f.cfg,'hirify/auth.json')));await assert.rejects(fetch(callback))}finally{await f.s.close()}
})
test('noninteractive login fails immediately, SSH requires a forwarded fixed port',async()=>{
  const a=await run(['login','--error-format=json']);assert.equal(JSON.parse(a.stderr).error.code,'interaction_required')
  const b=await run(['login','--no-browser','--error-format=json'],{env:{SSH_CONNECTION:'test'}});assert.equal(JSON.parse(b.stderr).error.code,'remote_callback_required')
})
for(const value of [{access_token:{}},{access_token:'x',token_type:'MAC'},{access_token:'x',token_type:'Bearer',expires_in:-1},{access_token:'x',token_type:'Bearer',expires_in:'no'},{access_token:'x',token_type:'Bearer',scope:[]}])test('malformed token response cannot become stored access',()=>assert.throws(()=>tokenResponse(value),{name:'CliError'}))
test('large raw error fully drains stdout; structured errors use stderr without a second body',async()=>{
  const body={error:{code:'bad_request',details:'x'.repeat(2*1024*1024)}};const s=await apiFixture((_,res)=>json(res,body,400))
  try{const a=await run(['api','call','account.status','--json'],{api:s.url,key:'synthetic'});assert.equal(a.code,1);assert.deepEqual(JSON.parse(a.stdout),body);const b=await run(['api','call','account.status','--json','--error-format=json'],{api:s.url,key:'synthetic'});assert.equal(b.stdout,'');assert.equal(JSON.parse(b.stderr).error.code,'request_rejected')}finally{await s.close()}
})
test('human output strips terminal controls; JSON keeps escaped data',async()=>{
  const name='hello\x1b]52;c;YQ==\x07world';const s=await apiFixture((_,res)=>json(res,{data:[{id:1,name}]}))
  try{const a=await run(['feed','list'],{api:s.url,key:'synthetic'});assert.equal(a.code,0,a.stderr);assert.doesNotMatch(a.stdout,/\x1b|\x07/);const b=await run(['feed','list','--json'],{api:s.url,key:'synthetic'});assert.equal(JSON.parse(b.stdout).data[0].name,name)}finally{await s.close()}
})
test('deadline interrupts slow discovery and ends without an external kill',async()=>{
  const s=await server(()=>{});try{const started=Date.now();const r=await run(['account','show','--timeout=1','--error-format=json'],{api:s.url,key:'synthetic'});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'command_timeout');assert.ok(Date.now()-started<3000);assert.equal(r.killed,false)}finally{await s.close()}
})
test('no automatic replay of a mutation on 401 or uncertain outcome',async()=>{
  let calls=0;const s=await apiFixture((_,res)=>{calls++;json(res,{error:{code:'expired'}},401)})
  try{const r=await run(['vacancy','apply','demo'],{api:s.url,key:'synthetic'});assert.equal(r.code,1);assert.equal(calls,1)}finally{await s.close()}
})
test('file inputs preserve quoting and Unicode without a shell',async()=>{
  const cfg=temp();const letter="O'Hara \"hello\" $HOME `command`\nПривет";const file=join(cfg,'cover letter.txt');writeFileSync(file,letter);let received
  const s=await apiFixture((_,res,body)=>{received=JSON.parse(body);json(res,{data:{application_id:42,status:'sent'}},201)})
  try{const r=await run(['vacancy','apply','demo','--cover-file',file,'--json'],{api:s.url,key:'synthetic'});assert.equal(r.code,0,r.stderr);assert.equal(received.cover_letter,letter)}finally{await s.close()}
})
test('browser platform and environment policy includes WSL and headless',()=>{
  assert.equal(environment({platform:'win32',env:{},isTTY:true}).canOpen,true)
  assert.equal(environment({platform:'darwin',env:{SSH_TTY:'x'},isTTY:true}).canOpen,false)
  assert.equal(environment({platform:'linux',env:{},isTTY:true}).canOpen,false)
  assert.equal(environment({platform:'linux',env:{WSL_INTEROP:'x'},isTTY:true}).canOpen,true)
  assert.equal(environment({platform:'win32',env:{},isTTY:false}).canOpen,false)
})
for(const [event,value,code] of [['exit',0,'launcher_exited'],['exit',1,'nonzero_exit'],['error',{code:'ENOENT'},'launcher_missing']])test(`browser launcher reason: ${code}`,async()=>{const child=new EventEmitter();child.unref=()=>{};const promise=openBrowser('https://example.test/?a=1&b=2',{waitMs:500,launch:async()=>child});setTimeout(()=>child.emit(event,value),20);assert.equal((await promise).code,code)})
test('browser launcher timeout is unconfirmed, not success',async()=>{const child=new EventEmitter();child.unref=()=>{};assert.equal((await openBrowser('https://example.test/',{waitMs:10,launch:async()=>child})).code,'launcher_unconfirmed')})
test('HTTP Retry-After accepts seconds and dates',()=>{assert.equal(retryDelay('2'),2000);const now=Date.now();assert.ok(retryDelay(new Date(now+5000).toUTCString(),now)>3500)})

test('short credential redaction preserves valid JSON numbers',async()=>{
 const s=await apiFixture((_,res)=>json(res,{data:{count:123,label:'1'}}),{document:manifest([['test.json','GET','/json']])})
 try{const r=await run(['api','call','test.json','--json'],{api:s.url,key:'1'});assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{data:{count:123,label:'[redacted]'}})}finally{await s.close()}
})
test('a closed stdout pipe terminates without an unhandled EPIPE',async()=>{
 const s=await apiFixture((_,res)=>json(res,{data:{text:'x'.repeat(2*1024*1024)}}),{document:manifest([['test.pipe','GET','/pipe']])})
 try{const child=launch(['api','call','test.pipe','--json'],{api:s.url,key:'synthetic',observe:(_out,_err,process)=>process.stdout.destroy()});const r=await child.done;assert.equal(r.killed,false);assert.doesNotMatch(r.stderr,/Unhandled|EPIPE/)}finally{await s.close()}
})
test('feedback uses advertised body idempotency key and preserves a queued response',async()=>{
 const doc=manifest([['feedback.send','POST','/feedback']]);doc.capabilities[0].retry_policy='caller_keyed';doc.capabilities[0].inputs={locations:{idempotency_key:'body'}}
 const s=await apiFixture((_,res)=>json(res,{data:{reference:'synthetic-reference',status:'queued'}},202),{document:doc})
 try{const r=await run(['feedback','send','bug','Test','--body','Details','--idempotency-key','repeat-same-request','--json'],{api:s.url,key:'synthetic-credential'});assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(s.requests.at(-1).body).idempotency_key,'repeat-same-request');assert.equal(JSON.parse(r.stdout).data.status,'queued');assert.equal(s.requests.filter(x=>x.method==='POST').length,1)}finally{await s.close()}
})
test('already signed-in login is idempotent without an interactive terminal',async()=>{
 const cfg=temp();authFile(cfg,oauth('http://127.0.0.1:1',{expires_at:9999999999}));const r=await run(['login','--json'],{cfg});assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(r.stdout).already_signed_in,true)
})
test('browser rejects non-web schemes without starting an executable',async()=>{
 let calls=0;assert.equal((await openBrowser('javascript:alert(1)',{launch:()=>{calls++}})).code,'invalid_url');assert.equal(calls,0)
})
test('structured errors remain JSON when a credential matches a numeric value',async()=>{
 const s=await apiFixture((_,res)=>json(res,{message:'failed'},401))
 try{const r=await run(['account','show','--error-format=json'],{api:s.url,key:'1'});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).schema_version,1)}finally{await s.close()}
})
test('unexpected successful status cannot turn a feed response into success',async()=>{
 const s=await apiFixture((_,res)=>json(res,{data:[]},201))
 try{const r=await run(['feed','list','--error-format=json'],{api:s.url,key:'synthetic'});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'protocol_error')}finally{await s.close()}
})
test('generic mutation server failure is an unknown result and is not retried',async()=>{
 const s=await apiFixture((_,res)=>json(res,{error:{code:'failed'}},500),{document:manifest([['test.mutate','POST','/mutate']])})
 try{const r=await run(['api','call','test.mutate','--error-format=json'],{api:s.url,key:'synthetic'});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'outcome_unknown');assert.equal(s.requests.filter(q=>q.method==='POST').length,1)}finally{await s.close()}
})
test('IPv4 bind failure falls back to real IPv6 loopback',async t=>{
 const factory=(...args)=>{const s=createServer(...args);const listen=s.listen.bind(s);s.listen=(port,host)=>{if(host==='127.0.0.1'){queueMicrotask(()=>s.emit('error',Object.assign(new Error('IPv4 disabled'),{code:'EAFNOSUPPORT'})));return s}return listen(port,host)};return s}
 let listener
 try{listener=await startCallbackServer({state:'synthetic-state',issuer:'https://api.example.test',timeoutMs:1000,serverFactory:factory})}catch(error){if(error.code==='callback_bind_failed'){t.skip('IPv6 unavailable on runner');return}throw error}
 try{assert.match(listener.redirectUri,/\[::1\]/);assert.equal((await fetch(listener.redirectUri+'?code=ok&state=synthetic-state')).status,200);assert.equal((await listener.received).code,'ok')}finally{await listener.close()}
})
test('correlated access denial ends login without token exchange or saved credentials',async()=>{
 const f=await loginFixture({observe:({callback,state})=>fetch(callback+'?error=access_denied&state='+state)})
 try{const r=await f.task.done;assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr.trim().split('\n').at(-1)).error.code,'auth_denied');assert.ok(!existsSync(join(f.cfg,'hirify/auth.json')));assert.ok(!f.s.requests.some(q=>q.url==='/token'))}finally{await f.s.close()}
})
test('registration cannot outlive the command deadline',async()=>{
 let s;s=await server((req,res)=>{if(req.url==='/.well-known/oauth-authorization-server')json(res,{issuer:s.url,authorization_endpoint:s.url+'/authorize',registration_endpoint:s.url+'/register',token_endpoint:s.url+'/token'})})
 try{const start=Date.now();const r=await run(['login','--no-browser','--timeout=1','--error-format=json'],{api:s.url});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'command_timeout');assert.ok(Date.now()-start<3000);assert.equal(r.killed,false);assert.ok(s.requests.some(q=>q.url==='/register'))}finally{await s.close()}
})
test('an unavailable exact version pin cannot silently execute another version',async()=>{
 const r=await run(['version','--error-format=json'],{env:{HIRIFY_VERSION_PIN:'99.99.99'}});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'version_pin_unavailable');assert.equal(r.stdout,'')
})
for(const flags of [['--data-file','-'],['--data-file=-']])test(`documented JSON stdin form sends the exact payload: ${flags.join(' ')}`,async()=>{
 const input={text:"O'Hara \"quoted\" $HOME `literal`\nПривет",count:7};let body
 const s=await apiFixture((_,res,text)=>{body=JSON.parse(text);json(res,{data:{accepted:true}})},{document:manifest([['test.stdin','POST','/stdin']])})
 try{const r=await run(['api','call','test.stdin',...flags,'--json'],{api:s.url,key:'synthetic',input:JSON.stringify(input)});assert.equal(r.code,0,r.stderr);assert.deepEqual(body,input);assert.deepEqual(JSON.parse(r.stdout),{data:{accepted:true}});assert.equal(s.requests.filter(q=>q.method==='POST').length,1)}finally{await s.close()}
})
for(const flags of [['--cover-file','-'],['--cover-file=-']])test(`documented cover stdin form preserves the full letter: ${flags.join(' ')}`,async()=>{
 const letter="O'Hara \"quoted\" $HOME `literal`\nПривет\n";let body
 const s=await apiFixture((_,res,text)=>{body=JSON.parse(text);json(res,{data:{application_id:7,status:'sent'}},201)})
 try{const r=await run(['vacancy','apply','demo',...flags,'--json'],{api:s.url,key:'synthetic',input:letter});assert.equal(r.code,0,r.stderr);assert.equal(body.cover_letter,letter);assert.equal(JSON.parse(r.stdout).data.application_id,7);assert.equal(s.requests.filter(q=>q.method==='POST').length,1)}finally{await s.close()}
})
test('UTF-8 BOM JSON from Windows editors works through file and stdin input',async()=>{
 const cfg=temp();const file=join(cfg,'windows.json');const input='\uFEFF'+JSON.stringify({text:'Unicode Привет'});writeFileSync(file,input);const received=[]
 const s=await apiFixture((_,res,body)=>{received.push(JSON.parse(body));json(res,{data:{accepted:true}})},{document:manifest([['test.bom','POST','/bom']])})
 try{for(const path of [file,'-']){const r=await run(['api','call','test.bom','--data-file',path,'--json'],{api:s.url,key:'synthetic',cfg,input});assert.equal(r.code,0,r.stderr)}assert.deepEqual(received,[{text:'Unicode Привет'},{text:'Unicode Привет'}])}finally{await s.close()}
})
test('non-UTF8 application text is rejected before sending a corrupted letter',async()=>{
 const cfg=temp();const file=join(cfg,'utf16-cover.txt');const input=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('Cover letter','utf16le')]);writeFileSync(file,input)
 const s=await apiFixture((_,res)=>json(res,{data:{application_id:7}},201))
 try{for(const path of [file,'-']){const r=await run(['vacancy','apply','demo','--cover-file',path,'--error-format=json'],{api:s.url,key:'synthetic',cfg,input});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr).error.code,'input_encoding')}assert.equal(s.requests.length,0)}finally{await s.close()}
})

// Node's filesystem permission boundary is real and portable; this is not an fs mock.
const readonlyNode = ['--experimental-permission', '--allow-fs-read=*', '--no-warnings']
const permissionTests = { skip: Number(process.versions.node.split('.')[0]) < 20 }
for (const kind of ['key', 'oauth', 'legacy']) test(`saved ${kind} authentication works with all filesystem writes denied`, permissionTests, async () => {
 const cfg = temp(); const s = await apiFixture((_, res) => json(res, { data: [] }))
 try {
  if (kind === 'legacy') { mkdirSync(join(cfg, 'hirify')); writeFileSync(join(cfg, 'hirify/key'), 'synthetic-legacy'); }
  else authFile(cfg, kind === 'oauth' ? oauth(s.url, { expires_at: 9999999999 }) : { kind: 'key', issuer: s.url, access_token: 'synthetic-key' })
  // Legacy keys belong to the production issuer, so test that read without sending a bearer elsewhere.
  if (kind === 'legacy') {
   const r = await run(['auth', 'status', '--json'], { cfg, api: 'https://api.hirify.me', nodeArgs: readonlyNode }); assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).source, 'key')
  } else {
   const path = join(cfg, 'hirify/auth.json'); const before = readFileSync(path, 'utf8'); const beforeStat = statSync(path)
   const r = await run(['feed', 'list', '--json', '--error-format=json'], { cfg, api: s.url, nodeArgs: readonlyNode })
   assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).data, []); assert.equal(readFileSync(path, 'utf8'), before); assert.equal(statSync(path).mtimeMs, beforeStat.mtimeMs); assert.equal(statSync(path).ctimeMs, beforeStat.ctimeMs)
   assert.ok(s.requests.some(q => q.url === '/feeds' && q.headers.authorization))
  }
 } finally { await s.close() }
})
test('missing saved session reports auth_required without creating a directory', permissionTests, async () => {
 const cfg = temp(); const s = await apiFixture((_, res) => json(res, { data: [] }))
 try { const r = await run(['feed', 'list', '--error-format=json'], { cfg, api: s.url, nodeArgs: readonlyNode }); assert.equal(r.code, 1); assert.equal(JSON.parse(r.stderr).error.code, 'auth_required'); assert.equal(existsSync(join(cfg, 'hirify')), false) } finally { await s.close() }
})
for (const force of [false, true]) test(`read-only session cannot rotate a token before saving it: ${force ? '401' : 'expired'}`, permissionTests, async () => {
 const cfg = temp(); const s = await apiFixture((_, res) => json(res, { error: 'expired' }, 401))
 authFile(cfg, oauth(s.url, { expires_at: force ? 9999999999 : 1 })); const before = readFileSync(join(cfg, 'hirify/auth.json'), 'utf8')
 try {
  const r = await run(['feed', 'list', '--error-format=json'], { cfg, api: s.url, nodeArgs: readonlyNode })
  assert.equal(r.code, 1); const error = JSON.parse(r.stderr).error; assert.equal(error.code, 'storage_unavailable'); assert.match(error.message, /write access/); assert.match(error.message, /ERR_ACCESS_DENIED/)
  assert.equal(s.requests.filter(q => q.method === 'POST').length, 0); assert.equal(readFileSync(join(cfg, 'hirify/auth.json'), 'utf8'), before); assert.doesNotMatch(r.stdout + r.stderr, /synthetic-access|synthetic-refresh/)
 } finally { await s.close() }
})
test('denied credential reads are distinct and never expose the credential path', permissionTests, async () => {
 const cfg = temp(); authFile(cfg, { kind: 'key', access_token: 'synthetic-private' })
 const r = await run(['auth', 'status', '--error-format=json'], { cfg, nodeArgs: ['--experimental-permission', `--allow-fs-read=${dirname(dirname(CLI))}`, '--no-warnings'] })
 assert.equal(r.code, 1); const error = JSON.parse(r.stderr).error; assert.equal(error.code, 'storage_unreadable'); assert.match(error.message, /read access/); assert.doesNotMatch(r.stderr, /synthetic-private/); assert.ok(!r.stderr.includes(cfg))
})
