import * as THREE from "three";
import { games } from "./games.js";

const $ = (s) => document.querySelector(s);
const grid = $("#game-grid");
const canvas = $("#room-canvas");
const boot = $("#boot");
const toast = $("#toast");
let activeFilter = "All", query = "", selectedGame = null, renderer, scene, camera, raycaster, pointer;
let interactive = [], gameObjects = new Map(), clock, animationId, roomReady = false, skipIntro = false;
$("#year").textContent = new Date().getFullYear();
$("#game-count").textContent = String(games.length).padStart(2,"0");
$("#all-count").textContent = String(games.length).padStart(2,"0");

function showToast(message){toast.textContent=message;toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),2800)}
function safeUrl(url){try{const u=new URL(url,location.href);return ["https:","http:"].includes(u.protocol)?u.href:null}catch{return null}}
function renderGames(){
 const visible=games.filter(g=>(activeFilter==="All"||g.tags.includes(activeFilter)||g.category===activeFilter)&&(`${g.title} ${g.description} ${g.category}`.toLowerCase().includes(query.toLowerCase())));
 grid.innerHTML="";
 if(!visible.length){grid.innerHTML='<p class="empty-state">No games found. Try another search.</p>';return}
 visible.forEach((g,i)=>{
  const card=document.createElement("article");card.className="game-card";card.tabIndex=0;card.setAttribute("aria-label",`${g.title} game case. Select for details.`);
  card.innerHTML=`<div class="case-art" style="--glow:${g.glow};--case:${g.case};--accent:${g.accent}"><div class="disc-case"><div class="case-stripe"></div><div class="case-symbol">${g.symbol}</div><div class="case-title">${g.title.toUpperCase()}</div><div class="case-tag">NUTCRACKER ORIGINAL</div><div class="case-bottom">WEB PLAY EDITION</div></div></div><div class="card-meta"><span class="card-category">${g.category.toUpperCase()}</span><h3>${g.title}</h3><p>${g.description}</p><div class="card-actions"><button class="play-small" data-play="${g.id}">▶ PLAY GAME</button><span class="case-index">DISC ${String(games.indexOf(g)+1).padStart(2,"0")}</span></div></div>`;
  card.addEventListener("click",e=>{if(!e.target.closest("button"))selectGame(g)});
  card.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();selectGame(g)}});
  grid.appendChild(card);
 });
}
grid.addEventListener("click",e=>{const b=e.target.closest("[data-play]");if(b){e.stopPropagation();const g=games.find(x=>x.id===b.dataset.play);if(g)launchGame(g)}});
$("#game-search").addEventListener("input",e=>{query=e.target.value;renderGames()});
document.querySelectorAll("[data-filter]").forEach(b=>b.addEventListener("click",()=>{activeFilter=b.dataset.filter;document.querySelectorAll("[data-filter]").forEach(x=>x.classList.toggle("active",x===b));renderGames()}));
document.querySelectorAll("[data-category-link]").forEach(a=>a.addEventListener("click",()=>{activeFilter=a.dataset.categoryLink;document.querySelectorAll("[data-filter]").forEach(x=>x.classList.toggle("active",x.dataset.filter===activeFilter));renderGames()}));
renderGames();

