module.exports = async (args) => {
  const fs=require('fs'), path=require('path');
  const log = msg => { if (typeof args.jobLog === 'function') args.jobLog(msg); else console.log(msg); };
  try {
    const saved=args.variables?.user?.original_snapshot;
    const original=args.originalLibraryFile?._id;
    const working=args.inputFileObj?._id;
    if (!saved || !original || !working || saved.path!==original) throw new Error('Missing original identity or working file');
    const s=fs.statSync(original,{bigint:true});
    if (!s.isFile() || fs.realpathSync(original)!==saved.realPath || String(s.dev)!==saved.dev || String(s.ino)!==saved.ino || String(s.size)!==saved.size || String(s.mtimeNs)!==saved.mtimeNs || String(s.ctimeNs)!==saved.ctimeNs) throw new Error('Original changed since job began');
    const dest=path.join(path.dirname(original),path.basename(working));
    if (dest!==original) {
      let occupied=true;
      try { fs.lstatSync(dest); } catch(e) { if(e.code==='ENOENT') occupied=false; else throw e; }
      if (occupied) throw new Error(`Replacement destination already exists: ${dest}`);
    }
    return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
  } catch(e) {
    log(`[Original guard] ${e.message || e}. Original will not be replaced.`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
};
