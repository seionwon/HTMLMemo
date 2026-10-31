const unavailable=()=>{throw Error('Desktop file access is unavailable in the read-only Office importer.');};
export const open=unavailable,readFile=unavailable,writeFile=unavailable,rename=unavailable,unlink=unavailable,createWriteStream=unavailable,pipeline=unavailable;
