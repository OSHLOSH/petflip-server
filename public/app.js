/* ══════════════════════════════════════════════════════════════
   CONFIG
   ══════════════════════════════════════════════════════════════ */

// Your trade bots. joinUrl = Roblox private server / profile link (optional)
const BOTS = [
  { name: 'petflip_grass', online: true, joinUrl: '' },
];

// Server URL. Leave '' when server.js serves this page. Test mode turns on automatically if no server answers.
const API_BASE = '';

// Demo pets — ONLY used in test mode (no server). Real pets are added from the Admin page.
const DEMO_PETS = [
  { id:'demo_garg',  name:'Demo Gargantuan', tier:'garg',  value:40e12,  img:'', em:'🎃' },
  { id:'demo_titan', name:'Demo Titanic',    tier:'titan', value:1.2e12, img:'', em:'🌈' },
  { id:'demo_titan2',name:'Demo Titanic II', tier:'titan', value:500e9,  img:'', em:'⭐' },
  { id:'demo_huge',  name:'Demo Huge',       tier:'huge',  value:250e9,  img:'', em:'🐉' },
  { id:'demo_huge2', name:'Demo Huge II',    tier:'huge',  value:85e9,   img:'', em:'🦄' },
  { id:'demo_huge3', name:'Demo Huge III',   tier:'huge',  value:42e9,   img:'', em:'🐺' },
  { id:'demo_huge4', name:'Demo Huge IV',    tier:'huge',  value:18e9,   img:'', em:'🦁' },
];

const UPGRADE_EDGE = 0.05, UPGRADE_MAX = 0.80, MATCH_RANGE = 0.10;

/* ══════════════════════════════════════════════════════════════ */

const RARITY = { garg:{label:'Gargantuan',c:'var(--r-garg)'}, titan:{label:'Titanic',c:'var(--r-titan)'}, huge:{label:'Huge',c:'var(--r-huge)'} };
const PCOL = ['#7c5cff','#ffc83d','#2ee59d','#ff4d6d','#3d8bff','#ff4fd8'];
const GEM = '<svg class="gem" viewBox="0 0 24 24"><path fill="#5fd4ff" d="M6 3h12l4 6-10 12L2 9z"/><path fill="#b5ecff" d="M6 3l3 6h6l3-6z" opacity=".7"/></svg>';
const $ = id => document.getElementById(id);
let API_ON = false;
let PETS = DEMO_PETS.slice();
let PET = {};
function setPets(list){ PETS = list; PET = Object.fromEntries(PETS.map(p=>[p.id,p])); }
setPets(PETS);

/* ── STATE ── */
const KEY = 'petflip_v3';
function fresh(){ return {user:null, session:'', inv:[], flips:[], pending:[], hist:[], clientSeed:randHex(8), nonce:0, uid:1, escrow:[]}; }
let S = load();
function load(){ try{ const s=JSON.parse(localStorage.getItem(KEY)); if(s&&s.inv) return s; }catch(e){} return fresh(); }
function save(){ try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} }
if(S.escrow && S.escrow.length){ S.inv.push(...S.escrow); S.escrow=[]; save(); }
const SV = () => API_ON && !!S.session;      // server mode

