import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {F1LiveClient} from './f1-live.mjs';
import {TokenStore, AuthError} from './f1-auth.mjs';
import {bearerGuard, readApiToken} from './api-access.mjs';
import {ApiError, invalid, objectBody} from './api-errors.mjs';
import {AccountService} from './services/account.mjs';
import {HistoryService} from './services/history.mjs';
import {ViewService} from './services/views.mjs';
import {StreamService} from './services/stream.mjs';
import {openapi} from './openapi.mjs';
import {readUIConfig} from './ui-config.mjs';

const ROOT = fileURLToPath(new URL('.',import.meta.url));
function json(req,res,data,status=200) {
  let body = Buffer.from(JSON.stringify(data));
  const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body); headers['Content-Encoding'] = 'gzip'; }
  res.writeHead(status,{...headers,'Content-Length':body.length}); res.end(body);
}
function bodyJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415,'JSON_REQUIRED','Send application/json.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw invalid('Encoded request bodies are not accepted.');
  return new Promise((resolve,reject) => {
    let size=0, chunks=[], failed=false;
    req.on('data',chunk => { size+=chunk.length; if (size>16384) { if (!failed) reject(new ApiError(413,'BODY_TOO_LARGE','Request body is too large.')); failed=true; chunks=[]; } else if (!failed) chunks.push(chunk); });
    req.on('end',() => { if (failed) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(invalid('Invalid JSON body.')); } });
    req.on('error',() => reject(invalid('Request body could not be read.')));
  });
}
const loopback = req => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
export function f1LoginTransportAllowed(req, allowInsecureLogin = false) {
  return loopback(req) || req.socket.encrypted === true || allowInsecureLogin === true;
}
export function createReplayServer({apiToken, uiConfig = null, allowedOrigins = [], tokens = new TokenStore(), live = new F1LiveClient({tokens}), login, load, loadCircuit, history = new HistoryService({load,loadCircuit}), views = new ViewService({history,live}), allowInsecureLogin = false, fetchImpl = fetch, streamOptions = {}} = {}) {
  const authorized = bearerGuard(apiToken), account = new AccountService({tokens,live,login}), instanceId = randomUUID(), streams = new StreamService({views,...streamOptions});
  const server = http.createServer(async(req,res) => {
    res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; media-src 'self' blob:; connect-src 'self' ws://${req.headers.host} wss://${req.headers.host}; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`);
    let url;
    try {
      url = new URL(req.url,'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        const ownOrigin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        if (origin && origin !== ownOrigin && !allowedOrigins.includes(origin)) throw new ApiError(403,'ORIGIN_NOT_ALLOWED','This browser origin is not allowed.');
        if (origin) { res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin, Accept-Encoding'); }
        if (req.method === 'OPTIONS') {
          res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}); return res.end();
        }
        if (!authorized(req.headers.authorization)) { res.setHeader('WWW-Authenticate','Bearer realm="F1 API"'); throw new ApiError(401,'API_UNAUTHORIZED','Supply a valid application bearer token.'); }
        const route = url.pathname.slice('/api/v1'.length);
        if (!url.pathname.startsWith('/api/v1/')) throw new ApiError(404,'NOT_FOUND','Use the documented /api/v1 API.');
        const method = req.method;
        if (route === '/system' && method === 'GET') return json(req,res,{apiVersion:'1',instanceId,serverTime:Date.now(),sources:['history','live'],independentViews:true,autoConnect:false,capabilities:{stream:'websocket',f1PasswordLogin:true,liveTurns:false}});
        if (route === '/openapi.json' && method === 'GET') return json(req,res,openapi);
        if (route === '/races' && method === 'GET') {
          if ([...url.searchParams.keys()].some(k=>!['year','month','circuit'].includes(k))) throw invalid('Unknown race filter.');
          return json(req,res,await history.races(Object.fromEntries(url.searchParams)));
        }
        if (route === '/f1/auth' && method === 'GET') return json(req,res,await account.status());
        if (route === '/f1/auth/login' && method === 'POST') {
          if (!f1LoginTransportAllowed(req,allowInsecureLogin)) throw new ApiError(426,'HTTPS_REQUIRED','Use HTTPS for F1 credentials.');
          return json(req,res,await account.login(await bodyJSON(req)));
        }
        if (route === '/f1/auth/logout' && method === 'POST') { objectBody(await bodyJSON(req),[]); return json(req,res,await account.logout()); }
        if (route === '/live' && method === 'GET') { const s=await live.snapshot(); return json(req,res,{connection:s.connection,auth:s.auth,session:s.session,sessionStatus:s.sessionStatus}); }
        if (['/live/connect','/live/disconnect'].includes(route) && method === 'POST') {
          objectBody(await bodyJSON(req),[]);
          if (route.endsWith('/connect')) await live.connect(); else live.disconnect();
          const s=await live.snapshot(); return json(req,res,{connection:s.connection,auth:s.auth},route.endsWith('/connect')?202:200);
        }
        if (route === '/views' && method === 'POST') { const v=views.create(await bodyJSON(req)); res.setHeader('Location','/api/v1/views/'+v.id); return json(req,res,await views.snapshot(v.id),201); }
        const match = /^\/views\/([a-f\d-]{36})(?:\/(playback|events|radio|stream-ticket))?$/.exec(route);
        if (match) {
          const [,id,action] = match;
          if (!action && method === 'GET') return json(req,res,await views.snapshot(id));
          if (!action && method === 'PATCH') { views.patch(id,await bodyJSON(req)); return json(req,res,await views.snapshot(id)); }
          if (!action && method === 'DELETE') { views.get(id); views.remove(id); res.writeHead(204); return res.end(); }
          if (action === 'playback' && method === 'POST') { views.playback(id,await bodyJSON(req)); return json(req,res,await views.snapshot(id)); }
          if (action === 'radio' && method === 'POST') { await views.radio(id,await bodyJSON(req)); return json(req,res,await views.snapshot(id)); }
          if (action === 'events' && method === 'GET') {
            if ([...url.searchParams.keys()].some(k=>!['offset','limit'].includes(k))) throw invalid('Unknown event filter. Set view notification filters first.');
            return json(req,res,await views.events(id,Object.fromEntries(url.searchParams)));
          }
          if (action === 'stream-ticket' && method === 'POST') { objectBody(await bodyJSON(req),[]); return json(req,res,streams.issue(id),201); }
          throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not supported for this endpoint.');
        }
        const media=/^\/media\/radio\/([A-Za-z\d_-]{1,300})$/.exec(route);
        if(media && method==='GET') {
          const id=media[1]; let bytes;
          const decoded=Buffer.from(id,'base64url').toString('utf8');
          if(decoded.startsWith('l:')) {
            const [,session,...event]=decoded.split(':'); const snapshot=await live.snapshot();
            if(String(snapshot.session.key)!==session)throw new ApiError(404,'CLIP_NOT_FOUND','This live clip has expired.');
            bytes=await live.radio(event.join(':'));
          }else{
            const event=history.clip(id);if(!event?.url)throw new ApiError(404,'CLIP_NOT_FOUND','This clip is unavailable.');
            const clip=new URL(event.url);
            if(clip.origin!=='https://livetiming.formula1.com'||!clip.pathname.startsWith('/static/')||!clip.pathname.endsWith('.mp3'))throw new ApiError(404,'CLIP_NOT_FOUND','This clip is unavailable.');
            const response=await fetchImpl(clip.href,{redirect:'manual',signal:AbortSignal.timeout(30000)});
            if(!response.ok)throw Error();
            const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw Error();chunks.push(chunk);}bytes=Buffer.concat(chunks);
          }
          res.writeHead(200,{'Content-Type':'audio/mpeg','Content-Length':bytes.length,'Cache-Control':'no-store'});return res.end(bytes);
        }
        throw new ApiError(404,'NOT_FOUND','API endpoint not found.');
      }
      if(req.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
      if(url.pathname==='/ui-config.json') {
        if(!uiConfig)throw new ApiError(503,'UI_NOT_CONFIGURED','Configure public/.env and restart the server.');
        return json(req,res,{apiToken:uiConfig.apiToken});
      }
      const allowed={'/':'index.html','/app.js':'app.js','/api-client.js':'api-client.js','/connection.js':'connection.js','/motion-buffer.js':'motion-buffer.js','/style.css':'style.css'};
      const file=allowed[url.pathname];if(!file)throw new ApiError(404,'NOT_FOUND','Not found.');
      const bytes=await readFile(path.join(ROOT,'public',file));
      const type=file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'text/css';
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-cache'});res.end(bytes);
    }catch(error){
      if(res.headersSent){res.end();return;}
      const e=error instanceof ApiError ? error : error instanceof AuthError ? new ApiError(409,'F1_AUTH_REQUIRED',error.message) : new ApiError(502,'UPSTREAM_FAILED','The requested source could not be reached. Try again.');
      json(req,res,{error:{code:e.code,message:e.message}},e.status);
    }
  });
  streams.attach(server,allowedOrigins);
  const shutdown=()=>{streams.close();account.close();views.close();live.disconnect();};
  server.on('close',shutdown); server.shutdown=shutdown; server.services={views,history,account,streams}; server.requestTimeout=70000;
  return server;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const apiToken=process.env.F1_API_TOKEN || await readApiToken();
    let uiConfig;
    try { uiConfig=await readUIConfig(); }
    catch { console.error('UI access is not configured safely. Set F1_UI_API_TOKEN in public/.env (mode 0600), then restart.'); process.exitCode=1; }
    if(!uiConfig)process.exit(1);
    const origins=(process.env.F1_ALLOWED_ORIGINS||'').split(',').filter(Boolean);
    const server=createReplayServer({apiToken,uiConfig,allowedOrigins:origins,allowInsecureLogin:process.env.F1_ALLOW_HTTP_LOGIN==='1'});
    const flag=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
    server.listen(Number(flag('--port')||process.env.PORT)||3000,flag('--host')||process.env.HOST||'127.0.0.1',()=>console.log(`F1 Replay → http://localhost:${server.address().port}`));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.shutdown();server.close();setTimeout(()=>process.exit(0),3000).unref();});
  }catch{console.error('API access is not configured safely. Run npm run api:setup, then npm start.');process.exitCode=1;}
}
