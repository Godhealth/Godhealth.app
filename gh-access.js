// ============================================================
// GodHealth — shared config + access check
// Access = signed in with Supabase AND an active Stripe subscription.
// Loaded by every page (after supabase-js).
// ============================================================
(function(){
  var CONFIG={
    supabaseUrl:'https://attnnjhkjwpunlnokgvx.supabase.co',
    supabaseKey:'sb_publishable_KBSraE-BqUasxBUW5fOxbA_nK6FNITG',
    // Stripe Payment Link — $20/month subscription
    stripePaymentLink:'https://buy.stripe.com/7sY5kFegqbxfbL06Xn9bO01',
    // Optional: Stripe customer portal login link (billing.stripe.com/p/login/...) so members can cancel/update their card
    stripePortalLink:'',
    priceLabel:'$20/month'
  };

  var CACHE_KEY='gh_access_v1';
  var FRESH_MS=6*60*60*1000;        // trust a positive check for 6h before blocking on the network again
  var OFFLINE_GRACE_MS=3*24*60*60*1000; // when offline, trust a positive check for 3 days

  var client=null;
  function db(){
    if(!client){try{if(window.supabase&&supabase.createClient)client=supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabaseKey);}catch(e){}}
    return client;
  }

  function readCache(){try{var s=localStorage.getItem(CACHE_KEY);return s?JSON.parse(s):null;}catch(e){return null;}}
  function writeCache(uid,active,sub){try{localStorage.setItem(CACHE_KEY,JSON.stringify({uid:uid,active:active,sub:sub||null,ts:Date.now()}));}catch(e){}}
  function clearCache(){try{localStorage.removeItem(CACHE_KEY);}catch(e){}}

  // Returns {state:'active'|'unpaid'|'signed_out'|'error', user, sub, offline}
  async function check(){
    var c=db();
    if(!c)return offlineFallback(null);
    var session=null;
    try{var res=await c.auth.getSession();session=res&&res.data&&res.data.session;}
    catch(e){return offlineFallback(null);}
    if(!session){clearCache();return {state:'signed_out'};}
    var user=session.user;
    try{
      var r=await c.rpc('gh_subscription_status');
      if(r.error)throw r.error;
      var sub=r.data||{};
      var active=sub.active===true;
      writeCache(user.id,active,sub);
      return {state:active?'active':'unpaid',user:user,sub:sub};
    }catch(e){
      return offlineFallback(user,e);
    }
  }

  function offlineFallback(user,err){
    var cached=readCache();
    if(cached&&cached.active&&(!user||cached.uid===user.id)&&Date.now()-cached.ts<OFFLINE_GRACE_MS){
      return {state:'active',user:user,sub:cached.sub,offline:true};
    }
    return {state:user?'error':'signed_out',user:user,error:err};
  }

  function checkoutUrl(user){
    var u=new URL(CONFIG.stripePaymentLink);
    if(user&&user.id)u.searchParams.set('client_reference_id',user.id);
    if(user&&user.email)u.searchParams.set('prefilled_email',user.email);
    return u.toString();
  }

  // For sub-pages: show the page only to paying members, otherwise send to index.html
  function guardPage(){
    function show(){var s=document.getElementById('gh-hide');if(s)s.parentNode.removeChild(s);}
    function leave(){window.location.replace('index.html');}
    var cached=readCache();
    var fresh=cached&&cached.active&&Date.now()-cached.ts<FRESH_MS;
    if(fresh)show();
    check().then(function(r){
      if(r.state==='active')show();
      else leave();
    }).catch(function(){if(!fresh)leave();});
  }

  window.GH={config:CONFIG,db:db,check:check,checkoutUrl:checkoutUrl,guardPage:guardPage,clearCache:clearCache,readCache:readCache};
})();