function selectGame(game){
 selectedGame=game;
 const obj=gameObjects.get(game.id);
 if(obj&&roomReady){obj.userData.selected=true;obj.userData.launchAt=clock.getElapsedTime();showToast(`${game.title} selected — press Play in the library to launch.`)}
 $("#playing-title").textContent=game.title;
 $("#screen-game-label").textContent=`DISC SELECTED / ${game.title.toUpperCase()}`;
 $("#playback").hidden=false;
 $("#playback").scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});
}
function launchGame(game){
 const url=safeUrl(game.url);
 if(!url){showToast("This game link is not configured yet.");return}
 selectedGame=game;
 $("#playback").hidden=false;
 $("#playing-title").textContent=game.title;
 $("#screen-game-label").textContent=`NOW PLAYING / ${game.title.toUpperCase()}`;
 $("#game-loading").hidden=false;
 $("#frame-fallback").hidden=true;
 const frame=$("#game-frame");frame.classList.remove("visible");frame.src="about:blank";
 $("#playback").scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});
 // Real launch path: try the configured game URL in an iframe; the direct-open fallback is always available.
 const openDirect=$("#open-direct");openDirect.href=url;
 setTimeout(()=>{
   if(!selectedGame||selectedGame.id!==game.id)return;
   frame.src=url;
   frame.onload=()=>{if(frame.src!=="about:blank"){ $("#game-loading").hidden=true;frame.classList.add("visible"); }};
   // Cross-origin pages can refuse iframe embedding; timeout gives a direct-launch option.
   setTimeout(()=>{
    if(selectedGame&&selectedGame.id===game.id&&$("#game-loading").hidden===false){
      $("#game-loading").hidden=true;$("#frame-fallback").hidden=false;
    }
   },6500);
 },skipIntro?0:1250);
}
$("#close-game").addEventListener("click",()=>{const f=$("#game-frame");f.src="about:blank";f.classList.remove("visible");$("#playback").hidden=true;selectedGame=null;$("#room").scrollIntoView({behavior:"smooth"})});
$("#skip-animation").addEventListener("click",()=>{if(selectedGame)launchGame(selectedGame)});
$("#skip-boot").addEventListener("click",()=>{skipIntro=true;boot.classList.add("done")});
$("#scene-fallback").addEventListener("click",()=>$("#library").scrollIntoView({behavior:"smooth"}));
$("#room-toggle").addEventListener("click",()=>{if(!roomReady){showToast("Room view is still loading.");return}camera.position.x=camera.position.x===0?1.2:0;camera.lookAt(0,1.3,0)});