/* ── UTIL ── */
function randHex(n){ const a=new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function sha256(s){ const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function newRound(){ const server=randHex(32); return {server, hash:await sha256(server)}; }
async function rollFrom(server,client,nonce){ const h=await sha256(server+':'+client+':'+nonce); return parseInt(h.slice(0,13),16)/2**52; }
async function roll(round){ const nonce=S.nonce++; const r=await rollFrom(round.server,S.clientSeed,nonce); save(); return {...round, client:S.clientSeed, nonce, r}; }
function fmt(v){ for(const [d,s] of [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']]) if(v>=d){ const n=v/d; return parseFloat(n.toFixed(n>=100?0:n>=10?1:2))+s; } return String(Math.round(v||0)); }
const gv = v => GEM + fmt(v);
const sumv = items => items.reduce((s,i)=>s+(i.value||0),0);
function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// normalise any item (local or from server) to {uid,pid,name,img,em,value,r}
function nItem(i){ const p=PET[i.pid]||{}; return {uid:i.uid, pid:i.pid, name:i.name||p.name||'Pet', img:i.img??p.img??'', em:i.em||p.em||'', value:i.value??p.value??0, r:i.r||i.tier||p.tier||'huge'}; }
function mkItem(pid){ const p=PET[pid]; return nItem({uid:S.uid++, pid, name:p.name, img:p.img, em:p.em, value:p.value, tier:p.tier}); }
const PH = '<div class="ph">?</div>';
function icon(i, big=true){
  if(i.img) return `<img src="${esc(i.img)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='${PH.replace(/"/g,'&quot;')}'">`;
  return i.em ? i.em : PH;
}
function userName(){ return S.user ? (S.user.displayName||S.user.name) : 'Guest'; }
function initial(n){ return (n||'?').trim().charAt(0).toUpperCase(); }
function avaFor(u){ if(!u) return '?'; if(u.bot) return '🤖'; return u.avatar?`<img src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:esc(initial(u.displayName||u.name)); }
function avaInner(){ return S.user ? avaFor(S.user) : esc(initial(userName())); }
function requireLink(){ if(S.user) return true; toast('Link your Roblox account first'); openLink(); return false; }
function ago(t){ const s=(Date.now()-t)/1000; if(s<60) return 'just now'; if(s<3600) return Math.floor(s/60)+'m ago'; if(s<86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function toast(msg,kind=''){ const t=document.createElement('div'); t.className='toast '+kind; t.textContent=msg; $('toasts').appendChild(t); setTimeout(()=>t.remove(),3800); }
function openOv(id){ $(id).classList.add('on'); }
function closeOv(id){ $(id).classList.remove('on'); }
document.querySelectorAll('.ov').forEach(o=>o.addEventListener('mousedown',e=>{ if(e.target===o && !o.dataset.lock) o.classList.remove('on'); }));
function filt(items,q){ q=(q||'').toLowerCase(); return items.filter(i=>!q||i.name.toLowerCase().includes(q)); }
function emptyHTML(ic,h,p,btn){ return `<div class="empty"><div class="ic">${ic}</div><h3>${h}</h3><p>${p}</p>${btn||''}</div>`; }

function tileHTML(i,o={}){
  const st = o.stock!=null ? `<span class="stock${o.stock?'':' out'}">${o.stock?o.stock+' left':'Out'}</span>` : '<div class="chk">✓</div>';
  return `<div class="tile r-${i.r||i.tier}${o.sel?' sel':''}${o.dis?' dis':''}"${o.click?` onclick="${o.click}"`:''}>
    <span class="rar">${RARITY[i.r||i.tier]?.label||''}</span>${st}
    <div class="em">${icon(i)}</div><div class="nm" title="${esc(i.name)}">${esc(i.name)}</div><div class="vl">${gv(i.value)}</div></div>`;
}
function chipsHTML(items,max=6){
  const s=[...items].map(nItem).sort((a,b)=>b.value-a.value);
  const out=s.slice(0,max).map(i=>`<div class="chip r-${i.r}" title="${esc(i.name)} · ${fmt(i.value)}">${icon(i,false)}</div>`);
  if(s.length>max) out.push(`<div class="chip more">+${s.length-max}</div>`);
  return out.join('');
}

/* ── API ── */
async function api(path, opts={}){
  const r = await fetch(API_BASE.replace(/\/$/,'')+path, {
    method: opts.body?'POST':(opts.method||'GET'),
    headers: {'content-type':'application/json', ...(S.session?{authorization:'Bearer '+S.session}:{}), ...(opts.headers||{})},
    body: opts.body?JSON.stringify(opts.body):undefined
  });
  let j={}; try{ j=await r.json(); }catch(e){}
  if(!r.ok || j.ok===false){ const e=new Error(j.error||('Request failed ('+r.status+')')); e.status=r.status; throw e; }
  return j;
}
function syncMe(j){
  if(!j || !j.inv) return;
  S.user = j.user || S.user; S.role = j.role || null;
  S.inv = j.inv.map(nItem);
  S.hist = j.hist || [];
  S.pending = (j.withdraws||[]).map(w=>({id:w.id, items:w.items.map(nItem), t:w.t}));
  S.clientSeed = j.clientSeed || S.clientSeed; S.nonce = j.nonce ?? S.nonce;
  save();
}
async function refreshCatalog(){ if(!API_ON) return; try{ const j=await api('/api/catalog'); setPets(j.pets); }catch(e){} }
async function refreshMe(){
  if(!SV()) return;
  try{ syncMe(await api('/api/me')); }
  catch(e){ if(e.status===401){ S.user=null; S.session=''; S.role=null; S.inv=[]; save(); toast('Session expired — link your account again'); } }
}

/* ── ROUTER ── */
const PAGES = {
  coinflip:['Coinflip','Double your pets, 50/50'], jackpot:['Jackpot','Biggest pot wins it all'],
  upgrader:['Upgrader','Turn small pets into big ones'], history:['History','Your games & verification'],
  fair:['Provably Fair','Verify every result'], faq:['FAQ','Deposits, withdrawals & more'], admin:['Admin','Catalogue, stock & withdrawals']
};
function go(p){
  if(!PAGES[p]) p='coinflip';
  document.querySelectorAll('.page').forEach(e=>e.classList.toggle('on',e.id==='p-'+p));
  document.querySelectorAll('.nav').forEach(e=>e.classList.toggle('on',e.dataset.p===p));
  $('pg-title').textContent=PAGES[p][0]; $('pg-sub').textContent=PAGES[p][1];
  if(location.hash!=='#'+p) history.replaceState(null,'','#'+p);
  if(p==='admin') admInit();
  render();
}

/* ── RENDER ── */
function render(){
  $('top-bal').innerHTML = gv(sumv(S.inv));
  $('nav-admin').style.display = S.role ? '' : 'none';
  $('top-ava').innerHTML=avaInner(); $('top-ava').style.display=S.user?'':'none'; $('top-link').style.display=S.user?'none':'';
  renderKpis(); renderFlips(); renderJp(); renderUpInv(); renderUpTargets(); updUp(); renderHist();
}
function stats(){ const w=S.hist.reduce((s,h)=>s+h.wager,0), p=S.hist.reduce((s,h)=>s+(h.payout-h.wager),0); return {w,p,games:S.hist.length,wins:S.hist.filter(h=>h.win).length}; }
function renderKpis(){
  const st=stats();
  const html=`<div class="kpi" style="--c:var(--gold-g)"><small>Inventory Value</small><b style="color:var(--gold)">${gv(sumv(S.inv))}</b></div>
    <div class="kpi"><small>Total Wagered</small><b>${gv(st.w)}</b></div>
    <div class="kpi" style="--c:${st.p>=0?'var(--win-g)':'var(--lose-g)'}"><small>Profit</small><b class="${st.p>=0?'up':'dn'}">${st.p>=0?'+':'−'}${fmt(Math.abs(st.p))}</b></div>
    <div class="kpi" style="--c:rgba(61,139,255,.3)"><small>Games / Wins</small><b>${st.games} <span style="color:var(--mute);font-size:15px">/ ${st.wins}</span></b></div>`;
  $('kpis').innerHTML=html; $('kpis2').innerHTML=html;
}

/* ══════════════ COINFLIP ══════════════ */
let crSide='h', crSel=new Set(), crJoin=null;      // crJoin = flip being joined (PvP)
let FL = {open:[], recent:[]};
function myFlips(){ return SV() ? FL.open : S.flips.map(f=>({...f, creator:S.user||{name:'Guest'}, mine:true})); }
function openCreate(){
  if(!requireLink()) return;
  if(!S.inv.length){ toast('Your inventory is empty — deposit first','bad'); openDep(); return; }
  crJoin=null; crSel.clear(); $('cr-title').textContent='Create Coinflip'; $('cr-sub').textContent='Pick a side and choose pets from your inventory';
  $('cr-sides').style.pointerEvents=''; $('cr-go').textContent='Create Flip';
  pickSide('h'); $('cr-q').value=''; renderCreatePicker(); openOv('ov-create');
}
function openJoin(id){
  if(!requireLink()) return;
  const f=FL.open.find(x=>x.id===id); if(!f) return;
  if(!S.inv.length){ toast('Your inventory is empty — deposit first','bad'); openDep(); return; }
  crJoin=f; crSel.clear();
  $('cr-title').textContent='Join '+(f.creator.displayName||f.creator.name)+"'s flip";
  $('cr-sub').textContent=`Match ${fmt(f.value*(1-MATCH_RANGE))} – ${fmt(f.value*(1+MATCH_RANGE))} in value`;
  pickSide(f.side==='h'?'t':'h'); $('cr-sides').style.pointerEvents='none'; $('cr-go').textContent='Join Flip';
  $('cr-q').value=''; renderCreatePicker(); openOv('ov-create');
}
function pickSide(s){ crSide=s; $('so-h').classList.toggle('on',s==='h'); $('so-t').classList.toggle('on',s==='t'); }
function renderCreatePicker(){
  const items=filt(S.inv,$('cr-q').value).sort((a,b)=>b.value-a.value);
  $('cr-picker').innerHTML = items.length?`<div class="tiles">${items.map(i=>tileHTML(i,{sel:crSel.has(i.uid),click:`crTog(${i.uid})`})).join('')}</div>`:emptyHTML('🔍','No items','Nothing matches your search.');
  const sel=S.inv.filter(i=>crSel.has(i.uid)), v=sumv(sel);
  $('cr-sum').innerHTML=gv(v); $('cr-n').textContent=sel.length;
  let ok=sel.length>0;
  if(crJoin) ok = ok && v>=crJoin.value*(1-MATCH_RANGE) && v<=crJoin.value*(1+MATCH_RANGE);
  $('cr-go').disabled=!ok;
}
function crTog(uid){ crSel.has(uid)?crSel.delete(uid):crSel.add(uid); renderCreatePicker(); }
function crSelAll(){ filt(S.inv,$('cr-q').value).forEach(i=>crSel.add(i.uid)); renderCreatePicker(); }
function crClear(){ crSel.clear(); renderCreatePicker(); }
async function createFlip(){
  const uids=[...crSel]; if(!uids.length) return;
  $('cr-go').disabled=true;
  try{
    if(crJoin){
      const j=await api('/api/coinflip/join',{body:{id:crJoin.id, uids}});
      syncMe(j); closeOv('ov-create'); await playFlip(j.flip, false); loadFlips(); return;
    }
    if(SV()){ const j=await api('/api/coinflip/create',{body:{side:crSide, uids}}); syncMe(j); await loadFlips(); }
    else {
      const items=S.inv.filter(i=>crSel.has(i.uid)); S.inv=S.inv.filter(i=>!crSel.has(i.uid));
      S.flips.unshift({id:Date.now(), side:crSide, items, value:sumv(items), t:Date.now(), round:await newRound()}); save();
    }
    closeOv('ov-create'); render(); toast('Flip created — waiting for an opponent','ok');
  }catch(e){ toast(e.message,'bad'); $('cr-go').disabled=false; }
}
async function cancelFlip(id){
  try{
    if(SV()){ syncMe(await api('/api/coinflip/cancel',{body:{id}})); await loadFlips(); }
    else { const f=S.flips.find(x=>x.id===id); if(!f) return; S.inv.push(...f.items); S.flips=S.flips.filter(x=>x.id!==id); save(); }
    render(); toast('Flip cancelled — items returned');
  }catch(e){ toast(e.message,'bad'); }
}
async function loadFlips(){ if(!API_ON) return; try{ const j=await api('/api/coinflip'); FL={open:j.open, recent:j.recent}; renderFlips(); }catch(e){} }
function sideDot(side){ return `<span class="side-dot" style="background:var(--${side==='h'?'heads':'tails'});color:${side==='h'?'#5a3d00':'#fff'}">${side.toUpperCase()}</span>`; }
function renderFlips(){
  const list = SV()||API_ON ? FL.open : myFlips();
  $('cf-count').textContent=list.length;
  $('pill-cf').textContent=list.length;
  if(!list.length){
    $('flips').innerHTML=emptyHTML('🪙','No open flips','Create a flip with your pets. Another player can join — or call the bot to play instantly.',`<button class="btn btn-y" onclick="openCreate()">Create Flip</button>`);
  } else $('flips').innerHTML=list.map(f=>{
    const c=f.creator||S.user||{name:'Guest'}; const mine = f.mine || (S.user && c.id===S.user.id);
    const lo=f.value*(1-MATCH_RANGE), hi=f.value*(1+MATCH_RANGE);
    const acts = mine ? `<button class="btn btn-r btn-sm" onclick="cancelFlip(${f.id})">Cancel</button><button class="btn btn-p btn-sm" onclick="callBotFlip(${f.id})">🤖 Call Bot</button>`
                      : `<button class="btn btn-y btn-sm" onclick="openJoin(${f.id})">Join</button>`;
    return `<div class="flip">
      <div class="who"><div class="ava you">${avaFor(c)}${sideDot(f.side)}</div><div style="min-width:0"><div class="n">${esc(c.displayName||c.name)}</div><div class="s">${ago(f.t)}</div></div></div>
      <div class="chips">${chipsHTML(f.items)}</div>
      <div class="mid"><div class="v">${gv(f.value)}</div><div class="vs">VS</div><div class="range">${fmt(lo)} – ${fmt(hi)}</div></div>
      <div class="chips r"><span style="font-size:12px;color:var(--mute)">${mine?'Waiting for opponent…':'Open — join with matching pets'}</span></div>
      <div class="acts">${acts}</div></div>`;
  }).join('');
  const rec = FL.recent||[];
  $('recent-h').style.display = rec.length?'':'none';
  $('recent').innerHTML = rec.map(f=>{ const w=f.winner==='creator'?f.creator:f.opponent; return `<div class="rc"><div class="ava you">${avaFor(w)}</div><span>${esc((w&&(w.displayName||w.name))||'')}</span> won <b>${fmt(f.value+sumv(f.oppItems))}</b><div class="mini-res mc-${f.result}">${(f.result||'').toUpperCase()}</div></div>`; }).join('');
}

// local bot stake (test mode only)
function botStake(target){ const out=[]; let rem=target; for(const p of [...PETS].sort((a,b)=>b.value-a.value)){ while(p.value<=rem*1.0001 && out.length<8){ out.push(mkItem(p.id)); rem-=p.value; } } return out; }

let busy=false;
async function callBotFlip(id){
  if(busy) return; busy=true;
  try{
    if(SV()){
      const j=await api('/api/coinflip/callbot',{body:{id}}); syncMe(j); await playFlip(j.flip, true); loadFlips();
    } else {
      const f=S.flips.find(x=>x.id===id); if(!f) return;
      const botItems=botStake(f.value); S.flips=S.flips.filter(x=>x.id!==id);
      const fair=await roll(f.round); const landed=fair.r<0.5?'h':'t'; const won=landed===f.side; const pot=[...f.items,...botItems];
      if(won) S.inv.push(...pot);
      addHistLocal('Coinflip', f.value, won?sumv(pot):0, won, (f.side==='h'?'Heads':'Tails')+' vs bot', fair); save();
      await playFlip({creator:S.user||{name:'Guest'}, side:f.side, items:f.items, value:f.value, opponent:{name:'PetFlip Bot',bot:true}, oppItems:botItems, result:landed, winner:won?'creator':'opponent', fair}, true);
    }
  }catch(e){ toast(e.message,'bad'); }
  busy=false; render();
}
// animate any resolved flip; asCreator = viewing user is the creator
async function playFlip(f, asCreator){
  const opp=f.side==='h'?'t':'h';
  const side=(u,side,items)=>`<div class="ava ${u&&u.bot?'bot':'you'}">${avaFor(u)}${sideDot(side)}</div><div class="n">${esc((u&&(u.displayName||u.name))||'')}</div><div class="v">${gv(sumv(items.map(nItem)))}</div><div class="chips">${chipsHTML(items,8)}</div>`;
  $('rs-a').className='room-side'; $('rs-b').className='room-side';
  $('rs-a').innerHTML=side(f.creator,f.side,f.items); $('rs-b').innerHTML=side(f.opponent,opp,f.oppItems);
  const potV=sumv(f.items.map(nItem))+sumv(f.oppItems.map(nItem));
  $('room-title').textContent='Coinflip · '+fmt(potV)+' pot'; $('room-sub').textContent='Server seed hash: '+f.fair.hash.slice(0,24)+'…';
  $('room-res').className='result'; $('room-res').textContent=''; $('room-fair').innerHTML='<b>Hash</b> '+f.fair.hash;
  $('ov-room').dataset.lock='1'; $('room-x').style.visibility='hidden'; openOv('ov-room');
  const coin=$('coin'); coin.style.transition='none'; coin.style.transform='rotateY(0deg)'; void coin.offsetWidth;
  for(const c of ['3','2','1']){ $('room-res').textContent=c; await sleep(550); }
  $('room-res').textContent='';
  coin.style.transition='transform 3.2s cubic-bezier(.15,.75,.25,1)'; coin.style.transform=`rotateY(${8*360+(f.result==='h'?0:180)}deg)`;
  await sleep(3300);
  const creatorWon=f.winner==='creator'; const iWon = asCreator?creatorWon:!creatorWon;
  $(creatorWon?'rs-a':'rs-b').classList.add('won'); $(creatorWon?'rs-b':'rs-a').classList.add('lost');
  $('room-res').className='result '+(iWon?'w':'l');
  $('room-res').textContent=(f.result==='h'?'Heads':'Tails')+' — '+(iWon?'You won '+fmt(potV)+'!':'You lost');
  $('room-fair').innerHTML='<b>Server seed</b> '+f.fair.server+'<br><b>Hash</b> '+f.fair.hash+'<br><b>Client seed</b> '+esc(f.fair.client)+' · <b>Nonce</b> '+f.fair.nonce+' · <b>Roll</b> '+(+f.fair.r).toFixed(8);
  delete $('ov-room').dataset.lock; $('room-x').style.visibility='visible';
  toast(iWon?'You won the flip! +'+fmt(potV):'Unlucky — you lost this one', iWon?'ok':'bad');
  render();
}

/* ══════════════ JACKPOT (vs bot) ══════════════ */
let JP={entries:[], state:'open'}, jpSel=new Set();
function openJpJoin(){
  if(!requireLink()) return;
  if(JP.state==='roll'){ toast('Round is rolling — wait a moment'); return; }
  if(!S.inv.length){ toast('Your inventory is empty — deposit first','bad'); openDep(); return; }
  jpSel.clear(); $('jp-q').value=''; renderJpPicker(); openOv('ov-jp');
}
const jpMine = () => JP.entries.find(e=>e.you);
function renderJpPicker(){
  const inPot=new Set((jpMine()?.items||[]).map(i=>i.uid));
  const items=filt(S.inv.filter(i=>!inPot.has(i.uid)),$('jp-q').value).sort((a,b)=>b.value-a.value);
  $('jp-picker').innerHTML=items.length?`<div class="tiles">${items.map(i=>tileHTML(i,{sel:jpSel.has(i.uid),click:`jpTog(${i.uid})`})).join('')}</div>`:emptyHTML('🔍','No items','Nothing left to add.');
  $('jp-sum').innerHTML=gv(sumv(S.inv.filter(i=>jpSel.has(i.uid))));
}
function jpTog(uid){ jpSel.has(uid)?jpSel.delete(uid):jpSel.add(uid); renderJpPicker(); }
function jpJoin(){
  const items=S.inv.filter(i=>jpSel.has(i.uid)); if(!items.length){ toast('Pick at least one item','bad'); return; }
  let me=jpMine(); if(me) me.items.push(...items); else JP.entries.push({you:true, u:S.user, name:userName(), items, col:PCOL[0]});
  closeOv('ov-jp'); render(); toast('Added to the pot — call the bot to roll','ok');
}
async function jpCallBot(){
  const me=jpMine(); if(!me){ toast('Join the pot first, then call the bot'); return; }
  if(JP.state==='roll') return;
  JP.state='roll'; render();
  try{
    let won, fair, botItems;
    if(SV()){
      const j=await api('/api/jackpot/bot',{body:{uids:me.items.map(i=>i.uid)}});
      syncMe(j); won=j.won; fair=j.fair; botItems=j.botItems.map(nItem);
    } else {
      botItems=botStake(sumv(me.items)); const myV=sumv(me.items), bV=sumv(botItems);
      const ids=new Set(me.items.map(i=>i.uid)); S.inv=S.inv.filter(i=>!ids.has(i.uid));
      fair=await roll(await newRound()); won=fair.r<myV/(myV+bV);
      if(won) S.inv.push(...me.items,...botItems);
      addHistLocal('Jackpot', myV, won?myV+bV:0, won, (myV/(myV+bV)*100).toFixed(2)+'% chance vs bot', fair); save();
    }
    JP.entries.push({bot:true, u:{bot:true,name:'PetFlip Bot'}, name:'PetFlip Bot', items:botItems, col:PCOL[1]});
    renderJp(true);
    await spinStrip(won?me:JP.entries[1]);
    const potV=JP.entries.reduce((s,e)=>s+sumv(e.items),0);
    $('jp-state').textContent='Winner'; $('jp-time').textContent=won?userName():'PetFlip Bot';
    toast(won?'🏆 You won the jackpot! +'+fmt(potV):'The bot won the pot', won?'ok':'bad');
    await sleep(3000);
  }catch(e){ toast(e.message,'bad'); }
  JP={entries:[],state:'open'}; render();
}
function renderJp(keepStrip){
  const pot=JP.entries.reduce((s,e)=>s+sumv(e.items),0), cnt=JP.entries.reduce((s,e)=>s+e.items.length,0);
  $('jp-pot').innerHTML=gv(pot); $('jp-items').textContent=cnt; $('jp-ecount').textContent=JP.entries.length;
  $('jp-state').textContent = JP.state==='roll'?'Rolling':JP.entries.length?'Call the bot to roll':'Waiting for you'; if(JP.state!=='roll') $('jp-time').textContent='--';
  $('jp-bar').innerHTML=JP.entries.map(e=>`<div style="width:${pot?sumv(e.items)/pot*100:0}%;background:${e.col}"></div>`).join('');
  $('jp-entries').innerHTML=JP.entries.length?JP.entries.map(e=>{ const v=sumv(e.items); return `<div class="entry" style="--pc:${e.col}"><div class="ava ${e.bot?'bot':'you'}" style="width:36px;height:36px;font-size:13px">${avaFor(e.u)}</div><div style="min-width:0"><div class="n">${esc(e.name)}</div><div class="s">${gv(v)} · ${e.items.length} items</div></div><div class="chips" style="margin-left:12px">${chipsHTML(e.items,5)}</div><div class="pct" style="color:${e.col}">${(pot?v/pot*100:0).toFixed(2)}%</div></div>`; }).join('')
    : emptyHTML('🎰','Pot is empty','Add pets, then call the bot. Your chance equals your share of the pot.');
  if(!keepStrip && JP.state!=='roll') buildStripIdle();
  $('jp-join').disabled=JP.state==='roll'; $('jp-bot').disabled=JP.state==='roll'||!jpMine();
}
function stileHTML(e){ return `<div class="stile" style="--pc:${e.col}"><div class="ava ${e.bot?'bot':'you'}">${avaFor(e.u)}</div>${esc(e.name.slice(0,10))}</div>`; }
function buildStripIdle(){
  const st=$('jp-strip'); st.style.transition='none'; st.style.transform='none';
  st.innerHTML = JP.entries.length ? Array.from({length:20},(_,k)=>stileHTML(JP.entries[k%JP.entries.length])).join('')
    : Array.from({length:20},()=>`<div class="stile" style="--pc:var(--line2)"><div class="ava open" style="width:38px;height:38px">?</div></div>`).join('');
}
function pickWeighted(x){ let acc=0; const tot=JP.entries.reduce((s,e)=>s+sumv(e.items),0); for(const e of JP.entries){ acc+=sumv(e.items)/tot; if(x<acc) return e; } return JP.entries[JP.entries.length-1]; }
async function spinStrip(winner){
  const N=70,W=60,tw=90; const tiles=[]; for(let k=0;k<N;k++) tiles.push(k===W?winner:pickWeighted(Math.random()));
  const st=$('jp-strip'); st.style.transition='none'; st.style.transform='translateX(0)'; st.innerHTML=tiles.map(stileHTML).join(''); void st.offsetWidth;
  const x=-(W*tw+42-st.parentElement.clientWidth/2+(Math.random()-.5)*60);
  st.style.transition='transform 6s cubic-bezier(.12,.8,.18,1)'; st.style.transform=`translateX(${x}px)`;
  await sleep(6200);
}

/* ══════════════ UPGRADER ══════════════ */
let upSel=new Set(), upTarget=null, upBusy=false;
const upInVal = () => sumv(S.inv.filter(i=>upSel.has(i.uid)));
function upChance(){ const iv=upInVal(); if(!upTarget||!iv) return 0; return Math.min(UPGRADE_MAX, iv/upTarget.value*(1-UPGRADE_EDGE)); }
function renderUpInv(){
  if(upBusy) return;
  for(const u of [...upSel]) if(!S.inv.find(i=>i.uid===u)) upSel.delete(u);
  const items=filt(S.inv,$('up-q1').value).sort((a,b)=>b.value-a.value);
  $('up-inv').innerHTML = S.inv.length ? (items.length?`<div class="tiles">${items.map(i=>tileHTML(i,{sel:upSel.has(i.uid),click:`upTog(${i.uid})`})).join('')}</div>`:emptyHTML('🔍','No items','Nothing matches.'))
    : emptyHTML('📦','No items','Deposit pets to start upgrading.',`<button class="btn btn-g btn-sm" onclick="openDep()">Deposit</button>`);
  $('up-sel-count').textContent=upSel.size+' selected';
}
function renderUpTargets(){
  if(upBusy) return;
  const iv=upInVal();
  const pool = API_ON ? PETS.filter(p=>p.stock>0) : PETS;
  const items=filt(pool,$('up-q2').value).sort((a,b)=>a.value-b.value);
  $('up-tgts').innerHTML = items.length ? `<div class="tiles">${items.map(p=>{
    const ok=!iv||(p.value>iv*1.05 && iv/p.value*(1-UPGRADE_EDGE)>=0.01);
    return tileHTML(nItem({pid:p.id,...p}),{sel:upTarget&&upTarget.id===p.id, dis:!!iv&&!ok, click:`upPick('${p.id}')`, stock:API_ON?p.stock:null});
  }).join('')}</div>` : emptyHTML('🎯','No targets','The bot has no pets in stock to upgrade into right now.');
  $('up-tgt-name').textContent=upTarget?upTarget.name:'none';
}
function upTog(uid){ upSel.has(uid)?upSel.delete(uid):upSel.add(uid); const iv=upInVal(); if(upTarget&&upTarget.value<=iv*1.05) upTarget=null; renderUpInv(); renderUpTargets(); updUp(); }
function upPick(id){ upTarget=PET[id]; renderUpTargets(); updUp(); }
function quickMult(m){
  const iv=upInVal(); if(!iv){ toast('Select items first'); return; }
  const pool=API_ON?PETS.filter(p=>p.stock>0):PETS; let best=null;
  for(const p of pool){ if(p.value<=iv*1.05) continue; if(!best||Math.abs(p.value-iv*m)<Math.abs(best.value-iv*m)) best=p; }
  if(!best){ toast('No pet in stock is worth more than your selection','bad'); return; }
  upTarget=best; renderUpTargets(); updUp();
}
function updUp(){
  if(upBusy) return;
  const iv=upInVal(), ch=upChance();
  $('up-in').innerHTML=gv(iv); $('up-out').innerHTML=gv(upTarget?upTarget.value:0);
  $('up-chance').textContent=(ch*100).toFixed(2)+'%'; $('up-mult').textContent=(upTarget&&iv?upTarget.value/iv:0).toFixed(2)+'x';
  const C=2*Math.PI*122; $('arc-win').setAttribute('stroke-dasharray',`${ch*C} ${C}`); $('arc-lose').setAttribute('stroke-dasharray',`0 ${ch*C} ${(1-ch)*C} 0`);
  $('up-go').disabled=!(iv&&upTarget&&ch>=0.01);
}
async function doUpgrade(){
  if(!requireLink()) return;
  if(upBusy) return; const iv=upInVal(), ch=upChance(); if(!iv||!upTarget||ch<0.01) return;
  upBusy=true; $('up-go').disabled=true; $('up-res').textContent=''; $('up-res').className='up-res'; $('wheel').classList.remove('win');
  const target=upTarget; let won, fair, j=null;
  try{
    if(SV()){ j=await api('/api/upgrade',{body:{uids:[...upSel], targetPid:target.id}}); won=j.won; fair=j.fair; }
    else {
      const ids=new Set(upSel); S.inv=S.inv.filter(i=>!ids.has(i.uid));
      fair=await roll(await newRound()); won=fair.r<ch; if(won) S.inv.push(mkItem(target.id));
      addHistLocal('Upgrader', iv, won?target.value:0, won, (ch*100).toFixed(2)+'% → '+target.name, fair); save();
    }
  }catch(e){ toast(e.message,'bad'); upBusy=false; updUp(); return; }
  const nd=$('needle'); nd.style.transition='none'; nd.style.transform='rotate(0deg)'; void nd.offsetWidth;
  nd.style.transition='transform 4.5s cubic-bezier(.12,.8,.2,1)'; nd.style.transform=`rotate(${360*6+fair.r*360}deg)`;
  await sleep(4700);
  if(j) syncMe(j);
  if(won) $('wheel').classList.add('win');
  $('up-res').className='up-res '+(won?'w':'l'); $('up-res').textContent=won?'Upgraded to '+target.name+'!':'Upgrade failed';
  toast(won?'⬆️ Upgrade success! '+target.name:'Upgrade failed — better luck next time', won?'ok':'bad');
  upSel.clear(); upTarget=null; upBusy=false;
  await refreshCatalog(); render();
}

/* ══════════════ HISTORY / FAIR ══════════════ */
function addHistLocal(game,wager,payout,win,detail,fair){ S.hist.unshift({game,wager,payout,win,detail,t:Date.now(),fair:{server:fair.server,hash:fair.hash,client:fair.client,nonce:fair.nonce,r:fair.r}}); if(S.hist.length>200) S.hist.length=200; }
function renderHist(){
  $('hist').innerHTML=S.hist.length?S.hist.map((h,k)=>`<tr><td><b>${h.game}</b><div style="font-size:11px;color:var(--mute)">${esc(h.detail)}</div></td><td style="color:var(--dim)">${ago(h.t)}</td><td class="mono">${gv(h.wager)}</td><td class="mono" style="color:${h.win?'var(--win)':'var(--mute)'}">${gv(h.payout)}</td><td><span class="tag ${h.win?'w':'l'}">${h.win?'Win':'Loss'}</span></td><td class="mono" style="color:var(--dim)">${(+h.fair.r).toFixed(6)}</td><td><button class="btn btn-s btn-sm" onclick="verifyRow(${k})">Verify</button></td></tr>`).join('')
    :`<tr><td colspan="7">${emptyHTML('🕓','No games yet','Your coinflips, jackpots and upgrades show up here with full provably-fair data.')}</td></tr>`;
}
function verifyRow(k){ const f=S.hist[k].fair; $('v-server').value=f.server; $('v-client').value=f.client; $('v-nonce').value=f.nonce; go('fair'); verify(); }
async function verify(){
  const s=$('v-server').value.trim(), c=$('v-client').value.trim(), n=$('v-nonce').value.trim();
  if(!s||!c||n===''){ $('v-out').textContent='Fill in all three fields.'; return; }
  const r=await rollFrom(s,c,n); $('v-out').innerHTML=`<b>SHA256(server seed)</b> ${await sha256(s)}<br><b>Roll</b> ${r.toFixed(10)}<br><b>Coinflip</b> ${r<0.5?'Heads':'Tails'}`;
}

/* ══════════════ INVENTORY ══════════════ */
let invCat='all';
function openInv(){ renderInv(); openOv('ov-inv'); }
function renderInv(){
  $('inv-name').textContent=userName(); $('inv-ava').innerHTML=avaInner();
  $('iv-total').innerHTML=gv(sumv(S.inv)); $('iv-pets').textContent=S.inv.length;
  const top=[...S.inv].sort((a,b)=>b.value-a.value)[0]; $('iv-gems').innerHTML=top?gv(top.value):gv(0);
  const cats=[['all','All Items'],['garg','Gargantuans'],['titan','Titanics'],['huge','Huges']];
  $('inv-cats').innerHTML=cats.map(([k,l])=>`<button class="cat${invCat===k?' on':''}" style="--rc:${k==='all'?'var(--text)':RARITY[k].c}" onclick="invCat='${k}';renderInv()"><i></i>${l}<span>${k==='all'?S.inv.length:S.inv.filter(i=>i.r===k).length}</span></button>`).join('');
  let items=filt(S.inv,$('inv-q').value).filter(i=>invCat==='all'||i.r===invCat);
  const so=$('inv-sort').value; items.sort(so==='lo'?(a,b)=>a.value-b.value:so==='az'?(a,b)=>a.name.localeCompare(b.name):(a,b)=>b.value-a.value);
  $('inv-grid').innerHTML=items.length?`<div class="tiles">${items.map(i=>tileHTML(i)).join('')}</div>`
    :emptyHTML('📦',S.inv.length?'Nothing here':'Inventory empty',S.inv.length?'No items in this category.':'Deposit Huges, Titanics or Gargantuans to get started.',S.inv.length?'':`<button class="btn btn-g btn-sm" onclick="closeOv('ov-inv');openDep()">Deposit</button>`);
}

/* ══════════════ DEPOSIT / WITHDRAW ══════════════ */
function botsHTML(){ return BOTS.map((b,k)=>`<div class="botrow"><div class="ava bot">🤖</div><div style="flex:1;min-width:0"><div class="n">${esc(b.name)} <span class="dot${b.online?'':' off'}"></span></div><span class="t">DEPOSITS + WITHDRAWS</span></div><button class="btn btn-s btn-sm" onclick="copyBot(${k})">Copy</button><button class="btn btn-g btn-sm" ${b.online?'':'disabled'} onclick="joinBot(${k})">Join</button></div>`).join(''); }
function copyBot(k){ const n=BOTS[k].name; (navigator.clipboard?navigator.clipboard.writeText(n):Promise.reject()).then(()=>toast('Copied '+n,'ok')).catch(()=>toast('Username: '+n)); }
function joinBot(k){ const b=BOTS[k]; if(b.joinUrl) window.open(b.joinUrl,'_blank','noopener'); else toast('Join '+b.name+' in Pet Simulator 99 and send a trade'); }
function openDep(){ if(!requireLink()) return; $('dep-bots').innerHTML=botsHTML(); $('dep-dev').style.display=API_ON?'none':''; $('dep-live').style.display=API_ON?'':'none'; openOv('ov-dep'); }
function addTestItems(){
  if(!requireLink()||API_ON) return;
  const pool=PETS.filter(p=>p.tier!=='garg'); const n=6+Math.floor(Math.random()*4);
  for(let k=0;k<n;k++) S.inv.push(mkItem(pool[Math.floor(Math.random()*pool.length)].id));
  save(); render(); toast('Added '+n+' demo pets','ok');
}
let wdSel=new Set();
function openWd(){ if(!requireLink()) return; wdSel.clear(); $('wd-q').value=''; renderWd(); openOv('ov-wd'); }
function renderWd(){
  $('wd-pending').innerHTML=S.pending.length?`<div class="lbl">Pending withdrawals</div><div class="flips" style="margin-bottom:18px">${S.pending.map(p=>`<div class="botrow"><div class="chips" style="flex:1">${chipsHTML(p.items,8)}</div><div style="color:var(--gold);font-weight:700;font-family:var(--mono)">${gv(sumv(p.items.map(nItem)))}</div><span class="tag g">Pending</span><button class="btn btn-r btn-sm" onclick="cancelWd(${p.id})">Cancel</button></div>`).join('')}</div><div class="lbl">Your items</div>`:'';
  const items=filt(S.inv,$('wd-q').value).sort((a,b)=>b.value-a.value);
  $('wd-picker').innerHTML=items.length?`<div class="tiles">${items.map(i=>tileHTML(i,{sel:wdSel.has(i.uid),click:`wdTog(${i.uid})`})).join('')}</div>`:emptyHTML('📦','No items','Nothing to withdraw.');
  const sel=S.inv.filter(i=>wdSel.has(i.uid)); $('wd-sum').innerHTML=gv(sumv(sel)); $('wd-n').textContent=sel.length;
}
function wdTog(uid){ wdSel.has(uid)?wdSel.delete(uid):wdSel.add(uid); renderWd(); }
function wdClear(){ wdSel.clear(); renderWd(); }
async function confirmWd(){
  const uids=[...wdSel]; if(!uids.length){ toast('Select items to withdraw','bad'); return; }
  const items=S.inv.filter(i=>wdSel.has(i.uid));
  try{
    if(SV()) syncMe(await api('/api/withdraw',{body:{uids}}));
    else { S.inv=S.inv.filter(i=>!wdSel.has(i.uid)); S.pending.unshift({id:Date.now(),items,t:Date.now()}); save(); }
  }catch(e){ toast(e.message,'bad'); return; }
  closeOv('ov-wd'); $('wd-bots').innerHTML=botsHTML(); $('wdbot-sub').innerHTML=items.length+' items · '+gv(sumv(items))+' — join a bot to receive them.';
  openOv('ov-wdbot'); render();
}
async function cancelWd(id){
  try{
    if(SV()) syncMe(await api('/api/withdraw/cancel',{body:{id}}));
    else { const p=S.pending.find(x=>x.id===id); if(!p) return; S.inv.push(...p.items); S.pending=S.pending.filter(x=>x.id!==id); save(); }
    renderWd(); render(); toast('Withdrawal cancelled');
  }catch(e){ toast(e.message,'bad'); }
}
async function openValues(){ await refreshCatalog(); $('vals-q').value=''; renderValues(); openOv('ov-vals'); }
function renderValues(){
  const items=filt(PETS,$('vals-q').value).sort((a,b)=>b.value-a.value);
  $('vals-grid').innerHTML=items.length?`<div class="tiles">${items.map(p=>tileHTML(nItem({pid:p.id,...p}),{stock:API_ON?p.stock:null})).join('')}</div>`:emptyHTML('📋','No pets yet','Pets will appear here once they are added to the catalogue.');
}

/* ══════════════ PROFILE ══════════════ */
function cardHTML(u){ return `<div class="pic">${u.avatar?`<img src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:esc(initial(u.displayName||u.name))}</div><div style="min-width:0"><b>${esc(u.displayName||u.name)}</b><small>@${esc(u.name)}${u.id?' · ID '+u.id:''}${u.test?' · test account':''}</small>${u.id?`<div style="margin-top:6px"><a href="https://www.roblox.com/users/${u.id}/profile" target="_blank" rel="noopener" style="font-size:12px;color:var(--brand2);font-weight:600">View Roblox profile ↗</a></div>`:''}</div>`; }
function openProfile(){ if(!S.user){ openLink(); return; } $('pf-card').innerHTML=cardHTML(S.user); $('pf-seed').value=S.clientSeed; $('pf-nonce').textContent=S.nonce; openOv('ov-prof'); }
async function saveProfile(){
  const seed=$('pf-seed').value.trim();
  if(seed && seed!==S.clientSeed){
    if(SV()){ try{ const j=await api('/api/seed',{body:{clientSeed:seed}}); S.clientSeed=j.clientSeed; S.nonce=0; }catch(e){ toast(e.message,'bad'); return; } }
    else { S.clientSeed=seed; S.nonce=0; }
  }
  save(); closeOv('ov-prof'); render(); toast('Profile saved','ok');
}
function resetAll(){ if(API_ON){ toast('Your inventory lives on the server — nothing to reset here'); return; } if(!confirm('Reset demo inventory, flips and history?')) return; const u=S.user; S=fresh(); S.user=u; save(); closeOv('ov-prof'); render(); toast('Demo data reset'); }

/* ══════════════ LINK ROBLOX ══════════════ */
let LK={token:'',phrase:'',user:null,expires:0,timer:null};
function lkStep(n){ [1,2,3].forEach(k=>{ $('lk-'+k).classList.toggle('on',k===n); $('lk-f'+k).style.display=k===n?'':'none'; }); $('lk-sub').textContent=n===1?'Step 1 of 2 — who are you on Roblox?':n===2?"Step 2 of 2 — prove it's you":'All done'; }
function openLink(){ clearInterval(LK.timer); LK={token:'',phrase:'',user:null,expires:0,timer:null}; $('lk-user').value=''; $('lk-err1').textContent=''; $('lk-err2').textContent=''; $('lk-dev').style.display=API_ON?'none':'block'; lkStep(1); openOv('ov-link'); setTimeout(()=>$('lk-user').focus(),50); }
async function linkStart(){
  const u=$('lk-user').value.trim();
  if(!/^[A-Za-z0-9_]{3,20}$/.test(u)){ $('lk-err1').textContent='Enter a valid Roblox username (3–20 letters, numbers or _).'; return; }
  if(!API_ON){ $('lk-err1').textContent='Server not connected — use test mode below for now.'; return; }
  const b=$('lk-go1'); b.disabled=true; b.innerHTML='<span class="spin"></span> Looking up…'; $('lk-err1').textContent='';
  try{
    const j=await api('/api/link/start',{body:{username:u}});
    LK.token=j.token; LK.phrase=j.phrase; LK.user=j.user; LK.expires=j.expiresAt;
    $('lk-card').innerHTML=cardHTML(j.user); $('lk-phrase').textContent=j.phrase; $('lk-prof').href='https://www.roblox.com/users/'+j.user.id+'/profile';
    $('lk-err2').textContent=''; $('lk-go2').disabled=false; lkStep(2); tickLk(); LK.timer=setInterval(tickLk,1000);
  }catch(e){ $('lk-err1').textContent=e.message; }
  b.disabled=false; b.textContent='Continue';
}
function tickLk(){ const r=Math.max(0,LK.expires-Date.now()); $('lk-timer').textContent=String(Math.floor(r/60000)).padStart(2,'0')+':'+String(Math.floor(r%60000/1000)).padStart(2,'0'); if(!r){ clearInterval(LK.timer); $('lk-err2').textContent='Phrase expired — go back and start again.'; $('lk-go2').disabled=true; } }
function linkBack(){ clearInterval(LK.timer); lkStep(1); $('lk-go2').disabled=false; }
function copyPhrase(){ (navigator.clipboard?navigator.clipboard.writeText(LK.phrase):Promise.reject()).then(()=>toast('Phrase copied','ok')).catch(()=>toast('Select the phrase and copy it manually')); }
async function linkCheck(){
  const b=$('lk-go2'); b.disabled=true; b.innerHTML='<span class="spin"></span> Checking bio…'; $('lk-err2').textContent='';
  try{
    const j=await fetch(API_BASE.replace(/\/$/,'')+'/api/link/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:LK.token})}).then(r=>r.json());
    if(!j.ok) throw new Error(j.error||'Phrase not found in your bio yet.');
    clearInterval(LK.timer); S.user=j.user; S.session=j.session; S.inv=[]; S.hist=[]; S.pending=[]; save();
    await refreshMe(); linkDone();
  }catch(e){ $('lk-err2').textContent=e.message; }
  b.disabled=LK.expires<Date.now(); b.textContent='Verify bio';
}
function linkTest(){ const u=$('lk-user').value.trim(); if(!/^[A-Za-z0-9_]{3,20}$/.test(u)){ $('lk-err1').textContent='Type a username first (3–20 letters, numbers or _).'; return; } S.user={id:0,name:u,displayName:u,avatar:'',test:true}; S.session=''; save(); linkDone(); }
function linkDone(){ $('lk-done-name').textContent=userName(); $('lk-card3').innerHTML=cardHTML(S.user); lkStep(3); render(); loadFlips(); toast('Roblox account linked','ok'); }
async function unlink(){
  if(!confirm('Unlink '+userName()+'?')) return;
  if(SV()){ try{ await api('/api/logout',{body:{}}); }catch(e){} S.inv=[]; S.hist=[]; S.pending=[]; }
  S.user=null; S.session=''; S.role=null; save(); closeOv('ov-prof'); render(); toast('Account unlinked');
}

/* ══════════════ ADMIN ══════════════ */
let ADM={key:'', state:null, edit:null};
try{ ADM.key=sessionStorage.getItem('pf_admin')||''; }catch(e){}
const admHdr=()=>ADM.key?{'x-admin-key':ADM.key}:{};
const admApi=(p,body)=>api(p,{body, headers:admHdr()});
async function admInit(){
  if(!API_ON){ $('adm-err').textContent='Admin needs the server — open the site from your Render link.'; return; }
  if(S.role || ADM.key) await admLoad(); else { $('adm-panel').style.display='none'; $('adm-login').style.display=''; }
}
async function admLogin(){
  ADM.key=$('adm-key').value.trim(); $('adm-err').textContent='';
  try{
    if(SV()){ await api('/api/admin/claim',{body:{},headers:admHdr()}); S.role='owner'; save(); ADM.key=''; }
    else { await api('/api/admin/state',{headers:admHdr()}); try{ sessionStorage.setItem('pf_admin',ADM.key); }catch(e){} }
  }catch(e){ $('adm-err').textContent=e.message; ADM.key=''; return; }
  $('adm-key').value=''; render(); await admLoad();
  if(!SV()) toast('Unlocked for this tab. Link your Roblox account and unlock again to make it permanent.');
}
async function admLoad(){
  try{ ADM.state=await api('/api/admin/state',{headers:admHdr()}); }
  catch(e){ $('adm-err').textContent=e.status===403?"You don't have access to this page.":e.message; $('adm-panel').style.display='none'; $('adm-login').style.display=''; if(e.status===403 && S.role){ S.role=null; save(); render(); } return; }
  $('adm-login').style.display='none'; $('adm-panel').style.display=''; setPets(ADM.state.pets);
  $('adm-staff-card').style.display = ADM.state.role==='owner' ? '' : 'none';
  admRender(); if(ADM.state.role==='owner') admStaffLoad();
}
async function admStaffLoad(){
  try{
    const j=await api('/api/admin/staff',{headers:admHdr()});
    $('adm-owner').innerHTML = j.owner ? `Owner: <b>${esc(j.owner.displayName||j.owner.name)}</b> <span style="color:var(--mute)">@${esc(j.owner.name)}</span>` : 'Owner not bound yet — link your Roblox account and unlock again.';
    $('adm-staff').innerHTML = j.staff.length ? j.staff.map(u=>`<tr><td><div style="display:flex;align-items:center;gap:10px"><div class="ava you" style="width:30px;height:30px;font-size:11px">${avaFor(u)}</div><b>${esc(u.displayName||u.name)}</b> <span style="color:var(--mute)">@${esc(u.name)}</span></div></td><td style="text-align:right"><button class="btn btn-r btn-sm" onclick="admStaffRemove(${u.id})">Remove</button></td></tr>`).join('')
      : `<tr><td colspan="2" style="color:var(--mute);padding:16px">No staff yet.</td></tr>`;
  }catch(e){ $('adm-serr').textContent=e.message; }
}
async function admStaffAdd(){ $('adm-serr').textContent=''; try{ await admApi('/api/admin/staff/add',{username:$('adm-staff-user').value}); $('adm-staff-user').value=''; toast('Staff added — they can now see the Admin tab','ok'); admStaffLoad(); }catch(e){ $('adm-serr').textContent=e.message; } }
async function admStaffRemove(id){ try{ await admApi('/api/admin/staff/remove',{userId:id}); toast('Staff removed'); admStaffLoad(); }catch(e){ toast(e.message,'bad'); } }
function admRender(){
  const s=ADM.state;
  $('adm-kpis').innerHTML=`<div class="kpi" style="--c:var(--gold-g)"><small>Bot stock value</small><b style="color:var(--gold)">${gv(s.houseValue)}</b></div><div class="kpi"><small>Bot stock items</small><b>${s.houseItems}</b></div><div class="kpi"><small>Catalogue pets</small><b>${s.pets.length}</b></div><div class="kpi" style="--c:var(--lose-g)"><small>Pending withdrawals</small><b>${s.withdraws.length}</b></div>`;
  const pets=[...s.pets].sort((a,b)=>b.value-a.value);
  $('adm-pets').innerHTML=pets.length?pets.map(p=>`<tr><td>${p.img?`<img src="${esc(p.img)}" referrerpolicy="no-referrer">`:'<span style="color:var(--mute)">—</span>'}</td><td><b>${esc(p.name)}</b><div style="font-size:11px;color:var(--mute)">${esc(p.id)}</div></td><td><span class="tag g" style="color:${RARITY[p.tier].c}">${RARITY[p.tier].label}</span></td><td class="mono">${gv(p.value)}</td><td class="mono">${p.stock}</td>
    <td><div class="act"><input type="number" id="q-${esc(p.id)}" value="1"><button class="btn btn-g btn-sm" onclick="admStock('${esc(p.id)}',1)">+</button><button class="btn btn-r btn-sm" onclick="admStock('${esc(p.id)}',-1)">−</button><button class="btn btn-s btn-sm" onclick="admEdit('${esc(p.id)}')">Edit</button><button class="btn btn-s btn-sm" onclick="admDel('${esc(p.id)}')">Delete</button></div></td></tr>`).join('')
    :`<tr><td colspan="6" style="color:var(--mute);padding:20px">No pets yet — add your first Huge, Titanic or Gargantuan on the left.</td></tr>`;
  $('cr-pet').innerHTML=pets.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${fmt(p.value)})</option>`).join('');
  $('adm-wds').innerHTML=s.withdraws.length?s.withdraws.map(w=>`<tr><td><b>${esc(w.username)}</b><div style="font-size:11px;color:var(--mute)">ID ${w.userId}</div></td><td><div class="chips">${chipsHTML(w.items,6)}</div></td><td class="mono">${gv(sumv(w.items.map(nItem)))}</td><td style="color:var(--dim)">${ago(w.t)}</td><td><button class="btn btn-g btn-sm" onclick="admWdDone(${w.id})">Mark sent</button></td></tr>`).join('')
    :`<tr><td colspan="5" style="color:var(--mute);padding:20px">No pending withdrawals.</td></tr>`;
  $('adm-users').innerHTML=s.users.length?s.users.map(u=>`<tr><td><b>${esc(u.displayName||u.name)}</b> <span style="color:var(--mute)">@${esc(u.name)}</span></td><td class="mono">${u.items}</td><td class="mono">${gv(u.value)}</td></tr>`).join(''):`<tr><td colspan="3" style="color:var(--mute);padding:20px">No players yet.</td></tr>`;
}
function admPrev(){ const u=$('adm-img').value.trim(); $('adm-prev').innerHTML=u?`<img src="${esc(u)}" referrerpolicy="no-referrer" onerror="this.parentElement.textContent='bad image'">`:'no image'; }
function admReset(){ ADM.edit=null; ['adm-name','adm-value','adm-img'].forEach(i=>$(i).value=''); $('adm-tier').value='huge'; $('adm-form-title').textContent='Add pet to catalogue'; $('adm-perr').textContent=''; admPrev(); }
function admEdit(id){ const p=ADM.state.pets.find(x=>x.id===id); if(!p) return; ADM.edit=id; $('adm-name').value=p.name; $('adm-tier').value=p.tier; $('adm-value').value=p.value; $('adm-img').value=p.img||''; $('adm-form-title').textContent='Edit '+p.name; admPrev(); window.scrollTo(0,0); }
async function admSavePet(){
  $('adm-perr').textContent='';
  try{ await admApi('/api/admin/pet',{id:ADM.edit||undefined, name:$('adm-name').value, tier:$('adm-tier').value, value:$('adm-value').value, img:$('adm-img').value}); toast('Pet saved','ok'); admReset(); await admLoad(); }
  catch(e){ $('adm-perr').textContent=e.message; }
}
async function admStock(id,sign){ const q=Math.max(1,parseInt($('q-'+id).value)||1)*sign; try{ await admApi('/api/admin/stock',{pid:id,qty:q}); toast((sign>0?'Added ':'Removed ')+Math.abs(q),'ok'); await admLoad(); }catch(e){ toast(e.message,'bad'); } }
async function admDel(id){ try{ await admApi('/api/admin/pet/delete',{id}); toast('Pet deleted'); await admLoad(); }catch(e){ toast(e.message,'bad'); } }
async function admCredit(){ $('adm-cerr').textContent=''; try{ await admApi('/api/admin/credit',{username:$('cr-user').value.trim(), pid:$('cr-pet').value, qty:$('cr-qty').value}); toast('Credited','ok'); await admLoad(); }catch(e){ $('adm-cerr').textContent=e.message; } }
async function admWdDone(id){ try{ await admApi('/api/admin/withdraw/complete',{id}); toast('Marked as sent','ok'); await admLoad(); }catch(e){ toast(e.message,'bad'); } }

/* ══════════════ INIT ══════════════ */
window.addEventListener('hashchange',()=>go(location.hash.slice(1)));
(async()=>{
  go(location.hash.slice(1)||'coinflip');
  try{ const j=await fetch(API_BASE.replace(/\/$/,'')+'/api/health').then(r=>r.json()); API_ON=!!(j&&j.ok); }catch(e){ API_ON=false; }
  if(API_ON){
    setPets([]);
    if(S.user && S.user.test){ S.user=null; S.inv=[]; save(); }   // test accounts don't exist on the server
    if(!S.session){ S.inv=[]; S.hist=[]; S.pending=[]; S.flips=[]; }
    await refreshCatalog(); await refreshMe(); await loadFlips();
    setInterval(()=>{ if(!document.hidden && document.querySelector('#p-coinflip.on')) loadFlips(); },4000);
    setInterval(()=>{ if(!document.hidden && SV() && !busy && !upBusy && JP.state!=='roll') refreshMe().then(render); },8000);
    window.addEventListener('focus',()=>{ if(SV() && !busy && !upBusy && JP.state!=='roll') refreshMe().then(render); });
  }
  go(location.hash.slice(1)||'coinflip');
})();
