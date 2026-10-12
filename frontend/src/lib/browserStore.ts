import type { MessageItem, SessionInfo, SourceItem, Step } from "../types";

// Upgrade the existing document database in place, preserving its vectors.
const DB_NAME="policy-radar-documents",DB_VERSION=2;
export const MAX_BACKUP_BYTES=50_000_000;
export interface LocalSession {session_id:string;created_at:string;messages:(MessageItem&{request_id?:string})[]}
export interface LocalArtifact {key:string;session_id:string;kind:"document"|"research";source_url?:string;saved_at?:string;data:Record<string,unknown>}
export interface LocalDocument {key:string;session_id:string;model:string;doc_key:string;text_hash:string;chunks:{text:string;vector:Float32Array;doc_key:string;source_url:string;pdf_url?:string}[]}
const stores=["sessions","artifacts","documents"] as const;

export function storageError(error:unknown):Error {
  const quota=error instanceof DOMException&&error.name==="QuotaExceededError";
  const message=quota?"Browser storage is full. This change was not saved. Export your saved data, then clear space and try again.":"Browser storage is unavailable. This change was not saved. Allow site storage and try again; existing data has not been deleted.";
  if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("policy-storage-error",{detail:message}));
  return new Error(message,{cause:error});
}
export async function localDatabase():Promise<IDBDatabase> {
  try {return await new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);let settled=false;
    const timeout=setTimeout(()=>{settled=true;reject(new Error("Storage did not open. Close other Policy Radar tabs and retry."));},4000);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains("documents")){const store=db.createObjectStore("documents",{keyPath:"key"});store.createIndex("session","session_id");}
      if(!db.objectStoreNames.contains("sessions"))db.createObjectStore("sessions",{keyPath:"session_id"});
      if(!db.objectStoreNames.contains("artifacts")){const store=db.createObjectStore("artifacts",{keyPath:"key"});store.createIndex("session","session_id");store.createIndex("url","source_url");}
    };
    req.onsuccess=()=>{clearTimeout(timeout);if(settled){req.result.close();return;}req.result.onversionchange=()=>req.result.close();resolve(req.result);};
    req.onerror=()=>{clearTimeout(timeout);reject(req.error);};
  });}catch(error){throw storageError(error);}
}
export async function localTransaction<T>(names:string|string[],mode:IDBTransactionMode,action:(tx:IDBTransaction,setResult:(value:T)=>void)=>void):Promise<T> {
  const db=await localDatabase();
  try{return await new Promise<T>((resolve,reject)=>{
    const tx=db.transaction(names,mode);let result:T;
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||new Error("Storage transaction aborted."));tx.onerror=()=>reject(tx.error);
    try{action(tx,value=>{result=value;});}catch(error){tx.abort();reject(error);}
  });}catch(error){throw storageError(error);}finally{db.close();}
}
export async function createLocalSession() {
  const session:LocalSession={session_id:crypto.randomUUID(),created_at:new Date().toISOString(),messages:[]};
  await localTransaction("sessions","readwrite",tx=>{tx.objectStore("sessions").add(session);});
  return {session_id:session.session_id};
}
export async function getLocalSession(id:string):Promise<LocalSession> {
  const session=await localTransaction<LocalSession|undefined>("sessions","readonly",(tx,set)=>{const req=tx.objectStore("sessions").get(id);req.onsuccess=()=>set(req.result);});
  if(!session)throw new Error("Saved conversation was not found in this browser.");return session;
}
export async function listLocalSessions():Promise<{sessions:SessionInfo[]}> {
  const rows=await localTransaction<LocalSession[]>("sessions","readonly",(tx,set)=>{const req=tx.objectStore("sessions").getAll();req.onsuccess=()=>set(req.result);});
  return {sessions:rows.map(row=>({session_id:row.session_id,created_at:row.created_at,title:row.messages.find(m=>m.role==="user")?.content.slice(0,200)||null,last_message:row.messages.at(-1)?.content.slice(0,300)||null,last_message_at:row.messages.at(-1)?.created_at||null})).sort((a,b)=>(b.last_message_at||b.created_at).localeCompare(a.last_message_at||a.created_at))};
}
export async function changeSession<T>(id:string,change:(row:LocalSession)=>T):Promise<T> {
  let missing=false;
  const result=await localTransaction<T>("sessions","readwrite",(tx,set)=>{
    const store=tx.objectStore("sessions"),req=store.get(id);
    req.onsuccess=()=>{if(!req.result){missing=true;return;}set(change(req.result));store.put(req.result);};
  });
  if(missing)throw new Error("Saved conversation was not found in this browser.");return result;
}
export async function beginInquiry(id:string,requestId:string,message:string) {
  if(!message.trim()||message.length>20_000)throw new Error("Use an inquiry between 1 and 20,000 characters.");
  return changeSession(id,row=>{
    if(!row.messages.some(m=>m.request_id===requestId&&m.role==="user"))row.messages.push({id:(row.messages.at(-1)?.id||0)+1,role:"user",content:message,request_id:requestId,created_at:new Date().toISOString()});
    // Keep complete durable history locally; send only recent, bounded text.
    const recent:MessageItem[]=[];let bytes=0;
    for(const item of row.messages.slice(-30).reverse()) {const content=item.content.slice(-20_000),size=new TextEncoder().encode(content).length;if(bytes+size>120_000)break;bytes+=size;recent.unshift({...item,content});}
    return {messages:recent.map(({role,content})=>({role,content}))};
  });
}
export async function finishInquiry(id:string,requestId:string,answer:string,sources:SourceItem[],steps:Step[],model:string) {
  if(answer.length>80_000)throw new Error("The answer is too large to save.");
  await changeSession(id,row=>{if(!row.messages.some(m=>m.request_id===requestId&&m.role==="assistant"))row.messages.push({id:(row.messages.at(-1)?.id||0)+1,request_id:requestId,role:"assistant",content:answer,created_at:new Date().toISOString(),sources:clean(sources) as SourceItem[],steps:clean(steps) as Step[],model});});
  return {saved:true};
}
export async function deleteLocalSession(id:string) {
  await localTransaction([...stores],"readwrite",tx=>{
    tx.objectStore("sessions").delete(id);
    for(const name of ["documents","artifacts"]){const store=tx.objectStore(name),req=store.index("session").openCursor(id);req.onsuccess=()=>{const cursor=req.result;if(cursor){cursor.delete();cursor.continue();}};}
  });
}
export async function saveArtifact(row:LocalArtifact) {await localTransaction("artifacts","readwrite",tx=>{tx.objectStore("artifacts").put({...row,data:clean(row.data) as Record<string,unknown>});});}
export async function cachedDocument(url:string) {
  return localTransaction<LocalArtifact|undefined>("artifacts","readonly",(tx,set)=>{const req=tx.objectStore("artifacts").index("url").getAll(url);req.onsuccess=()=>set((req.result as LocalArtifact[]).find(row=>row.kind==="document"));});
}
export async function storageCounts() {
  return localTransaction<Record<string,number>>([...stores],"readonly",(tx,set)=>{const counts:Record<string,number>={};for(const name of stores){const req=tx.objectStore(name).count();req.onsuccess=()=>{counts[name]=req.result;set(counts);};}});
}
export async function clearLocalData() {await localTransaction([...stores],"readwrite",tx=>{for(const name of stores)tx.objectStore(name).clear();});}

