import type { Transport } from "../api/browserTransport";

export const LOCAL_MODEL="sentence-transformers/all-MiniLM-L6-v2";
export const CLOUDFLARE_MODEL="@cf/baai/bge-small-en-v1.5";
let worker:Worker|undefined;
const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
let exhaustedUntil=0;
export function disposeLocalRuntime() {
  worker?.terminate();worker=undefined;
  for(const item of pending.values()){item.cleanup();item.reject(new Error("Local operation stopped."));}pending.clear();
}
function rpc<T>(message:Record<string,unknown>,signal?:AbortSignal):Promise<T> {
  signal?.throwIfAborted();
  if(!worker) {
    worker=new Worker(new URL("./retrieval.worker.ts",import.meta.url),{type:"module"});
    worker.onmessage=(event:MessageEvent)=>{
      const item=pending.get(event.data.id);if(!item||event.data.progress) return;
      pending.delete(event.data.id);item.cleanup();
      if(event.data.error){item.reject(new Error(event.data.error));disposeLocalRuntime();}else item.resolve(event.data.result);
    };
    worker.onerror=()=>disposeLocalRuntime();
  }
  return new Promise<T>((resolve,reject)=>{
    const id=crypto.randomUUID(),abort=()=>{disposeLocalRuntime();reject(new DOMException("Operation cancelled.","AbortError"));};
    const cleanup=()=>signal?.removeEventListener("abort",abort);
    signal?.addEventListener("abort",abort,{once:true});
    pending.set(id,{resolve:value=>resolve(value as T),reject,cleanup});worker!.postMessage({...message,id});
  });
}
export async function embedTexts(texts:string[],provider:"local"|"cloudflare",sessionId:string,transport:Transport,signal?:AbortSignal):Promise<number[][]> {
  if(provider==="local") {
    const output:number[][]=[];
    // Keep activation memory bounded on phones and long PDF indexes.
    for(let i=0;i<texts.length;i+=8)output.push(...await rpc<number[][]>({type:"embed",texts:texts.slice(i,i+8)},signal));
    return output;
  }
  if(Date.now()<exhaustedUntil) throw new Error("The free embedding quota is exhausted for today. No paid fallback will run.");
  const output:number[][]=[];
  for(let i=0;i<texts.length;i+=16) {
    signal?.throwIfAborted();
    const response=await transport("/api/embeddings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session_id:sessionId,texts:texts.slice(i,i+16)}),signal});
    const data=await response.json();
    if(!response.ok) {
      if(data.code==="free_quota_exhausted") {const now=new Date();exhaustedUntil=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1);}
      throw new Error(data.detail||"Hosted embedding failed.");
    }
    if(!Array.isArray(data.data)||data.data.length!==Math.min(16,texts.length-i)) throw new Error("The embedding service returned an invalid batch.");
    output.push(...data.data);
  }
  return output;
}
export async function rank(query:number[],vectors:(number[]|Float32Array)[],topK=5,signal?:AbortSignal) {
  return rpc<{index:number;score:number}[]>({type:"rank",query,vectors,topK},signal);
}
export interface IndexedChunk {text:string;vector:Float32Array;doc_key:string;source_url:string;pdf_url?:string}
interface DocumentIndex {key:string;session_id:string;model:string;doc_key:string;text_hash:string;chunks:IndexedChunk[]}
async function database():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open("policy-radar-documents",1);
    request.onupgradeneeded=()=>{const store=request.result.createObjectStore("documents",{keyPath:"key"});store.createIndex("session","session_id");};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
async function indexes(sessionId:string):Promise<DocumentIndex[]> {
  const db=await database();
  try{return await new Promise((resolve,reject)=>{const req=db.transaction("documents").objectStore("documents").index("session").getAll(sessionId);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
  finally{db.close();}
}
function chunks(text:string):string[] {
  const normalized=text.replace(/\s+/g," ").trim(),output:string[]=[];
  for(let start=0;start<normalized.length&&output.length<400;) {
    let end=Math.min(start+750,normalized.length);
    if(end<normalized.length){const space=normalized.lastIndexOf(" ",end);if(space>start+500)end=space;}
    output.push(normalized.slice(start,end));if(end===normalized.length)break;
    start=Math.max(start+1,end-100);
  }
  return output;
}
export async function indexDocument(sessionId:string,docKey:string,text:string,sourceURL:string,provider:"local"|"cloudflare",transport:Transport,signal?:AbortSignal,pdfURL?:string) {
  if(!text.trim())return;
  const model=provider==="local"?LOCAL_MODEL:CLOUDFLARE_MODEL;
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  const hash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,"0")).join("");
  const key=JSON.stringify([sessionId,model,docKey]);
  if((await indexes(sessionId)).some(x=>x.key===key&&x.text_hash===hash))return;
  const parts=chunks(text),vectors=await embedTexts(parts,provider,sessionId,transport,signal);
  const row:DocumentIndex={key,session_id:sessionId,model,doc_key:docKey,text_hash:hash,
    chunks:parts.map((part,i)=>({text:part,vector:new Float32Array(vectors[i]),doc_key:docKey,source_url:sourceURL,pdf_url:pdfURL}))};
  signal?.throwIfAborted();const db=await database();
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction("documents","readwrite");tx.objectStore("documents").put(row);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
  finally{db.close();}
}
export async function queryDocuments(sessionId:string,query:string,provider:"local"|"cloudflare",transport:Transport,topK=5,signal?:AbortSignal) {
  const model=provider==="local"?LOCAL_MODEL:CLOUDFLARE_MODEL;
  const rows=(await indexes(sessionId)).filter(x=>x.model===model).flatMap(x=>x.chunks);
  if(!rows.length)return {count:0,matches:[]};
  const [vector]=await embedTexts([query.slice(0,750)],provider,sessionId,transport,signal);
  const ranked=await rank(vector,rows.map(x=>x.vector),topK,signal);
  return {count:ranked.length,matches:ranked.map(({index,score})=>({text:rows[index].text,score,metadata:{doc_key:rows[index].doc_key,source_url:rows[index].source_url,pdf_url:rows[index].pdf_url}}))};
}
export async function deleteDocumentIndex(sessionId:string) {
  const rows=await indexes(sessionId),db=await database();
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction("documents","readwrite");for(const row of rows)tx.objectStore("documents").delete(row.key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
  finally{db.close();}
}
