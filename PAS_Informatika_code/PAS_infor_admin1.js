(function () {
  "use strict";
  var L=window.LABELS, $=id=>document.getElementById(id), KEY="antrean.adminToken",
      token=null, live=null, entries=[], previous={}, synced=false, lateMs=600000,
      pendingConfirm={}, flashTimer=null;
  function sGet(k){try{return sessionStorage.getItem(k)}catch(e){return null}}
  function sSet(k,v){try{sessionStorage.setItem(k,v)}catch(e){}}
  function sDel(k){try{sessionStorage.removeItem(k)}catch(e){}}
  function msg(el,t,k){el.textContent=t;el.className="message "+(k||"info");el.classList.remove("hidden")}
  function hide(el){el.classList.add("hidden")}
  function flash(t,k){var e=$("actionMsg");msg(e,t,k);clearTimeout(flashTimer);flashTimer=setTimeout(()=>hide(e),6000)}
  function eff(e){return e.callStatus==="dipanggil"&&e.deadlineAt&&window.serverNow()>=e.deadlineAt?"hangus":e.callStatus}
  function api(method,path,body){
    var o={method,headers:{Authorization:"Bearer "+token},cache:"no-store"};
    if(body!==undefined){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body)}
    return fetch(path,o).then(r=>r.json().catch(()=>({})).then(d=>{
      if(r.status===401)showLogin("Sesi berakhir. Silakan masuk lagi.");
      return {status:r.status,ok:r.ok&&d.ok,body:d}
    }))
  }
  function showLogin(t){
    if(live)live.stop();token=null;sDel(KEY);
    $("dashView").classList.add("hidden");$("loginView").classList.remove("hidden");
    $("logoutBtn").classList.add("hidden");$("conn").classList.add("hidden");$("offlineBanner").classList.add("hidden");
    if(t)msg($("loginMsg"),t,"error");$("password").focus();
  }
  function showDashboard(){
    $("loginView").classList.add("hidden");$("dashView").classList.remove("hidden");
    $("logoutBtn").classList.remove("hidden");hide($("loginMsg"));
    if(!live)live=new window.LiveSocket({onOpen:()=>live.send({type:"hello_admin",token}),onMessage:onServerMessage,onStatus:setConn});
    live.start();
  }
  $("loginForm").addEventListener("submit",ev=>{
    ev.preventDefault();var btn=$("loginBtn");
    if(!$("password").value)return msg($("loginMsg"),"Masukkan kata sandi.","error");
    btn.disabled=true;
    fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("password").value})})
      .then(r=>r.json().catch(()=>({})).then(d=>{
        if(r.ok&&d.ok){token=d.token;sSet(KEY,token);$("password").value="";showDashboard()}
        else msg($("loginMsg"),d.error||"Gagal masuk.","error")
      })).catch(()=>msg($("loginMsg"),"Tidak dapat terhubung ke server.","error"))
      .then(()=>btn.disabled=false);
  });
  $("logoutBtn").addEventListener("click",()=>{
    var t=token;showLogin(null);fetch("/api/admin/logout",{method:"POST",headers:{Authorization:"Bearer "+t}}).catch(()=>{});
  });
  function setConn(st){
    var e=$("conn");e.classList.remove("hidden","online","offline");
    if(st==="online"){e.classList.add("online");e.textContent="Real time aktif"}
    else if(st==="offline"){e.classList.add("offline");e.textContent="Terputus"}
    else e.textContent="Menghubungkan…";
    if(st!=="online")setSynced(false);
  }
  function setSynced(v){
    synced=v;$("offlineBanner").classList.toggle("hidden",v||!token);
    document.querySelectorAll("[data-needs-online]").forEach(b=>{if(!b.dataset.busy)b.disabled=!v});
  }
  function onServerMessage(m){
    if(typeof m.serverTime==="number")window.syncServerTime(m.serverTime);
    if(m.type==="queue"){
      entries=m.entries||[];
      if(m.lateMs){lateMs=m.lateMs;document.querySelectorAll(".late-min").forEach(x=>x.textContent=Math.round(lateMs/60000)+" menit")}
      setSynced(true);render(m);
    }else if(m.type==="auth_error")showLogin("Sesi dokter tidak valid. Silakan masuk lagi.");
  }
  function el(tag,cls,text){var x=document.createElement(tag);if(cls)x.className=cls;if(text!=null)x.textContent=text;return x}
  function button(label,cls,action,n){
    var b=el("button",cls,label);b.type="button";b.dataset.action=action;b.dataset.number=n;
    b.setAttribute("data-needs-online","");b.disabled=!synced;return b;
  }
  function render(snapshot){
    var body=$("queueBody");body.textContent="";
    var c={total:0,menunggu:0,dipanggil:0,dilayani:0,selesai:0,hangus:0,di_area:0,perjalanan:0,tidak_datang:0,belum_konfirmasi:0}, next={};
    entries.forEach(e=>{
      var st=eff(e),sig,tr,td,wrap;
      c.total++;c[st]=(c[st]||0)+1;if(st==="menunggu"||st==="dipanggil")c[e.attendance]++;
      next[e.number]=e.attendance+"|"+st+"|"+e.callId;
      tr=el("tr");tr.dataset.number=e.number;
      if(st==="selesai"||st==="hangus")tr.classList.add("is-done");
      if(previous[e.number]!==undefined&&previous[e.number]!==next[e.number])tr.classList.add("flash");
      var cells=[el("td","num",e.number),el("td"),el("td"),el("td"),el("td")];
      cells[1].setAttribute("data-label","Kode");cells[1].appendChild(el("span","code",e.code));
      cells[2].setAttribute("data-label","Kehadiran");cells[2].appendChild(el("span","badge att-"+e.attendance,L.attendance[e.attendance]||e.attendance));
      if(e.attendanceUpdatedAt)cells[2].appendChild(el("div","small muted","diperbarui "+window.formatTime(e.attendanceUpdatedAt)));
      cells[3].setAttribute("data-label","Panggilan");cells[3].appendChild(el("span","badge call-"+st,L.call[st]||st));
      if(e.callCount>0)cells[3].appendChild(el("div","small muted","dipanggil "+e.callCount+"× · terakhir "+window.formatTime(e.calledAt)));
      if(st==="dipanggil"){
        td=el("div","small muted","hangus dalam ");var cd=el("span","cd",window.formatCountdown(e.deadlineAt-window.serverNow()));
        cd.dataset.deadline=e.deadlineAt;td.appendChild(cd);cells[3].appendChild(td);
      }
      wrap=el("div","actions");
      if(st==="menunggu")wrap.appendChild(button("Panggil","btn-primary","call",e.number));
      if(st==="dipanggil"){wrap.appendChild(button("Hadir","btn-ok","hadir",e.number));wrap.appendChild(button("Panggil ulang","btn-outline","call",e.number))}
      if(st==="dilayani")wrap.appendChild(button("Selesai","btn-primary","selesai",e.number));
      if(st==="hangus")wrap.appendChild(button("Aktifkan lagi","btn-outline","aktifkan",e.number));
      if(["menunggu","selesai","hangus"].includes(st))wrap.appendChild(button("Hapus","btn-danger","hapus",e.number));
      cells[4].appendChild(wrap);cells.forEach(x=>tr.appendChild(x));body.appendChild(tr);
    });
    previous=next;$("emptyState").classList.toggle("hidden",entries.length>0);
    var sum=$("summary");sum.textContent="";
    [["Total",c.total],["Menunggu",c.menunggu],["Dipanggil",c.dipanggil],["Dilayani",c.dilayani],["Selesai",c.selesai],["Hangus",c.hangus],["Di area RS",c.di_area],["Dalam perjalanan",c.perjalanan],["Tidak bisa datang",c.tidak_datang],["Belum kabar",c.belum_konfirmasi]]
      .forEach(p=>sum.appendChild(el("span","pill",p[0]+": "+p[1])));
    if(snapshot)$("syncInfo").textContent="Data server pukul "+window.formatTime(snapshot.serverTime)+(snapshot.lastCalledNumber?" · nomor terakhir dipanggil: "+snapshot.lastCalledNumber:"");
  }
  setInterval(()=>{
    var expired=false;document.querySelectorAll("[data-deadline]").forEach(sp=>{
      var left=Number(sp.dataset.deadline)-window.serverNow();sp.textContent=window.formatCountdown(left);
      sp.classList.toggle("urgent",left<=60000);if(left<=0)expired=true;
    });if(expired)render(null);
  },1000);
  function needsConfirm(key,b){
    if(pendingConfirm[key]){delete pendingConfirm[key];return false}
    pendingConfirm[key]=true;var old=b.textContent;b.textContent="Yakin? Tekan lagi";
    setTimeout(()=>{delete pendingConfirm[key];if(b.isConnected)b.textContent=old},3500);return true;
  }
  function doAction(a,n,b){
    if(b){b.dataset.busy="1";b.disabled=true}
    return api("POST","/api/admin/queue/"+n+"/"+a).then(r=>{
      if(r.ok)flash(r.body.message||"Berhasil.","ok");else if(r.status!==401)flash(r.body.error||"Aksi gagal.","error");
    }).catch(()=>flash("Aksi gagal karena koneksi ke server terputus.","error"))
      .then(()=>{if(b){delete b.dataset.busy;b.disabled=!synced}});
  }
  $("queueBody").addEventListener("click",ev=>{
    var b=ev.target.closest("button[data-action]");if(!b||b.disabled)return;
    var a=b.dataset.action,n=Number(b.dataset.number);
    if((a==="hapus"||a==="aktifkan")&&needsConfirm(a+n,b))return;doAction(a,n,b);
  });
  function readNumber(i){
    var r=i.value.trim();if(!/^\d{1,4}$/.test(r)||Number(r)<1){flash("Nomor antrean harus berupa angka 1 sampai 9999.","error");return null}
    return Number(r);
  }
  $("addForm").addEventListener("submit",ev=>{
    ev.preventDefault();var n=readNumber($("addNumber"));if(n===null)return;
    api("POST","/api/admin/queue",{number:n}).then(r=>{
      if(r.ok){flash("Nomor "+r.body.number+" ditambahkan. Berikan kode karcis "+r.body.code+" kepada pasien.","ok");
        $("kNum").textContent=r.body.number;$("kCode").textContent=r.body.code;$("karcis").classList.remove("hidden");
        $("addNumber").value="";$("addNumber").focus();
      }else if(r.status!==401)flash(r.body.error||"Gagal menambahkan nomor.","error");
    }).catch(()=>flash("Gagal menambahkan karena koneksi terputus.","error"));
  });
  $("kCopy").addEventListener("click",()=>{
    var t="Nomor antrean "+$("kNum").textContent+", kode karcis "+$("kCode").textContent,
        done=()=>{$("kCopy").textContent="Tersalin";setTimeout(()=> $("kCopy").textContent="Salin",1500)},
        fallback=()=>{var r=document.createRange();r.selectNodeContents($("kCode"));var s=getSelection();s.removeAllRanges();s.addRange(r)};
    try{navigator.clipboard.writeText(t).then(done,fallback)}catch(e){fallback()}
  });
  $("callForm").addEventListener("submit",ev=>{
    ev.preventDefault();var n=readNumber($("callNumber"));if(n===null)return;
    doAction("call",n,null).then(()=> $("callNumber").value="");
  });
  token=sGet(KEY);
  if(token)api("GET","/api/admin/queue").then(r=>{
    if(r.ok){window.syncServerTime(r.body.serverTime);entries=r.body.entries||[];render(r.body);showDashboard()}
  }).catch(showDashboard);else showLogin(null);
})();