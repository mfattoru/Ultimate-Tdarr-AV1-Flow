module.exports = async (args) => {
  const fs=require('fs'), path=require('path');
  const log=msg=>{if(typeof args.jobLog==='function')args.jobLog(msg);else console.log(msg);};
  const dir=args.variables?.user?.safety_temp_dir, output=args.variables?.user?.safety_temp_output;
  const original=args.originalLibraryFile?._id;
  try {
    if (typeof dir==='string' && path.isAbsolute(dir) && /^tdarr-av1-[a-zA-Z0-9_-]+$/.test(path.basename(dir))) {
      if (!original || !fs.existsSync(original)) log(`[Cache cleanup] Original unavailable; retained job cache for inspection: ${dir}`);
      else {
        if (typeof output==='string' && path.dirname(output)===dir && fs.existsSync(output)) fs.unlinkSync(output);
        fs.rmSync(dir,{recursive:true,force:true});
        log(`[Cache cleanup] Removed job cache: ${dir}`);
      }
    }
  } catch(e) { log(`[Cache cleanup] Could not clean job cache: ${e.message || e}`); }
  return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
};
