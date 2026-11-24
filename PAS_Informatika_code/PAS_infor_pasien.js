(function () {
  "use strict";

  var L=window.LABELS,Sound=window.AntreanSound,$=id=>document.getElementById(id);
  var my=null,live=null,current=null,lateMs=600000,reminded={},
      originalTitle=document.title,titleTimer=null,wakeLock=null;

  function sGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
  function sSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
  function sDel(k){try{localStorage.removeItem(k)}catch(e){}}

  function getHandled(n){
    try{return JSON.parse(sGet("antrean.handledCall."+n))||{bootId:"",callId:0}}
    catch(e){return {bootId:"",callId:0}}
  }
  function setHandled(n,b,c){sSet("antrean.handledCall."+n,JSON.stringify({bootId:b,callId:c}))}
  function alreadyHandled(n,b,c){
    var h=getHandled(n);return h.bootId===b&&c<=h.callId;
  }

  function showMsg(e,t,k){e.textContent=t;e.className="message "+(k||"info");e.classList.remove("hidden")}
  function hideMsg(e){e.classList.add("hidden")}
  function eff(e){
    return e.callStatus==="dipanggil"&&e.deadlineAt&&window.serverNow()>=e.deadlineAt?"hangus":e.callStatus;
  }

  function setConn(st){
    var e=$("conn");e.classList.remove("hidden","online","offline");
    if(st==="online"){e.classList.add("online");e.textContent="Terhubung"}
    else if(st==="offline"){e.classList.add("offline");e.textContent="Terputus"}
    else e.textContent="Menghubungkan…";
    $("offlineBanner").classList.toggle("hidden",st==="online"||!my);
    updateButtons();
  }

  function updateButtons(){
    var online=live&&live.isOpen(),st=current?eff(current):null,
        closed=st!=="menunggu"&&st!=="dipanggil";
    document.querySelectorAll(".att-btn").forEach(b=>{
      b.disabled=!online||closed||b.dataset.busy==="1";
    });
  }

  function render(e){
    current=e;
    if(e.lateMs){lateMs=e.lateMs;$("lateRule").textContent=Math.round(lateMs/60000)+" menit"}
    var st=eff(e);
    $("ticketNumber").textContent=e.number;
    var badge=$("callBadge");badge.className="badge call-"+st;badge.textContent=L.call[st]||st;
    $("aheadCount").textContent=st==="menunggu"?e.aheadCount:"-";
    $("lastCalled").textContent=e.lastCalledNumber||"-";
    $("deadlineBox").classList.toggle("hidden",st!=="dipanggil");
    $("deadlineAt").textContent=window.formatTime(e.deadlineAt);
    if(st!=="dipanggil")hideMsg($("warnMsg"));

    var note=$("calledNote");
    if(st==="dipanggil")showMsg(note,"Dipanggil"+(e.callCount>1?" "+e.callCount+" kali":"")+", terakhir pukul "+window.formatTime(e.calledAt)+".","info");
    else if(st==="dilayani")showMsg(note,"Anda sedang dilayani. Terima kasih sudah datang tepat waktu.","ok");
    else if(st==="selesai")showMsg(note,"Antrean Anda sudah selesai. Terima kasih.","ok");
    else if(st==="hangus")showMsg(note,"Nomor Anda hangus karena tidak hadir dalam "+Math.round(lateMs/60000)+" menit setelah dipanggil. Silakan hubungi petugas pendaftaran.","error");
    else hideMsg(note);

    var att=$("attBadge");att.className="badge att-"+e.attendance;
    att.textContent=L.attendance[e.attendance]||e.attendance;
    $("attTime").textContent=e.attendanceUpdatedAt?"Disimpan pukul "+window.formatTime(e.attendanceUpdatedAt):"";
    document.querySelectorAll(".att-btn").forEach(b=>b.classList.toggle("selected",b.dataset.status===e.attendance));
    if(st!=="dipanggil")hideAlert();
    tick();updateButtons();
  }

  function tick(){
    if(!current)return;
    var st=eff(current);
    if(st==="dipanggil"){
      var left=current.deadlineAt-window.serverNow(),t=window.formatCountdown(left);
      $("countdown").textContent=t;$("callAlertCd").textContent=t;
      $("deadlineBox").classList.toggle("urgent",left<=60000);

      [[300000,"5 menit"],[60000,"1 menit"]].forEach(w=>{
        var key=current.deadlineAt+":"+w[0];
        if(left<=w[0]&&left>w[0]-15000&&!reminded[key]){
          reminded[key]=true;
          showMsg($("warnMsg"),"Peringatan: sisa waktu "+w[1]+". Segera ke loket atau nomor Anda hangus.","warn");
          if(navigator.vibrate)try{navigator.vibrate([300,150,300])}catch(e){}
          if(Sound.enabled)Sound.warn();
        }
      });
    }else if($("callBadge").textContent!==(L.call[st]||st))render(current);
  }
  setInterval(tick,1000);

  function showAlert(n,withSound,missed){
    $("callAlertNumber").textContent=n;
    $("callAlertTitle").textContent=missed?"Nomor antrean Anda sudah dipanggil":"Nomor antrean Anda dipanggil";
    var alert=$("callAlert"),audio=$("callAlertAudio");
    alert.classList.toggle("silent",!withSound);alert.classList.remove("hidden");
    audio.classList.add("hidden");
    var fail=t=>{audio.textContent=t;audio.classList.remove("hidden")};
    clearInterval(titleTimer);
    var on=false;
    titleTimer=setInterval(()=>document.title=(on=!on)?"🔔 DIPANGGIL – "+n:originalTitle,800);
    tick();
    if(missed){fail("Panggilan terjadi saat halaman tidak terhubung, jadi tidak dibunyikan ulang.");return}
    if(navigator.vibrate)try{navigator.vibrate([400,200,400,200,400,200,400])}catch(e){}
    if(!Sound.supported)return fail("Browser ini tidak mendukung bunyi web. Perhatikan pesan di layar.");
    if(!Sound.enabled)return fail("Bunyi belum diaktifkan di HP ini, jadi panggilan hanya tampil di layar.");
    Sound.playCall(5).then(ok=>{if(!ok)fail("Bunyi gagal diputar oleh browser. Perhatikan pesan di layar.")});
  }

  function hideAlert(){
    if($("callAlert").classList.contains("hidden"))return;
    $("callAlert").classList.add("hidden");Sound.stop();
    clearInterval(titleTimer);document.title=originalTitle;
  }

  function keepAwake(){
    if(!("wakeLock" in navigator)||document.visibilityState!=="visible"||!my||wakeLock)return;
    navigator.wakeLock.request("screen").then(w=>{
      wakeLock=w;w.addEventListener("release",()=>wakeLock=null);
    }).catch(()=>{});
  }
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible")keepAwake();
  });

  function onServerMessage(m){
    if(typeof m.serverTime==="number")window.syncServerTime(m.serverTime);
    if(m.type==="call"&&my&&m.number===my.number){
      if(alreadyHandled(my.number,m.bootId,m.callId))return;
      setHandled(my.number,m.bootId,m.callId);
      if(current)current.deadlineAt=m.deadlineAt;
      showAlert(m.number,true,false);
    }else if(m.type==="state"&&m.entry&&my&&m.entry.number===my.number){
      var e=m.entry;window.syncServerTime(e.serverTime);render(e);
      if(e.callId&&eff(e)==="dipanggil"&&!alreadyHandled(my.number,e.bootId,e.callId)){
        setHandled(my.number,e.bootId,e.callId);showAlert(e.number,false,true);
      }
    }else if(m.type==="not_found"||m.type==="denied"){
      goBackToEntry(m.type==="denied"
        ?"Karcis nomor "+m.number+" sudah diganti atau kodenya tidak cocok lagi. Masukkan kode karcis yang baru."
        :"Nomor antrean "+m.number+" sudah dihapus dari daftar oleh petugas.");
    }
  }

  function post(path,body){
    return fetch(path,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body),cache:"no-store"
    }).then(r=>r.json().catch(()=>({})).then(d=>({
      status:r.status,ok:r.ok&&d.ok,body:d
    })));
  }

  function openTicket(e,code){
    my={number:e.number,code:code};
    sSet("antrean.ticket",JSON.stringify(my));
    window.syncServerTime(e.serverTime);
    $("enterView").classList.add("hidden");
    $("ticketView").classList.remove("hidden");
    hideMsg($("attMsg"));render(e);

    if(eff(e)==="dipanggil"&&e.callId&&!alreadyHandled(my.number,e.bootId,e.callId)){
      setHandled(my.number,e.bootId,e.callId);showAlert(e.number,false,true);
    }
    if(!live)live=new window.LiveSocket({
      onOpen:()=>{if(my)live.send({type:"hello_patient",number:my.number,code:my.code})},
      onMessage:onServerMessage,onStatus:setConn
    });
    live.start();
  }

  function goBackToEntry(message){
    if(live)live.stop();
    my=null;current=null;hideAlert();sDel("antrean.ticket");
    if(wakeLock){try{wakeLock.release()}catch(e){}wakeLock=null}
    $("ticketView").classList.add("hidden");
    $("enterView").classList.remove("hidden");
    $("conn").classList.add("hidden");
    $("offlineBanner").classList.add("hidden");
    if(message)showMsg($("enterMsg"),message,"error");
    else hideMsg($("enterMsg"));
  }

  $("enterForm").addEventListener("submit",ev=>{
    ev.preventDefault();
    var msgEl=$("enterMsg"),raw=$("numberInput").value.trim(),
        code=$("codeInput").value.toUpperCase().replace(/[\s-]/g,"");
    if(!/^\d{1,4}$/.test(raw)||Number(raw)<1)
      return showMsg(msgEl,"Nomor antrean harus berupa angka 1 sampai 9999.","error");
    if(!/^[A-Z0-9]{6}$/.test(code))
      return showMsg(msgEl,"Kode karcis terdiri dari 6 huruf/angka, contoh K7QF4M. Periksa kembali karcis Anda.","error");

    var btn=$("enterBtn");btn.disabled=true;
    showMsg(msgEl,"Memeriksa karcis…","info");
    post("/api/patient/open",{number:Number(raw),code}).then(r=>{
      if(r.ok){hideMsg(msgEl);$("codeInput").value="";openTicket(r.body.entry,code)}
      else showMsg(msgEl,r.body.error||"Karcis tidak dapat diperiksa.","error");
    }).catch(()=>showMsg(msgEl,"Tidak dapat terhubung ke server. Periksa koneksi internet, lalu coba lagi.","error"))
      .then(()=>btn.disabled=false);
  });

  document.querySelectorAll(".att-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      if(!my)return;
      var status=btn.dataset.status,msgEl=$("attMsg");
      btn.dataset.busy="1";updateButtons();
      showMsg(msgEl,"Menyimpan…","info");
      post("/api/patient/attendance",{number:my.number,code:my.code,status}).then(r=>{
        if(r.ok){
          render(r.body.entry);
          showMsg(msgEl,"Tersimpan: "+L.attendance[status]+". Dokter sudah dapat melihatnya.","ok");
        }else showMsg(msgEl,r.body.error||"Gagal menyimpan. Coba lagi.","error");
      }).catch(()=>showMsg(msgEl,"Gagal menyimpan karena koneksi terputus. Pilihan sebelumnya tetap berlaku.","error"))
        .then(()=>{btn.dataset.busy="";updateButtons()});
    });
  });

  $("soundBtn").addEventListener("click",()=>{
    var msgEl=$("soundMsg");
    if(!Sound.supported)return showMsg(msgEl,"Browser ini tidak mendukung Web Audio. Panggilan hanya akan tampil di layar.","error");
    Sound.enable().then(ok=>{
      if(ok){
        $("soundBtn").textContent="Bunyi aktif · tekan untuk tes lagi";
        showMsg(msgEl,"Bunyi aktif. Jika bunyi tes terdengar, HP siap berbunyi saat nomor Anda dipanggil.","ok");
        keepAwake();
      }else showMsg(msgEl,"Bunyi belum bisa diaktifkan. Coba tekan lagi, periksa volume, atau gunakan browser lain.","error");
    });
  });

  $("callAlertClose").addEventListener("click",hideAlert);
  $("changeBtn").addEventListener("click",()=>{
    goBackToEntry(null);$("numberInput").focus();
  });

  var saved=null;
  try{saved=JSON.parse(sGet("antrean.ticket")||"null")}catch(e){}
  if(saved&&saved.number&&saved.code){
    post("/api/patient/open",{number:saved.number,code:saved.code}).then(r=>{
      if(r.ok)openTicket(r.body.entry,saved.code);
      else{
        sDel("antrean.ticket");
        if(r.status!==429)showMsg($("enterMsg"),"Karcis tersimpan sudah tidak berlaku. Masukkan nomor dan kode karcis.","error");
      }
    }).catch(()=>{
      $("numberInput").value=saved.number;
      showMsg($("enterMsg"),"Tidak dapat terhubung ke server. Masukkan kode karcis lalu coba lagi.","error");
    });
  }
})();