// In-memory File System Access contract for unit tests; no real user folder is read.
export function memoryFolder(name='LibreMemo',control={}) {
  const children=new Map();
  const folder={kind:'directory',name,children,control,
    queryPermission:async()=>control.permission||'granted',requestPermission:async()=>control.permission||'granted',
    async getDirectoryHandle(name,{create=false}={}){
      if(!children.has(name)&&create)children.set(name,memoryFolder(name,control));
      const child=children.get(name);if(!child)throw new DOMException('Missing directory','NotFoundError');if(child.kind!=='directory')throw new DOMException('Wrong kind','TypeMismatchError');return child;
    },
    async getFileHandle(name,{create=false}={}){
      if(!children.has(name)&&create){
        let contents=new Blob([]);
        const handle={kind:'file',name,
          getFile:async()=>new File([contents],name,{lastModified:1000}),
          async createWritable(){let pending;return {write:async value=>{control.writes?.push(name);await control.onWrite?.(name);if(control.failWrite===name)throw new DOMException('Disk full','QuotaExceededError');pending=value instanceof Blob?value:new Blob([value]);},close:async()=>{if(control.failClose===name)throw Error('Interrupted close');contents=pending;},abort:async()=>{control.aborts=(control.aborts||0)+1;}};},
          replace:value=>{contents=value instanceof Blob?value:new Blob([value]);},
        };children.set(name,handle);
      }
      const child=children.get(name);if(!child)throw new DOMException('Missing file','NotFoundError');if(child.kind!=='file')throw new DOMException('Wrong kind','TypeMismatchError');return child;
    },
    async removeEntry(name,{recursive=false}={}){const child=children.get(name);if(!child)throw new DOMException('Missing entry','NotFoundError');if(child.kind==='directory'&&child.children.size&&!recursive)throw new DOMException('Directory is not empty','InvalidModificationError');children.delete(name);},async *entries(){yield* children;},
  };return folder;
}
export function memoryLocal(entries=[]) {
  const values=new Map(entries);return {values,get length(){return values.size;},key:index=>[...values.keys()][index]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
}
export async function settleUntil(condition){for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Timed out waiting for unit fixture');}
