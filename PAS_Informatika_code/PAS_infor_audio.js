(function () {
  "use strict";
  var AC=window.AudioContext||window.webkitAudioContext,ctx=null,master=null,stopTimer=null;

  var Sound=window.AntreanSound={
    supported:!!AC,enabled:false,playCount:0,

    enable:function(){
      if(!AC)return Promise.resolve(false);
      try{
        if(!ctx)ctx=new AC();
        var src=ctx.createBufferSource();
        src.buffer=ctx.createBuffer(1,1,22050);
        src.connect(ctx.destination);src.start(0);
      }catch(e){return Promise.resolve(false)}
      return Promise.resolve(ctx.resume&&ctx.resume()).then(function(){
        Sound.enabled=ctx.state==="running";
        if(Sound.enabled)Sound.playTest();
        return Sound.enabled;
      }).catch(function(){Sound.enabled=false;return false});
    },

    isRunning:function(){return !!ctx&&ctx.state==="running"},

    _master:function(){
      if(!master){master=ctx.createGain();master.gain.value=.9;master.connect(ctx.destination)}
      return master;
    },

    _tone:function(freq,start,duration,volume){
      var osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type="sine";osc.frequency.setValueAtTime(freq,start);
      gain.gain.setValueAtTime(.0001,start);
      gain.gain.exponentialRampToValueAtTime(volume,start+.02);
      gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
      osc.connect(gain);gain.connect(Sound._master());
      osc.start(start);osc.stop(start+duration+.05);
    },

    playTest:function(){
      if(!Sound.isRunning())return false;
      var t=ctx.currentTime+.05;
      Sound._tone(880,t,.18,.5);
      Sound._tone(1175,t+.22,.25,.5);
      return true;
    },

    playCall:function(times){
      times=times||5;
      if(!ctx)return Promise.resolve(false);
      return Promise.resolve(ctx.state==="running"?null:ctx.resume&&ctx.resume()).then(function(){
        if(ctx.state!=="running")return false;
        Sound.stop();
        var t=ctx.currentTime+.05;
        for(var i=0;i<times;i++){
          var s=t+i*1.6;
          Sound._tone(988,s,.5,.8);
          Sound._tone(784,s+.45,.8,.8);
        }
        Sound.playCount++;
        stopTimer=setTimeout(function(){master=null},times*1600+1500);
        return true;
      }).catch(function(){return false});
    },

    warn:function(){
      if(!ctx)return Promise.resolve(false);
      return Promise.resolve(ctx.state==="running"?null:ctx.resume&&ctx.resume()).then(function(){
        if(ctx.state!=="running")return false;
        var t=ctx.currentTime+.05;
        for(var i=0;i<3;i++)Sound._tone(1320,t+i*.3,.18,.7);
        return true;
      }).catch(function(){return false});
    },

    stop:function(){
      clearTimeout(stopTimer);
      if(master){
        try{master.gain.setValueAtTime(0,ctx.currentTime);master.disconnect()}catch(e){}
        master=null;
      }
    }
  };
})();