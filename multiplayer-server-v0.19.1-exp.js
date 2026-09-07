#!/usr/bin/env node
'use strict';

/**
 * Power Rangers RPG Character Builder — v0.19.1-exp companion room server
 * Experimental branch only. Stable standalone trunk remains v0.18.0.
 *
 * Dependency-free Node.js WebSocket server (RFC 6455 subset sufficient for
 * browser text JSON, ping/pong, fragmentation, close, and payload limits).
 *
 * Run: node multiplayer-server-v0.19.1-exp.js
 * Default: ws://localhost:8787
 */

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PROTOCOL = 1;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 12 * 60 * 60 * 1000);
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 15_000);
const MAX_LOG = Number(process.env.MAX_LOG || 200);
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD || 1024 * 1024);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const rooms = new Map();

function now() { return Date.now(); }
function normalizeRoomCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8); }
function safeClientId(v) { return String(v || '').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 128); }
function cleanText(v, max = 500) { return String(v ?? '').slice(0, max); }
function jsonClone(v, fallback) { try { return JSON.parse(JSON.stringify(v)); } catch { return fallback; } }
function cleanRulesContext(rc) { return rc && typeof rc === 'object' ? jsonClone(rc, {}) : {}; }
function cleanTeamSnapshot(s) { return s && typeof s === 'object' ? jsonClone(s, null) : null; }
function clampNumber(v, min, max, fallback = 0) { v = Number(v); return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback; }
function cleanPlayer(p, clientId) {
  p = p && typeof p === 'object' ? p : {};
  const health = p.health && typeof p.health === 'object' ? p.health : {};
  const power = p.power && typeof p.power === 'object' ? p.power : {};
  return {
    clientId,
    characterId: cleanText(p.characterId, 160),
    name: cleanText(p.name || 'Unnamed Ranger', 120),
    ranger: cleanText(p.ranger || '—', 40),
    level: clampNumber(p.level || 1, 1, 20, 1),
    rulesContext: cleanRulesContext(p.rulesContext),
    rulesFingerprint: cleanText(p.rulesFingerprint, 1000),
    health: { current: clampNumber(health.current, 0, 9999), max: clampNumber(health.max, 0, 9999) },
    power: { current: clampNumber(power.current, 0, 9999), max: clampNumber(power.max, 0, 9999) },
    morphed: !!p.morphed,
    conditions: Array.isArray(p.conditions) ? p.conditions.slice(0, 20).map(x => cleanText(x, 60)) : [],
    initiative: p.initiative === null || p.initiative === undefined ? null : clampNumber(p.initiative, -999, 999),
    turnActive: !!p.turnActive,
    zordPresence: cleanText(p.zordPresence || 'lair', 40),
    activity: cleanText(p.activity || 'Ready', 500),
    teamSnapshot: cleanTeamSnapshot(p.teamSnapshot),
    updatedAt: now()
  };
}

