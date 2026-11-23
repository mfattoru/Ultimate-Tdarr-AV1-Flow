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
  user.arr_corruption_blocklist_status = sourceCorruption ? 'not_attempted' : 'not_applicable';
  user.arr_corruption_delete_status = sourceCorruption ? 'not_attempted' : 'not_applicable';
  if (!isoRemoval && !sourceCorruption) {
    log('[ARR Notifier] No ISO removal or confirmed source corruption; skipping Arr action.');
    return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
  }

  const parseEnvBool = (raw, fallback = true) => {
    const val = String(raw ?? '').trim().toLowerCase();
    if (!val) return fallback;
    if (['0', 'false', 'no', 'off'].includes(val)) return false;
    if (['1', 'true', 'yes', 'on'].includes(val)) return true;
    return fallback;
  };
  const deleteCorruptEnabled = parseEnvBool(process.env?.TDARR_ARR_DELETE_CORRUPT, true);

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
  if (sourceCorruption) user.arr_corruption_search_target = target.label;

  const request = (method,urlString,apiKey,body=null) => new Promise(resolve => {
    let url;
    try { url = new URL(urlString); } catch (error) { return resolve({ok:false,statusCode:0,error}); }
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = {'X-Api-Key':apiKey,'Accept':'application/json','User-Agent':'Tdarr-ArrNotifier/1.0'};
    if (data) { headers['Content-Type']='application/json'; headers['Content-Length']=Buffer.byteLength(data); }
    else if (method === 'POST' || method === 'PUT') { headers['Content-Length'] = 0; }
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

  const normalizeArrPath = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const baseNameLower = value => path.posix.basename(normalizeArrPath(value)).toLowerCase();
  const isEventType = (record, targetType) => String(record?.eventType || '').toLowerCase() === targetType.toLowerCase();
  const positiveId = value => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const sanitizeReleaseTitle = value => String(value || '').replace(/[`\r\n]+/g, ' ').trim().slice(0, 200);
  const resolveHistoryRecords = payload => Array.isArray(payload) ? payload : (Array.isArray(payload?.records) ? payload.records : null);
  const sortNewestFirst = records => [...records].sort((a, b) => {
    const dt = (Date.parse(b?.date || '') || 0) - (Date.parse(a?.date || '') || 0);
    return dt !== 0 ? dt : (Number(b?.id || 0) - Number(a?.id || 0));
  });

  const selectUniqueMatchedFile = (files, sourceName, normalizedFullPath) => {
    const allMatches = files.filter(item => baseNameLower(item?.path || item?.relativePath || item?.relativepath || '') === sourceName);
    if (!allMatches.length) return { matched: false, file: null, allMatches: [], ambiguous: false };
    if (allMatches.length === 1) return { matched: true, file: allMatches[0], allMatches, ambiguous: false };
    const exactFull = normalizedFullPath ? allMatches.filter(item => normalizeArrPath(item?.path) === normalizedFullPath) : [];
    if (exactFull.length === 1) return { matched: true, file: exactFull[0], allMatches, ambiguous: false };
    return { matched: true, file: null, allMatches, ambiguous: true };
  };

  const findGrabbedHistoryForFile = (records, matchedFile, { normalizedFullPath, sourceName, episodeIds }) => {
    const ordered = sortNewestFirst(records);
    const imports = ordered.filter(r => isEventType(r, 'downloadFolderImported'));
    const matchedFileId = positiveId(matchedFile?.id);
    const matchedFilePath = normalizeArrPath(matchedFile?.path);
    const sceneTitle = String(matchedFile?.sceneName || '').trim().toLowerCase();

    let importRecord = matchedFileId !== null
      ? imports.find(r => String(r?.data?.fileId ?? '').trim() === String(matchedFileId))
      : null;
    if (!importRecord) {
      importRecord = imports.find(r => {
        const importedPath = normalizeArrPath(r?.data?.importedPath || r?.data?.droppedPath || '');
        if (!importedPath) return false;
        if (normalizedFullPath && importedPath === normalizedFullPath) return true;
        if (matchedFilePath && importedPath === matchedFilePath) return true;
        return baseNameLower(importedPath) === sourceName;
      }) || null;
    }
    if (!importRecord && sceneTitle) {
      importRecord = imports.find(r => String(r?.sourceTitle || '').trim().toLowerCase() === sceneTitle) || null;
    }

    const releaseTitle = sanitizeReleaseTitle(importRecord?.sourceTitle || matchedFile?.sceneName);
    const downloadId = String(importRecord?.downloadId || '').trim();
    if (!downloadId) return { status: 'no_history', grab: null, alreadyFailed: false, releaseTitle };

    const failedRecord = ordered.find(r => isEventType(r, 'downloadFailed') && String(r?.downloadId || '').trim() === downloadId);
    if (failedRecord) {
      return {
        status: 'already_blocklisted',
        grab: null,
        alreadyFailed: true,
        releaseTitle: sanitizeReleaseTitle(failedRecord?.sourceTitle || releaseTitle)
      };
    }

    const matchingGrabs = ordered.filter(r =>
      isEventType(r, 'grabbed') && String(r?.downloadId || '').trim() === downloadId && positiveId(r?.id) !== null
    );
    if (!matchingGrabs.length) return { status: 'no_history', grab: null, alreadyFailed: false, releaseTitle };

    const epScoped = Array.isArray(episodeIds) && episodeIds.length
      ? matchingGrabs.filter(g => g?.episodeId !== undefined && episodeIds.includes(Number(g.episodeId)))
      : [];
    const grab = (epScoped.length ? epScoped[0] : matchingGrabs[0]);
    return {
      status: 'found',
      grab,
      alreadyFailed: false,
      releaseTitle: sanitizeReleaseTitle(grab?.sourceTitle || releaseTitle)
    };
  };

  const blocklistAndMaybeDeleteCorruptFile = async ({ baseUrl, historyUrl, deleteUrlFor, matchedFile, matchedTitle, ambiguous, normalizedFullPath, sourceName, episodeIds }) => {
    if (ambiguous || !matchedFile) {
      user.arr_corruption_blocklist_status = 'no_history';
      user.arr_corruption_delete_status = deleteCorruptEnabled ? 'skipped_no_file_id' : 'disabled';
      log(`[ARR Notifier] Matched multiple files named '${sourceName}' in ${target.label}; skipping automatic blocklist and deletion.`);
      return false;
    }
    const historyRes = await request('GET', historyUrl, target.apiKey);
    const records = historyRes.ok ? resolveHistoryRecords(historyRes.data) : null;
    if (!historyRes.ok || !records) {
      user.arr_corruption_blocklist_status = 'history_unavailable';
      user.arr_corruption_delete_status = deleteCorruptEnabled ? 'skipped_no_blocklist' : 'disabled';
      log(`[ARR Notifier] Could not query history for '${matchedTitle}' (${target.label}, HTTP ${historyRes.statusCode}); skipping blocklist and deletion.`);
      return false;
    }

    const lookup = findGrabbedHistoryForFile(records, matchedFile, { normalizedFullPath, sourceName, episodeIds });
    if (lookup.releaseTitle) user.arr_corruption_blocklist_release = lookup.releaseTitle;

    if (lookup.alreadyFailed) {
      user.arr_corruption_blocklist_status = 'already_blocklisted';
      log(`[ARR Notifier] Release '${lookup.releaseTitle || 'unknown'}' is already blocklisted in ${target.label}.`);
    } else if (lookup.status !== 'found' || !positiveId(lookup.grab?.id)) {
      user.arr_corruption_blocklist_status = 'no_history';
      user.arr_corruption_delete_status = deleteCorruptEnabled ? 'skipped_no_blocklist' : 'disabled';
      log(`[ARR Notifier] No matching grab history found for '${sourceName}' in ${target.label}; skipping blocklist and deletion.`);
      return false;
    } else {
      const failRes = await request('POST', `${baseUrl}/api/v3/history/failed/${encodeURIComponent(lookup.grab.id)}`, target.apiKey);
      if (!failRes.ok) {
        user.arr_corruption_blocklist_status = 'failed';
        user.arr_corruption_delete_status = deleteCorruptEnabled ? 'skipped_no_blocklist' : 'disabled';
        log(`[ARR Notifier] Failed to mark history ${lookup.grab.id} failed in ${target.label} (HTTP ${failRes.statusCode}); skipping file deletion.`);
        return false;
      }
      user.arr_corruption_blocklist_status = 'blocklisted';
      log(`[ARR Notifier] Blocklisted release '${lookup.releaseTitle || `history#${lookup.grab.id}`}' in ${target.label} (HTTP ${failRes.statusCode}).`);
    }

    if (!deleteCorruptEnabled) {
      user.arr_corruption_delete_status = 'disabled';
      log(`[ARR Notifier] Corrupt file auto-deletion disabled (TDARR_ARR_DELETE_CORRUPT=false); source remains in place.`);
      return false;
    }

    const fileId = positiveId(matchedFile?.id);
    if (!fileId) {
      user.arr_corruption_delete_status = 'skipped_no_file_id';
      log(`[ARR Notifier] Blocklisted release, but Arr did not expose a file ID for '${sourceName}'; skipping file deletion.`);
      return false;
    }

    const delRes = await request('DELETE', deleteUrlFor(fileId), target.apiKey);
    if (!delRes.ok) {
      user.arr_corruption_delete_status = 'failed';
      log(`[ARR Notifier] Deleted Arr file ${fileId} in ${target.label} failed (HTTP ${delRes.statusCode}); source may remain on disk.`);
      return false;
    }
    user.arr_corruption_delete_status = 'deleted';
    log(`[ARR Notifier] Deleted corrupt file ${fileId} via ${target.label} (HTTP ${delRes.statusCode}).`);
    return true;
  };

  try {
    const baseUrl=target.host.replace(/\/+$/,'');
    const isSonarr=target.type==='sonarr';
    const type=isSonarr?'series':'movie';
    const listRes=await request('GET',`${baseUrl}/api/v3/${type}`,target.apiKey);
    let matchedItem=null;
    if(listRes.ok&&Array.isArray(listRes.data)){
      matchedItem=listRes.data.find(item=>{
        if(!item.path)return false;
        const itemPath=normalizeArrPath(item.path);
        return filePath===itemPath||filePath.startsWith(itemPath+'/');
      });
      if(!matchedItem&&contentFolder){
        const name=contentFolder.toLowerCase();
        matchedItem=listRes.data.find(item=>{
          const itemPath=normalizeArrPath(item.path);
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

    if(!targetId){
      user.arr_corruption_search_status='not_found';
      user.arr_corruption_blocklist_status='not_found';
      user.arr_corruption_delete_status=deleteCorruptEnabled?'skipped_no_blocklist':'disabled';
      log(`[ARR Notifier] Could not resolve the Arr item for '${filePath}'; no blocklist or search was sent.`);
      return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
    }
    const normalizedFullPath=normalizeArrPath(filePath);
    const sourceName=baseNameLower(filePath);
    if(isSonarr){
      const episodeFiles=await request('GET',`${baseUrl}/api/v3/episodefile?seriesId=${encodeURIComponent(targetId)}`,target.apiKey);
      if(!episodeFiles.ok||!Array.isArray(episodeFiles.data)){
        user.arr_corruption_search_status='failed';
        user.arr_corruption_blocklist_status='history_unavailable';
        user.arr_corruption_delete_status=deleteCorruptEnabled?'skipped_no_blocklist':'disabled';
        log(`[ARR Notifier] Could not list episode files for '${matchedTitle}' (${target.label}, HTTP ${episodeFiles.statusCode}); no action was sent.`);
        return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
      }
      const selection=selectUniqueMatchedFile(episodeFiles.data,sourceName,normalizedFullPath);
      const matching=selection.allMatches;
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
      if(!ids.length){
        user.arr_corruption_search_status='file_unmatched';
        user.arr_corruption_blocklist_status='file_unmatched';
        user.arr_corruption_delete_status=deleteCorruptEnabled?'skipped_no_blocklist':'disabled';
        log(`[ARR Notifier] Matched Sonarr series '${matchedTitle}' but could not map '${sourceName}' to episode IDs; no search was sent.`);
        return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
      }
      const seasonNumber=Number(selection.file?.seasonNumber);
      const seasonQuery=Number.isSafeInteger(seasonNumber)?`&seasonNumber=${encodeURIComponent(seasonNumber)}`:'';
      const deleted=await blocklistAndMaybeDeleteCorruptFile({
        baseUrl,
        historyUrl:`${baseUrl}/api/v3/history/series?seriesId=${encodeURIComponent(targetId)}${seasonQuery}`,
        deleteUrlFor:id=>`${baseUrl}/api/v3/episodefile/${encodeURIComponent(id)}`,
        matchedFile:selection.file,
        matchedTitle,
        ambiguous:selection.ambiguous,
        normalizedFullPath,
        sourceName,
        episodeIds:ids
      });
      const result=await request('POST',`${baseUrl}/api/v3/command`,target.apiKey,{name:'EpisodeSearch',episodeIds:ids});
      user.arr_corruption_search_status=result.ok?'requested':'failed';
      const tail=deleted?'Corrupt file deleted via Sonarr.':'Source remains in place.';
      log(result.ok?`[ARR Notifier] Sonarr accepted EpisodeSearch for ${ids.length} episode(s) in '${matchedTitle}' (${target.label}, HTTP ${result.statusCode}). ${tail}`:`[ARR Notifier] EpisodeSearch for '${matchedTitle}' failed with HTTP ${result.statusCode}. ${tail}`);
      return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
    }

    const movieFiles=await request('GET',`${baseUrl}/api/v3/moviefile?movieId=${encodeURIComponent(targetId)}`,target.apiKey);
    if(!movieFiles.ok||!Array.isArray(movieFiles.data)){
      user.arr_corruption_search_status='failed';
      user.arr_corruption_blocklist_status='history_unavailable';
      user.arr_corruption_delete_status=deleteCorruptEnabled?'skipped_no_blocklist':'disabled';
      log(`[ARR Notifier] Could not list movie files for '${matchedTitle}' (${target.label}, HTTP ${movieFiles.statusCode}); no action was sent.`);
      return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
    }
    const selection=selectUniqueMatchedFile(movieFiles.data,sourceName,normalizedFullPath);
    if(!selection.matched){
      user.arr_corruption_search_status='file_unmatched';
      user.arr_corruption_blocklist_status='file_unmatched';
      user.arr_corruption_delete_status=deleteCorruptEnabled?'skipped_no_blocklist':'disabled';
      log(`[ARR Notifier] Matched Radarr movie '${matchedTitle}' but could not match exact file '${sourceName}'; no search was sent.`);
      return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
    }
    const deleted=await blocklistAndMaybeDeleteCorruptFile({
      baseUrl,
      historyUrl:`${baseUrl}/api/v3/history/movie?movieId=${encodeURIComponent(targetId)}`,
      deleteUrlFor:id=>`${baseUrl}/api/v3/moviefile/${encodeURIComponent(id)}`,
      matchedFile:selection.file,
      matchedTitle,
      ambiguous:selection.ambiguous,
      normalizedFullPath,
      sourceName,
      episodeIds:null
    });
    const result=await request('POST',`${baseUrl}/api/v3/command`,target.apiKey,{name:'MoviesSearch',movieIds:[Number(targetId)]});
    user.arr_corruption_search_status=result.ok?'requested':'failed';
    const tail=deleted?'Corrupt file deleted via Radarr.':'Source remains in place.';
    log(result.ok?`[ARR Notifier] Radarr accepted MoviesSearch for '${matchedTitle}' (${target.label}, HTTP ${result.statusCode}). ${tail}`:`[ARR Notifier] MoviesSearch for '${matchedTitle}' failed with HTTP ${result.statusCode}. ${tail}`);
  } catch(error) {
    if(sourceCorruption){
      if(user.arr_corruption_search_status==='not_attempted')user.arr_corruption_search_status='failed';
      if(user.arr_corruption_blocklist_status==='not_attempted')user.arr_corruption_blocklist_status='failed';
      if(user.arr_corruption_delete_status==='not_attempted')user.arr_corruption_delete_status='failed';
    }
    else user.arr_refetch_status='failed';
    log(`[ARR Notifier] Non-fatal error communicating with ${target.label}: ${error.message||error}`);
  }
  return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
};
