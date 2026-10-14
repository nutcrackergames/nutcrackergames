const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const RAPIER = require('@dimforge/rapier3d-compat');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static('public'));
const rooms = new Map();
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function makeRoom(code){return {code,players:new Map(),started:false,finished:false,startAt:0,finishAt:0,falls:0,world:null,body:null,collider:null,x:0,y:2,z:0,vx:0,vy:0,vz:0,angle:0,left:0,right:0,checkpoint:0, lastFall:0};}
function send(ws,obj){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}
function broadcast(room,obj){for(const p of room.players.values())send(p.ws,obj);}
async function initPhysics(){await RAPIER.init();}
function resetRoom(room){room.x=0;room.y=2;room.z=0;room.vx=0;room.vy=0;room.vz=0;room.angle=0;room.left=0;room.right=0;room.checkpoint=0;room.falls=0;room.started=false;room.finished=false;room.startAt=0;room.finishAt=0;room.lastFall=0;}
function state(room){return {type:'state',players:[...room.players.values()].map(p=>({id:p.id,leg:p.leg,ready:p.ready})),x:room.x,y:room.y,z:room.z,vx:room.vx,vy:room.vy,vz:room.vz,angle:room.angle,left:room.left,right:room.right,started:room.started,finished:room.finished,time:room.finished?(room.finishAt-room.startAt)/1000:room.started?(Date.now()-room.startAt)/1000:0,falls:room.falls,checkpoint:room.checkpoint};}
wss.on('connection',ws=>{
 let player=null,room=null;
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}
  if(m.type==='create'||m.type==='join'){
   let code=(m.code||Math.random().toString(36).slice(2,6)).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
   if(m.type==='join'&&!rooms.has(code)){send(ws,{type:'error',message:'Room not found. Ask your friend to create a room first.'});return;}
   room=rooms.get(code)||makeRoom(code);rooms.set(code,room);
   if(room.players.size>=2){send(ws,{type:'error',message:'This room already has two players.'});return;}
   const leg=room.players.size===0?'left':'right';player={id:Math.random().toString(36).slice(2,9),leg,ws,ready:true};room.players.set(player.id,player);ws.room=room;ws.player=player;
   send(ws,{type:'joined',code,leg,playerId:player.id});broadcast(room,{type:'notice',message:`Player joined the ${leg} leg!`});broadcast(room,state(room));return;
  }
  if(!room||!player)return;
  if(m.type==='input'){
   const v=clamp(Number(m.value)||0,-1,1);if(player.leg==='left')room.left=v;else room.right=v;
   if(m.action==='jump'&&room.started&&!room.finished&&room.y<2.2){room.vy=7.3;}
   if(m.action==='start'&&room.players.size===2&&!room.started&&!room.finished){room.started=true;room.startAt=Date.now();broadcast(room,{type:'notice',message:'GO GO GO! Try not to embarrass yourselves.'});}
   if(m.action==='reset'){resetRoom(room);broadcast(room,{type:'notice',message:'Back to the start. Coordination not included.'});}
  }
  if(m.type==='leave'){room.players.delete(player.id);broadcast(room,{type:'notice',message:'Your teammate disconnected.'});room=null;player=null;}
 });
 ws.on('close',()=>{if(room&&player){room.players.delete(player.id);broadcast(room,{type:'notice',message:'Your teammate disconnected.'});if(room.players.size===0)rooms.delete(room.code);}});
});
// Server-authoritative arcade physics. Collision course is generated deterministically in the client.
setInterval(()=>{for(const room of rooms.values()){
 if(!room.started||room.finished||room.players.size===0)continue;
 const t=Date.now();
 // The legs must agree: mismatch produces wobble; matching input advances along the course.
 const coordination=1-Math.min(1,Math.abs(room.left-room.right)*0.75);
 const drive=(room.left+room.right)/2;
 room.vz=clamp(room.vz + drive*0.10*coordination,-0.2,0.34);
 room.vz*=0.985; room.z+=room.vz;
 room.angle=clamp(room.angle+(room.right-room.left)*0.045,-0.95,0.95)*0.985;
 room.vx=clamp(room.vx+(room.right-room.left)*0.018,-0.13,0.13);room.x+=room.vx;room.vx*=0.96;
 room.vy-=0.018;room.y+=room.vy;
 // Basic platforms / gaps; fall sends the team to last checkpoint.
 const gap = (room.z>13&&room.z<16)||(room.z>31&&room.z<34)||(room.z>50&&room.z<53);
 const overEdge=Math.abs(room.x)>3.1;
 if(room.y<0.65&&!gap){room.y=0.65;room.vy=0;}
 if((room.y< -4 || overEdge || (gap&&room.y<1.2))&&t-room.lastFall>1200){room.lastFall=t;room.falls++;room.z=room.checkpoint;room.x=0;room.y=2.5;room.vx=0;room.vy=0;room.vz=0;room.left=0;room.right=0;broadcast(room,{type:'notice',message:'BONK! Team fall — checkpoint respawn!'});}
 if(room.z>12)room.checkpoint=10;if(room.z>30)room.checkpoint=27;if(room.z>49)room.checkpoint=46;
 if(room.z>=65){room.finished=true;room.finishAt=Date.now();broadcast(room,{type:'result',time:(room.finishAt-room.startAt)/1000,falls:room.falls});}
 broadcast(room,state(room));
}},33);
const PORT=process.env.PORT||3000;
initPhysics().then(()=>server.listen(PORT,()=>console.log(`Two Idiots, One Body listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
