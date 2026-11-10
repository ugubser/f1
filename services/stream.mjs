import {WebSocketServer, WebSocket} from 'ws';
import {randomBytes, createHash} from 'node:crypto';
import {ApiError} from '../api-errors.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value);
const same = (a,b) => encoded(a) === encoded(b);
const OMIT = new Set(['sequence','serverTime','motionEpoch','cars']);

// Application deltas are independent of WebSocket framing and testable as data.
export function stateDelta(previous, next) {
  const changes = {};
  for (const [key,value] of Object.entries(next)) {
    if (OMIT.has(key)) continue;
    if (key === 'playback' && previous.motionEpoch === next.motionEpoch && previous.playback.time !== null && next.playback.time !== null) continue;
    if (!same(value, previous[key])) changes[key] = value;
  }
  const old = new Map(previous.cars.map(car => [car.driverNumber,car])), upsert = [];
  for (const car of next.cars) {
    const prior = old.get(car.driverNumber);
    if (!prior) { upsert.push(car); continue; }
    const patch = {driverNumber: car.driverNumber};
    for (const [key,value] of Object.entries(car)) if (key !== 'location' && !same(value,prior[key])) patch[key] = value;
    // Live visibility/staleness is authoritative; replay motion is in coordinate chunks.
    if ((car.location === null) !== (prior.location === null)) patch.location = car.location;
    if (Object.keys(patch).length > 1) upsert.push(patch);
  }
  const present = new Set(next.cars.map(c => c.driverNumber)), remove = previous.cars.filter(c => !present.has(c.driverNumber)).map(c => c.driverNumber);
  return {changes, cars: {upsert,remove}};
}

