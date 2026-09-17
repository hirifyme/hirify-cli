import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import semver from 'semver'
import { createUpdater, activeInstallation, runProcess } from '../bin/lib/update.js'
const dirs=[]
after(()=>{for(const dir of dirs)rmSync(dir,{recursive:true,force:true})})
function fixture({failInstall=false,wrongVersion=false,interrupt=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'hirify-update-'));dirs.push(dir);const globalRoot=join(dir,'global with spaces','node_modules');const baseRoot=join(globalRoot,'hirify-cli');mkdirSync(baseRoot,{recursive:true});writeFileSync(join(baseRoot,'original'),'intact')
 const config={dir:join(dir,'config'),env:{HIRIFY_NO_AUTO_UPDATE:''},version:'0.5.0'};const controller=new AbortController();const calls=[];const events=[]
 const run=async(command,args)=>{
  calls.push({command,args})
  if(args[0]==='root')return{code:0,stdout:globalRoot+'\n'}
  if(args[0]==='config')return{code:0,stdout:'https://registry.example.test/\n'}
  if(args[0]==='install'){
   if(interrupt){controller.abort(new Error('synthetic interruption'));throw controller.signal.reason}
   if(failInstall)return{code:1,stdout:'',stderr:'synthetic-private-error'}
   const prefix=args[args.indexOf('--prefix')+1];const version=args.at(-1).split('@').at(-1);const root=join(prefix,'node_modules','hirify-cli');mkdirSync(join(root,'bin','lib'),{recursive:true});writeFileSync(join(root,'package.json'),JSON.stringify({name:'hirify-cli',version:wrongVersion?'0.5.0':version,engines:{node:'>=18'}}));writeFileSync(join(root,'bin','lib','main.js'),'export async function main(){return 0}\n');writeFileSync(join(root,'bin','hirify.js'),'console.log('+JSON.stringify(version)+')\n');writeFileSync(join(prefix,'package-lock.json'),JSON.stringify({packages:{'node_modules/hirify-cli':{integrity:'sha512-synthetic'}}}));return{code:0,stdout:''}
  }
  if(command===process.execPath){const version=JSON.parse(readFileSync(join(args[0],'..','..','package.json'),'utf8')).version;return{code:0,stdout:version+'\n'}}
  throw Error('unexpected command')
 }
 const http={request:async()=>({ok:true,status:200,headers:new Headers({'content-type':'application/json'}),body:{name:'hirify-cli',version:'0.5.1',engines:{node:'>=18'},dist:{integrity:'sha512-synthetic'}}})}
 const updater=createUpdater({config,http,signal:controller.signal,output:{progress:()=>{}},event:(...x)=>events.push(x),packageRoot:baseRoot,run})
 return{dir,baseRoot,config,updater,calls,events,controller}
}
test('update stages one exact version with lifecycle scripts disabled and activates atomically',async()=>{
 const f=fixture();const target=await f.updater.check();const result=await f.updater.install(target);assert.equal(result.version,'0.5.1');const install=f.calls.find(x=>x.args[0]==='install');assert.equal(install.args.at(-1),'hirify-cli@0.5.1');assert.ok(install.args.includes('--ignore-scripts'));assert.ok(install.args.includes('--strict-ssl=true'));assert.equal(install.args[install.args.indexOf('--registry')+1],'https://registry.example.test');assert.equal(readFileSync(join(f.baseRoot,'original'),'utf8'),'intact');assert.equal(activeInstallation(f.config.dir,f.baseRoot,'0.5.0').version,'0.5.1')
})
for(const options of [{failInstall:true},{wrongVersion:true},{interrupt:true}])test('failed or interrupted staging never changes the active installation: '+JSON.stringify(options),async()=>{
 const f=fixture(options);await assert.rejects(f.updater.install({version:'0.5.1',registry:'https://registry.example.test',integrity:'sha512-synthetic'}));assert.equal(activeInstallation(f.config.dir,f.baseRoot,'0.5.0'),null);assert.equal(readFileSync(join(f.baseRoot,'original'),'utf8'),'intact');assert.ok(!existsSync(join(f.updater.dir,'active.json')))
})
test('concurrent updates serialize and do not install the same generation twice',async()=>{
 const f=fixture();const target=await f.updater.check();await Promise.all([f.updater.install(target),f.updater.install(target)]);assert.equal(f.calls.filter(x=>x.args[0]==='install').length,1);assert.equal(JSON.parse(readFileSync(join(f.updater.dir,'active.json'),'utf8')).previous,'0.5.0');assert.equal(activeInstallation(f.config.dir,f.baseRoot,'0.5.0').version,'0.5.1')
})
test('exact install pins; automatic updates respect pin and offline rollback restores base',async()=>{
 const f=fixture();await f.updater.install(await f.updater.check(),{pin:true});const count=f.calls.length;assert.equal(await f.updater.automatic(),null);assert.equal(f.calls.length,count);assert.equal((await f.updater.rollback()).version,'0.5.0');assert.equal(activeInstallation(f.config.dir,f.baseRoot,'0.5.0'),null);assert.equal(await f.updater.automatic(),null)
})
test('manual npm replacement invalidates the old per-user activation pointer',async()=>{
 const f=fixture();await f.updater.install(await f.updater.check());assert.equal(activeInstallation(f.config.dir,f.baseRoot,'0.6.0'),null)
})
test('tampered activation version cannot name a path outside managed artifacts',async()=>{
 const f=fixture();await f.updater.install(await f.updater.check());writeFileSync(join(f.updater.dir,'active.json'),JSON.stringify({base_version:'0.5.0',version:'../../other',pinned:true}));assert.equal(activeInstallation(f.config.dir,f.baseRoot,'0.5.0'),null)
})
test('the verified install owner is required; local checkout never mutates',async()=>{
 const f=fixture();const other=createUpdater({config:f.config,http:{},signal:f.controller.signal,output:{},event:()=>{},packageRoot:f.dir});assert.equal((await other.installation()).owner,'unmanaged');await assert.rejects(other.install({version:'0.5.1'}),{code:'update_owner_unknown'})
})
test('SemVer handles prerelease and build metadata correctly',()=>{
 assert.equal(semver.gt('0.4.7','0.4.7-beta.1'),true);assert.equal(semver.gt('0.4.8+build.1','0.4.7'),true);assert.equal(semver.gt('0.4.7+build.1','0.4.7'),false)
})
test('native package-manager process adapter runs npm on this platform, including its Windows cmd shim',async()=>{
 const r=await runProcess('npm',['--version'],{timeout:10000});assert.equal(r.code,0);assert.match(r.stdout.trim(),/^\d+\.\d+\.\d+/)
})
test('cancelled package-manager process stops within a bounded time',async()=>{
 const controller=new AbortController();const started=Date.now();const task=runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});setTimeout(()=>controller.abort(new Error('cancelled')),100);await assert.rejects(task,/cancelled/);assert.ok(Date.now()-started<3000)
})
test('cached artifact integrity must still match the selected release',async()=>{
 const f=fixture();const target=await f.updater.check();await f.updater.install(target);await assert.rejects(f.updater.install({...target,integrity:'sha512-different'}),{code:'update_verification_failed'});assert.equal(activeInstallation(f.config.dir,f.baseRoot,'0.5.0').version,'0.5.1')
})
