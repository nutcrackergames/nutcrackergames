"use strict";
/* ============================================================
   TWO IDIOTS — 3D side-view co-op ragdoll parkour
   Rendering : Three.js (side-on perspective camera, toon materials)
   Networking: WebRTC data channel (PeerJS only brokers the handshake)
   Voice chat: WebRTC audio call over the same peer link
   Levels    : separate files in /levels (see levels/README.md)
   Physics   : box character controller + verlet ragdoll puppets,
               co-op tools: head boost, toss, haul (hold hands), crates, launcher
   ============================================================ */

const $ = id => document.getElementById(id);
const VH = 540;                      // world units visible vertically at zoom 1
const G = 560, WORLD_H = 700;
const PW = 26, PH = 40;
const SEA_Y = WORLD_H - 60;          // falling below this = splash
const INK = 0x2b2d5b;
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const hash = n=>{ n=(n^61)^(n>>>16); n=n+(n<<3); n=n^(n>>>4); n=Math.imul(n,0x27d4eb2d); n=n^(n>>>15); return n>>>0; };
const TAU = Math.PI*2;

/* ---------------- Level registry + loader ---------------- */
window.LEVELS = [];
window.registerLevel = d => { window.LEVELS.push(d); };
function loadLevelFiles(){
  const files = window.LEVEL_FILES || [];
  return files.reduce((p,f)=>p.then(()=>new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=f+'?v='+Date.now(); s.onload=res; s.onerror=()=>rej(new Error('Could not load '+f));
    document.head.appendChild(s);
  })),Promise.resolve());
}

const THEMES = {
  meadow:{sky:['#7fd3ff','#eafaff'],fog:0xdff4ff,hills:[0xbfe9b0,0xa3dd96,0x88d082],top:0x6fd35f,body:0xe8b47c,dot:0xcf9560,plank:0xe6a96a,sea:[0x4cc9ff,0x8be0ff]},
  beach: {sky:['#ffc58f','#fff4df'],fog:0xfff0dc,hills:[0xffe3bd,0xffd5a0,0xf6c68a],top:0xffd86b,body:0xf1b97a,dot:0xdca062,plank:0xd99a5c,sea:[0x2fd0c0,0x7ee8dc]},
  sky:   {sky:['#a9b9ff','#f4f1ff'],fog:0xeeeaff,hills:[0xdcd6ff,0xcbc7fb,0xbcbaf4],top:0xe3ceff,body:0xaab4f0,dot:0x8f9be0,plank:0x9aa6ea,sea:[0xffffff,0xe8defc]},
  candy: {sky:['#ffb8e0','#fff0f8'],fog:0xffe8f4,hills:[0xffd6ea,0xffc3e0,0xffb0d6],top:0x9be8ff,body:0xff9bd0,dot:0xe879b8,plank:0xffa6d6,sea:[0xc79bff,0xe6c9ff]}
};
const PCOL = {a:0xff6fa5,b:0xffb300,L:0xffb300,B:0xffb300,U:0x3fb8ff,F:0x3fb8ff,X:0xa07bff,w:0xff6fa5,W:0xff6fa5,V:0xffb300};
const colorFor = id => PCOL[id] || 0xffffff;

/* ---------------- State ---------------- */
let phase = 'menu';       // menu | wait | dock | count | play | done | win
let isHost = false;
const net = { peer:null, conn:null, connected:false };
let myName = 'Idiot';
let lvlIdx = 0, L = null, SOL = [], world = null;
let tick = 0, countT = 0, exitT = 0, cpIdx = 0, doneT = 0, lastCount = 0;
let levelTime = 0, levelDeaths = 0, combo = 0, lastStarT = -999, bannerT = 0;
let totals = { stars:0, time:0, deaths:0 };
let summary = null;
let fx = [];
let ASPECT = 16/9;
const cam = { x:300, y:420, zoom:1 };
let prevR = false;

const newDoll = ()=>({p:null,mode:'alive',phase:0,hold:null});
const me    = { x:0,y:0,vx:0,vy:0,onGround:false,on:null,face:1,ready:false,dead:0,coyote:0,buf:0,wasGround:false,stepT:0,
                name:'',talk:false,eHold:false,onHead:false,onHeadT:-99,claspLower:null,pushIdx:-1,pushDir:0,doll:newDoll() };
const other = { x:0,y:0,tx:0,ty:0,vx:0,vy:0,onGround:false,face:-1,ready:false,dead:false,seen:false,name:'Partner',
                prevReady:false,talk:false,eHold:false,onHead:false,pi:-1,pd:0,doll:newDoll() };

/* ---------------- Input ---------------- */
const keys = {};
let eEdge = false;
addEventListener('keydown', e=>{
  if (e.target.tagName==='INPUT') return;
  const k = e.key.toLowerCase();
  if (['arrowleft','arrowright','arrowup',' ','a','d','w','e','r'].includes(k)) e.preventDefault();
  if (k==='m' && !e.repeat) $('btnMute').click();
  if (!keys[k] && k==='e') eEdge = true;
  keys[k] = true;
});
addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; });
function bindTouch(id, key){
  const b=$(id);
  const on = ev=>{ ev.preventDefault(); getAC(); if(!isFs()) enterFullscreen(); if(key==='e'&&!keys.e) eEdge=true; keys[key]=true; };
  const off= ev=>{ ev.preventDefault(); keys[key]=false; };
  b.addEventListener('pointerdown',on); b.addEventListener('pointerup',off);
  b.addEventListener('pointerleave',off); b.addEventListener('pointercancel',off);
}
bindTouch('tL','arrowleft'); bindTouch('tR','arrowright'); bindTouch('tJ',' '); bindTouch('tE','e');

/* ---------------- Audio: engine, sound effects, music ---------------- */
let ac = null, localStream = null, muted = false, micOK = false;
let sfxOn = true, musicOn = true;
const meters = { me:null, other:null };
function getAC(){
  if(!ac) ac = new (window.AudioContext||window.webkitAudioContext)();
  if(ac.state==='suspended') ac.resume();
  return ac;
}
function tn(f,d,type='sine',v=0.15,slideTo=null,delay=0){
  const a=getAC(), t=a.currentTime+delay;
  const o=a.createOscillator(), g=a.createGain();
  o.type=type; o.frequency.setValueAtTime(f,t);
  if(slideTo) o.frequency.exponentialRampToValueAtTime(slideTo,t+d);
  g.gain.setValueAtTime(0.0001,t);
  g.gain.exponentialRampToValueAtTime(v,t+0.012);
  g.gain.exponentialRampToValueAtTime(0.0001,t+d);
  o.connect(g); g.connect(a.destination); o.start(t); o.stop(t+d+0.03);
}
const tone = (...a)=>{ if(sfxOn) tn(...a); };
function noise(d,v,freq){
  if(!sfxOn) return;
  const a=getAC(), len=Math.floor(a.sampleRate*d), buf=a.createBuffer(1,len,a.sampleRate), data=buf.getChannelData(0);
  for(let i=0;i<len;i++) data[i]=(Math.random()*2-1)*(1-i/len);
  const s=a.createBufferSource(); s.buffer=buf;
  const f=a.createBiquadFilter(); f.type='lowpass'; f.frequency.value=freq;
  const g=a.createGain(); g.gain.value=v;
  s.connect(f); f.connect(g); g.connect(a.destination); s.start();
}
const sfx = {
  jump(){ tone(330,.13,'sine',.18,700); },
  land(){ noise(.08,.18,600); },
  step(){ noise(.03,.05,2200); },
  star(n){ const b=880*Math.pow(1.0595,Math.min(n,7)*2); tone(b,.1,'triangle',.2); tone(b*1.5,.2,'triangle',.18,null,.07); },
  spring(){ tone(170,.28,'square',.1,950); },
  plateOn(){ tone(520,.07,'triangle',.22); tone(780,.1,'triangle',.18,null,.05); },
  plateOff(){ tone(420,.09,'triangle',.16,280); },
  doorOpen(){ tone(150,.4,'sawtooth',.06,440); },
  doorClose(){ tone(400,.3,'sawtooth',.05,140); },
  die(){ tone(560,.45,'sawtooth',.1,80); noise(.2,.12,900); },
  boing(){ tone(120,.5,'sine',.2,360); noise(.1,.1,400); },
  clasp(){ tone(300,.08,'triangle',.18); tone(450,.12,'triangle',.18,null,.07); },
  toss(){ tone(200,.3,'square',.12,1100); noise(.12,.1,1500); },
  lever(){ tone(140,.12,'square',.15); tone(90,.18,'square',.15,null,.08); noise(.1,.1,800); },
  launch(){ tone(140,.5,'sawtooth',.1,1300); noise(.25,.15,2500); },
  crate(){ noise(.06,.12,500); },
  cp(){ [523,659,784].forEach((f,i)=>tone(f,.16,'triangle',.2,null,i*.08)); },
  ready(on){ tone(on?660:440,.1,'square',.09); if(on) tone(990,.14,'square',.09,null,.08); },
  tick(){ tone(520,.12,'square',.1); },
  go(){ tone(1040,.45,'square',.12); tone(1560,.45,'triangle',.1,null,.05); },
  win(){ [523,659,784,1047,784,1047,1319].forEach((f,i)=>tone(f,.22,'triangle',.2,null,i*.11)); },
  join(){ tone(660,.1,'sine',.22); tone(990,.22,'sine',.22,null,.1); },
  creak(){ tone(90+Math.random()*25,.22,'sawtooth',.03,70); }
};
const MEL=[0,4,7,12,7,4,9,7, 5,9,12,9,5,4,2,4], BASS=[0,-3,-7,-5];
let mStep=0, mTimer=null;
function startMusic(){
  if(mTimer) return;
  mTimer=setInterval(()=>{
    if(!musicOn||!ac||ac.state!=='running') return;
    tn(523.25*Math.pow(2,MEL[mStep%16]/12),.22,'triangle',.045);
    if(mStep%4===0) tn(130.8*Math.pow(2,BASS[(mStep/4|0)%4]/12),.7,'sine',.07);
    mStep++;
  },230);
}
$('btnSfx').onclick = ()=>{ sfxOn=!sfxOn; $('btnSfx').textContent=sfxOn?'Sound on':'Sound off'; $('btnSfx').classList.toggle('off',!sfxOn); if(sfxOn) sfx.plateOn(); };
$('btnMusic').onclick = ()=>{ musicOn=!musicOn; $('btnMusic').textContent=musicOn?'Music on':'Music off'; $('btnMusic').classList.toggle('off',!musicOn); };

/* ---------------- Voice chat ---------------- */
function setVC(t){ $('vcState').textContent=t; const w=$('waitVoice'); if(w) w.textContent='Voice chat: '+t.toLowerCase(); }
function silentStream(){
  const a=getAC(), d=a.createMediaStreamDestination(), o=a.createOscillator(), g=a.createGain();
  g.gain.value=0; o.connect(g); g.connect(d); o.start(); return d.stream;
}
async function initMic(){
  getAC(); startMusic();
  try{
    localStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    micOK = true;
  }catch(e){ localStream = silentStream(); micOK = false; }
  meters.me = makeMeter(localStream);
  if(micOK) setVC('Mic ready');
  else setVC(window.isSecureContext ? 'Mic blocked (listen only)' : 'Needs HTTPS for mic');
  if(!micOK) $('btnMute').style.display='none';
}
function makeMeter(stream){
  try{
    const a=getAC(), src=a.createMediaStreamSource(stream), an=a.createAnalyser();
    an.fftSize=256; src.connect(an);
    return {an, buf:new Uint8Array(an.fftSize)};
  }catch(e){ return null; }
}
function level(m){
  if(!m) return 0;
  m.an.getByteTimeDomainData(m.buf);
  let s=0; for(let i=0;i<m.buf.length;i++){ const v=(m.buf[i]-128)/128; s+=v*v; }
  return Math.sqrt(s/m.buf.length);
}
function attachCall(call){
  call.on('stream', rs=>{
    const el=$('remoteAudio'); el.srcObject=rs; el.volume=+$('vol').value; el.play().catch(()=>{ $('btnEnableVoice').style.display=''; });
    meters.other = makeMeter(rs);
    setVC('Voice live');
  });
  call.on('close', ()=>{ setVC('Voice off'); });
  call.on('error', ()=>{ setVC('Voice error'); });
}
$('vol').oninput = ()=>{ $('remoteAudio').volume=+$('vol').value; };
$('btnEnableVoice').onclick = ()=>{ getAC(); $('remoteAudio').play().then(()=>{ $('btnEnableVoice').style.display='none'; }).catch(()=>{}); };
$('btnMute').onclick = ()=>{
  if(!localStream || !micOK) return;
  muted=!muted;
  localStream.getAudioTracks().forEach(t=>t.enabled=!muted);
  $('btnMute').textContent = muted?'Unmute':'Mute';
  $('btnMute').classList.toggle('off',muted);
};