function publicRoom(room) {
  const members = {};
  for (const [id, m] of room.members) members[id] = { ...m.player, connected: !!m.conn, disconnectedAt: m.disconnectedAt || null };
  return {
    protocol: PROTOCOL,
    code: room.code,
    ownerId: room.ownerId,
    rulesFingerprint: room.rulesFingerprint,
    profileName: room.profileName,
    members,
    storyPoints: room.storyPoints,
    log: room.log,
    revision: room.revision,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}
function touch(room) { room.revision += 1; room.updatedAt = now(); }
function broadcast(room) {
  const payload = { type: 'room_state', room: publicRoom(room) };
  for (const member of room.members.values()) if (member.conn) member.conn.sendJSON(payload);
}
function sendError(conn, message) { conn.sendJSON({ type: 'error', message }); }
function roomForConn(conn) {
  const meta = conn.prRoom;
  if (!meta) return null;
  return rooms.get(meta.roomCode) || null;
}

function removeMember(room, clientId, announce = true) {
  const member = room.members.get(clientId);
  if (!member) return;
  if (member.cleanupTimer) clearTimeout(member.cleanupTimer);
  room.members.delete(clientId);
  if (room.ownerId === clientId) room.ownerId = [...room.members.keys()][0] || '';
  touch(room);
  if (!room.members.size) room.emptyAt = now();
  if (announce && room.members.size) broadcast(room);
}
function detach(conn, { explicit = false, announce = true } = {}) {
  const meta = conn.prRoom;
  conn.prRoom = null;
  if (!meta) return;
  const room = rooms.get(meta.roomCode);
  if (!room) return;
  const member = room.members.get(meta.clientId);
  if (!member || member.conn !== conn) return;
  if (explicit || DISCONNECT_GRACE_MS <= 0) return removeMember(room, meta.clientId, announce);
  member.conn = null;
  member.disconnectedAt = now();
  if (member.cleanupTimer) clearTimeout(member.cleanupTimer);
  member.cleanupTimer = setTimeout(() => {
    const current = room.members.get(meta.clientId);
    if (current && !current.conn && current.disconnectedAt === member.disconnectedAt) removeMember(room, meta.clientId, true);
  }, DISCONNECT_GRACE_MS);
  touch(room);
  if (announce) broadcast(room);
}
function attach(conn, room, clientId, player) {
  // A reconnect with the same client id supersedes the previous transport.
  const existing = room.members.get(clientId);
  if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
  if (existing?.conn && existing.conn !== conn) existing.conn.close(4001, 'Reconnected from another socket');
  if (conn.prRoom) detach(conn, { explicit: true, announce: false });
  room.members.set(clientId, { conn, player: cleanPlayer(player, clientId), disconnectedAt: null, cleanupTimer: null });
  conn.prRoom = { roomCode: room.code, clientId };
  room.emptyAt = null;
  touch(room);
  broadcast(room);
}
function createRoom(conn, msg, clientId) {
  const code = normalizeRoomCode(msg.roomCode);
  if (!code) return sendError(conn, 'Invalid room code.');
  if (rooms.has(code)) return sendError(conn, 'That room code already exists.');
  const player = cleanPlayer(msg.player, clientId);
  const room = {
    code,
    ownerId: clientId,
    rulesFingerprint: player.rulesFingerprint,
    profileName: cleanText(msg.player?.rulesContext?.profileName || msg.player?.rulesContext?.profileId || 'Rules Environment', 120),
    members: new Map(),
    storyPoints: clampNumber(msg.player?.storyPoints || 1, 1, 99, 1),
    log: [],
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
    emptyAt: null
  };
  rooms.set(code, room);
  attach(conn, room, clientId, player);
}
function joinRoom(conn, msg, clientId) {
  const code = normalizeRoomCode(msg.roomCode);
  const room = rooms.get(code);
  if (!room) return sendError(conn, 'Room not found.');
  const player = cleanPlayer(msg.player, clientId);
  if (room.rulesFingerprint && player.rulesFingerprint && room.rulesFingerprint !== player.rulesFingerprint) {
    return sendError(conn, `Rules Environment mismatch. Room uses ${room.profileName || 'another rules profile'}.`);
  }
  attach(conn, room, clientId, player);
}
function handleRoomMessage(conn, msg, clientId) {
  const meta = conn.prRoom;
  if (!meta || meta.clientId !== clientId) return sendError(conn, 'Join a room first.');
  const room = rooms.get(meta.roomCode);
  if (!room) return sendError(conn, 'Room no longer exists.');
  const member = room.members.get(clientId);
  if (!member || member.conn !== conn) return sendError(conn, 'Player is not active in this room.');

  switch (msg.type) {
    case 'presence_update':
      member.player = cleanPlayer(msg.player, clientId);
      member.disconnectedAt = null;
      touch(room);
      broadcast(room);
      break;
    case 'combat_event': {
      const e = msg.event && typeof msg.event === 'object' ? msg.event : {};
      const eventId = cleanText(e.id || crypto.randomUUID(), 160);
      if (room.log.some(x => x.id === eventId)) break; // idempotent retry safety
      const event = {
        id: eventId,
        kind: cleanText(e.kind || 'COMBAT_LOG', 80),
        roomCode: room.code,
        clientId,
        characterId: cleanText(e.characterId || member.player.characterId, 160),
        who: cleanText(e.who || member.player.name, 120),
        ranger: cleanText(e.ranger || member.player.ranger, 40),
        round: clampNumber(e.round || 0, 0, 999, 0),
        message: cleanText(e.message, 1000),
        at: now()
      };
      room.log.unshift(event);
      room.log = room.log.slice(0, MAX_LOG);
      member.player.activity = event.message;
      member.player.updatedAt = now();
      touch(room);
      broadcast(room);
      break;
    }
    case 'story_points_set':
      room.storyPoints = clampNumber(msg.value || 0, 0, 99, 0);
      touch(room);
      broadcast(room);
      break;
    case 'clear_shared_log':
      room.log = [];
      touch(room);
      broadcast(room);
      break;
    case 'leave':
      detach(conn, { explicit: true, announce: true });
      break;
    default:
      sendError(conn, `Unsupported message type: ${cleanText(msg.type, 80)}`);
  }
}

// ----------------------- Minimal WebSocket transport -----------------------
function makeFrame(opcode, payload = Buffer.alloc(0)) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2); header[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}
function makeConnection(socket) {
  const conn = {
    socket,
    buffer: Buffer.alloc(0),
    fragmentOpcode: null,
    fragments: [],
    fragmentBytes: 0,
    isAlive: true,
    prRoom: null,
    closed: false,
    sendJSON(obj) { if (!this.closed && !socket.destroyed) socket.write(makeFrame(0x1, Buffer.from(JSON.stringify(obj)))); },
    ping() { if (!this.closed && !socket.destroyed) socket.write(makeFrame(0x9)); },
    close(code = 1000, reason = '') {
      if (this.closed) return;
      this.closed = true;
      const r = Buffer.from(String(reason).slice(0, 120));
      const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
      try { socket.write(makeFrame(0x8, p)); } catch {}
      setTimeout(() => { try { socket.end(); } catch {} }, 10);
    }
  };
  return conn;
}
function failConnection(conn, code, reason) { conn.close(code, reason); }
function handleText(conn, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return sendError(conn, 'Invalid JSON.'); }
  if (msg.protocol !== PROTOCOL) return sendError(conn, `Protocol mismatch. Expected ${PROTOCOL}.`);
  const clientId = safeClientId(msg.clientId);
  if (!clientId) return sendError(conn, 'Missing clientId.');
  if (msg.type === 'create_room') return createRoom(conn, msg, clientId);
  if (msg.type === 'join_room') return joinRoom(conn, msg, clientId);
  handleRoomMessage(conn, msg, clientId);
}
function consumeFrames(conn, chunk) {
  conn.buffer = Buffer.concat([conn.buffer, chunk]);
  while (conn.buffer.length >= 2) {
    const b0 = conn.buffer[0], b1 = conn.buffer[1];
    const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, offset = 2;
    if (!masked) return failConnection(conn, 1002, 'Client frames must be masked');
    if (len === 126) {
      if (conn.buffer.length < 4) return;
      len = conn.buffer.readUInt16BE(2); offset = 4;
    } else if (len === 127) {
      if (conn.buffer.length < 10) return;
      const big = conn.buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) return failConnection(conn, 1009, 'Payload too large');
      len = Number(big); offset = 10;
    }
    if (len > MAX_PAYLOAD || conn.fragmentBytes + len > MAX_PAYLOAD) return failConnection(conn, 1009, 'Payload too large');
    if (conn.buffer.length < offset + 4 + len) return;
    const mask = conn.buffer.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.from(conn.buffer.subarray(offset, offset + len));
    conn.buffer = conn.buffer.subarray(offset + len);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    if (opcode === 0x8) { conn.close(); return; }
    if (opcode === 0x9) { if (!conn.closed) conn.socket.write(makeFrame(0xA, payload)); continue; }
    if (opcode === 0xA) { conn.isAlive = true; continue; }
    if (opcode !== 0x0 && opcode !== 0x1) return failConnection(conn, 1003, 'Only text frames are supported');

    if (opcode === 0x1 && !fin) {
      if (conn.fragmentOpcode !== null) return failConnection(conn, 1002, 'Unexpected fragmented message');
      conn.fragmentOpcode = 0x1; conn.fragments = [payload]; conn.fragmentBytes = payload.length; continue;
    }
    if (opcode === 0x0) {
      if (conn.fragmentOpcode === null) return failConnection(conn, 1002, 'Unexpected continuation frame');
      conn.fragments.push(payload); conn.fragmentBytes += payload.length;
      if (!fin) continue;
      const full = Buffer.concat(conn.fragments);
      conn.fragmentOpcode = null; conn.fragments = []; conn.fragmentBytes = 0;
      handleText(conn, full.toString('utf8'));
      continue;
    }
    if (opcode === 0x1 && fin) handleText(conn, payload.toString('utf8'));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, rooms: rooms.size, version: '0.19.1-exp' }));
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('Power Rangers RPG multiplayer server. Connect with WebSocket.');
});
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || version !== '13' || upgrade !== 'websocket') { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const conn = makeConnection(socket);
  socket.setNoDelay(true);
  socket.on('data', chunk => consumeFrames(conn, chunk));
  socket.on('close', () => { conn.closed = true; detach(conn, { explicit: false, announce: true }); });
  socket.on('error', () => { conn.closed = true; detach(conn, { explicit: false, announce: true }); });
  if (head && head.length) consumeFrames(conn, head);
});

const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const member of room.members.values()) {
      const conn = member.conn;
      if (!conn) continue;
      if (conn.isAlive === false) { try { conn.socket.destroy(); } catch {} continue; }
      conn.isAlive = false; conn.ping();
    }
  }
  const cutoff = now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) if (!room.members.size && (room.emptyAt || room.updatedAt) < cutoff) rooms.delete(code);
}, 30_000);

function shutdown() {
  clearInterval(heartbeat);
  for (const room of rooms.values()) for (const m of room.members.values()) if (m.cleanupTimer) clearTimeout(m.cleanupTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => console.log(`Power Rangers RPG v0.19.1-exp room server listening on ws://${HOST}:${PORT}`));