function mat(color,roughness=.7,metalness=.1,emissive=null){return new THREE.MeshStandardMaterial({color,roughness,metalness,emissive:emissive||0,emissiveIntensity:emissive?0.5:0})}
function box(w,h,d,material,x,y,z,parent=scene){const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh}
function cylinder(rt,rb,h,material,x,y,z,parent=scene){const mesh=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,32),material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh}
function glowBar(x,y,z,w,h,d,color){const m=new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:2.2,roughness:.3});return box(w,h,d,m,x,y,z)}
function makeDiscCase(g,index){
 const group=new THREE.Group();group.userData={game:g,baseY:1.65,phase:index*.8,selected:false,launchAt:null};
 const body=box(.66,.92,.11,mat(g.case,.28,.3),0,0,0,group);
 const stripe=box(.61,.045,.012,new THREE.MeshStandardMaterial({color:g.accent,emissive:g.accent,emissiveIntensity:.7}),0,.36,.063,group);
 const label=box(.54,.32,.013,mat("#171827",.4,.2),0,.06,.066,group);
 const emblem=cylinder(.105,.105,.016,new THREE.MeshStandardMaterial({color:g.accent,metalness:.35,roughness:.25,emissive:g.accent,emissiveIntensity:.5}),0,.07,.082,group);emblem.rotation.x=Math.PI/2;
 // Fine spine strip gives the cases a physical, boxed silhouette.
 box(.035,.88,.015,mat("#b5b7ca",.35,.25),-.29,0,.066,group);
 group.position.set(-2.25+index*.9,1.65,-1.8);
 group.rotation.y=-.12;
 group.userData.parts=[body,stripe,label,emblem];
 interactive.push({mesh:body,game:g,group});
 gameObjects.set(g.id,group);scene.add(group);return group;
}
function buildRoom(){
 scene=new THREE.Scene();scene.background=new THREE.Color("#080910");scene.fog=new THREE.Fog("#080910",8,22);
 camera=new THREE.PerspectiveCamera(43,1,.1,100);camera.position.set(0,3.1,9.7);camera.lookAt(0,1.3,0);
 renderer=new THREE.WebGLRenderer({canvas,antialias:!matchMedia("(max-width: 700px)").matches,alpha:false,powerPreference:"low-power"});
 renderer.setPixelRatio(Math.min(devicePixelRatio,matchMedia("(max-width: 700px)").matches?1.35:1.8));renderer.shadowMap.enabled=!matchMedia("(max-width: 700px)").matches;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
 scene.add(new THREE.HemisphereLight("#9aa9ff","#1b142a",2.1));
 const key=new THREE.DirectionalLight("#c4c7ff",3);key.position.set(-3,7,5);key.castShadow=true;key.shadow.mapSize.set(512,512);scene.add(key);
 const purple=new THREE.PointLight("#8e55ff",22,12);purple.position.set(3,3,-2);scene.add(purple);
 const blue=new THREE.PointLight("#2e9eff",12,10);blue.position.set(-4,2,1);scene.add(blue);
 const wall=mat("#171824",.92),floor=mat("#10111a",.82),trim=mat("#38374e",.5,.35),black=mat("#08090e",.3,.55),screenMat=new THREE.MeshStandardMaterial({color:"#090b19",emissive:"#31276a",emissiveIntensity:.7,metalness:.2,roughness:.25});
 box(12,6,.3,wall,0,3,-3.5);box(12,.25,10,floor,0,-.15,0);box(.16,6,7,wall,-6,3,0);box(.16,6,7,wall,6,3,0);
 // wall panels and ceiling slats
 for(let i=0;i<8;i++){box(.035,4.8,.025,trim,-5.1+i*1.45,3,-3.31);if(i%2===0)glowBar(-5+i*1.45,5.3,-3.29,.45,.025,.025,"#624b9c")}
 glowBar(-4.7,2.5,-3.29,1.2,.025,.025,"#4b7fbe");glowBar(4.6,2.5,-3.29,1.3,.025,.025,"#8151cb");
 // TV wall mount + screen
 box(3.75,2.25,.16,black,0,2.65,-3.02);box(3.56,2.05,.035,screenMat,0,2.67,-2.91);
 glowBar(0,1.51,-2.87,2.2,.018,.02,"#8060ff");
 // animated screen accent lines
 for(let i=0;i<5;i++)box(1.1-i*.12,.012,.012,new THREE.MeshStandardMaterial({color:"#8e78ff",emissive:"#8e78ff",emissiveIntensity:.8}),-.9+i*.08,2.4+i*.09,-2.87);
 // console and cabinet
 box(2.4,.65,.8,mat("#20212d",.4,.4),0,.42,-2.15);box(1.15,.16,.5,black,0,.82,-2.15);
 box(1.1,.06,.42,mat("#303342",.3,.6),0,.93,-2.15);glowBar(.72,.95,-2.1,.08,.03,.03,"#8d76ff");
 cylinder(.09,.09,.04,mat("#9e8dff",.2,.5,"#8c69ff"),.45,.96,-2.05);
 // couch / gamer silhouette: upholstered chair, back, head, hoodie torso, arms
 const chair=mat("#171a28",.75,.15),hoodie=mat("#242638",.8,.05),skin=mat("#9b8b9e",.85),headmat=mat("#2b2b3c",.75);
 cylinder(.7,.8,.25,chair,0,.5,1.25);box(1.4,1.5,.3,chair,0,1.3,1.65);box(.55,.75,.45,hoodie,0,2.05,1.25);
 const head=new THREE.Mesh(new THREE.SphereGeometry(.36,24,20),headmat);head.position.set(0,2.75,1.08);head.castShadow=true;scene.add(head);
 const hair=new THREE.Mesh(new THREE.SphereGeometry(.37,24,12,0,Math.PI*2,0,Math.PI*.6),mat("#101118",.9));hair.position.copy(head.position);hair.position.y+=.08;scene.add(hair);
 // headphones
 const headphone=new THREE.Mesh(new THREE.TorusGeometry(.39,.055,8,32,Math.PI),mat("#9b7cff",.35,.4,"#7654ff"));headphone.position.set(0,2.8,1.08);headphone.rotation.z=Math.PI;scene.add(headphone);
 cylinder(.09,.09,.14,mat("#7c65ca",.4,.4),-.36,2.72,1.08);cylinder(.09,.09,.14,mat("#7c65ca",.4,.4),.36,2.72,1.08);
 // arms reach toward a controller
 const armMat=mat("#202234",.7,.1);const arm1=box(.72,.17,.2,armMat,-.54,1.85,.48);arm1.rotation.z=-.32;const arm2=box(.72,.17,.2,armMat,.54,1.85,.48);arm2.rotation.z=.32;
 const controller=box(.46,.13,.24,mat("#08090f",.35,.5),0,1.62,.1);glowBar(-.12,1.69,.08,.06,.015,.015,"#8d72ff");glowBar(.12,1.69,.08,.06,.015,.015,"#4ba7ff");
 // shelf with cases
 box(5.3,.12,.52,mat("#282a38",.45,.3),0,1.05,-1.75);box(5.3,.08,.52,mat("#282a38",.45,.3),0,2.2,-1.75);
 for(let i=0;i<games.length;i++)makeDiscCase(games[i],i);
 // table legs and floor light bars
 box(3.3,.12,1.3,mat("#1b1d29",.45,.4),0,.85,.15);
 for(let x of [-1.45,1.45])box(.08,.85,.08,trim,x,.38,.6);
 glowBar(-4.4,.02,1.8,1.3,.015,.04,"#3b7eae");glowBar(4.4,.02,1.8,1.3,.015,.04,"#6f48bd");
 // logo plaque
 box(1.7,.48,.09,mat("#0d0e17",.3,.4),0,4.55,-3.28);glowBar(0,4.79,-3.22,1.2,.018,.018,"#8f73ff");
 raycaster=new THREE.Raycaster();pointer=new THREE.Vector2();clock=new THREE.Clock();roomReady=true;
 resize();window.addEventListener("resize",resize);
 canvas.addEventListener("pointermove",onPointerMove);canvas.addEventListener("pointerdown",onPointerDown);
 animate();
 $("#boot-status").textContent="Room systems online.";
 setTimeout(()=>boot.classList.add("done"),skipIntro?0:900);
}
function resize(){if(!renderer||!camera)return;const r=canvas.getBoundingClientRect();camera.aspect=Math.max(.1,r.width/r.height);camera.updateProjectionMatrix();renderer.setSize(r.width,r.height,false)}
function getHit(e){const r=canvas.getBoundingClientRect();pointer.x=((e.clientX-r.left)/r.width)*2-1;pointer.y=-((e.clientY-r.top)/r.height)*2+1;raycaster.setFromCamera(pointer,camera);return raycaster.intersectObjects(interactive.map(o=>o.mesh),false)[0]}
function onPointerMove(e){if(e.pointerType==="touch")return;const hit=getHit(e);canvas.style.cursor=hit?"pointer":"grab";if(hit){const label=$("#hotspot-label");label.style.display="block";label.style.left=`${Math.min(e.clientX-canvas.getBoundingClientRect().left+12,canvas.clientWidth-180)}px`;label.style.top=`${Math.max(35,e.clientY-canvas.getBoundingClientRect().top-22)}px`;label.textContent=`SELECT DISC / ${hit.object.parent.userData.game.title.toUpperCase()}`}else $("#hotspot-label").style.display="none"}
function onPointerDown(e){const hit=getHit(e);if(hit){const g=hit.object.parent.userData.game;selectGame(g);launchGame(g)}}
function animate(){animationId=requestAnimationFrame(animate);const t=clock.getElapsedTime();for(const [id,obj] of gameObjects){obj.position.y=obj.userData.baseY+Math.sin(t*1.3+obj.userData.phase)*.025;if(obj.userData.selected)obj.rotation.y=Math.sin(t*2)*.08;else obj.rotation.y=-.12+Math.sin(t*.5+obj.userData.phase)*.025;}renderer.render(scene,camera)}
try{buildRoom()}catch(err){console.error("3D room failed:",err);$("#scene-fallback").style.display="block";$("#boot-status").textContent="Opening the game library…";setTimeout(()=>boot.classList.add("done"),500)}
// Keep a fully functional library even if the CDN/WebGL cannot initialize.