/* ---------------- Networking ---------------- */
const PREFIX = 'twoidiots-v2-';
function rndCode(){ const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<5;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function send(o){ if(net.conn && net.conn.open) net.conn.send(o); }
function showScreen(id,on){ $(id).classList.toggle('hidden',!on); }

async function createRoom(){
  myName = ($('name').value.trim()||'Idiot').slice(0,12);
  $('menuErr').textContent='';
  isHost = true;
  await initMic();
  const code = rndCode();
  const peer = new Peer(PREFIX+code);
  net.peer = peer;
  peer.on('open', ()=>{
    $('roomCode').textContent = code;
    showScreen('menu',false); showScreen('wait',true);
    phase='wait';
  });
  peer.on('connection', conn=>{
    if(net.conn && net.conn.open){ conn.close(); return; }
    setupConn(conn);
  });
  peer.on('call', call=>{ call.answer(localStream); attachCall(call); });
  peer.on('error', err=>{
    if(err.type==='unavailable-id'){ peer.destroy(); createRoom(); return; }
    $('menuErr').textContent='Connection problem: '+err.type;
  });
}
async function joinRoom(){
  const code = $('code').value.trim().toUpperCase();
  if(code.length<5){ $('menuErr').textContent='Enter the 5-letter room code.'; return; }
  myName = ($('name').value.trim()||'Idiot').slice(0,12);
  $('menuErr').textContent='Connecting…';
  isHost = false;
  await initMic();
  const peer = new Peer();
  net.peer = peer;
  peer.on('open', ()=>{
    const conn = peer.connect(PREFIX+code,{reliable:true});
    const to = setTimeout(()=>{ if(!net.connected){ $('menuErr').textContent='Room not found. Check the code and try again.'; peer.destroy(); } }, 12000);
    conn.on('open', ()=>{
      clearTimeout(to);
      setupConn(conn);
      attachCall(peer.call(PREFIX+code, localStream));
    });
  });
  peer.on('error', err=>{
    $('menuErr').textContent = err.type==='peer-unavailable' ? 'Room not found. Check the code.' : 'Connection problem: '+err.type;
  });
}
function setupConn(conn){
  net.conn = conn;
  const ready = ()=>{
    net.connected = true;
    send({t:'hi', name:myName});
    showScreen('menu',false); showScreen('wait',false);
    $('lblMe').textContent = myName;
    $('btnRestart').style.display = isHost ? '' : 'none';
    sfx.join();
    totals={stars:0,time:0,deaths:0};
    loadLevel(0);
  };
  if(conn.open) ready(); else conn.on('open', ready);
  conn.on('data', onMsg);
  conn.on('close', onDisconnect);
  conn.on('error', onDisconnect);
}
function onDisconnect(){
  net.connected=false; net.conn=null; other.seen=false;
  meters.other=null; setVC('Voice off');
  $('lblOther').textContent='Partner';
  showScreen('win',false);
  if(isHost){ phase='wait'; showScreen('wait',true); }
  else{
    phase='menu'; showScreen('menu',true);
    $('menuErr').textContent='Your partner left the room.';
    if(net.peer) net.peer.destroy();
  }
}
function onMsg(m){
  switch(m.t){
    case 'hi': other.name=m.name||'Partner'; $('lblOther').textContent=other.name; break;
    case 's':
      other.tx=m.x; other.ty=m.y; other.vx=m.vx; other.vy=m.vy; other.face=m.f; other.onGround=m.g; other.ready=m.r; other.dead=m.dd;
      other.eHold=!!m.e; other.onHead=!!m.oh; other.pi=m.pi; other.pd=m.pd;
      if(!other.seen){ other.x=m.x; other.y=m.y; other.seen=true; other.doll=newDoll(); }
      break;
    case 'c': if(!isHost && L) L.crates.forEach((c,i)=>{ if(m.c[i]){ c.tx=m.c[i][0]; c.ty=m.c[i][1]; } }); break;
    case 'start': if(phase==='dock'){ phase='count'; countT=180; lastCount=4; } break;
    case 'lvl': loadLevel(m.i); break;
    case 'done': finishLevel(m.time); break;
    case 'win': phase='win'; showWin(); break;
    case 'cp': if(m.i>cpIdx){ cpIdx=m.i; sfx.cp(); } break;
    case 'star': collectStar(m.i,false); break;
    case 'death': levelDeaths++; sfx.die(); break;
    case 'lever': applyLever(m.i,false); break;
    case 'toss': if(tick-me.onHeadT<=8) tossMe(); break;
  }
}

/* ---------------- Level instance ---------------- */
function loadLevel(i){
  showScreen('win',false);
  if(i===0) totals={stars:0,time:0,deaths:0};
  lvlIdx = i;
  const d = window.LEVELS[i];
  const th = THEMES[d.theme] || THEMES.meadow;
  const crates=(d.crates||[]).map(c=>{
    const s=c.heavy?56:44, y=(c.y!=null)?c.y:G-s;
    return {x:c.x,y,sx:c.x,sy:y,w:s,h:s,heavy:!!c.heavy,vx:0,vy:0,tx:c.x,ty:y,dx:0};
  });
  L = {
    name:d.name||'Level', w:d.width||3000, top:d.top!=null?d.top:0, hint:d.hint||'', theme:th, kind:d.theme||'meadow',
    solids:(d.solids||[]).map(a=>({x:a[0],y:a[1],w:a[2],h:a[3]})),
    spikes:(d.spikes||[]).map(a=>({x:a[0],y:a[1],w:a[2],h:a[3]})),
    plates:(d.plates||[]).map(p=>({...p,pressed:false,was:false})),
    doors:(d.doors||[]).map(o=>({...o,open:0,y0:o.y,prevWant:0})),
    lifts:(d.lifts||[]).map(o=>({ids:o.ids,x:o.x,w:o.w,h:o.h||20,y0:o.y0,y1:o.y1,sp:o.speed||o.sp||2.4,y:o.y0,dy:0})),
    springs:(d.springs||[]).map(s=>({x:s.x,y:s.y,w:s.w||44,p:s.power||s.p||19,anim:0,cool:0})),
    crates,
    launchers:(d.launchers||[]).map(l=>({x:l.x,y:l.y,w:l.w||100,power:l.power||22,lx:l.lever.x,ly:l.lever.y,anim:0,cool:0})),
    stars:(d.stars||[]).map(s=>({x:s[0],y:s[1],got:false})),
    cps:d.checkpoints||[], exit:d.exit,
    gate:{x:340,y:G-420,w:22,h:420,open:0}
  };
  phase='dock'; cpIdx=0; exitT=0; countT=0; levelTime=0; levelDeaths=0; combo=0; summary=null; bannerT=0;
  me.ready=false; other.ready=false; other.prevReady=false; me.claspLower=null;
  spawnMe();
  other.doll=newDoll();
  if(world) disposeWorld(world);
  world = buildWorld(L);
  cam.x = 400; cam.y = 420; cam.zoom = 1;
  hintShownAt = tick;
}
function myPad(){ return isHost ? {x:30,w:100} : {x:220,w:100}; }
function spawnMe(){
  me.x = isHost ? 62 : 252; me.y = G-PH; me.vx=me.vy=0; me.dead=0; me.name=myName; me.claspLower=null;
  me.doll=newDoll();
}
function respawn(){
  if(cpIdx===0){ spawnMe(); return; }
  const c = L.cps[cpIdx-1];
  me.x = c.x + (isHost?-18:18); me.y=c.y; me.vx=me.vy=0; me.dead=0; me.claspLower=null;
  me.doll=newDoll();
}
function die(){
  if(me.dead>0) return;
  me.dead=75; me.claspLower=null; levelDeaths++; send({t:'death'}); sfx.die();
}
function burst(x,y,c,n){
  for(let i=0;i<n;i++) fx.push({x,y,vx:(Math.random()-.5)*8,vy:(Math.random()-.9)*8,life:34,c,s:4+Math.random()*3});
}
function collectStar(i,mine){
  const s=L.stars[i]; if(!s||s.got) return;
  s.got=true;
  if(mine) send({t:'star',i});
  if(tick-lastStarT<150) combo++; else combo=0;
  lastStarT=tick;
  sfx.star(combo);
  burst(s.x,s.y,0xffc93c,12);
  if(combo>0) banner('Combo x'+(combo+1)+'!');
}
function finishLevel(time){
  phase='done'; doneT=210;
  const got=L.stars.filter(s=>s.got).length, tot=L.stars.length;
  const pct=tot?got/tot:1;
  summary={got,tot,time:time||levelTime,deaths:levelDeaths,rating:pct>=1?3:pct>=0.6?2:1};
  totals.stars+=got; totals.time+=summary.time; totals.deaths+=levelDeaths;
  sfx.win();
  for(let i=0;i<70;i++) fx.push({x:cam.x+(Math.random()-.5)*500,y:cam.y-180,vx:(Math.random()-.5)*10,vy:-Math.random()*9,life:100,c:[0xff5d8f,0xffc93c,0x19c3a6,0x4cb8ff,0xb388ff,0xff8a3d][i%6],s:6+Math.random()*4,g:0.28});
}
const fmt = f => { const s=Math.floor(f/60); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };
function totalStarsAll(){ return window.LEVELS.reduce((a,l)=>a+(l.stars||[]).length,0); }
function showWin(){
  showScreen('win',true);
  sfx.win();
  const tot=totalStarsAll(), r = tot?totals.stars/tot:1;
  $('winStars').textContent = (r>=0.9?'★★★':r>=0.55?'★★☆':'★☆☆');
  $('winStats').innerHTML =
    '<div class="stat"><b>'+totals.stars+'/'+tot+'</b>stars</div>'+
    '<div class="stat"><b>'+fmt(totals.time)+'</b>time</div>'+
    '<div class="stat"><b>'+totals.deaths+'</b>faceplants</div>';
  $('btnAgain').style.display = isHost ? '' : 'none';
  $('winNote').textContent = isHost ? '' : 'Waiting for the host to restart.';
}
function banner(t){ const b=$('banner'); b.textContent=t; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show'); bannerT=90; }

/* ---------------- Helpers ---------------- */
const hit = (a,b)=> a.x<b.x+b.w && a.x+a.w>b.x && a.y<b.y+b.h && a.y+a.h>b.y;
function pressedIds(){
  const s = new Set();
  L.plates.forEach(p=>{
    const test = q=>{
      if(!q.onGround) return false;
      const b = q.y+PH;
      return q.x+PW>p.x && q.x<p.x+p.w && b>=p.y-2 && b<=p.y+12;
    };
    let on = (me.dead===0 && test(me)) || (other.seen && !other.dead && test(other));
    if(!on) for(const c of L.crates){ const b=c.y+c.h; if(c.x+c.w>p.x && c.x<p.x+p.w && b>=p.y-2 && b<=p.y+12 && Math.abs(c.vy)<1){ on=true; break; } }
    p.pressed = on;
    if(on) s.add(p.id);
    if(p.pressed!==p.was){ p.was=p.pressed; p.pressed?sfx.plateOn():sfx.plateOff(); }
  });
  return s;
}
function buildSolids(){
  const arr = L.solids.slice();
  L.doors.forEach(d=>{
    const h = d.h*(1-d.open);
    if(h>8) arr.push({x:d.x,y:d.y0+d.h-h,w:d.w,h:h});
  });
  const g=L.gate, gh=g.h*(1-g.open);
  if(gh>8) arr.push({x:g.x,y:g.y+g.h-gh,w:g.w,h:gh});
  L.lifts.forEach(l=>arr.push({x:l.x,y:l.y,w:l.w,h:l.h,ref:l}));
  L.crates.forEach(c=>arr.push({x:c.x,y:c.y,w:c.w,h:c.h,ref:c}));
  return arr;
}

/* ---------------- Ragdoll puppets (verlet) ---------------- */
const mkpt = (x,y)=>({x,y,px:x,py:y});
const LINKS = [['H','C',10],['C','P',11],['C','LE',8],['LE','LH',8],['C','RE',8],['RE','RH',8],['P','LF',10],['P','RF',10]];
function dollReset(d,bx,by){
  const cx=bx+PW/2;
  d.p={H:mkpt(cx,by+9),C:mkpt(cx,by+19),P:mkpt(cx,by+30),
       LE:mkpt(cx-8,by+23),LH:mkpt(cx-9,by+30),RE:mkpt(cx+8,by+23),RH:mkpt(cx+9,by+30),
       LF:mkpt(cx-5,by+40),RF:mkpt(cx+5,by+40)};
  d.mode='alive'; d.phase=0;
}
function pin(pt,x,y){ pt.px=pt.x; pt.py=pt.y; pt.x=x; pt.y=y; }
function spring(pt,tx,ty,k){ pt.x+=(tx-pt.x)*k; pt.y+=(ty-pt.y)*k; }
function collidePt(pt,solids){
  for(const s of solids){
    if(pt.x>s.x && pt.x<s.x+s.w && pt.y>s.y && pt.y<s.y+s.h){
      const dl=pt.x-s.x, dr=s.x+s.w-pt.x, dt=pt.y-s.y, db=s.y+s.h-pt.y;
      const m=Math.min(dl,dr,dt,db);
      const vx=pt.x-pt.px, vy=pt.y-pt.py;
      if(m===dt){ pt.y=s.y; pt.py=pt.y+vy*0.25; pt.px=pt.x-vx*0.7; }
      else if(m===db){ pt.y=s.y+s.h; pt.py=pt.y; }
      else if(m===dl){ pt.x=s.x; pt.px=pt.x; }
      else { pt.x=s.x+s.w; pt.px=pt.x; }
    }
  }
}
function dollStep(d,b,mode){
  if(!d.p) dollReset(d,b.x,b.y);
  const p=d.p;
  if(d.mode!==mode){
    if(mode==='alive') dollReset(d,b.x,b.y);
    else if(mode==='dead'){
      for(const k in p){ const q=p[k]; const vx=(b.vx||0)*0.7+(Math.random()-.5)*6, vy=-9-Math.random()*4; q.px=q.x-vx; q.py=q.y-vy; }
    }
    d.mode=mode;
  }
  const cx=b.x+PW/2, alive=mode==='alive';
  const lean=(b.vx||0)*0.8;
  if(alive){ pin(p.P,cx,b.y+30); pin(p.C,cx+lean*0.5,b.y+19); }
  const GR = mode==='dead'?0.6:0.45;
  for(const k in p){
    if(alive&&(k==='P'||k==='C')) continue;
    const q=p[k], vx=(q.x-q.px)*0.985, vy=(q.y-q.py)*0.985;
    q.px=q.x; q.py=q.y; q.x+=vx; q.y+=vy+GR;
  }
  if(alive){
    const run=b.onGround && Math.abs(b.vx||0)>0.6;
    d.phase += run ? Math.min(0.4,Math.abs(b.vx)*0.085) : 0;
    const s=Math.sin(d.phase), c=Math.cos(d.phase), C=p.C, P=p.P, bottom=b.y+PH;
    spring(p.H, C.x+lean*0.4, C.y-10, 0.35);
    if(!b.onGround){
      spring(p.LH, C.x-12, C.y-9, 0.1); spring(p.RH, C.x+12, C.y-9, 0.1);
      spring(p.LF, P.x-4, P.y+10, 0.06); spring(p.RF, P.x+4, P.y+10, 0.06);
    }else if(run){
      spring(p.LH, C.x+s*11, C.y+8, 0.16); spring(p.RH, C.x-s*11, C.y+8, 0.16);
      spring(p.LF, P.x-s*9, bottom-Math.max(0,c)*5, 0.5); spring(p.RF, P.x+s*9, bottom-Math.max(0,-c)*5, 0.5);
    }else{
      const sw=Math.sin(tick*0.05)*2;
      spring(p.LH, C.x-10+sw, C.y+12, 0.08); spring(p.RH, C.x+10-sw, C.y+12, 0.08);
      spring(p.LF, P.x-5, bottom, 0.5); spring(p.RF, P.x+5, bottom, 0.5);
    }
    if(d.hold){ spring(p.RH, d.hold.x, d.hold.y, 0.4); spring(p.RE, (d.hold.x+C.x)/2, (d.hold.y+C.y)/2, 0.3); }
  }
  for(let it=0;it<5;it++){
    for(const [a,bk,len] of LINKS){
      const A=p[a], B=p[bk];
      const dx=B.x-A.x, dy=B.y-A.y, dd=Math.hypot(dx,dy)||0.001, diff=(dd-len)/dd;
      const wa=(alive&&(a==='P'||a==='C'))?0:1, wb=(alive&&(bk==='P'||bk==='C'))?0:1;
      const sw=wa+wb; if(!sw) continue;
      A.x+=dx*diff*wa/sw; A.y+=dy*diff*wa/sw; B.x-=dx*diff*wb/sw; B.y-=dy*diff*wb/sw;
    }
  }
  const only = alive ? ['LE','LH','RE','RH','LF','RF'] : Object.keys(p);
  for(const k of only) collidePt(p[k],SOL);
}

/* ---------------- Co-op tools ---------------- */
function launcherPadHit(l,q){ // is player q standing on the pad?
  return q.onGround && q.x+PW>l.x && q.x<l.x+l.w && Math.abs(q.y+PH-l.y)<8;
}
function applyLever(i,mine){
  const l=L.launchers[i]; if(!l||l.cool>0) return;
  l.cool=45; l.anim=24; sfx.lever();
  if(mine) send({t:'lever',i});
  if(me.dead===0 && launcherPadHit(l,me)){
    me.vy=-l.power; me.onGround=false; me.on=null; sfx.launch();
    burst(me.x+PW/2,me.y+PH,0xffc93c,14); banner('LAUNCH!');
  }
}
function tossMe(){ me.vy=-18.5; me.onGround=false; me.on=null; me.onHead=false; sfx.toss(); burst(me.x+PW/2,me.y+PH,0xffffff,8); }

/* ---------------- Update (fixed 60 Hz) ---------------- */
function stepCrates(){
  const need=c=>c.heavy?2:1;
  L.crates.forEach((c,i)=>{
    const oldX=c.x;
    if(isHost){
      const pushes=[];
      if(me.pushIdx===i) pushes.push(me.pushDir);
      if(other.seen && other.pi===i) pushes.push(other.pd);
      let target=0;
      if(pushes.length){
        const dir=pushes[0], n=pushes.filter(d=>d===dir).length, opp=pushes.length-n;
        if(n>opp && n>=need(c)) target=dir*(c.heavy?1.5:2.2);
      }
      c.vx += (target-c.vx)*0.3;
      const others=SOL.filter(s=>s.ref!==c);
      c.x += c.vx;
      for(const s of others){ if(hit(c,s)){ c.x=oldX; c.vx=0; break; } }
      c.vy=Math.min(c.vy+0.6,12);
      c.y += c.vy;
      for(const s of others){
        if(hit(c,s)){ if(c.vy>=0){ c.y=s.y-c.h; } else c.y=s.y+s.h; c.vy=0; }
      }
      if(c.y>WORLD_H+80){ c.x=c.sx; c.y=c.sy; c.vx=c.vy=0; }
    }else{
      c.x += (c.tx-c.x)*0.4; c.y += (c.ty-c.y)*0.4;
    }
    c.dx=c.x-oldX;
    if(me.on===c && me.dead===0) me.x += c.dx;
  });
  if(isHost && L.crates.length && tick%3===0) send({t:'c',c:L.crates.map(c=>[Math.round(c.x*10)/10,Math.round(c.y*10)/10])});
}

function update(){
  tick++;
  if(!L || !net.connected) return;
  if(phase==='play') levelTime++;

  const pressed = pressedIds();
  L.doors.forEach(d=>{
    const want = d.ids.every(id=>pressed.has(id)) ? 1 : 0;
    if(want!==d.prevWant){ d.prevWant=want; want?sfx.doorOpen():sfx.doorClose(); }
    d.open += Math.sign(want-d.open)*Math.min(Math.abs(want-d.open),0.05);
  });
  L.lifts.forEach(l=>{
    const want = l.ids.some(id=>pressed.has(id)) ? l.y1 : l.y0;
    const old=l.y;
    l.y += Math.sign(want-l.y)*Math.min(Math.abs(want-l.y),l.sp);
    l.dy = l.y-old;
    if(me.on===l && me.dead===0) me.y += l.dy;
  });
  const g=L.gate, gwant = (phase==='play'||phase==='done') ? 1 : 0;
  g.open += Math.sign(gwant-g.open)*Math.min(Math.abs(gwant-g.open),0.04);
  L.springs.forEach(s=>{ if(s.anim>0) s.anim--; if(s.cool>0) s.cool--; });
  L.launchers.forEach(l=>{ if(l.anim>0) l.anim--; if(l.cool>0) l.cool--; });
  SOL = buildSolids();
  stepCrates();
  SOL = buildSolids();

  if(other.seen){
    other.x += (other.tx-other.x)*0.4; other.y += (other.ty-other.y)*0.4;
    if(other.ready!==other.prevReady){ other.prevReady=other.ready; if(phase==='dock') sfx.ready(other.ready); }
  }

  // respawn key
  if(keys['r'] && !prevR && phase==='play' && me.dead===0) die();
  prevR = !!keys['r'];

  me.eHold = !!keys['e'] && phase==='play';
  me.pushIdx=-1; me.pushDir=0; me.onHead=false;

  // action key (edge): ready / lever / toss
  if(eEdge){
    eEdge=false;
    if(phase==='dock'){
      const pad=myPad();
      if(me.x+PW>pad.x && me.x<pad.x+pad.w && me.onGround){ me.ready=!me.ready; sfx.ready(me.ready); }
    }else if(phase==='play' && me.dead===0){
      let handled=false;
      L.launchers.forEach((l,i)=>{
        if(!handled && Math.abs(me.x+PW/2-l.lx)<48 && Math.abs(me.y+PH-l.ly)<30){ applyLever(i,true); handled=true; }
      });
      if(!handled && other.seen && other.onHead && Math.abs(other.x-me.x)<30 && other.y+PH<=me.y+10 && other.y+PH>=me.y-16){
        send({t:'toss'}); sfx.toss(); handled=true;
      }
    }
  }
  if(phase==='dock' && isHost && me.ready && other.ready){
    send({t:'start'}); phase='count'; countT=180; lastCount=4;
  }
  if(phase==='count'){
    countT--;
    const n=Math.ceil(countT/60);
    if(n!==lastCount){ lastCount=n; if(n>0) sfx.tick(); }
    if(countT<=0){ phase='play'; sfx.go(); banner('GO!'); }
  }
  if(phase==='done'){
    doneT--;
    if(isHost && doneT<=0){
      if(lvlIdx+1>=window.LEVELS.length){ send({t:'win'}); phase='win'; showWin(); }
      else { send({t:'lvl',i:lvlIdx+1}); loadLevel(lvlIdx+1); }
    }
  }

  /* ---- my character ---- */
  me.doll.hold = null;
  if(me.dead>0){
    me.dead--; if(me.dead===0) respawn();
  }else{
    const left = keys['a']||keys['arrowleft'], right = keys['d']||keys['arrowright'];
    const jump = keys[' ']||keys['w']||keys['arrowup'];
    const dir = (right?1:0)-(left?1:0);

    // clasp (hold hands): both hold E near each other, one above the other
    let clasp=null;
    if(phase==='play' && other.seen && !other.dead){
      const dx=Math.abs(other.x-me.x);
      if(me.claspLower!==null){
        const lowerY = me.claspLower?me.y:other.y, upperY = me.claspLower?other.y:me.y, dy=lowerY-upperY;
        if(me.eHold && other.eHold && dx<=110 && dy>-10 && dy<=340) clasp={lowerIsMe:me.claspLower}; else me.claspLower=null;
      }
      if(!clasp && me.eHold && other.eHold && dx<=90 && !other.onHead && !me.onHeadRecent){
        const lowerIsMe = me.y>other.y, lower=lowerIsMe?me:other, upper=lowerIsMe?other:me, dy=lower.y-upper.y;
        if(dy>=20 && dy<=340 && upper.onGround){ me.claspLower=lowerIsMe; clasp={lowerIsMe}; sfx.clasp(); banner('HOLD ON!'); }
      }
    }else me.claspLower=null;

    if(dir){ me.vx += dir*(me.onGround?0.9:0.55); me.face=dir; }
    else me.vx *= me.onGround?0.72:0.96;
    me.vx = clamp(me.vx,-4.6,4.6);

    if(jump){ me.buf=7; } else if(me.buf>0) me.buf--;
    if(me.onGround) me.coyote=6; else if(me.coyote>0) me.coyote--;
    if(me.buf>0 && me.coyote>0){ me.vy=-14; me.buf=0; me.coyote=0; me.onGround=false; sfx.jump(); }
    if(!jump && me.vy<-5) me.vy*=0.85;
    me.vy = Math.min(me.vy+0.6, 14);

    if(clasp){
      me.doll.hold = other.doll.p ? other.doll.p.RH : null;
      if(clasp.lowerIsMe){ me.vy=-5.5; me.onGround=false; me.coyote=0; me.buf=0; me.vx += clamp((other.x-me.x)*0.02,-0.5,0.5); if(tick%12===0) sfx.creak(); }
      else { me.vx*=0.15; }
    }

    const oldY = me.y, wasVy = me.vy;
    const oldX = me.x;
    me.x += me.vx;
    for(const s of SOL){
      if(hit({x:me.x,y:me.y,w:PW,h:PH},s)){
        if(s.ref && s.ref.heavy!==undefined && dir!==0 && me.onGround && ((me.vx>0&&dir>0)||(me.vx<0&&dir<0))){
          me.pushIdx=L.crates.indexOf(s.ref); me.pushDir=dir;
        }
        if(me.vx>0) me.x=s.x-PW; else if(me.vx<0) me.x=s.x+s.w;
        me.vx=0;
      }
    }
    if(me.x<0){ me.x=0; me.vx=0; }
    if(me.x>L.w-PW){ me.x=L.w-PW; me.vx=0; }
    me.y += me.vy;
    const wasOn = me.onGround;
    me.onGround=false; me.on=null;
    for(const s of SOL){
      if(hit({x:me.x,y:me.y,w:PW,h:PH},s)){
        if(me.vy>=0){ me.y=s.y-PH; me.onGround=true; me.on=s.ref||null; }
        else me.y=s.y+s.h;
        me.vy=0;
      }
    }
    if(other.seen && !other.dead && me.vy>=0){
      const ob={x:other.x,y:other.y,w:PW,h:PH};
      const prevBottom=oldY+PH, nb=me.y+PH;
      if(me.x+PW>ob.x+3 && me.x<ob.x+PW-3 && prevBottom<=ob.y+10 && nb>=ob.y && nb<=ob.y+26){
        me.y=ob.y-PH; me.vy=0; me.onGround=true; me.onHead=true; me.onHeadT=tick;
      }
    }
    me.onHeadRecent = (tick-me.onHeadT)<=8;
    if(me.onGround && !wasOn && wasVy>6){ sfx.land(); }
    if(me.onGround && Math.abs(me.vx)>2){ me.stepT++; if(me.stepT>13){ me.stepT=0; sfx.step(); } } else me.stepT=0;
    if(me.pushIdx>=0 && tick%18===0) sfx.crate();

    L.springs.forEach(s=>{
      const b=me.y+PH;
      if(s.cool===0 && me.x+PW>s.x && me.x<s.x+s.w && b>=s.y && b<=s.y+16 && me.vy>=0){
        me.vy=-s.p; me.onGround=false; s.anim=16; s.cool=14; sfx.spring();
      }
    });
    L.stars.forEach((s,i)=>{
      if(!s.got && Math.abs(me.x+PW/2-s.x)<26 && Math.abs(me.y+PH/2-s.y)<30) collectStar(i,true);
    });
    for(const s of L.spikes){
      if(hit({x:me.x+4,y:me.y+8,w:PW-8,h:PH-8},{x:s.x+4,y:s.y+4,w:s.w-8,h:s.h-4})) die();
    }
    if(me.dead===0 && me.y>SEA_Y) die();
    L.cps.forEach((c,i)=>{
      if(me.x>c.x && cpIdx<i+1){ cpIdx=i+1; send({t:'cp',i:cpIdx}); sfx.cp(); burst(c.x+10,c.y-20,0xffc93c,10); banner('Checkpoint!'); }
    });
  }

  /* ---- ragdolls ---- */
  dollStep(me.doll, me, me.dead>0?'dead':'alive');
  if(other.seen){
    other.doll.hold = (me.claspLower!==null && other.doll.p && me.doll.p) ? me.doll.p.RH : null;
    dollStep(other.doll, other, other.dead?'dead':'alive');
  }

  // exit (host judges)
  if(phase==='play' && isHost && other.seen){
    const e={x:L.exit[0],y:L.exit[1],w:L.exit[2],h:L.exit[3]};
    const inMe = me.dead===0 && hit({x:me.x,y:me.y,w:PW,h:PH},e);
    const inO  = !other.dead && hit({x:other.x,y:other.y,w:PW,h:PH},e);
    if(inMe && inO) exitT++; else exitT=0;
    if(exitT>40){ exitT=0; send({t:'done',time:levelTime}); finishLevel(levelTime); }
  }

  if(tick%2===0) send({t:'s',x:Math.round(me.x*10)/10,y:Math.round(me.y*10)/10,vx:Math.round(me.vx*10)/10,vy:Math.round(me.vy*10)/10,
    f:me.face,g:me.onGround,r:me.ready,dd:me.dead>0,e:me.eHold,oh:me.onHead,pi:me.pushIdx,pd:me.pushDir});

  // camera target (zoom out when the idiots drift apart)
  const mx = other.seen ? (me.x+other.x)/2 : me.x;
  const my = other.seen ? (me.y+other.y)/2 : me.y;
  const sepX = other.seen ? Math.abs(me.x-other.x) : 0, sepY = other.seen ? Math.abs(me.y-other.y) : 0;
  const zt = clamp(Math.max((sepX+380)/(VH*ASPECT), (sepY+300)/VH, 1),1,1.8);
  cam.zoom += (zt-cam.zoom)*0.05;
  const halfH=VH/2*cam.zoom, halfW=halfH*ASPECT;
  const tx = L.w<=halfW*2 ? L.w/2 : clamp(mx, halfW, L.w-halfW);
  const ty = clamp(my-20, L.top+halfH, WORLD_H-halfH+40);
  cam.x += (tx-cam.x)*0.1; cam.y += (ty-cam.y)*0.08;

  fx.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.vy+=(p.g||0.3);p.life--;});
  fx = fx.filter(p=>p.life>0);

  const lm = muted?0:level(meters.me), lo = level(meters.other);
  me.talk = lm>0.04; other.talk = lo>0.03;
  $('dotMe').classList.toggle('talk', me.talk);
  $('dotOther').classList.toggle('talk', other.talk);
}
let hintShownAt = 0;

