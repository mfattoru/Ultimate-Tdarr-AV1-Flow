// Arr actions are deliberately gated by the source-side reason. The ISO branch
// keeps its existing rescan behavior; confirmed corruption gets a scoped search.
module.exports = async args => {
  const http = require('http');
  const https = require('https');
  const path = require('path');
  const log = message => {
    try { if (typeof args.jobLog === 'function') args.jobLog(message); else console.log(message); } catch (_) {}
  };
  if (!args.variables) args.variables = {};
  if (!args.variables.user) args.variables.user = {};
  const user = args.variables.user;
  const reason = String(user.failure_reason || '');
  const videoCorruption = /invalid nal unit(?: size| type)?|error splitting the input into nal units|missing picture in access unit|corrupt decoded frame|invalid data found when processing input|invalid bitstream|corrupt packet|packet corrupt|invalid obu|error parsing obu|invalid frame marker|invalid sync code|could not find ref with poc|concealing \d+.*(?:dc|ac|mv) errors|premature end of file|truncated (?:packet|frame)|unexpected end of file/i;
  const videoScanCorruption = /\[video guard\].*ffprobe (?:exited 0 but emitted stderr|failed \([^)]*\))/i.test(reason) && videoCorruption.test(reason);
  const verifiedDecodeCorruption = /\[source media corruption\]/i.test(reason);
  const validationAllowsSearch=!user.validation_report || (user.validation_report.outcome==='rejected' && user.validation_report.failure?.sourceCorruption===true);
  const resourceFailure=/cannot allocate memory|out of memory|no space left on device|permission denied|resource temporarily unavailable|too many open files|input\/output error|tool\/resource cause/i.test(reason);
  const sourceCorruption = validationAllowsSearch && !resourceFailure && (videoScanCorruption || verifiedDecodeCorruption);
  const isoRemoval = /disc image removed/i.test(reason);
  user.arr_refetch_status = 'not_attempted';
  user.arr_corruption_search_status = sourceCorruption ? 'not_attempted' : 'not_applicable';
  if (!isoRemoval && !sourceCorruption) {
    log('[ARR Notifier] No ISO removal or confirmed source corruption; skipping Arr action.');
    return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
  }

  __ARR_CONFIG_DECLARATION__

  const filePath = String(args.originalLibraryFile?._id || args.inputFileObj?._id || '').replace(/\\/g, '/');
  if (!filePath) {
    if (sourceCorruption) user.arr_corruption_search_status = 'not_found';
    else user.arr_refetch_status = 'not_found';
    return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
  }
  const parts = filePath.split('/').filter(Boolean);
  const lowerParts = parts.map(part => part.toLowerCase());
  const libraryRoots = [];
  for (let index=0; index<lowerParts.length; index++) {
    const part=lowerParts[index];
    if (part==='anime') libraryRoots.push({index,kind:'anime'});
    else if (['tv','shows','series'].includes(part)) libraryRoots.push({index,kind:'tv'});
    else if (['movies','movie','films'].includes(part)) libraryRoots.push({index,kind:'movie'});
  }
  const libraryRoot=libraryRoots.sort((a,b)=>a.index-b.index)[0];
  let target = null, contentFolder = '';
  if (libraryRoot?.kind==='anime') { target = ARR_CONFIG.sonarrAnime; contentFolder = parts[libraryRoot.index+1] || ''; }
  else if (libraryRoot?.kind==='tv') { target = ARR_CONFIG.sonarrTv; contentFolder = parts[libraryRoot.index+1] || ''; }
  else if (libraryRoot?.kind==='movie') { target = ARR_CONFIG.radarr; contentFolder = parts[libraryRoot.index+1] || ''; }
  if (!target?.host || !target?.apiKey) {
    if (sourceCorruption) user.arr_corruption_search_status = 'skipped_path';
    else user.arr_refetch_status = 'skipped';
    log(`[ARR Notifier] File path '${filePath}' did not match a configured Arr library; skipping action.`);
    return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
  }

  const request = (method,urlString,apiKey,body=null) => new Promise(resolve => {
    let url;
    try { url = new URL(urlString); } catch (error) { return resolve({ok:false,statusCode:0,error}); }
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = {'X-Api-Key':apiKey,'Accept':'application/json','User-Agent':'Tdarr-ArrNotifier/1.0'};
    if (data) { headers['Content-Type']='application/json'; headers['Content-Length']=Buffer.byteLength(data); }
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (typeof clearTimeout === 'function' && timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    try {
      const req = lib.request({hostname:url.hostname,port:url.port || (url.protocol==='https:'?443:80),path:url.pathname+url.search,method,headers},res=>{
        let raw='';
        res.on('data',chunk=>{raw+=chunk;});
        res.on('error',error=>finish({ok:false,statusCode:0,error}));
        res.on('end',()=>{let parsed=null;try{if(raw)parsed=JSON.parse(raw);}catch(_){}finish({ok:res.statusCode>=200&&res.statusCode<300,statusCode:res.statusCode,data:parsed});});
      });
      req.on('error',error=>finish({ok:false,statusCode:0,error}));
      if (typeof setTimeout === 'function') {
        timer = setTimeout(()=>{try{req.destroy();}catch(_){}finish({ok:false,statusCode:0,timeout:true});},10000);
      }
      if (typeof req.setTimeout === 'function') {
        req.setTimeout(10000,()=>{try{req.destroy();}catch(_){}finish({ok:false,statusCode:0,timeout:true});});
      }
      if(data)req.write(data);
      req.end();
    } catch (error) {
      finish({ok:false,statusCode:0,error});
    }
  });

  try {
    const baseUrl=target.host.replace(/\/+$/,'');
    const isSonarr=target.type==='sonarr';
    const type=isSonarr?'series':'movie';
    const listRes=await request('GET',`${baseUrl}/api/v3/${type}`,target.apiKey);
    let matchedItem=null;
    if(listRes.ok&&Array.isArray(listRes.data)){
      matchedItem=listRes.data.find(item=>{
        if(!item.path)return false;
        const itemPath=String(item.path).replace(/\\/g,'/').replace(/\/+$/,'');
        return filePath===itemPath||filePath.startsWith(itemPath+'/');
      });
      if(!matchedItem&&contentFolder){
        const name=contentFolder.toLowerCase();
        matchedItem=listRes.data.find(item=>{
          const itemPath=String(item.path||'').replace(/\\/g,'/').replace(/\/+$/,'');
          return (itemPath.split('/').pop()||'').toLowerCase()===name;
        });
      }
    }
    let targetId=matchedItem?.id||null;
    let matchedTitle=matchedItem?.title||contentFolder||path.posix.basename(filePath);
    if(!targetId){
      const parseUrl=`${baseUrl}/api/v3/parse?title=${encodeURIComponent(path.posix.basename(filePath))}`;
      const parseRes=await request('GET',parseUrl,target.apiKey);
      if(parseRes.ok&&parseRes.data){
        if(isSonarr&&parseRes.data.series?.id){targetId=parseRes.data.series.id;matchedTitle=parseRes.data.series.title||matchedTitle;}
        else if(!isSonarr&&(parseRes.data.movie?.id||parseRes.data.movie?.movieFile?.movieId)){targetId=parseRes.data.movie?.id||parseRes.data.movie?.movieFile?.movieId;matchedTitle=parseRes.data.movie?.title||matchedTitle;}
      }
    }

    if(isoRemoval){
      if(!targetId){user.arr_refetch_status='not_found';log(`[ARR Notifier] Could not resolve the ${isSonarr?'series':'movie'} for '${filePath}'; no rescan was sent.`);}
      else {
        const cmdName=isSonarr?'RescanSeries':'RescanMovie';
        const cmdBody=isSonarr?{name:'RescanSeries',seriesId:targetId}:{name:'RescanMovie',movieId:targetId};
        const result=await request('POST',`${baseUrl}/api/v3/command`,target.apiKey,cmdBody);
        user.arr_refetch_status=result.ok?'requested':'failed';
        log(result.ok?`[ARR Notifier] Triggered ${cmdName} for '${matchedTitle}' (${target.label}, HTTP ${result.statusCode}).`:`[ARR Notifier] ${cmdName} for '${matchedTitle}' failed with HTTP ${result.statusCode}.`);
      }
      return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
    }

    if(!targetId){user.arr_corruption_search_status='not_found';log(`[ARR Notifier] Could not resolve the Arr item for '${filePath}'; no search was sent.`);return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};}
    const sourceName=path.posix.basename(filePath).toLowerCase();
    if(isSonarr){
      const episodeFiles=await request('GET',`${baseUrl}/api/v3/episodefile?seriesId=${encodeURIComponent(targetId)}`,target.apiKey);
      if(!episodeFiles.ok||!Array.isArray(episodeFiles.data)){user.arr_corruption_search_status='failed';log(`[ARR Notifier] Could not list episode files for '${matchedTitle}' (${target.label}, HTTP ${episodeFiles.statusCode}); no search was sent.`);return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};}
      const matching=episodeFiles.data.filter(item=>path.posix.basename(String(item.path||item.relativePath||item.relativepath||'').replace(/\\/g,'/')).toLowerCase()===sourceName);
      let ids=[...new Set(matching.flatMap(item=>Array.isArray(item.episodeIds)?item.episodeIds:Array.isArray(item.episodes)?item.episodes.map(episode=>episode?.id):[]).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))];
      if(!ids.length){
        const seasonMatch=sourceName.match(/(?:^|[^a-z0-9])s(\d{1,2})e(\d{1,3})(?:(?:[ ._-]*e)(\d{1,3}))*/i);
        if(seasonMatch){
          const season=Number(seasonMatch[1]);
          const numbers=[...seasonMatch[0].matchAll(/e(\d{1,3})/ig)].map(match=>Number(match[1]));
          const episodes=await request('GET',`${baseUrl}/api/v3/episode?seriesId=${encodeURIComponent(targetId)}&seasonNumber=${season}`,target.apiKey);
          if(episodes.ok&&Array.isArray(episodes.data))ids=[...new Set(episodes.data.filter(episode=>numbers.includes(Number(episode.episodeNumber))).map(episode=>Number(episode.id)).filter(id=>Number.isSafeInteger(id)&&id>0))];
        }
      }
      if(!ids.length){user.arr_corruption_search_status='file_unmatched';log(`[ARR Notifier] Matched Sonarr series '${matchedTitle}' but could not map '${sourceName}' to episode IDs; no search was sent.`);return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};}
      const result=await request('POST',`${baseUrl}/api/v3/command`,target.apiKey,{name:'EpisodeSearch',episodeIds:ids});
      user.arr_corruption_search_status=result.ok?'requested':'failed';
      if(result.ok)user.arr_corruption_search_target=target.label;
      log(result.ok?`[ARR Notifier] Sonarr accepted EpisodeSearch for ${ids.length} episode(s) in '${matchedTitle}' (${target.label}, HTTP ${result.statusCode}). Source remains in place.`:`[ARR Notifier] EpisodeSearch for '${matchedTitle}' failed with HTTP ${result.statusCode}. Source remains in place.`);
      return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
    }

    const movieFiles=await request('GET',`${baseUrl}/api/v3/moviefile?movieId=${encodeURIComponent(targetId)}`,target.apiKey);
    if(!movieFiles.ok||!Array.isArray(movieFiles.data)){user.arr_corruption_search_status='failed';log(`[ARR Notifier] Could not list movie files for '${matchedTitle}' (${target.label}, HTTP ${movieFiles.statusCode}); no search was sent.`);return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};}
    const exactFile=movieFiles.data.some(item=>path.posix.basename(String(item.path||item.relativePath||item.relativepath||'').replace(/\\/g,'/')).toLowerCase()===sourceName);
    if(!exactFile){user.arr_corruption_search_status='file_unmatched';log(`[ARR Notifier] Matched Radarr movie '${matchedTitle}' but could not match exact file '${sourceName}'; no search was sent.`);return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};}
    const result=await request('POST',`${baseUrl}/api/v3/command`,target.apiKey,{name:'MoviesSearch',movieIds:[Number(targetId)]});
    user.arr_corruption_search_status=result.ok?'requested':'failed';
    if(result.ok)user.arr_corruption_search_target=target.label;
    log(result.ok?`[ARR Notifier] Radarr accepted MoviesSearch for '${matchedTitle}' (${target.label}, HTTP ${result.statusCode}). Source remains in place.`:`[ARR Notifier] MoviesSearch for '${matchedTitle}' failed with HTTP ${result.statusCode}. Source remains in place.`);
  } catch(error) {
    if(sourceCorruption)user.arr_corruption_search_status='failed';
    else user.arr_refetch_status='failed';
    log(`[ARR Notifier] Non-fatal error communicating with ${target.label}: ${error.message||error}`);
  }
  return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
};