function clean(value:unknown,depth=0):unknown {
  if(depth>12)throw new Error("Backup data is nested too deeply.");
  if(value instanceof Float32Array)return Array.from(value);
  if(Array.isArray(value))return value.map(item=>clean(item,depth+1));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>!/(api[_-]?key|authorization|password|secret|token|__proto__|constructor|prototype)/i.test(key)).map(([key,item])=>[key,clean(item,depth+1)]));
  return value;
}
export async function exportLocalData(sessionId?:string):Promise<string> {
  const data=await localTransaction<Record<string,unknown[]>>([...stores],"readonly",(tx,set)=>{const rows:Record<string,unknown[]>={};for(const name of stores){const store=tx.objectStore(name),req=sessionId?(name==="sessions"?store.get(sessionId):store.index("session").getAll(sessionId)):store.getAll();req.onsuccess=()=>{rows[name]=sessionId&&name==="sessions"?(req.result?[req.result]:[]):req.result;set(rows);};}});
  const output=JSON.stringify({format:"policy-radar-local",version:1,exported_at:new Date().toISOString(),...clean(data) as object});
  if(new TextEncoder().encode(output).length>MAX_BACKUP_BYTES)throw new Error("This backup exceeds 50 MB. Export fewer conversations first.");return output;
}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid backup object.");return value as Record<string,unknown>;};
const string=(value:unknown,max:number)=>{if(typeof value!=="string"||value.length>max)throw new Error("Invalid backup text.");return value;};
const list=(value:unknown,max:number):unknown[]=>{if(!Array.isArray(value)||value.length>max)throw new Error("Invalid backup list.");return value;};
const id=(value:unknown)=>{const s=string(value,100);if(!/^[a-zA-Z0-9-]{1,100}$/.test(s))throw new Error("Invalid conversation identifier.");return s;};
const url=(value:unknown)=>{const s=string(value,4000);if(!["https:","http:"].includes(new URL(s).protocol))throw new Error("Invalid backup source URL.");return s;};
function sources(value:unknown):SourceItem[] {
  return list(value||[],200).map(value=>{const row=object(value);return {source_type:string(row.source_type,100),id:string(row.id,500),title:string(row.title,2000),url:url(row.url),agency:row.agency?string(row.agency,2000):null,date:row.date?string(row.date,100):null,excerpt:row.excerpt?string(row.excerpt,20_000):null,pdf_url:row.pdf_url?url(row.pdf_url):null,content_type:row.content_type?string(row.content_type,100):null} as SourceItem;});
}
function steps(value:unknown):Step[] {
  return list(value||[],200).map(value=>{const row=object(value);if(!["running","done","error"].includes(String(row.status)))throw new Error("Invalid research step.");return {step_id:id(row.step_id),status:row.status,label:string(row.label,500),tool_name:string(row.tool_name,100),args:clean(object(row.args||{})),result_preview:row.result_preview?clean(object(row.result_preview)):undefined} as Step;});
}
export function parseBackup(raw:string) {
  if(new TextEncoder().encode(raw).length>MAX_BACKUP_BYTES)throw new Error("Backups must be smaller than 50 MB.");
  const input=object(JSON.parse(raw));if(input.format!=="policy-radar-local"||input.version!==1)throw new Error("Select a Policy Radar saved-data backup.");
  let count=0;const sessions=list(input.sessions,500).map(value=>{
    const row=object(value),messages=list(row.messages,2000).map(value=>{
      if(++count>10_000)throw new Error("Backup contains too many messages.");
      const m=object(value);if(m.role!=="user"&&m.role!=="assistant"||!Number.isSafeInteger(m.id)||Number(m.id)<1)throw new Error("Invalid saved message.");
      return {id:Number(m.id),role:m.role,content:string(m.content,80_000),created_at:string(m.created_at,50),request_id:m.request_id===undefined?undefined:id(m.request_id),model:m.model===undefined||m.model===null?undefined:string(m.model,100),sources:sources(m.sources),steps:steps(m.steps)};
    });
    return {session_id:id(row.session_id),created_at:string(row.created_at,50),messages} as LocalSession;
  });
  const sessionIds=new Set(sessions.map(row=>row.session_id));if(sessionIds.size!==sessions.length)throw new Error("Backup repeats a conversation identifier.");
  const documents=list(input.documents||[],1000).map(value=>{
    const row=object(value),session_id=id(row.session_id),model=string(row.model,100),doc_key=string(row.doc_key,1000);
    if(!["@cf/baai/bge-small-en-v1.5","sentence-transformers/all-MiniLM-L6-v2"].includes(model))throw new Error("Unsupported backup embedding model.");
    const chunks=list(row.chunks,400).map(value=>{const c=object(value),vector=list(c.vector,384);if(vector.length!==384||vector.some(n=>typeof n!=="number"||!Number.isFinite(n)))throw new Error("Invalid saved embedding vector.");return {text:string(c.text,1600),vector:new Float32Array(vector as number[]),doc_key,source_url:url(c.source_url),pdf_url:c.pdf_url===undefined?undefined:url(c.pdf_url)};});
    return {key:JSON.stringify([session_id,model,doc_key]),session_id,model,doc_key,text_hash:string(row.text_hash,100),chunks};
  });
  const artifacts=list(input.artifacts||[],5000).map(value=>{const row=object(value),data=object(row.data);if(row.kind!=="document"&&row.kind!=="research")throw new Error("Invalid research artifact.");
    const safe=row.kind==="document"?{title:string(data.title,2000),full_text:string(data.full_text,500_000),truncated:Boolean(data.truncated),images:list(data.images||[],2).map(value=>{const image=string(value,4_000_000);if(!/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(image))throw new Error("Invalid document image.");return image;})}:{steps:steps(data.steps),sources:sources(data.sources)};
    return {key:string(row.key,1200),session_id:id(row.session_id),kind:row.kind,source_url:row.source_url===undefined?undefined:url(row.source_url),saved_at:row.saved_at===undefined?undefined:string(row.saved_at,50),data:safe} as LocalArtifact;});
  // Existing v1 indexes may belong to a synthetic benchmark, without a session.
  // Preserve such indexes by creating an empty imported session for each orphan.
  for(const row of [...documents,...artifacts])if(!sessionIds.has(row.session_id)){sessions.push({session_id:row.session_id,created_at:new Date().toISOString(),messages:[]});sessionIds.add(row.session_id);}
  return {sessions,documents,artifacts};
}
export async function importLocalData(raw:string) {
  const data=parseBackup(raw),mapping=new Map<string,string>();
  await localTransaction([...stores],"readwrite",tx=>{
    const store=tx.objectStore("sessions");let remaining=data.sessions.length;
    const dependents=()=>{
      for(const row of data.documents){row.session_id=mapping.get(row.session_id)!;row.key=JSON.stringify([row.session_id,row.model,row.doc_key]);tx.objectStore("documents").put(row);}
      for(const row of data.artifacts){const old=row.session_id;row.session_id=mapping.get(old)!;if(old!==row.session_id)row.key=JSON.stringify([row.session_id,row.kind,row.key]);tx.objectStore("artifacts").put(row);}
    };
    // Read, compare, merge and write in the same transaction, including conflicts
    // with another tab. A different local conversation is never overwritten.
    for(const row of data.sessions){const original=row.session_id,req=store.get(original);req.onsuccess=()=>{if(req.result&&JSON.stringify(clean(req.result))!==JSON.stringify(clean(row)))row.session_id=crypto.randomUUID();mapping.set(original,row.session_id);store.put(row);if(--remaining===0)dependents();};}
    if(!remaining)dependents();
  });
  if(typeof window!=="undefined")window.dispatchEvent(new Event("policy-data-changed"));
  return {sessions:data.sessions.length,session_ids:data.sessions.map(row=>row.session_id)};
}