/* ============================================================
   THREE.JS RENDERING
   ============================================================ */
let renderer=null, camera=null, hullMat=null, gradTex=null, lobby=null, lobbyChars=null, gameChars=null;
const matCache={};
const toon = hex=>{ if(!matCache[hex]) matCache[hex]=new THREE.MeshToonMaterial({color:hex,gradientMap:gradTex}); return matCache[hex]; };
const TAN20 = Math.tan(20*Math.PI/180);

function initThree(){
  renderer = new THREE.WebGLRenderer({canvas:$('gl'),antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.75));
  camera = new THREE.PerspectiveCamera(40,16/9,10,9000);
  const d = new Uint8Array([120,190,255]);
  gradTex = new THREE.DataTexture(d,3,1,THREE.LuminanceFormat);
  gradTex.minFilter = gradTex.magFilter = THREE.NearestFilter; gradTex.needsUpdate = true;
  hullMat = new THREE.MeshBasicMaterial({color:INK,side:THREE.BackSide});
}
function placeCamera(cx,cyWorld,zoom){
  const halfH=VH/2*zoom;
  camera.position.set(cx,-cyWorld,halfH/TAN20);
}
function addBox(parent,w,h,d,hex,x,y,z,ol){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),toon(hex)); m.position.set(x,y,z); parent.add(m);
  if(ol){ const o=new THREE.Mesh(new THREE.BoxGeometry(w+ol*2,h+ol*2,d+ol*2),hullMat); o.position.set(x,y,z); parent.add(o); }
  return m;
}
function addSphere(parent,r,hex,x,y,z,sx,sy,sz,ol){
  const m=new THREE.Mesh(new THREE.SphereGeometry(r,14,10),toon(hex)); m.position.set(x,y,z); m.scale.set(sx||1,sy||1,sz||1); parent.add(m);
  if(ol){ const o=new THREE.Mesh(new THREE.SphereGeometry(r+ol,14,10),hullMat); o.position.set(x,y,z); o.scale.set(sx||1,sy||1,sz||1); parent.add(o); }
  return m;
}
function addCyl(parent,rt,rb,h,hex,x,y,z,ol,seg){
  const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,seg||10),toon(hex)); m.position.set(x,y,z); parent.add(m);
  if(ol){ const o=new THREE.Mesh(new THREE.CylinderGeometry(rt+ol,rb+ol,h+ol,seg||10),hullMat); o.position.set(x,y,z); parent.add(o); }
  return m;
}
function textPlane(text,w,h,font,fg,bg){
  const c=document.createElement('canvas'); c.width=256; c.height=Math.round(256*h/w);
  const x=c.getContext('2d');
  if(bg){ x.fillStyle=bg; x.fillRect(0,0,c.width,c.height); x.strokeStyle='#2b2d5b'; x.lineWidth=14; x.strokeRect(0,0,c.width,c.height); }
  x.fillStyle=fg; x.font=font; x.textAlign='center'; x.textBaseline='middle'; x.fillText(text,c.width/2,c.height/2+4);
  const t=new THREE.CanvasTexture(c);
  return new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:t,transparent:true}));
}
function starGeom(){
  const sh=new THREE.Shape(); const R=15,r=7;
  for(let i=0;i<10;i++){ const a=-Math.PI/2+i*Math.PI/5, rad=i%2?r:R; i?sh.lineTo(Math.cos(a)*rad,-Math.sin(a)*rad):sh.moveTo(Math.cos(a)*rad,-Math.sin(a)*rad); }
  sh.closePath();
  const g=new THREE.ExtrudeGeometry(sh,{depth:7,bevelEnabled:true,bevelThickness:2,bevelSize:2,bevelSegments:2});
  g.center(); return g;
}