export class StreamService {
  constructor({views, now = Date.now, ticketMs = 10000, maxSockets = 24, maxBufferedBytes = 512 * 1024, maxUnacked = 32, authMs = 3000} = {}) {
    Object.assign(this,{views,now,ticketMs,maxSockets,maxBufferedBytes,maxUnacked,authMs});
    this.tickets = new Map(); this.wss = new WebSocketServer({noServer:true,maxPayload:2048,perMessageDeflate:false});
  }
  issue(viewId) {
    this.views.get(viewId);
    for (const [key,t] of this.tickets) if (t.expiresAt <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 128 || this.wss.clients.size >= this.maxSockets) throw new ApiError(429,'STREAM_LIMIT','Too many stream connections or unused tickets.');
    const ticket = randomBytes(32).toString('base64url'), expiresAt = this.now() + this.ticketMs;
    this.tickets.set(digest(ticket),{viewId,expiresAt});
    return {ticket,expiresAt,url:'/api/v1/socket',protocolVersion:1};
  }
  consume(ticket) {
    if (typeof ticket !== 'string' || ticket.length > 128) return null;
    const key = digest(ticket), value = this.tickets.get(key); this.tickets.delete(key);
    return value?.expiresAt > this.now() ? value.viewId : null;
  }
  attach(server, allowedOrigins) {
    server.on('upgrade',(req,socket,head) => {
      let url;try { url = new URL(req.url,'http://localhost'); } catch { return socket.destroy(); }
      const own = `${req.socket.encrypted?'https':'http'}://${req.headers.host}`;
      if (url.pathname !== '/api/v1/socket' || url.search || req.headers.origin && req.headers.origin !== own && !allowedOrigins.includes(req.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      if (this.wss.clients.size >= this.maxSockets) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return; }
      this.wss.handleUpgrade(req,socket,head,ws=>this.connection(ws));
    });
  }
  connection(ws) {
    let id = null, sequence = 0, acknowledged = 0, previous = null, cursor = null, busy = false, lastStateAt = 0, force = true, alive = true;
    const authTimer = setTimeout(()=>ws.close(4401,'Stream authentication required'),this.authMs);authTimer.unref();
    const send = message => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      if (ws.bufferedAmount > this.maxBufferedBytes || sequence - acknowledged >= this.maxUnacked) { ws.close(1013,'Resynchronize from a new snapshot'); return false; }
      ws.send(encoded({...message,sequence:++sequence}),error=>{if(error)ws.terminate();});return true;
    };
    const tick = async () => {
      if (!id || busy || ws.readyState !== WebSocket.OPEN) return;
      busy = true;
      try {
        const v = this.views.get(id);
        const changed = !previous || v.revision !== previous.revision || v.source !== previous.source || v.history?.status !== previous.status && v.source === 'history';
        const liveRevision = v.source === 'live' ? this.views.live.store?.revision : null;
        const liveChanged = v.source === 'live' && (liveRevision !== previous?._liveRevision || this.views.live.connection?.state !== previous?._connection);
        const needsState = force || changed || liveChanged || v.playing && this.now() - lastStateAt >= 100 || this.now() - lastStateAt >= 2000;
        if (!needsState) return;
        let snapshot = await this.views.snapshot(id,{geometry:false});
        if (!id || ws.readyState !== WebSocket.OPEN) return;
        if (!previous || snapshot.geometryRevision !== previous.geometryRevision) snapshot = await this.views.snapshot(id);
        const epochChanged = !previous || snapshot.motionEpoch !== previous.motionEpoch;
        if (epochChanged) {
          cursor = null;
          if (!send({type:'snapshot',state:snapshot})) return;
        } else {
          const delta = stateDelta(previous,snapshot);
          if (Object.keys(delta.changes).length || delta.cars.upsert.length || delta.cars.remove.length)
            if (!send({type:'state',epoch:snapshot.motionEpoch,viewSequence:snapshot.sequence,serverTime:snapshot.serverTime,revision:snapshot.revision,...delta})) return;
        }
        const coordinates = this.views.coordinates(id,snapshot,cursor);
        if (coordinates) {
          if (!send({type:'coordinates',...coordinates})) return;
          const drivers = coordinates.replace ? new Map() : cursor.drivers;
          for (const car of coordinates.cars) if (car.points.length) drivers.set(car.driverNumber,car.points.at(-1)[0]);
          cursor = {epoch:coordinates.epoch,until:coordinates.until,drivers};
        }
        previous = {...snapshot,_liveRevision:liveRevision,_connection:this.views.live.connection?.state};
        lastStateAt = this.now(); force = false;
      } catch (error) {
        send({type:'error',code:error instanceof ApiError && error.code==='VIEW_NOT_FOUND'?'VIEW_NOT_FOUND':'STATE_UNAVAILABLE',message:'The stream state is unavailable.'});
        ws.close(error instanceof ApiError && error.code==='VIEW_NOT_FOUND'?4404:1011,'Stream unavailable');
      } finally { busy = false; }
    };
    ws.on('message',(bytes,binary) => {
      try {
        if (binary) throw Error();
        const message = JSON.parse(bytes.toString());
        if (!id) {
          if (message.type !== 'auth' || Object.keys(message).some(k=>!['type','ticket'].includes(k))) throw Error();
          id = this.consume(message.ticket);
          if (!id) { ws.close(4401,'Invalid or expired stream ticket');return; }
          try{this.views.get(id);}catch{ws.close(4404,'View expired');return;}clearTimeout(authTimer);tick();return;
        }
        if (message.type === 'ack' && Number.isInteger(message.sequence) && message.sequence >= acknowledged && message.sequence <= sequence) acknowledged = message.sequence;
        else if (message.type === 'ping' && Number.isFinite(message.sentAt)) ws.send(encoded({type:'pong',sentAt:message.sentAt,serverTime:this.now()}));
        else throw Error();
      } catch { ws.close(1008,'Invalid stream message'); }
    });
    ws.on('error',()=>{});ws.on('pong',()=>{alive=true;});
    const timer = setInterval(tick,50);timer.unref();
    const heartbeat = setInterval(()=>{if(!alive)return ws.terminate();alive=false;ws.ping();},15000);heartbeat.unref();
    ws.on('close',()=>{id=null;clearTimeout(authTimer);clearInterval(timer);clearInterval(heartbeat);});
  }
  close() { if(this.closed)return;this.closed=true;this.tickets.clear();for(const ws of this.wss.clients)ws.terminate();this.wss.close(); }
}
