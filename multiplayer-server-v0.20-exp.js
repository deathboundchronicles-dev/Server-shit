#!/usr/bin/env node
'use strict';

/**
 * Power Rangers RPG Character Builder — v0.20-exp GM authority room server
 * Experimental branch only. Stable standalone trunk remains v0.18.0.
 *
 * Extends the v0.19.1-exp realtime room server with a first-class GM seat,
 * server-authoritative encounter roster, shared initiative controller, and
 * enemy Health tracking. The room creator is always the GM. Players cannot
 * acquire GM authority when the GM disconnects or times out.
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
const MAX_ACTORS = Number(process.env.MAX_ACTORS || 100);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const rooms = new Map();

function now() { return Date.now(); }
function normalizeRoomCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8); }
function safeClientId(v) { return String(v || '').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 128); }
function safeActorId(v) { return String(v || '').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 180); }
function cleanText(v, max = 500) { return String(v ?? '').slice(0, max); }
function jsonClone(v, fallback) { try { return JSON.parse(JSON.stringify(v)); } catch { return fallback; } }
function cleanRulesContext(rc) { return rc && typeof rc === 'object' ? jsonClone(rc, {}) : {}; }
function cleanTeamSnapshot(s) { return s && typeof s === 'object' ? jsonClone(s, null) : null; }
function clampNumber(v, min, max, fallback = 0) { v = Number(v); return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback; }
function nullableNumber(v, min = -999, max = 999) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null; }
function cleanConditions(v) { return Array.isArray(v) ? v.slice(0, 20).map(x => cleanText(x, 60)) : []; }

function cleanMember(p, clientId, role) {
  p = p && typeof p === 'object' ? p : {};
  role = role === 'gm' ? 'gm' : 'player';
  const health = p.health && typeof p.health === 'object' ? p.health : {};
  const power = p.power && typeof p.power === 'object' ? p.power : {};
  return {
    clientId,
    role,
    characterId: role === 'gm' ? '' : cleanText(p.characterId, 160),
    name: role === 'gm' ? 'Game Master' : cleanText(p.name || 'Unnamed Ranger', 120),
    ranger: role === 'gm' ? 'GM' : cleanText(p.ranger || '—', 40),
    level: role === 'gm' ? 0 : clampNumber(p.level || 1, 1, 20, 1),
    rulesContext: cleanRulesContext(p.rulesContext),
    rulesFingerprint: cleanText(p.rulesFingerprint, 1000),
    health: role === 'gm' ? { current: 0, max: 0 } : { current: clampNumber(health.current, 0, 9999), max: clampNumber(health.max, 0, 9999) },
    power: role === 'gm' ? { current: 0, max: 0 } : { current: clampNumber(power.current, 0, 9999), max: clampNumber(power.max, 0, 9999) },
    morphed: role === 'gm' ? false : !!p.morphed,
    conditions: role === 'gm' ? [] : cleanConditions(p.conditions),
    initiative: role === 'gm' ? null : nullableNumber(p.initiative),
    turnActive: role === 'gm' ? false : !!p.turnActive,
    zordPresence: role === 'gm' ? '—' : cleanText(p.zordPresence || 'lair', 40),
    activity: cleanText(p.activity || (role === 'gm' ? 'Running the table' : 'Ready'), 500),
    teamSnapshot: role === 'gm' ? null : cleanTeamSnapshot(p.teamSnapshot),
    updatedAt: now()
  };
}

function blankEncounter() {
  return { active: false, round: 1, turnIndex: -1, actors: [], updatedAt: now() };
}
function cleanNpcActor(a) {
  a = a && typeof a === 'object' ? a : {};
  const max = clampNumber(a.maxHealth ?? a.health?.max ?? 1, 1, 9999, 1);
  const cur = clampNumber(a.health?.current ?? max, 0, max, max);
  return {
    id: safeActorId(a.id) || `npc:${crypto.randomUUID()}`,
    kind: 'npc',
    clientId: '',
    name: cleanText(a.name || 'Enemy', 120),
    ranger: 'NPC',
    initiative: nullableNumber(a.initiative),
    health: { current: cur, max },
    conditions: cleanConditions(a.conditions),
    notes: cleanText(a.notes || '', 1000)
  };
}
function playerActorFromMember(member, existing = null) {
  const p = member.player;
  return {
    id: existing?.id || `pc:${p.clientId}`,
    kind: 'player',
    clientId: p.clientId,
    name: p.name,
    ranger: p.ranger,
    initiative: p.initiative ?? existing?.initiative ?? null,
    health: null,
    conditions: [],
    notes: ''
  };
}
function syncEncounterPlayers(room) {
  const encounter = room.encounter || (room.encounter = blankEncounter());
  const oldPlayers = new Map(encounter.actors.filter(a => a.kind === 'player').map(a => [a.clientId, a]));
  const npcs = encounter.actors.filter(a => a.kind === 'npc');
  const players = [];
  for (const member of room.members.values()) {
    if (member.player.role === 'gm') continue;
    players.push(playerActorFromMember(member, oldPlayers.get(member.player.clientId)));
  }
  encounter.actors = [...players, ...npcs].slice(0, MAX_ACTORS);
  if (encounter.turnIndex >= encounter.actors.length) encounter.turnIndex = encounter.actors.length ? encounter.actors.length - 1 : -1;
  encounter.updatedAt = now();
}
function sortEncounter(encounter) {
  encounter.actors.sort((a, b) => (b.initiative ?? -9999) - (a.initiative ?? -9999) || String(a.name || '').localeCompare(String(b.name || '')));
}
function currentActor(encounter) {
  return encounter.active && encounter.turnIndex >= 0 ? encounter.actors[encounter.turnIndex] || null : null;
}
function pushSystemLog(room, message) {
  const e = room.encounter || blankEncounter();
  room.log.unshift({ id: crypto.randomUUID(), kind: 'GM_SYSTEM', roomCode: room.code, clientId: room.ownerId, characterId: '', who: 'GM', ranger: 'GM', round: e.active ? e.round : 0, message: cleanText(message, 1000), at: now() });
  room.log = room.log.slice(0, MAX_LOG);
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
    encounter: room.encounter,
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
function sendError(conn, message, code = 'ROOM_ERROR') { conn.sendJSON({ type: 'error', code, message }); }
function roomForConn(conn) { const meta = conn.prRoom; if (!meta) return null; return rooms.get(meta.roomCode) || null; }
function isGm(room, clientId) { return !!room && room.ownerId === clientId; }
function requireGm(conn, room, clientId) { if (isGm(room, clientId)) return true; sendError(conn, 'GM authority required for that room action.', 'GM_AUTHORITY_REQUIRED'); return false; }

function removeMember(room, clientId, announce = true) {
  const member = room.members.get(clientId);
  if (!member) return;
  if (member.cleanupTimer) clearTimeout(member.cleanupTimer);
  room.members.delete(clientId);
  // v0.20-exp: GM authority never transfers to a player. ownerId remains stable
  // so the same GM clientId may reclaim control after a longer interruption.
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
function attach(conn, room, clientId, player, role) {
  const existing = room.members.get(clientId);
  if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
  if (existing?.conn && existing.conn !== conn) existing.conn.close(4001, 'Reconnected from another socket');
  if (conn.prRoom) detach(conn, { explicit: true, announce: false });
  const cleaned = cleanMember(player, clientId, role);
  room.members.set(clientId, { conn, player: cleaned, disconnectedAt: null, cleanupTimer: null });
  conn.prRoom = { roomCode: room.code, clientId };
  room.emptyAt = null;
  touch(room);
  broadcast(room);
}
function createRoom(conn, msg, clientId) {
  const code = normalizeRoomCode(msg.roomCode);
  if (!code) return sendError(conn, 'Invalid room code.');
  if (rooms.has(code)) return sendError(conn, 'That room code already exists.');
  const gm = cleanMember(msg.player, clientId, 'gm');
  const room = {
    code,
    ownerId: clientId,
    rulesFingerprint: gm.rulesFingerprint,
    profileName: cleanText(msg.player?.rulesContext?.profileName || msg.player?.rulesContext?.profileId || 'Rules Environment', 120),
    members: new Map(),
    storyPoints: clampNumber(msg.storyPoints ?? 1, 1, 99, 1),
    log: [],
    encounter: blankEncounter(),
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
    emptyAt: null
  };
  rooms.set(code, room);
  attach(conn, room, clientId, gm, 'gm');
}
function joinRoom(conn, msg, clientId) {
  const code = normalizeRoomCode(msg.roomCode);
  const room = rooms.get(code);
  if (!room) return sendError(conn, 'Room not found.');
  const role = clientId === room.ownerId ? 'gm' : 'player';
  const player = cleanMember(msg.player, clientId, role);
  if (room.rulesFingerprint && player.rulesFingerprint && room.rulesFingerprint !== player.rulesFingerprint) {
    return sendError(conn, `Rules Environment mismatch. Room uses ${room.profileName || 'another rules profile'}.`);
  }
  attach(conn, room, clientId, player, role);
}
function handleGmEncounterControl(room, msg) {
  let e = room.encounter || (room.encounter = blankEncounter());
  const action = cleanText(msg.action, 30);
  if (action === 'sync') syncEncounterPlayers(room);
  else if (action === 'start') {
    syncEncounterPlayers(room);
    e = room.encounter;
    sortEncounter(e);
    e.active = e.actors.length > 0;
    e.round = 1;
    e.turnIndex = e.active ? 0 : -1;
    if (e.active) pushSystemLog(room, `Encounter started. ${currentActor(e)?.name || 'First combatant'} has the first turn.`);
  } else if (action === 'next') {
    if (!e.actors.length) return;
    if (!e.active) { e.active = true; e.round = Math.max(1, e.round || 1); e.turnIndex = Math.max(0, e.turnIndex); }
    else {
      e.turnIndex += 1;
      if (e.turnIndex >= e.actors.length) { e.turnIndex = 0; e.round += 1; }
    }
  } else if (action === 'previous') {
    if (!e.actors.length) return;
    if (!e.active) { e.active = true; e.round = Math.max(1, e.round || 1); e.turnIndex = 0; }
    else {
      e.turnIndex -= 1;
      if (e.turnIndex < 0) { e.turnIndex = e.actors.length - 1; e.round = Math.max(1, e.round - 1); }
    }
  } else if (action === 'end') {
    if (e.active) pushSystemLog(room, `Encounter ended in round ${e.round}.`);
    e.active = false; e.turnIndex = -1;
  } else if (action === 'clear') {
    room.encounter = blankEncounter();
    pushSystemLog(room, 'Encounter roster cleared.');
    return;
  }
  e.updatedAt = now();
}
function handleRoomMessage(conn, msg, clientId) {
  const meta = conn.prRoom;
  if (!meta || meta.clientId !== clientId) return sendError(conn, 'Join a room first.');
  const room = rooms.get(meta.roomCode);
  if (!room) return sendError(conn, 'Room no longer exists.');
  const member = room.members.get(clientId);
  if (!member || member.conn !== conn) return sendError(conn, 'Player is not active in this room.');

  switch (msg.type) {
    case 'presence_update': {
      const role = isGm(room, clientId) ? 'gm' : 'player';
      member.player = cleanMember(msg.player, clientId, role);
      member.disconnectedAt = null;
      // Keep player labels fresh without stealing initiative authority from the GM.
      if (role === 'player' && room.encounter?.actors?.length) {
        const actor = room.encounter.actors.find(a => a.kind === 'player' && a.clientId === clientId);
        if (actor) { actor.name = member.player.name; actor.ranger = member.player.ranger; room.encounter.updatedAt = now(); }
      }
      touch(room); broadcast(room); break;
    }
    case 'combat_event': {
      const e = msg.event && typeof msg.event === 'object' ? msg.event : {};
      const eventId = cleanText(e.id || crypto.randomUUID(), 160);
      if (room.log.some(x => x.id === eventId)) break;
      const event = {
        id: eventId,
        kind: cleanText(e.kind || 'COMBAT_LOG', 80),
        roomCode: room.code,
        clientId,
        characterId: member.player.role === 'gm' ? '' : cleanText(e.characterId || member.player.characterId, 160),
        who: member.player.role === 'gm' ? 'GM' : cleanText(e.who || member.player.name, 120),
        ranger: member.player.role === 'gm' ? 'GM' : cleanText(e.ranger || member.player.ranger, 40),
        round: room.encounter?.active ? room.encounter.round : clampNumber(e.round || 0, 0, 999, 0),
        message: cleanText(e.message, 1000),
        at: now()
      };
      room.log.unshift(event); room.log = room.log.slice(0, MAX_LOG);
      member.player.activity = event.message; member.player.updatedAt = now();
      touch(room); broadcast(room); break;
    }
    case 'story_points_set':
      room.storyPoints = clampNumber(msg.value || 0, 0, 99, 0);
      touch(room); broadcast(room); break;
    case 'clear_shared_log':
      if (!requireGm(conn, room, clientId)) break;
      room.log = []; touch(room); broadcast(room); break;
    case 'gm_sync_players':
      if (!requireGm(conn, room, clientId)) break;
      syncEncounterPlayers(room); touch(room); broadcast(room); break;
    case 'gm_actor_add': {
      if (!requireGm(conn, room, clientId)) break;
      const e = room.encounter || (room.encounter = blankEncounter());
      if (e.actors.length >= MAX_ACTORS) { sendError(conn, `Encounter actor limit reached (${MAX_ACTORS}).`); break; }
      const actor = cleanNpcActor(msg.actor);
      if (e.actors.some(a => a.id === actor.id)) actor.id = `npc:${crypto.randomUUID()}`;
      e.actors.push(actor); e.updatedAt = now(); touch(room); broadcast(room); break;
    }
    case 'gm_actor_update': {
      if (!requireGm(conn, room, clientId)) break;
      const e = room.encounter || (room.encounter = blankEncounter());
      const actorId = safeActorId(msg.actorId);
      const actor = e.actors.find(a => a.id === actorId);
      if (!actor) { sendError(conn, 'Encounter actor not found.'); break; }
      const p = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
      if (Object.prototype.hasOwnProperty.call(p, 'initiative')) actor.initiative = nullableNumber(p.initiative);
      if (actor.kind === 'npc') {
        if (Object.prototype.hasOwnProperty.call(p, 'name')) actor.name = cleanText(p.name || 'Enemy', 120);
        if (Object.prototype.hasOwnProperty.call(p, 'healthMax')) { actor.health.max = clampNumber(p.healthMax, 1, 9999, actor.health.max); actor.health.current = Math.min(actor.health.current, actor.health.max); }
        if (Object.prototype.hasOwnProperty.call(p, 'healthCurrent')) actor.health.current = clampNumber(p.healthCurrent, 0, actor.health.max, actor.health.current);
        if (Object.prototype.hasOwnProperty.call(p, 'conditions')) actor.conditions = cleanConditions(p.conditions);
        if (Object.prototype.hasOwnProperty.call(p, 'notes')) actor.notes = cleanText(p.notes, 1000);
      }
      e.updatedAt = now(); touch(room); broadcast(room); break;
    }
    case 'gm_actor_remove': {
      if (!requireGm(conn, room, clientId)) break;
      const e = room.encounter || (room.encounter = blankEncounter());
      const actorId = safeActorId(msg.actorId);
      const idx = e.actors.findIndex(a => a.id === actorId);
      if (idx < 0) break;
      e.actors.splice(idx, 1);
      if (!e.actors.length) { e.active = false; e.turnIndex = -1; }
      else if (e.turnIndex > idx) e.turnIndex -= 1;
      else if (e.turnIndex >= e.actors.length) e.turnIndex = e.actors.length - 1;
      e.updatedAt = now(); touch(room); broadcast(room); break;
    }
    case 'gm_encounter_control':
      if (!requireGm(conn, room, clientId)) break;
      handleGmEncounterControl(room, msg); touch(room); broadcast(room); break;
    case 'gm_set_turn': {
      if (!requireGm(conn, room, clientId)) break;
      const e = room.encounter || (room.encounter = blankEncounter());
      const idx = e.actors.findIndex(a => a.id === safeActorId(msg.actorId));
      if (idx >= 0) { e.active = true; e.round = Math.max(1, e.round || 1); e.turnIndex = idx; e.updatedAt = now(); touch(room); broadcast(room); }
      break;
    }
    case 'leave':
      detach(conn, { explicit: true, announce: true }); break;
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
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, rooms: rooms.size, version: '0.20-exp' }));
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

server.listen(PORT, HOST, () => console.log(`Power Rangers RPG v0.20-exp GM room server listening on ws://${HOST}:${PORT}`));