/* ---- sky, sun, clouds, hills (shared by game + lobby scenes) ---- */
function addSky(sc,W,skyTop,skyBot){
  const g=new THREE.PlaneGeometry(16000,7000,1,1);
  const c=new Float32Array(12), ct=new THREE.Color(skyTop), cb=new THREE.Color(skyBot);
  [ct,ct,cb,cb].forEach((col,i)=>{ c[i*3]=col.r; c[i*3+1]=col.g; c[i*3+2]=col.b; });
  g.setAttribute('color',new THREE.BufferAttribute(c,3));
  const bd=new THREE.Mesh(g,new THREE.MeshBasicMaterial({vertexColors:true,fog:false,depthWrite:false}));
  sc.add(bd);
  W.follow.push({o:bd,fn:(o)=>o.position.set(camera.position.x,camera.position.y,camera.position.z-5000)});
  // cartoon sun
  const sun=new THREE.Group();
  const bm=new THREE.MeshBasicMaterial({color:0xffe066,fog:false}), rm=new THREE.MeshBasicMaterial({color:0xffc93c,fog:false}), im=new THREE.MeshBasicMaterial({color:INK,fog:false});
  sun.add(new THREE.Mesh(new THREE.SphereGeometry(300,24,16),bm));
  const ring=new THREE.Group(); sun.add(ring);
  for(let i=0;i<12;i++){ const cn=new THREE.Mesh(new THREE.ConeGeometry(70,170,4),rm); const a=i/12*TAU; cn.position.set(Math.cos(a)*410,Math.sin(a)*410,0); cn.rotation.z=a-Math.PI/2; ring.add(cn); }
  [[-95,45],[95,45]].forEach(p=>{ const e=new THREE.Mesh(new THREE.SphereGeometry(30,12,10),im); e.position.set(p[0],p[1],270); e.scale.set(0.8,1.3,0.5); sun.add(e); });
  const sm=new THREE.Mesh(new THREE.TorusGeometry(95,14,8,16,Math.PI),im); sm.position.set(0,-30,285); sm.rotation.z=Math.PI; sun.add(sm);
  [[-170,-30],[170,-30]].forEach(p=>{ const ch=new THREE.Mesh(new THREE.SphereGeometry(34,10,8),new THREE.MeshBasicMaterial({color:0xff9bb8,fog:false})); ch.position.set(p[0],p[1],250); ch.scale.set(1,0.7,0.4); sun.add(ch); });
  sc.add(sun);
  W.follow.push({o:sun,fn:(o)=>{ const dist=5000, hh=dist*TAN20; o.position.set(camera.position.x+hh*ASPECT*0.6,camera.position.y+hh*0.55,camera.position.z-dist); ring.rotation.z=tick*0.004; }});
}
function makeCloud(sc,W,x,y,z,s,speed){
  const g=new THREE.Group();
  [[0,0,40,1],[44,14,52,1],[96,0,44,1],[48,-12,46,0.9]].forEach(c=>addSphere(g,c[2],0xffffff,c[0],c[1],0,1,c[3],0.8,0));
  g.position.set(x,y,z); g.scale.set(s,s,s);
  g.userData.sp=speed; sc.add(g); W.clouds.push(g);
}
function addHills(sc,wMax,th){
  const geo=new THREE.SphereGeometry(1,20,12);
  for(let li=0;li<3;li++){
    const z=-700-li*700, R=460+li*220, step=R*1.25;
    const mat=new THREE.MeshLambertMaterial({color:th.hills[li]});
    for(let x=-2400;x<wMax+2400;x+=step){
      const r=R*(0.8+((hash(x+li*91)%40)/100));
      const m=new THREE.Mesh(geo,mat); m.position.set(x,-(640+li*30),z); m.scale.set(r,r*0.5,r*0.6); sc.add(m);
    }
  }
}
function makeBalloon(sc,W,x,y,z){
  const g=new THREE.Group();
  addSphere(g,34,0xff6fa5,0,0,0,1,1.2,1,2.5);
  const st=new THREE.Mesh(new THREE.TorusGeometry(33,5,6,20),toon(0xffe066)); st.rotation.y=Math.PI/2; st.scale.set(1,1.2,1); g.add(st);
  addBox(g,22,16,22,0xc98d58,0,-60,0,2);
  g.position.set(x,y,z); g.userData.sp=0.12; g.userData.bob=hash(x)%6; sc.add(g); W.clouds.push(g);
}

