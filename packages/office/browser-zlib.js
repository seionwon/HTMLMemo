import pako from 'pako';
export {crc32} from '../../public/src/zip.js';
export const deflateSync=bytes=>pako.deflate(bytes);
export const inflateRawSync=bytes=>pako.inflateRaw(bytes);
