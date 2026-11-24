(function () {
  "use strict";
  function LiveSocket(o){
    this.onOpen=o.onOpen||function(){};
    this.onMessage=o.onMessage||function(){};
    this.onStatus=o.onStatus||function(){};
    this.stopped=true;this.pollTimer=null;this.status="connecting";
    this.mode=null;this.adminToken="";this.patientNum=0;this.patientCode="";
    var s=this;
    window.addEventListener("online",()=>s.reconnectNow());
    window.addEventListener("offline",()=>{if(!s.stopped)s._setStatus("offline")});
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")s.checkAlive()});
  }
  LiveSocket.prototype._setStatus=function(s){
    if(this.status!==s){this.status=s;this.onStatus(s)}
  };
  LiveSocket.prototype.start=function(){
    var s=this;this.stopped=false;this._setStatus("connecting");
    fetch("/healthz",{cache:"no-store"}).then(r=>{
      if(!r.ok)throw Error();
      if(s.stopped)return;
      s._setStatus("online");s.onOpen();s._startPolling();
    }).catch(()=>{
      if(s.stopped)return;
      s._setStatus("offline");setTimeout(()=>{if(!s.stopped)s.start()},2000);
    });
  };
  LiveSocket.prototype.stop=function(){
    this.stopped=true;clearInterval(this.pollTimer);this.pollTimer=null;
  };
  LiveSocket.prototype.send=function(o){
    if(!o||typeof o!=="object")return false;
    if(o.type==="ping")return true;
    if(o.type==="auth"&&o.token){
      this.mode="admin";this.adminToken=o.token;this._fetchNow();return true;
    }
    if((o.type==="subscribe"||o.type==="open"||o.number)&&o.number&&o.code){
      this.mode="patient";this.patientNum=o.number;this.patientCode=o.code;
      this._fetchNow();return true;
    }
    return false;
  };
  LiveSocket.prototype.isOpen=function(){return !this.stopped&&this.status==="online"};
  LiveSocket.prototype._startPolling=function(){
    var s=this;clearInterval(this.pollTimer);
    this.pollTimer=setInterval(()=>s._fetchNow(),1200);
  };
  LiveSocket.prototype._fetchNow=function(){
    var s=this;if(this.stopped)return;
    var admin=this.mode==="admin"&&this.adminToken,
        patient=this.mode==="patient"&&this.patientNum&&this.patientCode,
        url=admin?"/api/admin/queue":patient?
          "/api/patient/state?number="+encodeURIComponent(this.patientNum)+"&code="+encodeURIComponent(this.patientCode):
          "/healthz",
        opts={cache:"no-store"};
    if(admin)opts.headers={Authorization:"Bearer "+this.adminToken};
    fetch(url,opts).then(r=>{
      if(admin&&r.status===401){s.onMessage({type:"error",error:"Sesi dokter berakhir."});return null}
      if(!r.ok)throw Error();
      return r.json().catch(()=>({}));
    }).then(d=>{
      if(!d||s.stopped)return;
      s._setStatus("online");
      if(admin){d.type="queue";s.onMessage(d)}
      else if(patient)s.onMessage({type:"state",entry:d.entry});
    }).catch(()=>{if(!s.stopped)s._setStatus("offline")});
  };
  LiveSocket.prototype.checkAlive=function(){if(!this.stopped)this._fetchNow()};
  LiveSocket.prototype.reconnectNow=function(){if(!this.stopped)this._fetchNow()};
  window.LiveSocket=LiveSocket;

  window.LABELS={
    attendance:{belum_konfirmasi:"Belum memberi kabar",di_area:"Sudah di area rumah sakit",perjalanan:"Sedang dalam perjalanan",tidak_datang:"Tidak bisa datang"},
    call:{menunggu:"Menunggu panggilan",dipanggil:"Dipanggil",dilayani:"Sedang dilayani",selesai:"Selesai",hangus:"Hangus (terlambat)"}
  };

  var offset=0;
  window.syncServerTime=t=>{if(typeof t==="number"&&t>0)offset=t-Date.now()};
  window.serverNow=()=>Date.now()+offset;
  window.formatCountdown=ms=>{
    var s=Math.ceil(Math.max(0,ms)/1000),m=Math.floor(s/60),r=s%60;
    return (m<10?"0":"")+m+":"+(r<10?"0":"")+r;
  };
  window.formatTime=ms=>{
    if(!ms)return "-";
    var d=new Date(ms),p=n=>(n<10?"0":"")+n;
    return p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
  };
})();