/* ---- props (3D scenery standing on ground) ---- */
function makeProp(kind,k){
  const g=new THREE.Group();
  if(kind==='meadow'){
    if(k===0){ addCyl(g,7,9,52,0xb9814f,0,26,0,2); [[0,78,32],[-24,62,23],[24,62,23]].forEach(c=>addSphere(g,c[2],0x5fd05a,c[0],c[1],0,1,1,1,2.2)); }
    else if(k===1){ [[-16,16,17],[0,22,20],[17,16,17]].forEach(c=>addSphere(g,c[2],0x5fd05a,c[0],c[1],0,1,1,1,2.2));
      addSphere(g,2.6,INK,-5,24,19); addSphere(g,2.6,INK,6,24,19); }
    else { addCyl(g,16,17,32,0xfff3d6,0,16,0,2); const cap=new THREE.Mesh(new THREE.SphereGeometry(38,18,10,0,TAU,0,Math.PI/2),toon(0xff4d6d)); cap.position.y=30; cap.scale.y=0.85; g.add(cap);
      [[-18,50,34],[10,60,6],[24,44,18]].forEach(c=>addSphere(g,5,0xffffff,c[0],c[1],c[2]*0.9)); }
  }else if(kind==='beach'){
    if(k===0){ let x=0; for(let i=0;i<5;i++){ addCyl(g,6,7,20,0xc98d58,x,10+i*18,0,1.8); x+=i*1.6; }
      for(let a=0;a<5;a++){ const l=addSphere(g,10,0x46c763,x+16*Math.cos(-0.1-a*0.75),96+Math.sin(-0.1-a*0.75)*-12,0,3,0.5,1,1.6); l.rotation.z=-0.1-a*0.75+0.2; l.position.x=x+Math.cos(a*0.8-0.2)*24; l.position.y=96-Math.abs(Math.sin(a*0.8))*8; l.rotation.z=a*0.8-0.9; }
      addSphere(g,6,0x8a5a2c,x-4,88,6); addSphere(g,6,0x8a5a2c,x+6,87,6); }
    else if(k===1){ addCyl(g,2.8,2.8,86,0xffffff,0,43,0,1.5); const cn=new THREE.Mesh(new THREE.ConeGeometry(46,26,14),toon(0xff5d8f)); cn.position.y=92; g.add(cn); const o=new THREE.Mesh(new THREE.ConeGeometry(49,29,14),hullMat); o.position.y=92; g.add(o); addSphere(g,5,0xffffff,0,108,0); }
    else { addBox(g,60,30,40,0xf7d58a,0,15,0,2); addBox(g,16,22,16,0xf7d58a,-24,40,0,2); addBox(g,16,22,16,0xf7d58a,24,40,0,2); addBox(g,18,40,18,0xf7d58a,0,30,0,2); addCyl(g,1.5,1.5,24,INK,0,62,0); addBox(g,16,10,2,0xff5d8f,8,66,0); }
  }else{
    if(k===0){ addCyl(g,3.5,3.5,62,0xffffff,0,31,0,1.8); const d=addCyl(g,26,26,9,0xff6fa5,0,76,0,2,24); d.rotation.x=Math.PI/2; const sw=new THREE.Mesh(new THREE.TorusGeometry(15,3.5,6,22),toon(0xffffff)); sw.position.set(0,76,6); g.add(sw); }
    else { [[-16,14,17,0xff9bd0],[0,20,20,0x9be8ff],[17,14,17,0xffe066]].forEach(c=>{ addSphere(g,c[2],c[3],c[0],c[1],0,1,1,1,2.2); addSphere(g,4,0xffffff,c[0]-5,c[1]+6,c[2]*0.75,1,0.8,0.5); }); }
  }
  return g;
}

