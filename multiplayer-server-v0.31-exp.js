#!/usr/bin/env node
'use strict';

/**
 * Power Rangers RPG Character Builder — v0.31-exp Advanced Topography Phase 2B room server
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
const PROTOCOL = 10;
const VTT_GROUND_SUPPORT = '__ground__';
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 12 * 60 * 60 * 1000);
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 15_000);
const MAX_LOG = Number(process.env.MAX_LOG || 200);
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD || 5 * 1024 * 1024);
const MAX_ROOM_ASSETS = Number(process.env.MAX_ROOM_ASSETS || 120);
const MAX_ASSET_DATA = Number(process.env.MAX_ASSET_DATA || 3_700_000);
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
function cleanGmSheet(s) { if (!s || typeof s !== 'object') return null; const x = jsonClone(s, null); return x; }
function cleanAttack(a) { a = a && typeof a === 'object' ? a : {}; return { name: cleanText(a.name || 'Attack', 120), die: cleanText(a.die || 'd4', 8), defense: ['Toughness','Evasion','Willpower','Cleverness'].includes(a.defense) ? a.defense : 'Toughness', damage: clampNumber(a.damage || 0, 0, 99, 0), damageType: cleanText(a.damageType || '', 40), range: cleanText(a.range || 'Reach', 80), specialized: !!a.specialized, effect: cleanText(a.effect || '', 800), ruleWarning: cleanText(a.ruleWarning || '', 900), uses: a.uses === null || a.uses === undefined ? null : clampNumber(a.uses, 0, 99, 0), multi: a.multi !== false, rollCount: clampNumber(a.rollCount || 1, 1, 6, 1), hitsRequired: clampNumber(a.hitsRequired || 1, 1, 6, 1), followUps: Array.isArray(a.followUps) ? a.followUps.slice(0, 12).map(x => cleanText(x, 120)) : null }; }
function cleanAbility(a) { a = a && typeof a === 'object' ? a : {}; return { name: cleanText(a.name || 'Ability', 120), text: cleanText(a.text || '', 1200), cost: ['free','move','standard','full'].includes(a.cost) ? a.cost : 'free', uses: a.uses === null || a.uses === undefined ? null : clampNumber(a.uses, 0, 99, 0), ruleWarning: cleanText(a.ruleWarning || '', 900) }; }
function cleanThreatTemplate(t) { if (!t || typeof t !== 'object') return null; const d=t.defenses&&typeof t.defenses==='object'?t.defenses:{}; return { id: cleanText(t.id || '', 180), name: cleanText(t.name || 'Threat', 120), source: cleanText(t.source || 'Custom', 80), page: cleanText(t.page || '', 20), threatLevel: clampNumber(t.threatLevel || 0, 0, 99, 0), size: cleanText(t.size || 'Common', 40), health: clampNumber(t.health || 1, 1, 9999, 1), defenses: { Toughness: clampNumber(d.Toughness || 10, 0, 999, 10), Evasion: clampNumber(d.Evasion || 10, 0, 999, 10), Willpower: clampNumber(d.Willpower || 10, 0, 999, 10), Cleverness: clampNumber(d.Cleverness || 10, 0, 999, 10) }, movement: cleanText(t.movement || '', 200), skills: cleanText(t.skills || '', 1500), initiativeDie: t.initiativeDie ? cleanText(t.initiativeDie, 8) : null, attacks: Array.isArray(t.attacks) ? t.attacks.slice(0, 24).map(cleanAttack) : [], abilities: Array.isArray(t.abilities) ? t.abilities.slice(0, 30).map(cleanAbility) : [], maxAttacksPerAction: clampNumber(t.maxAttacksPerAction || 1, 1, 8, 1), multiAttackNote: cleanText(t.multiAttackNote || '', 600), art: cleanTokenArt(t.art) }; }
function clampNumber(v, min, max, fallback = 0) { v = Number(v); return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback; }
function nullableNumber(v, min = -999, max = 999) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null; }
function cleanConditions(v) { return Array.isArray(v) ? v.slice(0, 20).map(x => cleanText(x, 60)) : []; }
function cleanMapUrl(v) { const x = cleanText(v || '', 2048).trim(); return /^https?:\/\//i.test(x) ? x : ''; }
function cleanAssetId(v) { return safeActorId(v); }
function cleanTokenArt(a) { a=a&&typeof a==='object'?a:{}; return { url: cleanMapUrl(a.url), credit: cleanText(a.credit||'',160), assetId: cleanAssetId(a.assetId||'') }; }
function cleanAsset(a) { a=a&&typeof a==='object'?a:{}; const id=cleanAssetId(a.id), dataUrl=String(a.dataUrl||''); if(!id||dataUrl.length>MAX_ASSET_DATA||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl)) return null; return { id, kind: cleanText(a.kind||'art',30), name: cleanText(a.name||id,160), dataUrl, updatedAt: now() }; }
function cleanPoint(p){p=p&&typeof p==='object'?p:{};return{x:clampNumber(p.x,-20000,20000,0),y:clampNumber(p.y,-20000,20000,0)}}
function cleanWall(w){w=w&&typeof w==='object'?w:{};return{id:safeActorId(w.id)||`wall:${crypto.randomUUID()}`,kind:'wall',ownerId:safeClientId(w.ownerId||''),x1:clampNumber(w.x1,-20000,20000,0),y1:clampNumber(w.y1,-20000,20000,0),x2:clampNumber(w.x2,-20000,20000,0),y2:clampNumber(w.y2,-20000,20000,0),at:clampNumber(w.at||now(),0,Number.MAX_SAFE_INTEGER,now())}}
function cleanTerrain(z){z=z&&typeof z==='object'?z:{};return{id:safeActorId(z.id)||`terrain:${crypto.randomUUID()}`,kind:'terrain',ownerId:safeClientId(z.ownerId||''),x1:clampNumber(z.x1,-20000,20000,0),y1:clampNumber(z.y1,-20000,20000,0),x2:clampNumber(z.x2,-20000,20000,0),y2:clampNumber(z.y2,-20000,20000,0),terrainType:['difficult','hazard','cover'].includes(z.terrainType)?z.terrainType:'difficult',label:cleanText(z.label||'',80),at:clampNumber(z.at||now(),0,Number.MAX_SAFE_INTEGER,now())}}
function cleanTopology(z){z=z&&typeof z==='object'?z:{};const shape=z.shape==='poly'?'poly':'rect',points=shape==='poly'&&Array.isArray(z.points)?z.points.slice(0,80).map(cleanPoint):[],traversal=['slope','climb','difficult','impassable'].includes(z.traversal)?z.traversal:'climb',legacyCheck=z.checkRequired===undefined&&traversal==='difficult';return{id:safeActorId(z.id)||`topo:${crypto.randomUUID()}`,kind:'topography',ownerId:safeClientId(z.ownerId||''),shape,name:cleanText(z.name||'Topography',100),x1:clampNumber(z.x1,-20000,20000,0),y1:clampNumber(z.y1,-20000,20000,0),x2:clampNumber(z.x2,-20000,20000,0),y2:clampNumber(z.y2,-20000,20000,0),points,baseElevation:Math.round(clampNumber(z.baseElevation,-10000,10000,0)/5)*5,height:Math.round(clampNumber(z.height,0,10000,10)/5)*5,volumeMode:['solid','platform','depression'].includes(z.volumeMode)?z.volumeMode:'solid',surfaceMode:z.surfaceMode==='slope'?'slope':'flat',slopeDirection:['north','south','east','west'].includes(z.slopeDirection)?z.slopeDirection:'east',thickness:clampNumber(z.thickness,.5,50,2),traversal,checkRequired:z.checkRequired===undefined?legacyCheck:!!z.checkRequired,checkSkill:cleanText(z.checkSkill||'Athletics',80),checkDif:clampNumber(z.checkDif||10,1,999,10),jumpMode:z.jumpMode==='never'?'never':'auto',topOccupiable:z.topOccupiable!==false,blockMode:['never','conditional','always'].includes(z.blockMode)?z.blockMode:'conditional',sightMode:['never','auto','always'].includes(z.sightMode)?z.sightMode:'auto',coverMode:['none','auto','cover','total'].includes(z.coverMode)?z.coverMode:'auto',ignoreAtSize:cleanText(z.ignoreAtSize||'',30),at:clampNumber(z.at||now(),0,Number.MAX_SAFE_INTEGER,now())}}
function cleanDrawing(d){d=d&&typeof d==='object'?d:{};return{id:safeActorId(d.id)||`draw:${crypto.randomUUID()}`,kind:'drawing',ownerId:safeClientId(d.ownerId||''),points:Array.isArray(d.points)?d.points.slice(0,120).map(cleanPoint):[],at:clampNumber(d.at||now(),0,Number.MAX_SAFE_INTEGER,now())}}
function cleanTemplate(t){t=t&&typeof t==='object'?t:{};return{id:safeActorId(t.id)||`template:${crypto.randomUUID()}`,kind:'template',ownerId:safeClientId(t.ownerId||''),shape:['circle','cone','line','square'].includes(t.shape)?t.shape:'circle',x1:clampNumber(t.x1,-20000,20000,0),y1:clampNumber(t.y1,-20000,20000,0),x2:clampNumber(t.x2,-20000,20000,0),y2:clampNumber(t.y2,-20000,20000,0),at:clampNumber(t.at||now(),0,Number.MAX_SAFE_INTEGER,now())}}
function blankTactical() { return { map: { id:'', assetId:'', url: '', name: 'Untitled Map', columns: 30, rows: 18, gridSize: 64, feetPerSquare: 5, gridVisible: true, snap: true, imageWidth: 1600, imageHeight: 900, imageScale: 1, offsetX: 0, offsetY: 0, fogEnabled:false, visionFeet:60, walls:[], terrain:[], topography:[], drawings:[], templates:[] }, positions: {}, elevations:{}, supports:{}, orientations:{}, mapPositionSets:{}, movement:{actorId:'',round:0,spent:0,bonus:0,tokenId:'',path:[]}, updatedAt: now() }; }
function cleanTacticalMap(m, old = null) { m=m&&typeof m==='object'?m:{}; old=old||blankTactical().map; return { id:cleanAssetId(m.id||old.id||''), assetId:cleanAssetId(m.assetId||old.assetId||''), url:cleanMapUrl(Object.prototype.hasOwnProperty.call(m,'url')?m.url:old.url), name:cleanText(m.name||old.name||'Untitled Map',120), columns:clampNumber(m.columns||old.columns,4,200,old.columns), rows:clampNumber(m.rows||old.rows,4,200,old.rows), gridSize:64, feetPerSquare:clampNumber(m.feetPerSquare||old.feetPerSquare,1,100,old.feetPerSquare), gridVisible:m.gridVisible!==false, snap:m.snap!==false, imageWidth:clampNumber(m.imageWidth||old.imageWidth,1,10000,old.imageWidth), imageHeight:clampNumber(m.imageHeight||old.imageHeight,1,10000,old.imageHeight), imageScale:clampNumber(m.imageScale||old.imageScale,.05,12,old.imageScale), offsetX:clampNumber(m.offsetX??old.offsetX,-12000,12000,old.offsetX), offsetY:clampNumber(m.offsetY??old.offsetY,-12000,12000,old.offsetY), fogEnabled:!!m.fogEnabled, visionFeet:clampNumber(m.visionFeet||old.visionFeet||60,5,1000,60), walls:(Array.isArray(m.walls)?m.walls:old.walls||[]).slice(0,200).map(cleanWall), terrain:(Array.isArray(m.terrain)?m.terrain:old.terrain||[]).slice(0,100).map(cleanTerrain), topography:(Array.isArray(m.topography)?m.topography:old.topography||[]).slice(0,160).map(cleanTopology), drawings:(Array.isArray(m.drawings)?m.drawings:old.drawings||[]).slice(0,100).map(cleanDrawing), templates:(Array.isArray(m.templates)?m.templates:old.templates||[]).slice(0,100).map(cleanTemplate) }; }
function segmentIntersect(a,b,c,d){const eps=1e-7,cross=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x),on=(p,q,r)=>Math.min(p.x,r.x)-eps<=q.x&&q.x<=Math.max(p.x,r.x)+eps&&Math.min(p.y,r.y)-eps<=q.y&&q.y<=Math.max(p.y,r.y)+eps&&Math.abs(cross(p,q,r))<=eps,o1=cross(a,b,c),o2=cross(a,b,d),o3=cross(c,d,a),o4=cross(c,d,b);if(((o1>eps&&o2<-eps)||(o1<-eps&&o2>eps))&&((o3>eps&&o4<-eps)||(o3<-eps&&o4>eps)))return true;return Math.abs(o1)<=eps&&on(a,c,b)||Math.abs(o2)<=eps&&on(a,d,b)||Math.abs(o3)<=eps&&on(c,a,d)||Math.abs(o4)<=eps&&on(c,b,d);}
function gridDistance(a,b,map){const g=map.gridSize||64,fps=map.feetPerSquare||5,dx=Math.abs(b.x-a.x)/g,dy=Math.abs(b.y-a.y)/g;return Math.max(dx,dy)*fps;}
function tacticalOrientation(room,id){return room.tactical?.orientations?.[id]==='rotated'?'rotated':'normal';}
function tacticalSizeFootprint(size,map,orientation='normal'){const fps=Math.max(1,+map.feetPerSquare||5);let feet=({Tiny:[2.5,2.5],Small:[5,5],Common:[5,5],Large:[10,10],Long:[5,10],Huge:[15,15],Extended:[10,20],Gigantic:[20,20],Towering:[25,25],Titanic:[30,30]})[size]||[5,5];if(orientation==='rotated'&&feet[0]!==feet[1])feet=[feet[1],feet[0]];return{cols:Math.max(1,Math.ceil(feet[0]/fps)),rows:Math.max(1,Math.ceil(feet[1]/fps))};}
function threatAthleticsDie(th){const m=String(th?.skills||'').match(/Athletics(?:\s*\([^)]*\))?\s*\+?d(2|4|6|8|10|12)(\*)?/i);return m?{die:+m[1],specialized:!!m[2]}:{die:0,specialized:false};}
function threatMobility(th){th=th||{};const mv=String(th.movement||''),abs=(th.abilities||[]).map(a=>`${a.name||''} ${a.text||''}`).join(' | '),jm=abs.match(/(?:jump|leap)[^\d]{0,30}(?:up to\s*)?(\d+)\s*ft/i),climb=/\bclimb(?:ing)?\s*\d+\s*ft/i.test(mv)||/climb(?:ing)? (?:does not|doesn't) (?:halve|reduce)|climb speed/i.test(abs),fly=/\baerial\s*\d+\s*ft|\bfly(?:ing)?\s*\d+\s*ft/i.test(mv),ath=threatAthleticsDie(th);return{climbMultiplier:climb?1:2,climbTestExempt:false,cling:/cling|wall.?crawl|ceiling/i.test(abs),jumpMultiplier:1,superLeap:jm?+jm[1]:0,athleticsDie:ath.die,athleticsSpecialized:ath.specialized,canFly:fly};}
function tacticalTokenInfo(room,id){if(id.startsWith('pc:')){const clientId=id.slice(3),m=room.members.get(clientId);if(!m||m.player.role==='gm')return null;return{id,kind:'player',clientId,size:'Common',conditions:m.player.conditions||[],movement:+m.player.movement||0,mobility:cleanMobility(m.player.mobility),side:'player'};}if(id.startsWith('zord:')){const clientId=id.slice(5),m=room.members.get(clientId),z=m?.player?.teamSnapshot?.zord;if(!m||m.player.role==='gm'||!z)return null;return{id,kind:'zord',clientId,size:z.stats?.size||'Huge',conditions:[],movement:parseFloat(String(z.stats?.ground??z.stats?.movement??0))||0,mobility:cleanMobility({}),side:'player'};}const a=(room.encounter?.actors||[]).find(x=>x.id===id&&x.kind==='npc');if(!a)return null;const th=a.threat||{};const mv=String(th.movement||'');const ground=mv.match(/(?:ground(?: movement)?\s*)?(\d+(?:\.\d+)?)\s*ft/i),any=mv.match(/(\d+(?:\.\d+)?)\s*ft/i);return{id,kind:'npc',clientId:'',size:th.size||'Common',conditions:a.conditions||[],movement:+(ground?.[1]||any?.[1]||0),mobility:threatMobility(th),side:'npc',threat:th};}
function tacticalTokens(room){const out=[];for(const m of room.members.values())if(m.player.role!=='gm'){const pc=tacticalTokenInfo(room,`pc:${m.player.clientId}`);if(pc)out.push(pc);if(m.player.zordPresence&&!['lair','recalled','—'].includes(m.player.zordPresence)&&m.player.teamSnapshot?.zord?.configured){const z=tacticalTokenInfo(room,`zord:${m.player.clientId}`);if(z)out.push(z);}}for(const a of room.encounter?.actors||[])if(a.kind==='npc'){const t=tacticalTokenInfo(room,a.id);if(t)out.push(t);}return out;}
function tacticalTokenRect(room,tok,pos){const map=room.tactical?.map||blankTactical().map,g=map.gridSize||64,fp=tacticalSizeFootprint(tok.size,map,tacticalOrientation(room,tok.id)),w=fp.cols*g,h=fp.rows*g,x=+pos?.x||0,y=+pos?.y||0;return{left:x-w/2,right:x+w/2,top:y-h/2,bottom:y+h/2,w,h};}
function rectCorners(r){return[{x:r.left,y:r.top},{x:r.right,y:r.top},{x:r.right,y:r.bottom},{x:r.left,y:r.bottom}];}
function convexHull(points){points=[...points].sort((a,b)=>a.x-b.x||a.y-b.y);const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);let lo=[],hi=[];for(const p of points){while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p)}for(let i=points.length-1;i>=0;i--){const p=points[i];while(hi.length>=2&&cross(hi[hi.length-2],hi[hi.length-1],p)<=0)hi.pop();hi.push(p)}return lo.slice(0,-1).concat(hi.slice(0,-1));}
function pointInPoly(p,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j],hit=((a.y>p.y)!==(b.y>p.y))&&(p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y||1e-12)+a.x);if(hit)inside=!inside}return inside;}
function segmentPolyIntersect(a,b,poly){if(pointInPoly(a,poly)||pointInPoly(b,poly))return true;for(let i=0;i<poly.length;i++)if(segmentIntersect(a,b,poly[i],poly[(i+1)%poly.length]))return true;return false;}
function sweptTokenPoly(room,tok,a,b){return convexHull([...rectCorners(tacticalTokenRect(room,tok,a)),...rectCorners(tacticalTokenRect(room,tok,b))]);}
function topologyPoly(z){if(!z)return[];if(z.shape==='poly')return(z.points||[]).map(cleanPoint);const x1=+z.x1||0,y1=+z.y1||0,x2=+z.x2||0,y2=+z.y2||0;return[{x:Math.min(x1,x2),y:Math.min(y1,y2)},{x:Math.max(x1,x2),y:Math.min(y1,y2)},{x:Math.max(x1,x2),y:Math.max(y1,y2)},{x:Math.min(x1,x2),y:Math.max(y1,y2)}];}
function topologyBounds(z){const p=topologyPoly(z);if(!p.length)return{left:0,right:0,top:0,bottom:0,w:1,h:1};const xs=p.map(q=>q.x),ys=p.map(q=>q.y),left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);return{left,right,top,bottom,w:Math.max(1,right-left),h:Math.max(1,bottom-top)};}
function topologySurfaceAt(z,p=null){const base=+z?.baseElevation||0,h=+z?.height||0;if(!z||z.surfaceMode!=='slope'||!p)return base+h;const b=topologyBounds(z),dir=z.slopeDirection||'east';let t=0;if(dir==='east')t=(p.x-b.left)/b.w;else if(dir==='west')t=(b.right-p.x)/b.w;else if(dir==='south')t=(p.y-b.top)/b.h;else t=(b.bottom-p.y)/b.h;return base+h*Math.max(0,Math.min(1,t));}
function topologySurface(z){const b=topologyBounds(z);return topologySurfaceAt(z,{x:(b.left+b.right)/2,y:(b.top+b.bottom)/2});}
function topologyVolumeAt(z,p){const surf=topologySurfaceAt(z,p),mode=z?.volumeMode||'solid',th=Math.max(.5,+z?.thickness||2),base=+z?.baseElevation||0;if(mode==='platform')return{bottom:surf-th,top:surf};if(mode==='depression')return null;return{bottom:Math.min(base,surf),top:Math.max(base,surf)};}
function topologyIgnoredBySize(tok,z){return!!(tok&&z?.ignoreAtSize&&sizeOrderIndex(tok.size)>=sizeOrderIndex(z.ignoreAtSize));}
function topologyContains(z,p){const poly=topologyPoly(z);return poly.length>=3&&pointInPoly(p,poly);}
function topologySupportCandidatesAt(room,p,tok=null){let hits=(room.tactical?.map?.topography||[]).filter(z=>z.topOccupiable!==false&&!topologyIgnoredBySize(tok,z)&&topologyContains(z,p)).map(z=>({topology:z,elevation:topologySurfaceAt(z,p),id:z.id||''}));const solid=hits.filter(x=>(x.topology.volumeMode||'solid')!=='platform'),suppressGround=solid.some(x=>(x.topology.volumeMode||'solid')==='depression'||((+x.topology.baseElevation||0)<=0&&x.elevation>=0));if(!suppressGround)hits.push({topology:null,elevation:0,id:VTT_GROUND_SUPPORT});hits.sort((a,b)=>a.elevation-b.elevation||((a.topology?.at||0)-(b.topology?.at||0)));return hits;}
function tacticalSupportId(room,id){room.tactical.supports=room.tactical.supports||{};const sid=room.tactical.supports[id]||'';if(sid===VTT_GROUND_SUPPORT)return sid;return sid&&(room.tactical?.map?.topography||[]).some(z=>z.id===sid)?sid:'';}
function topologySupportAt(room,p,tok=null,currentElevation=null,preferId=''){const hits=topologySupportCandidatesAt(room,p,tok);if(!hits.length)return{topology:null,elevation:0,id:''};if(preferId){const q=hits.find(x=>x.id===preferId);if(q)return q}if(currentElevation!==null&&Number.isFinite(+currentElevation)){const n=+currentElevation;hits.sort((a,b)=>Math.abs(a.elevation-n)-Math.abs(b.elevation-n)||b.elevation-a.elevation);return hits[0]}return hits[hits.length-1];}
function topologyMobilityProfile(tok){const p=tok?.mobility||{};return{climbMultiplier:+p.climbMultiplier===1?1:2,climbTestExempt:!!p.climbTestExempt,cling:!!p.cling,jumpMultiplier:Math.max(1,+p.jumpMultiplier||1),superLeap:Math.max(0,+p.superLeap||0),athleticsRank:Math.max(0,+p.athleticsRank||0),climberKit:!!p.climberKit};}
function segmentPolyBreaks(a,b,poly){if(!poly?.length)return[];const dx=b.x-a.x,dy=b.y-a.y,ts=[],eps=1e-8;for(let i=0;i<poly.length;i++){const c=poly[i],d=poly[(i+1)%poly.length],sx=d.x-c.x,sy=d.y-c.y,den=dx*sy-dy*sx;if(Math.abs(den)<eps)continue;const qx=c.x-a.x,qy=c.y-a.y,t=(qx*sy-qy*sx)/den,u=(qx*dy-qy*dx)/den;if(t>eps&&t<1-eps&&u>=-eps&&u<=1+eps)ts.push(t)}return ts;}
function topologyPathBreaks(room,a,b){let ts=[0,1];for(const z of room.tactical?.map?.topography||[])ts.push(...segmentPolyBreaks(a,b,topologyPoly(z)));return[...new Set(ts.map(x=>+Math.max(0,Math.min(1,x)).toFixed(8)))].sort((x,y)=>x-y);}
function pointLerp(a,b,t){return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};}
function topologyCheckSpec(edge,mob,delta,t=0){if(!edge)return null;const legacy=edge.checkRequired===undefined&&edge.traversal==='difficult',required=edge.checkRequired===undefined?legacy:!!edge.checkRequired;if(!required)return null;const skill=cleanText(edge.checkSkill||'Athletics',80)||'Athletics',baseDif=clampNumber(edge.checkDif||10,1,999,10),climbMode=edge.traversal==='climb'||edge.traversal==='difficult',kitApplied=!!(climbMode&&mob?.climberKit),dif=kitApplied?10:baseDif;return{kind:'check',t:+t||0,skill,dif,baseDif,kitApplied,topologyId:edge.id||'',topologyName:edge.name||'Difficult Climb',climbFeet:Math.abs(+delta||0),mode:edge.traversal||'climb'};}
function topologyMoveGate(tr,jump,approvals={}){const gates=[];if(jump&&jump.required>5&&!jump.auto&&!approvals.jumpApproved)gates.push({kind:'jump',t:+jump.t0||0,skill:'Athletics',dif:jump.dif,req:jump});if(tr?.check&&!approvals.topographyApproved)gates.push({kind:'check',t:+tr.check.t||0,skill:tr.check.skill,dif:tr.check.dif,req:tr.check});return gates.sort((a,b)=>a.t-b.t)[0]||null;}
function topologyMoveGateNote(g){if(!g)return'';if(g.kind==='jump'){const j=g.req;return`${j.running?'Running ':'Standing '}${j.method} jump · ${Math.ceil(j.required)} ft required · ${Math.round(j.runup||0)} ft run-up`;}const c=g.req;return`${c.topologyName||'Difficult Climb'} · ${Math.ceil(c.climbFeet||0)} ft climb${c.kitApplied?" · Climber's Kit sets DIF 10":''}`;}
function topologyPathProfile(room,tok,a,b,targetSupportId=''){room.tactical.elevations=room.tactical.elevations||{};room.tactical.supports=room.tactical.supports||{};const current=+room.tactical.elevations[tok.id]||0,old=topologySupportAt(room,a,tok,current,tacticalSupportId(room,tok.id)),grounded=Math.abs(current-old.elevation)<=2.5;if(!grounded)return{grounded:false,newElevation:current,newSupport:old,segments:[],verticalExtra:0,jumpSavedExtra:0,blocked:false,requiresTest:false,checks:[],check:null,jumps:[],mobility:topologyMobilityProfile(tok)};const ts=topologyPathBreaks(room,a,b),segments=[],edges=[],checks=[],jumps=[];let prevSupport=old,verticalExtra=0,blocked=false,requiresTest=false;for(let i=0;i<ts.length-1;i++){const t0=ts[i],t1=ts[i+1],tm=(t0+t1)/2,mid=pointLerp(a,b,tm),p0=pointLerp(a,b,Math.min(1,t0+1e-6)),p1=pointLerp(a,b,Math.max(0,t1-1e-6)),prefer=(i===ts.length-2&&targetSupportId)?targetSupportId:prevSupport.id,sup=topologySupportAt(room,mid,tok,prevSupport.elevation,prefer),e0=sup.topology?topologySurfaceAt(sup.topology,p0):sup.elevation,e1=sup.topology?topologySurfaceAt(sup.topology,p1):sup.elevation;segments.push({t0,t1,support:sup,e0,e1});if(i===0&&Math.abs(e0-prevSupport.elevation)>2.5)edges.push({from:prevSupport.elevation,to:e0,edge:e0>prevSupport.elevation?sup.topology:prevSupport.topology,t:t0});verticalExtra+=Math.abs(e1-e0);if(i<ts.length-2){const nextMid=pointLerp(a,b,(ts[i+1]+ts[i+2])/2),next=topologySupportAt(room,nextMid,tok,e1,(i===ts.length-3&&targetSupportId)?targetSupportId:''),nextP=pointLerp(a,b,Math.min(1,ts[i+1]+1e-6)),nextE=next.topology?topologySurfaceAt(next.topology,nextP):next.elevation;if(Math.abs(nextE-e1)>2.5)edges.push({from:e1,to:nextE,edge:nextE>e1?next.topology:sup.topology,t:ts[i+1]});prevSupport=next}else prevSupport=sup;}
const mob=topologyMobilityProfile(tok);for(const e of edges){const edge=e.edge,mode=edge?.traversal||'climb',block=edge?.blockMode||'conditional',delta=e.to-e.from;if(edge&&topologyIgnoredBySize(tok,edge)){e.cost=0;continue}if(block==='always'||mode==='impassable'){blocked=true;e.blocked=true;e.cost=0;continue}const check=topologyCheckSpec(edge,mob,delta,e.t);if(check){requiresTest=true;e.requiresTest=true;e.check=check;checks.push(check)}const mult=(mode==='climb'||mode==='difficult')?mob.climbMultiplier:1;e.cost=Math.abs(delta)*mult;verticalExtra+=e.cost;}
for(let i=0;i<segments.length;i++){const seg=segments[i],before=i?segments[i-1]:null,after=i+1<segments.length?segments[i+1]:null;if(!before||!after)continue;const low=Math.min(seg.e0,seg.e1),be=before.e1,ae=after.e0;if((seg.support.topology?.jumpMode||'auto')!=='never'&&low+2.5<Math.min(be,ae)){const world=Math.hypot(b.x-a.x,b.y-a.y)*(seg.t1-seg.t0),feet=world/(room.tactical.map.gridSize||64)*(room.tactical.map.feetPerSquare||5),rise=Math.max(0,ae-be),runup=Math.hypot(b.x-a.x,b.y-a.y)*seg.t0/(room.tactical.map.gridSize||64)*(room.tactical.map.feetPerSquare||5),running=runup>=10,method=rise>5?'high':'long',dif=method==='high'?(running?13:18):(running?5:10),required=Math.max(feet,rise);jumps.push({t0:seg.t0,t1:seg.t1,gap:feet,rise,required,runup,running,method,dif,fromElevation:be,toElevation:ae});}}
let jumpSavedExtra=0;for(const j of jumps){const eps=1e-5;for(const e of edges)if(e.t>=j.t0-eps&&e.t<=j.t1+eps)jumpSavedExtra+=+e.cost||0}jumpSavedExtra=Math.min(verticalExtra,jumpSavedExtra);checks.sort((x,y)=>x.t-y.t);const newSupport=topologySupportAt(room,b,tok,prevSupport.elevation,targetSupportId),newElevation=newSupport.topology?topologySurfaceAt(newSupport.topology,b):newSupport.elevation;return{grounded:true,oldSupport:old,newSupport,newElevation,segments,edges,verticalExtra,jumpSavedExtra,blocked,requiresTest,checks,check:checks[0]||null,jumps,mobility:mob};}
function topologyTransition(room,tok,a,b,targetSupportId=''){const p=topologyPathProfile(room,tok,a,b,targetSupportId),delta=p.newElevation-(+room.tactical.elevations?.[tok.id]||0);return{...p,delta,extra:p.verticalExtra,edge:p.edges?.[0]?.edge||null};}
function topologyJumpRequirement(room,tok,a,b,targetSupportId=''){const p=topologyPathProfile(room,tok,a,b,targetSupportId),j=(p.jumps||[]).slice().sort((x,y)=>y.required-x.required)[0]||null;if(!j)return null;const mob=p.mobility||topologyMobilityProfile(tok),auto=mob.superLeap>=j.required&&mob.superLeap>0;return{...j,auto,superLeap:mob.superLeap,jumpMultiplier:mob.jumpMultiplier,profile:p};}
function tacticalMovementBlocked(room,tok,a,b){const poly=sweptTokenPoly(room,tok,a,b);return(room.tactical?.map?.walls||[]).some(w=>segmentPolyIntersect({x:+w.x1||0,y:+w.y1||0},{x:+w.x2||0,y:+w.y2||0},poly));}
function rectOverlap(a,b){return a.left<b.right-1e-7&&a.right>b.left+1e-7&&a.top<b.bottom-1e-7&&a.bottom>b.top+1e-7;}
function sizeOrderIndex(size){const a=['Tiny','Small','Common','Large','Long','Huge','Extended','Gigantic','Extended II','Towering','Extended III','Titanic'],i=a.indexOf(size);return i<0?a.indexOf('Common'):i;}
function tokensAllied(a,b){return a.side===b.side;}
function smallShareAllowed(a,b){return a.size==='Small'&&b.size==='Small';}
function endOccupied(room,tok,pos){const r=tacticalTokenRect(room,tok,pos),positions=room.tactical?.positions||{};return tacticalTokens(room).some(o=>o.id!==tok.id&&!smallShareAllowed(tok,o)&&rectOverlap(r,tacticalTokenRect(room,o,positions[o.id]||defaultTokenPos(room,o))));}
function movementLocked(tok){return(tok.conditions||[]).some(x=>['Grappled','Immobilized','Restrained','Stunned','Unconscious','Asleep'].includes(x));}
function segmentRectInterval(a,b,r){let t0=0,t1=1,dx=b.x-a.x,dy=b.y-a.y;for(const [p,q] of [[-dx,a.x-r.left],[dx,r.right-a.x],[-dy,a.y-r.top],[dy,r.bottom-a.y]]){if(Math.abs(p)<1e-12){if(q<0)return null;continue}let t=q/p;if(p<0){if(t>t1)return null;if(t>t0)t0=t}else{if(t<t0)return null;if(t<t1)t1=t}}return t1>t0?[Math.max(0,t0),Math.min(1,t1)]:null;}
function mergeIntervals(xs){xs=xs.filter(Boolean).map(x=>[Math.max(0,x[0]),Math.min(1,x[1])]).filter(x=>x[1]>x[0]).sort((a,b)=>a[0]-b[0]);let out=[];for(const x of xs){let z=out[out.length-1];if(z&&x[0]<=z[1]+1e-9)z[1]=Math.max(z[1],x[1]);else out.push(x.slice())}return out;}
function roughIntervals(room,a,b,tok){const map=room.tactical?.map||blankTactical().map,tr=tacticalTokenRect(room,tok,a),hw=tr.w/2,hh=tr.h/2,ints=[];for(const z of map.terrain||[])if(z.terrainType==='difficult'){const r={left:Math.min(z.x1,z.x2)-hw,right:Math.max(z.x1,z.x2)+hw,top:Math.min(z.y1,z.y2)-hh,bottom:Math.max(z.y1,z.y2)+hh};ints.push(segmentRectInterval(a,b,r));}const moverI=sizeOrderIndex(tok.size),g=map.gridSize||64,positions=room.tactical?.positions||{};for(const o of tacticalTokens(room)){if(o.id===tok.id||tokensAllied(tok,o)||moverI-sizeOrderIndex(o.size)>=2)continue;const or=tacticalTokenRect(room,o,positions[o.id]||defaultTokenPos(room,o)),r={left:or.left-g-hw,right:or.right+g+hw,top:or.top-g-hh,bottom:or.bottom+g+hh};ints.push(segmentRectInterval(a,b,r));}if((tok.conditions||[]).includes('Blinded'))ints.push([0,1]);return mergeIntervals(ints);}
function tacticalMoveCost(room,a,b,tok){const map=room.tactical?.map||blankTactical().map,base=gridDistance(a,b,map);if(!base)return 0;const rough=roughIntervals(room,a,b,tok).reduce((n,x)=>n+(x[1]-x[0]),0),prone=(tok.conditions||[]).includes('Prone')?1:0;return base*(1+Math.min(1,rough)+prone);}
function movementTokenMatches(room,tokenId){const e=room.encounter||blankEncounter(),cur=currentActor(e);if(!e.active||!cur)return false;if(cur.id===tokenId)return true;return cur.kind==='player'&&tokenId===`zord:${cur.clientId}`;}
function resetTacticalMovement(room){room.tactical=room.tactical||blankTactical();const e=room.encounter||blankEncounter(),cur=e.active?currentActor(e):null;room.tactical.movement={actorId:cur?.id||'',round:e.active?(e.round||0):0,spent:0,bonus:0,tokenId:'',path:[]};room.tactical.updatedAt=now();}
function hashId(s){let h=2166136261;for(const ch of String(s||'')){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0;}
function defaultTokenPos(room,tok){const map=room.tactical?.map||blankTactical().map,g=map.gridSize||64,w=(map.columns||30)*g,h=(map.rows||18)*g,fp=tacticalSizeFootprint(tok.size,map,tacticalOrientation(room,tok.id)),pw=fp.cols*g,ph=fp.rows*g,cols=Math.max(1,Math.floor((w-pw)/g)+1),rows=Math.max(1,Math.floor((h-ph)/g)+1),hash=hashId(tok.id),c=hash%cols,r=Math.floor(hash/cols)%rows;return{x:Math.max(pw/2,Math.min(w-pw/2,pw/2+c*g)),y:Math.max(ph/2,Math.min(h-ph/2,ph/2+r*g))};}
function clampTokenPos(room,tok,p){const map=room.tactical?.map||blankTactical().map,g=map.gridSize||64,w=(map.columns||30)*g,h=(map.rows||18)*g,r=tacticalTokenRect(room,tok,p),hw=r.w/2,hh=r.h/2;return{x:Math.max(hw,Math.min(Math.max(hw,w-hw),+p.x||hw)),y:Math.max(hh,Math.min(Math.max(hh,h-hh),+p.y||hh))};}
function clampAllPositions(room){room.tactical=room.tactical||blankTactical();room.tactical.positions=room.tactical.positions||{};for(const tok of tacticalTokens(room))if(room.tactical.positions[tok.id])room.tactical.positions[tok.id]=clampTokenPos(room,tok,room.tactical.positions[tok.id]);}
function seedTacticalPositions(room){room.tactical=room.tactical||blankTactical();room.tactical.positions=room.tactical.positions||{};for(const tok of tacticalTokens(room))if(!room.tactical.positions[tok.id])room.tactical.positions[tok.id]=defaultTokenPos(room,tok);clampAllPositions(room);}
function saveMapPositionSet(room){room.tactical=room.tactical||blankTactical();const id=room.tactical.map?.id;if(!id)return;room.tactical.mapPositionSets=room.tactical.mapPositionSets||{};room.tactical.mapPositionSets[id]={positions:jsonClone(room.tactical.positions||{},{}),elevations:jsonClone(room.tactical.elevations||{},{}),supports:jsonClone(room.tactical.supports||{},{}),orientations:jsonClone(room.tactical.orientations||{},{})};}
function restoreMapPositionSet(room,id){room.tactical.mapPositionSets=room.tactical.mapPositionSets||{};const set=room.tactical.mapPositionSets[id]||null;room.tactical.positions=jsonClone(set?.positions||{},{});room.tactical.elevations=jsonClone(set?.elevations||{},{});room.tactical.supports=jsonClone(set?.supports||{},{});room.tactical.orientations=jsonClone(set?.orientations||room.tactical.orientations||{},{});clampAllPositions(room);}
function cleanMobility(p){p=p&&typeof p==='object'?p:{};return{climbMultiplier:+p.climbMultiplier===1?1:2,climbTestExempt:false,cling:!!p.cling,jumpMultiplier:clampNumber(p.jumpMultiplier,1,3,1),superLeap:clampNumber(p.superLeap,0,1000,0),athleticsRank:clampNumber(p.athleticsRank,0,6,0),climberKit:!!p.climberKit};}
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
    movement: role === 'gm' ? 0 : clampNumber(p.movement || 0, 0, 9999, 0),
    mobility: role === 'gm' ? cleanMobility({}) : cleanMobility(p.mobility),
    conditions: role === 'gm' ? [] : cleanConditions(p.conditions),
    initiative: role === 'gm' ? null : nullableNumber(p.initiative),
    turnActive: role === 'gm' ? false : !!p.turnActive,
    zordPresence: role === 'gm' ? '—' : cleanText(p.zordPresence || 'lair', 40),
    art: role === 'gm' ? null : { civilian: cleanAssetId(p.art?.civilian||''), morphed: cleanAssetId(p.art?.morphed||''), zord: cleanAssetId(p.art?.zord||'') },
    activity: cleanText(p.activity || (role === 'gm' ? 'Running the table' : 'Ready'), 500),
    teamSnapshot: role === 'gm' ? null : cleanTeamSnapshot(p.teamSnapshot),
    gmSheet: role === 'gm' ? null : cleanGmSheet(p.gmSheet),
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
    notes: cleanText(a.notes || '', 1000),
    templateId: cleanText(a.templateId || a.threat?.id || '', 180),
    threat: cleanThreatTemplate(a.threat),
    art: cleanTokenArt(a.art || a.threat?.art)
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

function publicRoom(room, viewerId) {
  const viewerIsGm = room.ownerId === viewerId;
  const members = {};
  for (const [id, m] of room.members) {
    const p = { ...m.player, connected: !!m.conn, disconnectedAt: m.disconnectedAt || null };
    if (!viewerIsGm) delete p.gmSheet;
    members[id] = p;
  }
  const encounter = jsonClone(room.encounter, blankEncounter());
  if (!viewerIsGm && encounter?.actors) for (const a of encounter.actors) if (a.kind === 'npc') { delete a.threat; delete a.templateId; }
  return {
    protocol: PROTOCOL, code: room.code, ownerId: room.ownerId, rulesFingerprint: room.rulesFingerprint,
    profileName: room.profileName, members, storyPoints: room.storyPoints, log: room.log,
    encounter, tactical: jsonClone(room.tactical || blankTactical(), blankTactical()), lifecycle: room.lifecycle, revision: room.revision, createdAt: room.createdAt, updatedAt: room.updatedAt
  };
}
function touch(room) { room.revision += 1; room.updatedAt = now(); }
function broadcast(room) {
  for (const [id, member] of room.members) if (member.conn) member.conn.sendJSON({ type: 'room_state', room: publicRoom(room, id) });
}
function sendRoomAssets(conn, room) { if(!conn||!room?.assets)return; for(const asset of room.assets.values()) conn.sendJSON({type:'asset_data',asset}); }
function broadcastAsset(room, asset) { for(const member of room.members.values()) if(member.conn) member.conn.sendJSON({type:'asset_data',asset}); }
function broadcastAssetRemove(room, assetId) { for(const member of room.members.values()) if(member.conn) member.conn.sendJSON({type:'asset_remove',assetId}); }
function assetAllowed(room,clientId,id){ if(isGm(room,clientId))return true; return id===`pc:${clientId}:civilian`||id===`pc:${clientId}:morphed`||id===`pc:${clientId}:zord`; }

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
  sendRoomAssets(conn, room);
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
    tactical: blankTactical(),
    assets: new Map(),
    lifecycle: { sessionSerial: 0, sceneSerial: 0, updatedAt: now() },
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
    emptyAt: null,
    pendingMoves: new Map()
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
    if (e.active) { seedTacticalPositions(room); pushSystemLog(room, `Encounter started. ${currentActor(e)?.name || 'First combatant'} has the first turn.`); }
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
  resetTacticalMovement(room);
}
function roomPendingMoves(room){if(!(room.pendingMoves instanceof Map))room.pendingMoves=new Map();return room.pendingMoves;}
function samePoint(a,b){return!!a&&!!b&&Math.abs((+a.x||0)-(+b.x||0))<.001&&Math.abs((+a.y||0)-(+b.y||0))<.001;}
function sendMoveGateResult(room,targetId,message,extra={}){const payload={type:'vtt_move_gate_result',result:{message:cleanText(message,700),...extra}};const ids=new Set([targetId,room.ownerId]);for(const id of ids){const m=room.members.get(id);if(m?.conn)m.conn.sendJSON(payload)}}
function requestRemoteMoveGate(room,pending,gate){const target=room.members.get(pending.targetClientId);if(!target||target.player.role==='gm'||!target.conn)return false;const pm=roomPendingMoves(room);for(const [rid,p] of pm)if(p.tokenId===pending.tokenId)pm.delete(rid);const requestId=crypto.randomUUID(),note=topologyMoveGateNote(gate);pending={...pending,requestId,gateKind:gate.kind,gate:jsonClone(gate,{})};pm.set(requestId,pending);target.conn.sendJSON({type:'gm_command',command:{id:requestId,type:'check_request',targetId:pending.targetClientId,skill:gate.skill,dc:gate.dif,note,gmName:'GM',context:{kind:'vtt_move',gate:gate.kind,tokenId:pending.tokenId},at:now()}});pushSystemLog(room,`Movement pending ${target.player.name}: ${gate.skill} DIF ${gate.dif} · ${note}.`);touch(room);broadcast(room);return true;}
function commitTacticalMove(room,tok,tokenId,old,next,supportId,tr,jump,tracking,requestedByGm=false){if(tracking&&endOccupied(room,tok,next))return{ok:false,code:'VTT_SPACE_OCCUPIED',message:"A creature cannot end its combat move in another creature's occupied space."};if(tracking&&movementLocked(tok)&&!requestedByGm)return{ok:false,code:'VTT_MOVEMENT_ZERO',message:'This condition reduces voluntary movement to 0.'};const countMovement=tracking&&!(requestedByGm&&movementLocked(tok));if(!countMovement){if(!tracking)room.tactical.movement={actorId:'',round:0,spent:0,bonus:0,tokenId:'',path:[]};}else{let mv=room.tactical.movement||{actorId:'',round:0,spent:0,bonus:0,tokenId:'',path:[]},cur=currentActor(room.encounter||blankEncounter());if(mv.actorId!==cur?.id||mv.round!==(room.encounter?.round||0))resetTacticalMovement(room);mv=room.tactical.movement;mv.tokenId=tokenId;const topoExtra=jump?Math.max(0,tr.extra-(tr.jumpSavedExtra||0)):tr.extra;mv.spent=clampNumber((mv.spent||0)+tacticalMoveCost(room,old,next,tok)+topoExtra,0,99999,0);if(!Array.isArray(mv.path))mv.path=[];if(!mv.path.length)mv.path.push(old);mv.path.push(next);}room.tactical.positions[tokenId]=next;if(tr.grounded){room.tactical.elevations=room.tactical.elevations||{};room.tactical.elevations[tokenId]=tr.newElevation;room.tactical.supports[tokenId]=tr.newSupport?.id||'';}room.tactical.updatedAt=now();return{ok:true};}
function applyFailedJump(room,pending,tok,jump,total){const t=Math.max(0,Math.min(1,(+jump.t0||0)-1e-6)),takeoff=clampTokenPos(room,tok,pointLerp(pending.old,pending.next,t)),tr=topologyTransition(room,tok,pending.old,takeoff,''),tracking=movementTokenMatches(room,pending.tokenId),spent=tracking?tacticalMoveCost(room,pending.old,takeoff,tok)+tr.extra:0,res=commitTacticalMove(room,tok,pending.tokenId,pending.old,takeoff,'',tr,null,tracking,!!pending.requestedByGm),dist=Math.max(0,(+total||0)-(+jump.dif||0))*Math.max(1,+jump.jumpMultiplier||1),fall=!!(jump.gap>0&&dist>0&&dist+1e-7<jump.gap),msg=`${Math.round(spent*10)/10} ft RUN-UP SPENT · Jump failed. Token stops at the takeoff edge.${fall?' FALLING RESOLUTION REQUIRED.':''}`;if(res.ok){pushSystemLog(room,msg);sendMoveGateResult(room,pending.targetClientId,msg,{success:false,fallingRequired:fall,jumpDistance:dist});touch(room);broadcast(room)}return res;}
function resolvePendingMoveCheck(room,clientId,r){const pm=roomPendingMoves(room),pending=pm.get(cleanText(r.requestId||'',180));if(!pending||pending.targetClientId!==clientId)return false;pm.delete(pending.requestId);const tok=tacticalTokenInfo(room,pending.tokenId);if(!tok)return true;const current=room.tactical.positions?.[pending.tokenId]||defaultTokenPos(room,tok);if(!samePoint(current,pending.old)){sendMoveGateResult(room,pending.targetClientId,'Stored movement expired because the token position changed before the check resolved.',{success:false});return true}const tr=topologyTransition(room,tok,pending.old,pending.next,pending.supportId||''),jump=topologyJumpRequirement(room,tok,pending.old,pending.next,pending.supportId||''),gate=pending.gate||{},total=nullableNumber(r.total,-9999,9999)??0;let gateSuccess=!!r.success;if(gate.kind==='jump'){const dist=Math.max(0,total-(+gate.dif||0))*Math.max(1,+gate.req?.jumpMultiplier||jump?.jumpMultiplier||1);gateSuccess=dist+1e-7>=(+gate.req?.required||+jump?.required||Infinity)}if(!gateSuccess){if(gate.kind==='jump')applyFailedJump(room,pending,tok,gate.req||jump,total);else{const msg=`${gate.skill||'Skill'} ${total} vs DIF ${gate.dif||0} · FAILURE · movement not committed.`;pushSystemLog(room,msg);sendMoveGateResult(room,pending.targetClientId,msg,{success:false});touch(room);broadcast(room)}return true}if(gate.kind==='jump')pending.jumpApproved=true;else pending.topographyApproved=true;const nextGate=topologyMoveGate(tr,jump,pending);if(nextGate){requestRemoteMoveGate(room,pending,nextGate);return true}if(tacticalMovementBlocked(room,tok,pending.old,pending.next)||tr.blocked){const msg='Stored movement can no longer be completed because the route became blocked.';pushSystemLog(room,msg);sendMoveGateResult(room,pending.targetClientId,msg,{success:false});touch(room);broadcast(room);return true}const tracking=movementTokenMatches(room,pending.tokenId),res=commitTacticalMove(room,tok,pending.tokenId,pending.old,pending.next,pending.supportId||'',tr,jump,tracking,!!pending.requestedByGm);if(res.ok){const msg=`Movement check passed. ${room.members.get(pending.targetClientId)?.player?.name||'Ranger'} completes the stored move.`;pushSystemLog(room,msg);sendMoveGateResult(room,pending.targetClientId,msg,{success:true});touch(room);broadcast(room)}else sendMoveGateResult(room,pending.targetClientId,res.message,{success:false});return true;}
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
      if (idx >= 0) { e.active = true; e.round = Math.max(1, e.round || 1); e.turnIndex = idx; e.updatedAt = now(); seedTacticalPositions(room); resetTacticalMovement(room); touch(room); broadcast(room); }
      break;
    }
    case 'gm_party_lifecycle': {
      if (!requireGm(conn, room, clientId)) break;
      room.lifecycle = room.lifecycle || { sessionSerial: 0, sceneSerial: 0, updatedAt: now() };
      const scope = cleanText(msg.scope, 20);
      if (scope === 'session') {
        room.lifecycle.sessionSerial += 1; room.lifecycle.sceneSerial += 1;
        room.storyPoints = Math.max(1, [...room.members.values()].filter(m => m.player.role !== 'gm').length);
        const e = room.encounter || (room.encounter = blankEncounter());
        e.active = false; e.round = 1; e.turnIndex = -1; for (const a of e.actors) a.initiative = null; e.updatedAt = now();
        pushSystemLog(room, 'GM started a new session. Ranger session resources reset together.');
      } else if (scope === 'scene') {
        room.lifecycle.sceneSerial += 1;
        pushSystemLog(room, 'GM started a new scene. Ranger scene-limited resources reset together.');
      } else { sendError(conn, 'Unknown lifecycle scope.'); break; }
      room.lifecycle.updatedAt = now(); touch(room); broadcast(room); break;
    }
    case 'gm_player_damage': {
      if (!requireGm(conn, room, clientId)) break;
      const targetId = safeClientId(msg.targetId), amount = clampNumber(msg.amount || 0, 0, 999, 0);
      const target = room.members.get(targetId);
      if (!target || target.player.role === 'gm') { sendError(conn, 'Target Ranger is not in the room.'); break; }
      if (!target.conn) { sendError(conn, 'Target Ranger is currently offline.'); break; }
      target.conn.sendJSON({ type: 'gm_command', command: { id: crypto.randomUUID(), type: 'damage', targetId, amount } });
      break;
    }
    case 'gm_check_request': {
      if (!requireGm(conn, room, clientId)) break;
      const rawTargets = Array.isArray(msg.targets) ? msg.targets : [];
      const targets = [...new Set(rawTargets.map(safeClientId))].slice(0, 24);
      const skill = cleanText(msg.skill || 'Alertness', 80);
      const dc = clampNumber(msg.dc || 10, 1, 999, 10);
      const note = cleanText(msg.note || '', 500);
      const requestId = crypto.randomUUID();
      const delivered = [];
      for (const targetId of targets) {
        const target = room.members.get(targetId);
        if (!target || target.player.role === 'gm' || !target.conn) continue;
        target.conn.sendJSON({ type: 'gm_command', command: { id: requestId, type: 'check_request', targetId, skill, dc, note, gmName: 'GM', at: now() } });
        delivered.push(target.player.name);
      }
      if (!delivered.length) { sendError(conn, 'No selected Rangers are currently connected.'); break; }
      pushSystemLog(room, `GM requested ${skill} DIF ${dc} from ${delivered.join(', ')}${note ? ` · ${note}` : ''}.`);
      touch(room); broadcast(room); break;
    }
    case 'player_check_result': {
      if (member.player.role === 'gm') { sendError(conn, 'GM cannot submit a Ranger check result.'); break; }
      const r = msg.result && typeof msg.result === 'object' ? msg.result : {};
      const skill = cleanText(r.skill || 'Skill', 80);
      const dc = clampNumber(r.dc || 0, 0, 999, 0);
      const automatic = !!r.automatic;
      const stage = cleanText(r.stage || '', 100);
      const total = nullableNumber(r.total, -9999, 9999);
      const success = !!r.success, critical = !!r.critical, fumble = !!r.fumble;
      const shown = automatic ? (stage || 'Automatic Success') : (total === null ? '—' : total);
      const d20s = Array.isArray(r.d20s) ? r.d20s.slice(0, 3).map(x => clampNumber(x, 1, 20, 1)) : [];
      const parts = Array.isArray(r.parts) ? r.parts.slice(0, 12).map(p => ({ label: cleanText(p?.label || 'die', 20), value: nullableNumber(p?.value, -999, 999) })) : [];
      const dice = automatic ? '' : [d20s.length ? `d20 ${d20s.join('/')}` : '', ...parts.map(p => `${p.label} ${p.value ?? '—'}`)].filter(Boolean).join(' + ');
      const rollMode = cleanText(r.rollMode || '', 20) === 'physical' ? ' · PHYSICAL' : '';
      room.log.unshift({
        id: crypto.randomUUID(), kind: 'CHECK_RESULT', roomCode: room.code, clientId,
        characterId: member.player.characterId, who: member.player.name, ranger: member.player.ranger,
        round: room.encounter?.active ? room.encounter.round : 0,
        message: cleanText(`${skill} DIF ${dc}: ${dice ? `${dice} = ` : ''}${shown} → ${success ? 'SUCCESS' : 'FAILURE'}${critical ? ' · Critical' : ''}${fumble ? ' · Fumble' : ''}${rollMode}.`, 1000), at: now()
      });
      room.log = room.log.slice(0, MAX_LOG);
      member.player.activity = `${skill} check: ${success ? 'success' : 'failure'}`; member.player.updatedAt = now();
      if (resolvePendingMoveCheck(room, clientId, r)) break;
      touch(room); broadcast(room); break;
    }
    case 'vtt_map_set': {
      if (!requireGm(conn, room, clientId)) break;
      room.tactical = room.tactical || blankTactical();
      room.tactical.orientations=room.tactical.orientations||{}; room.tactical.supports=room.tactical.supports||{}; room.tactical.mapPositionSets=room.tactical.mapPositionSets||{};
      const oldId=room.tactical.map?.id||'', next=cleanTacticalMap(msg.map,room.tactical.map), nextId=next.id||'';
      if(oldId!==nextId){ saveMapPositionSet(room); room.tactical.map=next; restoreMapPositionSet(room,nextId); }
      else { room.tactical.map=next; clampAllPositions(room); }
      if(room.encounter?.active)seedTacticalPositions(room); resetTacticalMovement(room); room.tactical.updatedAt=now();
      touch(room); broadcast(room); break;
    }
    case 'vtt_feature_add': {
      room.tactical = room.tactical || blankTactical(); room.tactical.map=cleanTacticalMap(room.tactical.map,room.tactical.map);
      const f=msg.feature&&typeof msg.feature==='object'?msg.feature:{},kind=cleanText(f.kind,20); let clean=null,key='';
      if(kind==='wall'){if(!requireGm(conn,room,clientId))break; clean=cleanWall({...f,ownerId:clientId});key='walls';}
      else if(kind==='terrain'){if(!requireGm(conn,room,clientId))break; clean=cleanTerrain({...f,ownerId:clientId});key='terrain';}
      else if(kind==='topography'){if(!requireGm(conn,room,clientId))break; clean=cleanTopology({...f,ownerId:clientId});key='topography';}
      else if(kind==='drawing'){clean=cleanDrawing({...f,ownerId:clientId});key='drawings';}
      else if(kind==='template'){clean=cleanTemplate({...f,ownerId:clientId});key='templates';}
      else {sendError(conn,'Unknown Tactical Table feature.');break;}
      const arr=room.tactical.map[key]||(room.tactical.map[key]=[]); if(arr.length>=200){sendError(conn,'Tactical layer limit reached.');break;} arr.push(clean);
      room.tactical.updatedAt=now();touch(room);broadcast(room);break;
    }
    case 'vtt_feature_update': {
      if (!requireGm(conn, room, clientId)) break; room.tactical=room.tactical||blankTactical();room.tactical.map=cleanTacticalMap(room.tactical.map,room.tactical.map);const f=msg.feature&&typeof msg.feature==='object'?msg.feature:{},id=safeActorId(f.id||msg.featureId),arr=room.tactical.map.topography||[],i=arr.findIndex(x=>x.id===id);if(i<0){sendError(conn,'Unknown topography feature.');break;}arr[i]=cleanTopology({...arr[i],...f,id:arr[i].id,ownerId:arr[i].ownerId});room.tactical.updatedAt=now();touch(room);broadcast(room);break;
    }
    case 'vtt_feature_remove': {
      room.tactical=room.tactical||blankTactical();room.tactical.map=cleanTacticalMap(room.tactical.map,room.tactical.map);const id=safeActorId(msg.featureId);let found=null;
      for(const key of ['walls','terrain','topography','drawings','templates']){const arr=room.tactical.map[key]||[],i=arr.findIndex(x=>x.id===id);if(i>=0){found=arr[i];if(!isGm(room,clientId)&&found.ownerId!==clientId){sendError(conn,'You do not own that tactical mark.');found=null;break;}arr.splice(i,1);break;}}
      if(found){room.tactical.updatedAt=now();touch(room);broadcast(room)} break;
    }
    case 'vtt_feature_clear': {
      room.tactical=room.tactical||blankTactical();room.tactical.map=cleanTacticalMap(room.tactical.map,room.tactical.map);const all=isGm(room,clientId)&&cleanText(msg.scope,20)==='all';
      for(const key of ['walls','terrain','topography','drawings','templates'])room.tactical.map[key]=all?[]:(room.tactical.map[key]||[]).filter(x=>x.ownerId!==clientId);
      room.tactical.updatedAt=now();touch(room);broadcast(room);break;
    }
    case 'vtt_elevation_set': {
      room.tactical=room.tactical||blankTactical();const tokenId=safeActorId(msg.tokenId),own=`pc:${clientId}`,ownZ=`zord:${clientId}`,memberIsGm=isGm(room,clientId);
      if(!memberIsGm&&tokenId!==own&&tokenId!==ownZ){sendError(conn,'Players may only change elevation for their own token.');break;} const tok=tacticalTokenInfo(room,tokenId);if(!tok){sendError(conn,'Unknown Tactical Table token.');break;}
      room.tactical.elevations=room.tactical.elevations&&typeof room.tactical.elevations==='object'?room.tactical.elevations:{};const old=+room.tactical.elevations[tokenId]||0,next=Math.round(clampNumber(msg.value,-10000,10000,0)/5)*5,tracking=movementTokenMatches(room,tokenId);
      if(tracking&&movementLocked(tok)&&!memberIsGm){sendError(conn,'This condition reduces voluntary movement to 0.','VTT_MOVEMENT_ZERO');break;}
      const countMovement=tracking&&!(memberIsGm&&movementLocked(tok));if(countMovement&&Math.abs(next-old)){let mv=room.tactical.movement||{actorId:'',round:0,spent:0,bonus:0,tokenId:'',path:[]},cur=currentActor(room.encounter||blankEncounter());if(mv.actorId!==cur?.id||mv.round!==(room.encounter?.round||0))resetTacticalMovement(room);mv=room.tactical.movement;mv.tokenId=tokenId;mv.spent=clampNumber((mv.spent||0)+Math.abs(next-old),0,99999,0);}else if(!tracking)room.tactical.movement={actorId:'',round:0,spent:0,bonus:0,tokenId:'',path:[]};
      room.tactical.elevations[tokenId]=next;room.tactical.updatedAt=now();touch(room);broadcast(room);break;
    }
    case 'vtt_orientation_set': {
      room.tactical=room.tactical||blankTactical(); const tokenId=safeActorId(msg.tokenId),own=`pc:${clientId}`,ownZ=`zord:${clientId}`,tok=tacticalTokenInfo(room,tokenId);
      if(!tok){sendError(conn,'Unknown Tactical Table token.');break;} if(!isGm(room,clientId)&&tokenId!==own&&tokenId!==ownZ){sendError(conn,'Players may only rotate their own Tactical Table tokens.');break;}
      room.tactical.orientations=room.tactical.orientations||{}; room.tactical.orientations[tokenId]=msg.orientation==='rotated'?'rotated':'normal'; if(room.tactical.positions?.[tokenId])room.tactical.positions[tokenId]=clampTokenPos(room,tok,room.tactical.positions[tokenId]); room.tactical.updatedAt=now(); touch(room);broadcast(room);break;
    }
    case 'vtt_movement_bonus': {
      room.tactical=room.tactical||blankTactical(); const tokenId=safeActorId(msg.tokenId),own=`pc:${clientId}`,ownZ=`zord:${clientId}`,tok=tacticalTokenInfo(room,tokenId);
      if(!tok||!movementTokenMatches(room,tokenId)){sendError(conn,'Movement purchases only apply to the active combat token.');break;} if(!isGm(room,clientId)&&tokenId!==own&&tokenId!==ownZ){sendError(conn,'Players may only track movement purchases for their own token.');break;}
      const max=Math.max(0,(+tok.movement||0)-5),value=Math.floor(clampNumber(msg.value,0,max,0)/5)*5; room.tactical.movement=room.tactical.movement||{}; room.tactical.movement.bonus=value;room.tactical.updatedAt=now();touch(room);broadcast(room);break;
    }
    case 'vtt_ping': {
      const map=room.tactical?.map||blankTactical().map,worldW=(map.columns||30)*(map.gridSize||64),worldH=(map.rows||18)*(map.gridSize||64),ping={id:crypto.randomUUID(),x:clampNumber(msg.x,0,worldW,0),y:clampNumber(msg.y,0,worldH,0),who:member.player.role==='gm'?'GM':member.player.name,ranger:member.player.role==='gm'?'GM':member.player.ranger,at:now()};
      for(const m of room.members.values())if(m.conn)m.conn.sendJSON({type:'vtt_ping',ping});break;
    }
    case 'vtt_token_move': {
      room.tactical = room.tactical || blankTactical();
      const tokenId=safeActorId(msg.tokenId),memberIsGm=isGm(room,clientId),ownToken=`pc:${clientId}`,ownZord=`zord:${clientId}`,tok=tacticalTokenInfo(room,tokenId);
      if(!tok){sendError(conn,'Unknown Tactical Table token.');break;} if(!memberIsGm&&tokenId!==ownToken&&tokenId!==ownZord){sendError(conn,'Players may only move their own Tactical Table tokens.');break;}
      room.tactical.positions=room.tactical.positions&&typeof room.tactical.positions==='object'?room.tactical.positions:{}; room.tactical.orientations=room.tactical.orientations||{}; room.tactical.supports=room.tactical.supports||{};
      const next=clampTokenPos(room,tok,{x:msg.x,y:msg.y}),old=room.tactical.positions[tokenId]||defaultTokenPos(room,tok),tracking=movementTokenMatches(room,tokenId),supportId=safeActorId(msg.supportId||''),tr=topologyTransition(room,tok,old,next,supportId),jump=topologyJumpRequirement(room,tok,old,next,supportId),remotePlayer=!!(memberIsGm&&tok.kind==='player'&&tok.clientId!==clientId),approvals={jumpApproved:!!msg.jumpApproved,topographyApproved:!!msg.topographyApproved},gate=tracking?topologyMoveGate(tr,jump,approvals):null;
      if(tracking&&tacticalMovementBlocked(room,tok,old,next)){sendError(conn,'That movement crosses a wall.','VTT_WALL_BLOCK');break;}
      if(tracking&&tr.blocked){sendError(conn,'That topographic route is impassable.','VTT_TOPO_BLOCK');break;}
      if(tracking&&msg.jumpFailed&&jump){applyFailedJump(room,{tokenId,targetClientId:tok.clientId||clientId,old,next,supportId,requestedByGm:memberIsGm},tok,jump,nullableNumber(msg.jumpResultTotal,-9999,9999)||0);break;}
      if(tracking&&remotePlayer&&gate){if(!requestRemoteMoveGate(room,{tokenId,targetClientId:tok.clientId,old,next,supportId,jumpApproved:false,topographyApproved:false,requestedByGm:true},gate))sendError(conn,'The Ranger must be connected to resolve that movement check.','VTT_REMOTE_CHECK_OFFLINE');break;}
      if(tracking&&gate){const message=gate.kind==='jump'?`${gate.req.running?'Running ':'Standing '}${gate.req.method} jump requires Athletics DIF ${gate.dif} and about ${Math.ceil(gate.req.required)} ft of jump distance.`:`${gate.req.topologyName||'Difficult climb'} requires ${gate.skill} DIF ${gate.dif}.`;sendError(conn,message,gate.kind==='jump'?'VTT_JUMP_REQUIRED':'VTT_TOPO_TEST');break;}
      const res=commitTacticalMove(room,tok,tokenId,old,next,supportId,tr,jump,tracking,memberIsGm);if(!res.ok){sendError(conn,res.message,res.code);break;}room.tactical.updatedAt=now();touch(room);broadcast(room);break;
    }
    case 'asset_upload': {
      const asset=cleanAsset(msg.asset); if(!asset){sendError(conn,'Invalid or oversized image asset.','BAD_ASSET');break;}
      if(!assetAllowed(room,clientId,asset.id)){sendError(conn,'You do not own that image slot.','ASSET_AUTHORITY_REQUIRED');break;}
      room.assets=room.assets||new Map(); if(!room.assets.has(asset.id)&&room.assets.size>=MAX_ROOM_ASSETS){sendError(conn,'Room asset limit reached.','ASSET_LIMIT');break;}
      room.assets.set(asset.id,asset); touch(room); broadcastAsset(room,asset); break;
    }
    case 'asset_remove': {
      const assetId=cleanAssetId(msg.assetId); if(!assetAllowed(room,clientId,assetId)){sendError(conn,'You do not own that image slot.','ASSET_AUTHORITY_REQUIRED');break;}
      if(room.assets?.delete(assetId)){touch(room);broadcastAssetRemove(room,assetId)} break;
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
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, rooms: rooms.size, version: '0.31-exp' }));
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

server.listen(PORT, HOST, () => console.log(`Power Rangers RPG v0.31-exp Advanced Topography Phase 2B room server listening on ws://${HOST}:${PORT}`));
