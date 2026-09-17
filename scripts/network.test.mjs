import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cert = fileURLToPath(new URL('./fixtures/localhost-cert.pem', import.meta.url))
const key = fileURLToPath(new URL('./fixtures/localhost-key.pem', import.meta.url))
const moduleURL = new URL('../bin/lib/http.js', import.meta.url).href
async function listening(server) { await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port }
async function close(server) { server.closeAllConnections?.(); await new Promise(resolve=>server.close(resolve)) }
async function request(url, {env={},options={},abortAfter}={}) {
  const code=`const {createHttp}=await import(process.argv[1]);const c=new AbortController();const timeout=process.argv[4]==='undefined'?null:setTimeout(()=>c.abort(),Number(process.argv[4]));const h=createHttp({signal:c.signal,version:'test',timeoutMs:1500});try{const r=await h.request(process.argv[2],JSON.parse(process.argv[3]));console.log(JSON.stringify({status:r.status,body:r.body}));}catch(e){console.log(JSON.stringify({code:e.code||e.name}));process.exitCode=1}finally{clearTimeout(timeout);h.close()}`
  const p=spawn(process.execPath,['--input-type=module','-e',code,moduleURL,url,JSON.stringify(options),String(abortAfter)],{env:{...process.env,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:'',NO_PROXY:'',no_proxy:'',NODE_EXTRA_CA_CERTS:'',NODE_OPTIONS:'',...env},stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);const timeout=setTimeout(()=>p.kill('SIGKILL'),8000);const exit=await new Promise(r=>p.on('close',r));clearTimeout(timeout);return {exit,stdout,stderr,...(stdout?JSON.parse(stdout):{})}
}
test('TLS rejects untrusted certificates even when Node TLS opt-out is set; explicit CA works',async()=>{
  let hits=0;const s=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(_,res)=>{hits++;res.setHeader('content-type','application/json');res.end('{"ok":true}')});const port=await listening(s)
  try{const rejected=await request(`https://127.0.0.1:${port}`,{env:{NODE_TLS_REJECT_UNAUTHORIZED:'0'}});assert.equal(rejected.code,'tls_error');assert.equal(hits,0);const good=await request(`https://127.0.0.1:${port}`,{env:{NODE_EXTRA_CA_CERTS:cert}});assert.equal(good.status,200,good.stderr);assert.equal(hits,1)}finally{await close(s)}
})
test('HTTP_PROXY and NO_PROXY are honored without a Node feature flag',async()=>{
  let direct=0,proxied=0;const s=http.createServer((_,res)=>{direct++;res.end('{}')});const target=await listening(s);const p=http.createServer((req,res)=>{proxied++;assert.match(req.url,/^http:\/\/127\.0\.0\.1:/);res.end('{}')});const proxy=await listening(p)
  try{assert.equal((await request(`http://127.0.0.1:${target}`,{env:{HTTP_PROXY:`http://127.0.0.1:${proxy}`}})).status,200);assert.equal(proxied,1);assert.equal(direct,0);assert.equal((await request(`http://127.0.0.1:${target}`,{env:{HTTP_PROXY:`http://127.0.0.1:${proxy}`,NO_PROXY:'127.0.0.1'}})).status,200);assert.equal(direct,1);assert.equal(proxied,1)}finally{await close(s);await close(p)}
})
test('authenticated HTTPS CONNECT proxy and custom CA work together',async()=>{
  let connects=0,auth,apiAuth;const sockets=new Set();const s=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{apiAuth=req.headers.authorization;res.setHeader('content-type','application/json');res.end('{"ok":true}')});const target=await listening(s)
  const p=http.createServer();p.on('connect',(req,client,head)=>{connects++;auth=req.headers['proxy-authorization'];const upstream=net.connect(target,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client)});sockets.add(client);sockets.add(upstream);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy())});const proxy=await listening(p)
  try{const r=await request(`https://127.0.0.1:${target}`,{env:{HTTPS_PROXY:`http://synthetic:proxy-password@127.0.0.1:${proxy}`,NODE_EXTRA_CA_CERTS:cert},options:{headers:{Authorization:'Bearer synthetic-api-token'}}});assert.equal(r.status,200,r.stderr);assert.equal(connects,1);assert.equal(auth,'Basic '+Buffer.from('synthetic:proxy-password').toString('base64'));assert.equal(apiAuth,'Bearer synthetic-api-token');assert.doesNotMatch(r.stderr,/proxy-password|synthetic-api-token/)}finally{for(const socket of sockets)socket.destroy();await close(p);await close(s)}
})
for(const status of [301,302,303,307,308])test(`redirect ${status} never forwards credentials or bodies`,async()=>{
  let hits=0;const sink=http.createServer((_,res)=>{hits++;res.end('{}')});const foreign=await listening(sink);const s=http.createServer((_,res)=>{res.writeHead(status,{Location:`http://127.0.0.1:${foreign}/target`});res.end()});const port=await listening(s)
  try{const r=await request(`http://127.0.0.1:${port}`,{options:{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/x-www-form-urlencoded'},body:'refresh_token=synthetic-secret'}});assert.equal(r.code,'redirect_refused');assert.equal(hits,0)}finally{await close(s);await close(sink)}
})
test('response byte limit and stalled body have bounded failures',async()=>{
  const s=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});if(req.url==='/large')res.end('x'.repeat(5000));else res.write('{')});const port=await listening(s)
  try{assert.equal((await request(`http://127.0.0.1:${port}/large`,{options:{maxBytes:1024}})).code,'response_too_large');assert.equal((await request(`http://127.0.0.1:${port}/slow`,{options:{timeout:100}})).code,'network_timeout')}finally{await close(s)}
})
test('only explicitly safe requests retry transient status; Retry-After bounds the wait',async()=>{
  let hits=0;const s=http.createServer((_,res)=>{hits++;res.writeHead(hits<3?503:200,{'Content-Type':'application/json','Retry-After':'0'});res.end('{}')});const port=await listening(s)
  try{assert.equal((await request(`http://127.0.0.1:${port}`,{options:{safe:true}})).status,200);assert.equal(hits,3);hits=0;assert.equal((await request(`http://127.0.0.1:${port}`,{options:{method:'POST'}})).status,503);assert.equal(hits,1)}finally{await close(s)}
})