/* ---- world (level) builder ---- */
function buildWorld(Lv){
  const th=Lv.theme, sc=new THREE.Scene();
  sc.fog=new THREE.Fog(th.fog,1600,5200);
  sc.add(new THREE.HemisphereLight(0xffffff,0xc8d0ff,0.8));
  const dl=new THREE.DirectionalLight(0xffffff,0.55); dl.position.set(-300,700,600); sc.add(dl);
  const W={scene:sc,follow:[],clouds:[],doors:[],lifts:[],plates:[],crates:[],springs:[],stars:[],cps:[],launchers:[],pads:[],gate:null,sea:null,sea2:null,exit:null};
  const sk=th.sky;
  addSky(sc,W,sk[0],sk[1]);
  addHills(sc,Lv.w,th);
  for(let i=0;i<9;i++){
    const h=hash(i*131+7);
    makeCloud(sc,W,-600+h%(Lv.w+1200),-(Lv.top-80+(h%500)),-300-(h%700),0.9+(h%5)/5,0.08+(h%5)/60);
  }
  if(Lv.kind!=='beach') makeBalloon(sc,W,Lv.w*0.6,-(Lv.top+160),-520);

  // sea / cotton clouds in the gaps
  const seaW=Lv.w+3000;
  const mkSea=(hex,z,ofs)=>{
    const g=new THREE.PlaneGeometry(seaW,260,200,1);
    const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:hex}));
    m.position.set(Lv.w/2,-(WORLD_H-84+ofs)-130,z); sc.add(m); return m;
  };
  W.sea=mkSea(th.sea[0],-10,0); W.sea2=mkSea(th.sea[1],40,16);

  // solids
  const fringe=[], pebbles=[];
  Lv.solids.forEach((s,si)=>{
    if(s.h<=24){ addBox(sc,s.w,s.h,60,th.plank,s.x+s.w/2,-(s.y+s.h/2),0,3); addBox(sc,s.w-6,7,64,th.top,s.x+s.w/2,-(s.y+5),0,0); return; }
    addBox(sc,s.w,s.h,160,th.body,s.x+s.w/2,-(s.y+s.h/2),0,4);
    addBox(sc,s.w+4,12,166,th.top,s.x+s.w/2,-(s.y+6),0,0);
    for(let x=s.x+10;x<s.x+s.w-8;x+=22) fringe.push([x,-(s.y+11),80]);
    for(let x=s.x+30,r=0;x<s.x+s.w-20;x+=52,r++) for(let y=s.y+40+(r%2)*22;y<Math.min(s.y+s.h-10,s.y+200);y+=46) pebbles.push([x,-y,82]);
    // props behind the idiots
    if(s.w>=380 && s.h>=100){
      for(let x=Math.ceil((s.x+110)/230)*230; x<s.x+s.w-60; x+=230){
        if(s.x<10 && x<460) continue;
        const h=hash(x+si*77), p=makeProp(Lv.kind==='sky'?'candy':Lv.kind,h%3);
        p.position.set(x+(h%60)-30,-(s.y),-70-(h%140)); sc.add(p);
      }
    }
  });
  if(fringe.length){
    const im=new THREE.InstancedMesh(new THREE.SphereGeometry(9.5,10,8),toon(th.top),fringe.length), o=new THREE.Object3D();
    fringe.forEach((f,i)=>{ o.position.set(f[0],f[1],f[2]); o.scale.set(1,0.85,0.8); o.updateMatrix(); im.setMatrixAt(i,o.matrix); });
    im.instanceMatrix.needsUpdate=true; sc.add(im);
  }
  if(pebbles.length){
    const im=new THREE.InstancedMesh(new THREE.SphereGeometry(8,8,6),toon(th.dot),pebbles.length), o=new THREE.Object3D();
    pebbles.forEach((f,i)=>{ o.position.set(f[0],f[1],f[2]); o.scale.set(1.1,0.6,0.35); o.updateMatrix(); im.setMatrixAt(i,o.matrix); });
    im.instanceMatrix.needsUpdate=true; sc.add(im);
  }
  // spikes
  Lv.spikes.forEach(s=>{
    for(let x=s.x;x<s.x+s.w-4;x+=13) for(const z of [-14,14]){
      const c=new THREE.Mesh(new THREE.ConeGeometry(7,s.h+2,8),toon(0xff4d6d)); c.position.set(x+6.5,-(s.y+s.h/2),z); sc.add(c);
      const o=new THREE.Mesh(new THREE.ConeGeometry(8.6,s.h+4,8),hullMat); o.position.copy(c.position); sc.add(o);
    }
  });
  // plates
  Lv.plates.forEach(p=>{
    const g=new THREE.Group(); const c=colorFor(p.id);
    addBox(g,p.w+8,5,50,0xffffff,0,-3,0,2); addBox(g,p.w,8,44,c,0,2,0,2);
    g.position.set(p.x+p.w/2,-(p.y+3.5),0); sc.add(g); W.plates.push(g);
  });
  // doors (pivot at the bottom so they sink into the floor)
  Lv.doors.forEach(d=>{
    const g=new THREE.Group(); const c=colorFor(d.ids[0]);
    addBox(g,d.w,d.h,40,c,0,d.h/2,0,3);
    for(let y=14;y<d.h-8;y+=26) addBox(g,d.w-10,6,4,0xffffff,0,y,21,0);
    g.position.set(d.x+d.w/2,-(d.y0+d.h),0); sc.add(g); W.doors.push(g);
    addBox(sc,d.w+14,10,48,0xffffff,d.x+d.w/2,-(d.y0-4),0,2);
  });
  // lifts
  Lv.lifts.forEach(l=>{
    const g=new THREE.Group(); const c=colorFor(l.ids[0]);
    addBox(g,l.w,l.h,80,0xffffff,0,0,0,3); addBox(g,l.w-8,5,70,c,0,l.h/2-3,0,0);
    for(let x=-l.w/2+16;x<l.w/2-10;x+=26) addBox(g,12,4,60,c,x,-3,0,0);
    sc.add(g); W.lifts.push(g);
  });
  // springs (bouncy mushrooms)
  Lv.springs.forEach(s=>{
    const g=new THREE.Group();
    addCyl(g,7,8,12,0xfff3d6,0,6,0,2);
    const cap=new THREE.Mesh(new THREE.SphereGeometry(s.w/2,16,10,0,TAU,0,Math.PI/2),toon(0xff4d6d)); cap.position.y=10; cap.scale.y=0.7; g.add(cap);
    [[-9,19,16],[8,21,12]].forEach(c=>addSphere(g,3.2,0xffffff,c[0],c[1],c[2]*0.8));
    g.position.set(s.x+s.w/2,-(s.y+14),0); sc.add(g); W.springs.push(g);
  });
  // crates
  Lv.crates.forEach(c=>{
    const g=new THREE.Group();
    if(c.heavy){
      addBox(g,c.w,c.h,c.w,0x9aa3c8,0,0,0,3);
      addBox(g,c.w+3,8,c.w+3,0xff5d8f,0,c.h/2-14,0,0); addBox(g,c.w+3,8,c.w+3,0xff5d8f,0,-c.h/2+14,0,0);
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(q=>addSphere(g,3.4,0xffe066,q[0]*(c.w/2-7),q[1]*(c.h/2-7),c.w/2+1));
      const t=textPlane('2x',22,16,'bold 90px Arial','#2b2d5b',null); t.position.set(0,0,c.w/2+2); g.add(t);
    }else{
      addBox(g,c.w,c.h,c.w,0xe0a560,0,0,0,3);
      for(let i=-1;i<=1;i+=2) addBox(g,c.w+2,6,c.w+2,0xb97a3a,0,i*(c.h/2-6),0,0);
      const d1=addBox(g,6,c.h*1.2,3,0xb97a3a,0,0,c.w/2+1,0); d1.rotation.z=0.75;
    }
    sc.add(g); W.crates.push(g);
  });
  // launchers: pad + lever
  Lv.launchers.forEach(l=>{
    const pad=new THREE.Group();
    addBox(pad,l.w,10,56,0xff8a3d,0,0,0,3);
    for(let i=-1;i<=1;i++){ const c=new THREE.Mesh(new THREE.ConeGeometry(8,16,4),toon(0xffe066)); c.position.set(i*26,12,0); pad.add(c); }
    pad.position.set(l.x+l.w/2,-(l.y+5),0); sc.add(pad);
    const lev=new THREE.Group();
    addBox(lev,36,12,34,0x8f93c8,0,6,0,2.5);
    const stick=new THREE.Group(); addCyl(stick,3.5,3.5,40,0xdfe3ff,0,20,0,1.8); addSphere(stick,8,0xff4d6d,0,42,0,1,1,1,2); stick.position.y=12; lev.add(stick);
    lev.position.set(l.lx,-l.ly,0); sc.add(lev);
    const hintP=textPlane('E',22,22,'bold 120px Arial','#ffffff','#ff5d8f'); hintP.position.set(l.lx,-(l.ly-76),20); sc.add(hintP);
    W.launchers.push({pad,stick});
  });
  // stars
  const sg=starGeom();
  Lv.stars.forEach(s=>{
    const m=new THREE.Mesh(sg,new THREE.MeshToonMaterial({color:0xffc93c,gradientMap:gradTex,emissive:0x664400}));
    const o=new THREE.Mesh(sg,hullMat); o.scale.set(1.18,1.18,1.3); m.add(o);
    m.position.set(s.x,-s.y,0); sc.add(m); W.stars.push(m);
  });
  // checkpoints
  Lv.cps.forEach(c=>{
    const g=new THREE.Group();
    addCyl(g,2.6,2.6,96,0xdfe3ff,0,14,0,1.6);
    const f=new THREE.Mesh(new THREE.PlaneGeometry(34,22),new THREE.MeshBasicMaterial({color:0xe3e5f7,side:THREE.DoubleSide})); f.position.set(18,48,0); g.add(f);
    g.position.set(c.x,-(c.y+14)+14,0); g.position.y=-(c.y+14); sc.add(g); W.cps.push({g,f});
  });
  // exit arch
  {
    const e=Lv.exit, cx=e[0]+e[2]/2, base=e[1]+e[3], R=44, cy=e[1]+R;
    const g=new THREE.Group();
    [0xff5d8f,0xffb300,0x6fd35f,0x3fb8ff].forEach((hex,i)=>{
      const r=R-3-i*7;
      const t=new THREE.Mesh(new THREE.TorusGeometry(r,3.6,8,28,Math.PI),toon(hex)); t.position.set(0,cy-base,0); g.add(t);
      const colH=cy-e[1]+ (base-cy);
      [-r,r].forEach(x=>{ const c=addCyl(g,3.6,3.6,base-cy,hex,x,(cy-base)/2*-1*0,0,0); c.position.set(x,-(base-cy)/2 + 0,0); c.position.y=(cy-base)*0 - (base-cy)/2 + (cy-base)*0; });
    });
    // columns positions fixed below (relative to base at y=0)
    g.children.forEach(ch=>{});
    g.position.set(cx,-base,0);
    // rebuild properly: clear and redo with explicit relative coordinates
    while(g.children.length) g.remove(g.children[0]);
    [0xff5d8f,0xffb300,0x6fd35f,0x3fb8ff].forEach((hex,i)=>{
      const r=R-3-i*7, h=base-cy;
      const t=new THREE.Mesh(new THREE.TorusGeometry(r,3.6,8,28,Math.PI),toon(hex)); t.position.set(0,h,0); g.add(t);
      [-r,r].forEach(x=>{ const c=new THREE.Mesh(new THREE.CylinderGeometry(3.6,3.6,h,8),toon(hex)); c.position.set(x,h/2,0); g.add(c); });
    });
    const glow=new THREE.Mesh(new THREE.PlaneGeometry(R*1.5,base-e[1]),new THREE.MeshBasicMaterial({color:0xfff6b8,transparent:true,opacity:0.55}));
    glow.position.set(0,(base-e[1])/2-4,-10); g.add(glow);
    const pole=addCyl(g,2,2,44,INK,0,base-e[1]+22,0,0), flag=new THREE.Mesh(new THREE.PlaneGeometry(28,18),new THREE.MeshBasicMaterial({color:0xff5d8f,side:THREE.DoubleSide}));
    flag.position.set(14,base-e[1]+34,0); g.add(flag);
    const lab=textPlane('both idiots',70,18,'bold 36px Arial','#2b2d5b',null); lab.position.set(0,-14,30); g.add(lab);
    sc.add(g); W.exit={g,flag,glow};
  }
  // start bay: gate, pads, sign
  {
    const g=new THREE.Group();
    addBox(g,22,420,44,0xffffff,0,210,0,3);
    for(let y=14;y<400;y+=36) addBox(g,24,14,46,0xff5d8f,0,y,0,0);
    g.position.set(351,-G,0); sc.add(g); W.gate=g;
    [[80,0x19c3a6],[270,0xff8a3d]].forEach(p=>{
      const d=addCyl(sc,46,46,7,p[1],p[0],-(G-3),0,2.5,24); W.pads.push(d);
    });
    const post=addCyl(sc,3,3,86,INK,170,-(G-43),-30,0), sign=textPlane('START',84,36,'bold 80px Arial','#2b2d5b','#ffffff');
    sign.position.set(170,-(G-102),-27); sc.add(sign);
  }
  return W;
}
function disposeWorld(W){
  W.scene.traverse(o=>{ if(o.geometry && o.geometry.dispose) o.geometry.dispose(); });
}

