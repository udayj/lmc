import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker.mjs';
const env = { APP_BACKEND_ORIGIN: 'https://app.example.com', WEBSITE_DOWNLOAD_TOKEN: 'test-key', PDF_STORAGE_ORIGIN: 'https://storage.example.com' };
const entry = { brand: 'kei', keywords: ['latest solar'], public_url: 'https://storage.example.com/storage/v1/object/public/pricelists/Solar%20LP.pdf' };
const request = (path='/api/pricelists', init) => new Request('https://lmccables.com'+path, init);
const directory = items => Response.json({pricelists: items});
test('directory exposes safe metadata and coalesces simultaneous reads', async () => {
 let calls=0;
 const worker=createWorker(async (url, init) => {
   calls++; assert.equal(new URL(url).pathname,'/api/website/pricelists');
   assert.equal(init.headers.Authorization, 'Bearer '+env.WEBSITE_DOWNLOAD_TOKEN);
   assert.equal(init.redirect,'manual');
   return directory([entry,entry]);
 });
 const responses=await Promise.all([worker.fetch(request(),env),worker.fetch(request(),env)]);
 const body=await responses[0].json();
 assert.equal(calls,1); assert.equal(body.pricelists.length,1);
 assert.equal(body.pricelists[0].title,'Solar LP'); assert.equal(body.pricelists[0].latest,true);
 assert.match(body.pricelists[0].id,/^[a-f0-9]{64}$/);
 assert.equal(body.pricelists[0].url,undefined);
 assert.ok(!JSON.stringify(body).includes(env.WEBSITE_DOWNLOAD_TOKEN));
});
test('only GET directory and known ID download routes are reachable', async () => {
 let calls=0;const worker=createWorker(async()=>{calls++;return directory([])});
 for(const path of ['/api/web/catalog','/api/web/workspaces','/api/pricelists/https://evil.example/download']) {
   assert.equal((await worker.fetch(request(path),env)).status,404);
 }
 assert.equal((await worker.fetch(request(undefined,{method:'POST'}),env)).status,405);
 assert.equal((await worker.fetch(request(undefined,{headers:{Origin:'https://evil.example'}}),env)).status,403);
 assert.equal(calls,0);
});
test('PDF download streams bytes with safe filename and never forwards app credentials to storage',async()=>{
 const bytes=new TextEncoder().encode('%PDF-1.7\nfixture\n%%EOF');
 const worker=createWorker(async(url,init)=>{
   if(String(url).includes('/api/website/'))return directory([entry]);
   assert.equal(String(url),entry.public_url);assert.equal(init.headers,undefined);assert.equal(init.redirect,'manual');
   return new Response(bytes,{headers:{'Content-Type':'application/pdf'}});
 });
 const {pricelists}=await (await worker.fetch(request(),env)).json();
 const r=await worker.fetch(request('/api/pricelists/'+pricelists[0].id+'/download'),env);
 assert.equal(r.status,200);assert.equal(r.headers.get('Content-Disposition'),'attachment; filename="Solar LP.pdf"');
 assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
 assert.equal((await worker.fetch(request('/api/pricelists/'+'0'.repeat(64)+'/download'),env)).status,404);
});
test('rejects unexpected storage hosts, private buckets, URL credentials and redirects',async()=>{
 for(const url of ['https://evil.example/file.pdf','https://storage.example.com/storage/v1/object/private/secret.pdf','https://user:password@storage.example.com/storage/v1/object/public/pricelists/file.pdf']) {
   const worker=createWorker(async()=>directory([{...entry,public_url:url}]));
   assert.equal((await worker.fetch(request(),env)).status,503);
 }
 const worker=createWorker(async()=>new Response(null,{status:302,headers:{Location:'https://evil.example'}}));
 assert.equal((await worker.fetch(request(),env)).status,503);
});
test('missing credentials fail closed, failed directory requests are retryable, empty lists are valid',async()=>{
 let calls=0;const worker=createWorker(async()=>++calls===1?new Response(null,{status:500}):directory([]));
 assert.equal((await worker.fetch(request(),{...env,WEBSITE_DOWNLOAD_TOKEN:''})).status,503);
 assert.equal(calls,0);
 assert.equal((await worker.fetch(request(),env)).status,503);
 const r=await worker.fetch(request(),env);assert.equal(r.status,200);assert.deepEqual((await r.json()).pricelists,[]);
});
test('failed, redirected and non-PDF storage responses never become successful downloads',async()=>{
 for(const pdf of [new Response(null,{status:404}),new Response(null,{status:302,headers:{Location:'https://evil.example'}}),new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}})]) {
   const worker=createWorker(async url=>String(url).includes('/api/website/')?directory([entry]):pdf);
   const {pricelists}=await(await worker.fetch(request(),env)).json();
   const r=await worker.fetch(request('/api/pricelists/'+pricelists[0].id+'/download'),env);
   assert.equal(r.status,503);assert.equal(r.headers.get('Cache-Control'),'no-store');
 }
});

test('accepts even a single-character configured token', async () => {
 const worker=createWorker(async()=>directory([]));
 assert.equal((await worker.fetch(request(),{...env,WEBSITE_DOWNLOAD_TOKEN:'x'})).status,200);
 assert.equal((await worker.fetch(request(),{...env,WEBSITE_DOWNLOAD_TOKEN:'   '})).status,503);
});