/* ---- cartoon ragdoll character (3D meshes driven by the 2D verlet puppet) ---- */
function makeChar(col,dark,acc){
  const root=new THREE.Group(), C={root,rotY:0};
  const sph=(r,hex,ol)=>{ const gr=new THREE.Group(); gr.add(new THREE.Mesh(new THREE.SphereGeometry(r,14,10),toon(hex))); if(ol){ gr.add(new THREE.Mesh(new THREE.SphereGeometry(r+ol,14,10),hullMat)); } return gr; };
  const limb=(hex,r)=>{ const gr=new THREE.Group(); gr.add(new THREE.Mesh(new THREE.CylinderGeometry(r,r,1,9),toon(hex))); gr.add(new THREE.Mesh(new THREE.CylinderGeometry(r+1.7,r+1.7,1,9),hullMat)); return gr; };
  C.torso=sph(10,col,2); root.add(C.torso);
  C.head=new THREE.Group(); root.add(C.head);
  C.head.add(sph(12.5,col,2.2));
  const eyeW=new THREE.MeshBasicMaterial({color:0xffffff}), eyeB=new THREE.MeshBasicMaterial({color:INK});
  C.eyes=[]; C.pupils=[]; C.xs=[];
  [-5.2,5.2].forEach(x=>{
    const e=new THREE.Mesh(new THREE.SphereGeometry(4.7,12,10),eyeW); e.position.set(x,2,9.2); e.scale.set(1,1.1,0.8); C.head.add(e); C.eyes.push(e);
    const p=new THREE.Mesh(new THREE.SphereGeometry(2.3,10,8),eyeB); p.position.set(x,2,13); C.head.add(p); C.pupils.push(p);
    const xa=new THREE.Mesh(new THREE.BoxGeometry(7,1.6,1.2),eyeB), xb=xa.clone(); xa.position.set(x,2,13.6); xb.position.copy(xa.position); xa.rotation.z=0.78; xb.rotation.z=-0.78; xa.visible=xb.visible=false; C.head.add(xa); C.head.add(xb); C.xs.push(xa,xb);
  });
  C.smile=new THREE.Mesh(new THREE.TorusGeometry(3.8,0.9,6,12,Math.PI),eyeB); C.smile.rotation.z=Math.PI; C.smile.position.set(0,-3.5,12); C.head.add(C.smile);
  C.mouthO=new THREE.Mesh(new THREE.SphereGeometry(3.2,10,8),eyeB); C.mouthO.scale.set(1,1.25,0.5); C.mouthO.position.set(0,-6.5,12); C.mouthO.visible=false; C.head.add(C.mouthO);
  [-9.5,9.5].forEach(x=>{ const ch=new THREE.Mesh(new THREE.SphereGeometry(2.8,8,6),new THREE.MeshBasicMaterial({color:0xff9bb8})); ch.position.set(x,-3,9.2); ch.scale.set(1,0.8,0.4); C.head.add(ch); });
  if(acc==='sprout'){ addCyl(C.head,1.4,1.4,9,0x3da34a,0,16,0,0); addSphere(C.head,5,0x6fd35f,5,20,0,1.5,0.5,1,0); }
  else { [-1,1].forEach(s=>{ const c=new THREE.Mesh(new THREE.ConeGeometry(6,10,4),toon(0xff5d8f)); c.position.set(s*6,15,0); c.rotation.z=-s*Math.PI/2; C.head.add(c); }); addSphere(C.head,2.6,0xff5d8f,0,15,0); }
  C.armL=[limb(col,3.4),limb(col,3.4)]; C.armR=[limb(col,3.4),limb(col,3.4)];
  C.legL=limb(dark,3.8); C.legR=limb(dark,3.8);
  [...C.armL,...C.armR,C.legL,C.legR].forEach(m=>root.add(m));
  C.elbowL=sph(3.8,col,1.4); C.elbowR=sph(3.8,col,1.4); C.handL=sph(4.6,0xffffff,1.5); C.handR=sph(4.6,0xffffff,1.5);
  C.footL=sph(1,0xffffff,0.15); C.footR=sph(1,0xffffff,0.15);
  [C.footL,C.footR].forEach(f=>{ f.scale.set(7.2,3.9,6); });
  [C.elbowL,C.elbowR,C.handL,C.handR,C.footL,C.footR].forEach(m=>root.add(m));
  C.belt=new THREE.Mesh(new THREE.TorusGeometry(8,2,6,14),toon(0xffc93c)); C.belt.rotation.x=Math.PI/2; root.add(C.belt);
  C.shadow=new THREE.Mesh(new THREE.CircleGeometry(14,16),new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.25,depthWrite:false}));
  C.shadow.rotation.x=-Math.PI/2;
  return C;
}
function setLimb(g,a,b,z,P){
  const ax=a.x-P.x, ay=-(a.y-P.y), bx=b.x-P.x, by=-(b.y-P.y);
  const len=Math.hypot(bx-ax,by-ay)||0.01;
  g.position.set((ax+bx)/2,(ay+by)/2,z);
  g.rotation.z=Math.atan2(by-ay,bx-ax)-Math.PI/2;
  g.scale.set(1,len,1);
}
function poseChar(C,doll,b){
  if(!doll.p) return;
  const p=doll.p, P=p.P, dead=doll.mode==='dead', scream=!b.onGround||dead;
  C.root.position.set(P.x,-P.y,0);
  const f=b.face||1;
  C.rotY += (f*0.55-C.rotY)*0.18; C.root.rotation.y=C.rotY;
  const rel=(q,z)=>[q.x-P.x,-(q.y-P.y),z];
  // torso
  const cy=-(p.C.y-P.y), mid=cy/2;
  C.torso.position.set((p.C.x-P.x)/2,mid,0);
  C.torso.rotation.z=-Math.atan2(p.C.x-P.x,P.y-p.C.y);
  C.torso.scale.set(0.9,(Math.abs(cy)/2+7)/10,0.85);
  C.belt.position.set(0,-2,0);
  // head
  C.head.position.set(p.H.x-P.x,-(p.H.y-P.y),2);
  C.head.rotation.z=-Math.atan2(p.H.x-p.C.x,p.C.y-p.H.y);
  const blink=(tick%220)<7 && !dead;
  C.eyes.forEach((e,i)=>{ e.visible=!dead; e.scale.y=blink?0.12:(scream?1.3:1.1); });
  C.pupils.forEach((e,i)=>{ e.visible=!dead&&!blink; e.position.x=(i?5.2:-5.2)+f*1.2; });
  C.xs.forEach(x=>x.visible=dead);
  C.smile.visible=!scream; C.mouthO.visible=scream&&!dead; if(dead) C.smile.visible=true;
  // limbs
  setLimb(C.armL[0],p.C,p.LE,-7,P); setLimb(C.armL[1],p.LE,p.LH,-7,P);
  setLimb(C.armR[0],p.C,p.RE,7,P); setLimb(C.armR[1],p.RE,p.RH,7,P);
  setLimb(C.legL,P,p.LF,-4,P); setLimb(C.legR,P,p.RF,4,P);
  const set=(m,q,z,ox)=>m.position.set(q.x-P.x+(ox||0),-(q.y-P.y),z);
  set(C.elbowL,p.LE,-7); set(C.elbowR,p.RE,7); set(C.handL,p.LH,-7); set(C.handR,p.RH,7);
  set(C.footL,p.LF,-4,f*2); set(C.footR,p.RF,4,f*2);
}
function groundBelow(x,y){
  let best=null;
  for(const s of SOL){ if(x>=s.x && x<=s.x+s.w && s.y>=y-6 && (best===null||s.y<best)) best=s.y; }
  return best;
}
function placeShadow(C,b,doll){
  if(!doll.p){ C.shadow.visible=false; return; }
  const x=doll.p.P.x, y=Math.max(doll.p.P.y,b.y+PH*0.5), gy=groundBelow(x,y);
  if(gy===null){ C.shadow.visible=false; return; }
  C.shadow.visible=true; const h=Math.max(0,gy-(b.y+PH));
  const s=clamp(1-h/260,0.25,1); C.shadow.scale.set(s,s,s); C.shadow.position.set(x,-gy+1,0);
  C.shadow.material.opacity=0.28*s;
}

/* ---- per-frame sync of the 3D game world ---- */
function syncWorld(){
  const W=world, th=L.theme;
  W.doors.forEach((g,i)=>{ g.scale.y=Math.max(0.001,1-L.doors[i].open); });
  W.lifts.forEach((g,i)=>{ const l=L.lifts[i]; g.position.set(l.x+l.w/2,-(l.y+l.h/2),0); });
  W.plates.forEach((g,i)=>{ const p=L.plates[i]; g.position.y=-(p.y+3.5)-(p.pressed?2.5:0); });
  W.crates.forEach((g,i)=>{ const c=L.crates[i]; g.position.set(c.x+c.w/2,-(c.y+c.h/2),0); });
  W.springs.forEach((g,i)=>{ const s=L.springs[i], k=s.anim>0?(1+Math.sin(s.anim*0.4)*0.28):1; g.scale.y=k; });
  W.stars.forEach((m,i)=>{ const s=L.stars[i]; m.visible=!s.got; m.rotation.y+=0.045; m.position.y=-s.y+Math.sin(tick*0.07+i)*4; });
  W.cps.forEach((c,i)=>{ const on=cpIdx>=i+1; c.f.material.color.setHex(on?0xffc93c:0xe3e5f7); c.f.position.x=18+(on?Math.sin(tick*0.2)*2:0); });
  W.launchers.forEach((o,i)=>{ const l=L.launchers[i]; o.stick.rotation.z=(l.anim>0?-0.7:0.55)*(l.anim>0?1:1); o.pad.scale.y=l.anim>0?1.5:1; });
  if(W.gate) W.gate.scale.y=Math.max(0.001,1-L.gate.open);
  W.pads.forEach((d,i)=>{ const rdy=((i===0)===isHost)?me.ready:other.ready; d.scale.y=rdy?1.8:1; });
  if(W.exit){ W.exit.flag.position.x=14+Math.sin(tick*0.15)*3; W.exit.glow.material.opacity=0.45+Math.sin(tick*0.08)*0.12; }
  // clouds drift
  W.clouds.forEach(c=>{ c.position.x+=c.userData.sp; if(c.position.x>L.w+800) c.position.x=-800; if(c.userData.bob!==undefined) c.position.y+=Math.sin(tick*0.02+c.userData.bob)*0.08; });
  // sea waves
  [W.sea,W.sea2].forEach((m,li)=>{
    const pos=m.geometry.attributes.position;
    for(let i=0;i<=200;i++){ const x=pos.getX(i)+m.position.x; pos.setY(i,130+Math.sin(x*0.02+tick*0.05*(li?-1:1))*7); }
    pos.needsUpdate=true;
  });
  // characters
  if(!gameChars){
    gameChars=[makeChar(isHost?0x19c3a6:0xff8a3d,isHost?0x0e8f79:0xc75d1a,'sprout'),makeChar(isHost?0xff8a3d:0x19c3a6,isHost?0xc75d1a:0x0e8f79,'bow')];
    // host always has the sprout, guest always the bow
    gameChars.forEach(c=>{ W.scene.add(c.root); W.scene.add(c.shadow); });
  }
  if(gameChars[0].root.parent!==W.scene){ gameChars.forEach(c=>{ W.scene.add(c.root); W.scene.add(c.shadow); }); }
  poseChar(gameChars[0],me.doll,me); placeShadow(gameChars[0],me,me.doll);
  gameChars[1].root.visible=other.seen; gameChars[1].shadow.visible=other.seen;
  if(other.seen){ poseChar(gameChars[1],other.doll,other); placeShadow(gameChars[1],other,other.doll); }
  // particles
  syncFx(W);
}
let fxMeshes=[], fxScene=null;
function syncFx(W){
  if(fxScene!==W.scene){ fxMeshes=[]; fxScene=W.scene; }
  while(fxMeshes.length<fx.length){ const m=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({color:0xffffff})); W.scene.add(m); fxMeshes.push(m); }
  fxMeshes.forEach((m,i)=>{ const p=fx[i]; if(!p){ m.visible=false; return; } m.visible=true; m.position.set(p.x,-p.y,40); const s=(p.s||5)*Math.min(1,p.life/20); m.scale.set(s,s,s); m.rotation.z+=0.2; m.material.color.setHex(p.c); });
}

/* ============================================================
   LOBBY 3D SCENE (two idiots goofing around while you set up a room)
   ============================================================ */
function buildLobby(){
  const sc=new THREE.Scene(), W={follow:[],clouds:[]};
  sc.fog=new THREE.Fog(0xdff4ff,1600,5200);
  sc.add(new THREE.HemisphereLight(0xffffff,0xc8d0ff,0.85));
  const dl=new THREE.DirectionalLight(0xffffff,0.55); dl.position.set(-200,500,600); sc.add(dl);
  addSky(sc,W,'#6fcbff','#fff0c8');
  addHills(sc,1200,{hills:[0xbfe9b0,0xa3dd96,0x88d082]});
  for(let i=0;i<8;i++){ const h=hash(i*77+3); makeCloud(sc,W,-900+h%1800,120+(h%260),-300-(h%600),0.9+(h%5)/5,0.12+(h%4)/40); }
  makeBalloon(sc,W,-420,260,-420);
  // floating island
  const isl=new THREE.Group();
  addCyl(isl,300,200,150,0xe8b47c,0,-75,0,4,36);
  addCyl(isl,306,300,22,0x6fd35f,0,-8,0,0,36);
  sc.add(isl);
  const tree=makeProp('meadow',0); tree.position.set(-220,0,-60); tree.scale.set(1.4,1.4,1.4); sc.add(tree);
  const bush=makeProp('meadow',1); bush.position.set(250,0,-50); bush.scale.set(1.3,1.3,1.3); sc.add(bush);
  const house=makeProp('meadow',2); house.position.set(150,0,-120); house.scale.set(1.2,1.2,1.2); sc.add(house);
  const A=makeChar(0x19c3a6,0x0e8f79,'sprout'), B=makeChar(0xff8a3d,0xc75d1a,'bow');
  [A,B].forEach(c=>{ sc.add(c.root); sc.add(c.shadow); });
  const boxA={x:-140,y:-PH,vx:0,vy:0,onGround:true,face:1,dead:false}, boxB={x:60,y:-PH,vx:0,vy:0,onGround:true,face:-1,dead:false};
  const dA=newDoll(), dB=newDoll();
  return {scene:sc,W,A,B,boxA,boxB,dA,dB,t:0};
}
const LSOL=[{x:-3000,y:0,w:6000,h:300}];
function lobbyScript(lb){
  const T=lb.t%720, a=lb.boxA, b=lb.boxB;
  const ox=a.x, oy=a.y, bx=b.x;
  b.face=-1; b.onGround=true; b.y=-PH; b.x=60+Math.sin(lb.t*0.03)*4;
  let modeA='alive', modeB='alive';
  if(T<150){ a.x=-150+(T/150)*160; a.y=-PH; a.face=1; a.onGround=true; }
  else if(T<210){ const u=(T-150)/60; a.x=10+(b.x-10)*u; a.y=-PH-40*u-70*Math.sin(Math.PI*u); a.onGround=u>=0.98; a.face=1; }
  else if(T<270){ a.x=b.x+Math.sin(T*0.2)*3; a.y=-PH-40; a.onGround=true; }
  else if(T<300){ const u=T-270; a.x=b.x+u*2; a.y=-PH-40-u*11; a.onGround=false; b.face=-1; }
  else if(T<392){ const u=T-300; a.x=b.x+60+u*1.2; a.y=-PH-40-330+0.5*0.0765*u*u*(92/92)*(310/310)*1.0; a.y=-370+0.5*0.082*u*u*92/92*100*0.01*100; a.onGround=false; }
  else if(T<470){ a.y=-PH; a.onGround=true; modeA='dead'; }
  else if(T<540){ const u=(T-470)/70; a.y=-PH; a.onGround=true; a.x=b.x+130; b.x=60+u*60; b.face=1; a.face=-1; }
  else{ const u=(T-540)/180; a.x=190-u*20; b.x=120+u*10; a.y=-PH-Math.abs(Math.sin(u*Math.PI*6))*50; b.y=-PH-Math.abs(Math.sin(u*Math.PI*6+0.5))*50; a.onGround=b.onGround=false; a.face=-1; b.face=1; }
  if(T>=300 && T<392){ // parabola back down to the ground
    const u=T-300, y0=-PH-40-110, g=0.0765, vy0=-8.1; a.y=y0+vy0*u+0.5*g*10*u*u/ (1) ; if(a.y>-PH) a.y=-PH;
  }
  a.vx=a.x-ox; a.vy=a.y-oy; b.vx=b.x-bx;
  if(T===392) lb.landedDead=true;
  if(T>=392&&T<470) modeA='dead';
  return [modeA,modeB];
}
function lobbyRender(){
  if(!lobby) return;
  const lb=lobby; lb.t++;
  const [ma,mb]=lobbyScript(lb);
  const prevSOL=SOL; SOL=LSOL;
  dollStep(lb.dA,lb.boxA,ma); dollStep(lb.dB,lb.boxB,mb);
  SOL=prevSOL;
  poseChar(lb.A,lb.dA,lb.boxA); poseChar(lb.B,lb.dB,lb.boxB);
  lb.A.shadow.position.set(lb.boxA.x+13,1,0); lb.B.shadow.position.set(lb.boxB.x+13,1,0);
  lb.W.clouds.forEach(c=>{ c.position.x+=c.userData.sp; if(c.position.x>1400) c.position.x=-1400; });
  const portrait=ASPECT<0.9;
  const halfH = portrait ? Math.max(270,260/ASPECT) : 330;
  const zoom=halfH/(VH/2);
  placeCamera(Math.sin(lb.t*0.004)*25, portrait?190:80, zoom);   // cyWorld so that Y=-cy
  lb.W.follow.forEach(f=>f.fn(f.o));
}

/* ============================================================
   HUD + frame loop
   ============================================================ */
const hudCache={};
function setText(id,t){ if(hudCache[id]!==t){ hudCache[id]=t; $(id).textContent=t; } }
function setHTML(id,t){ if(hudCache[id]!==t){ hudCache[id]=t; $(id).innerHTML=t; } }
function setDisp(id,v){ if(hudCache['d'+id]!==v){ hudCache['d'+id]=v; $(id).style.display=v; } }
const vec = ()=>new THREE.Vector3();
let _v=null;
function project(x,y,z,w,h){ if(!_v) _v=vec(); _v.set(x,y,z); _v.project(camera); return [(_v.x*0.5+0.5)*w,(-_v.y*0.5+0.5)*h,_v.z]; }
function hudUpdate(){
  if(!L) return;
  const w=app.clientWidth, h=app.clientHeight;
  setText('hLevel','Level '+(lvlIdx+1)+': '+L.name);
  const got=L.stars.filter(s=>s.got).length;
  setText('hStars','★ '+got+'/'+L.stars.length);
  setText('hTime',fmt(levelTime));
  setDisp('hDeaths',levelDeaths>0?'inline-block':'none'); setText('hDeaths','✖ '+levelDeaths);
  if(bannerT>0){ bannerT--; if(bannerT===0) $('banner').classList.remove('show'); }
  // dock panel
  if(phase==='dock'){
    const hostReady=isHost?me.ready:other.ready, guestReady=isHost?other.ready:me.ready;
    const hn=isHost?'You':other.name, gn=isHost?other.name:'You';
    setHTML('dock','<b>Start gate is locked</b><span class="'+(hostReady?'ok':'no')+'">'+hn+(hostReady?' is ready ✔':' is not ready')+'</span><br><span class="'+(guestReady?'ok':'no')+'">'+gn+(guestReady?' is ready ✔':' is not ready')+'</span><br>Stand on your glowing pad and press <b style="display:inline">E</b>');
    setDisp('dock','block');
  }else setDisp('dock','none');
  if(phase==='count'){ setText('count',String(Math.ceil(countT/60))); setDisp('count','block'); } else setDisp('count','none');
  const showHint = (phase==='dock'||phase==='count'||(phase==='play'&&levelTime<900)) && L.hint;
  if(showHint){ setText('hint',L.hint); setDisp('hint','block'); } else setDisp('hint','none');
  if(phase==='done' && summary){
    setHTML('done','<h3>Level cleared!</h3><div class="st">'+'★'.repeat(summary.rating)+'☆'.repeat(3-summary.rating)+'</div>Stars '+summary.got+'/'+summary.tot+' &nbsp; Time '+fmt(summary.time)+' &nbsp; Faceplants '+summary.deaths+'<br><small>'+(lvlIdx+1>=window.LEVELS.length?'Finishing up…':'Next level starting…')+'</small>');
    setDisp('done','block');
  }else setDisp('done','none');
  // name tags
  [[0,me,me.doll,'You'],[1,other,other.doll,other.name]].forEach(([i,b,d,nm])=>{
    const el=$('tag'+i);
    if(!d.p || (i===1 && !other.seen)){ el.style.display='none'; return; }
    const s=project(d.p.H.x,-(d.p.H.y)+30,0,w,h);
    el.textContent=nm; el.style.display='block'; el.style.left=s[0]+'px'; el.style.top=s[1]+'px';
    el.classList.toggle('talk',!!b.talk);
    el.style.borderColor=(i===0?isHost:!isHost)?'#19c3a6':'#ff8a3d';
  });
  // partner off-screen arrow
  const ar=$('arrow');
  if(other.seen && other.doll.p){
    const s=project(other.x+PW/2,-(other.y+20),0,w,h);
    if(s[0]<20||s[0]>w-20||s[1]<20||s[1]>h-20){
      const ax=clamp(s[0],50,w-50), ay=clamp(s[1],70,h-80);
      ar.style.display='block'; ar.style.left=ax+'px'; ar.style.top=ay+'px';
      ar.textContent=(s[0]<20?'◀ ':'')+other.name+(s[0]>w-20?' ▶':'')+(s[1]<20?' ▲':s[1]>h-20?' ▼':'');
    }else ar.style.display='none';
  }else ar.style.display='none';
}

const app = $('app');
function isFs(){ return !!(document.fullscreenElement||document.webkitFullscreenElement); }
function fit(){
  const coarse = matchMedia('(pointer:coarse)').matches;
  const portrait = innerHeight > innerWidth;
  const inGame = phase!=='menu' && phase!=='wait';
  app.classList.toggle('rot', coarse && portrait && inGame);   // fallback: rotate the game page when the phone stays upright
  const w = app.clientWidth || innerWidth, h = app.clientHeight || innerHeight;
  ASPECT = w/h;
  if(renderer){ renderer.setSize(w,h,false); camera.aspect=ASPECT; camera.updateProjectionMatrix(); }
}
addEventListener('resize', fit);
addEventListener('orientationchange', ()=>setTimeout(fit,200));
document.addEventListener('fullscreenchange', ()=>setTimeout(fit,200));
document.addEventListener('webkitfullscreenchange', ()=>setTimeout(fit,200));
function enterFullscreen(){
  const el=document.documentElement;
  try{ if(el.requestFullscreen) el.requestFullscreen({navigationUI:'hide'}).catch(()=>{}); else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen(); }catch(e){}
}
function exitFullscreen(){ try{ if(document.exitFullscreen) document.exitFullscreen(); else if(document.webkitExitFullscreen) document.webkitExitFullscreen(); }catch(e){} }
function lockLandscape(){ try{ screen.orientation.lock('landscape').catch(()=>{}); }catch(e){} setTimeout(fit,300); }
function unlockOrientation(){ try{ screen.orientation.unlock(); }catch(e){} setTimeout(fit,300); }
$('btnFs').onclick = ()=>{ isFs()?exitFullscreen():enterFullscreen(); };
$('btnRespawn').onclick = ()=>{ if(phase==='play' && me.dead===0) die(); };
$('btnRestart').onclick = ()=>{ if(isHost && net.connected){ send({t:'lvl',i:lvlIdx}); loadLevel(lvlIdx); } };
addEventListener('contextmenu', e=>{ if(e.target.tagName!=='INPUT') e.preventDefault(); });
addEventListener('selectstart', e=>{ if(e.target.tagName!=='INPUT') e.preventDefault(); });

function render(){
  if(!renderer) return;
  const ig = phase!=='menu' && phase!=='wait';
  if(ig && world && L){
    syncWorld();
    placeCamera(cam.x,cam.y,cam.zoom);
    world.follow.forEach(f=>f.fn(f.o));
    renderer.render(world.scene,camera);
  }else if(lobby){
    lobbyRender();
    renderer.render(lobby.scene,camera);
  }
}

let lastIG=null, last=performance.now(), acc=0;
function frame(now){
  acc += Math.min(100,now-last); last=now;
  const ig = phase!=='menu' && phase!=='wait';
  if(ig!==lastIG){ lastIG=ig; app.classList.toggle('ingame',ig); fit(); if(ig) lockLandscape(); else unlockOrientation(); }
  while(acc>=1000/60){ update(); acc-=1000/60; }
  try{ render(); if(ig) hudUpdate(); }catch(e){ console.error(e); }
  requestAnimationFrame(frame);
}

/* ---------------- UI wiring + boot ---------------- */
$('btnCreate').onclick = ()=>{ enterFullscreen(); createRoom(); };
$('btnJoin').onclick = ()=>{ enterFullscreen(); joinRoom(); };
$('btnAgain').onclick = ()=>{ if(!isHost) return; send({t:'lvl',i:0}); loadLevel(0); };
$('btnLeave').onclick = ()=>{ if(net.peer) net.peer.destroy(); location.href=location.pathname; };
$('btnCopy').onclick = ()=>{
  const url = location.origin+location.pathname+'?room='+$('roomCode').textContent;
  (navigator.clipboard?navigator.clipboard.writeText(url):Promise.reject()).then(()=>{ $('btnCopy').textContent='✔ Link copied'; })
    .catch(()=>{ prompt('Copy this invite link:',url); });
};
const qRoom = new URLSearchParams(location.search).get('room');
if(qRoom) $('code').value = qRoom.toUpperCase().slice(0,5);
addEventListener('beforeunload', ()=>{ if(net.peer) net.peer.destroy(); });

function boot(){
  try{
    initThree(); fit();
    lobby = buildLobby();
  }catch(e){
    console.error(e);
    $('menuErr').textContent='3D graphics are not available on this device/browser.';
  }
  requestAnimationFrame(frame);
  loadLevelFiles().then(()=>{
    if(!window.LEVELS.length) throw new Error('No levels found');
    $('btnCreate').disabled=false; $('btnJoin').disabled=false;
    $('loadMsg').textContent=window.LEVELS.length+' levels ready';
  }).catch(err=>{
    $('loadMsg').textContent='';
    $('menuErr').textContent=String(err.message||err);
  });
}
boot();
