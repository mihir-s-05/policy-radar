import { IDBFactory } from "fake-indexeddb";
import { beforeEach,it,expect,vi } from "vitest";
import { beginInquiry,createLocalSession,finishInquiry,getLocalSession,listLocalSessions,localDatabase,localTransaction,saveArtifact,exportLocalData,importLocalData,clearLocalData,deleteLocalSession,storageCounts,parseBackup } from "../../frontend/src/lib/browserStore";
const source={source_type:"federal_register" as const,id:"test",title:"Rule",url:"https://example.gov/rule",agency:null,date:null,excerpt:null};
const step={step_id:"step-test",status:"done" as const,label:"Search",tool_name:"search",args:{query:"water"},result_preview:{count:1}};
beforeEach(()=>{vi.stubGlobal("indexedDB",new IDBFactory());});
it("atomically saves idempotent messages across concurrent tabs without keys",async()=>{
  const {session_id}=await createLocalSession();
  await Promise.all(Array.from({length:20},()=>beginInquiry(session_id,"request-test","hello")));
  await Promise.all(Array.from({length:10},()=>finishInquiry(session_id,"request-test","answer",[source],[step],"model")));
  const row=await getLocalSession(session_id);expect(row.messages).toHaveLength(2);expect(row.messages[1].steps).toEqual([step]);expect((await listLocalSessions()).sessions[0].title).toBe("hello");
},20_000);
it("keeps full durable history while bounding state sent to providers",async()=>{
  const {session_id}=await createLocalSession();for(let i=0;i<35;i++)await beginInquiry(session_id,`request-${i}`,"界".repeat(15_000));
  const recent=await beginInquiry(session_id,"request-last","latest");expect(recent.messages.at(-1).content).toBe("latest");expect(recent.messages).toHaveLength(3);expect(recent.messages.reduce((sum,m)=>sum+new TextEncoder().encode(m.content).length,0)).toBeLessThanOrEqual(120_000);expect((await getLocalSession(session_id)).messages).toHaveLength(36);
},20_000);
it("upgrades existing v1 document indexes in place",async()=>{
  await new Promise<void>((resolve,reject)=>{const req=indexedDB.open("policy-radar-documents",1);req.onupgradeneeded=()=>{const s=req.result.createObjectStore("documents",{keyPath:"key"});s.createIndex("session","session_id");};req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction("documents","readwrite");tx.objectStore("documents").put({key:"old",session_id:"original",chunks:[{vector:new Float32Array(384)}]});tx.oncomplete=()=>{db.close();resolve();};};});
  const db=await localDatabase();expect(db.objectStoreNames.contains("sessions")).toBe(true);db.close();expect((await storageCounts()).documents).toBe(1);
});
it("round trips conversations, citations, documents, vectors, and sanitized artifacts",async()=>{
  const {session_id}=await createLocalSession();await beginInquiry(session_id,"request-test","question");await finishInquiry(session_id,"request-test","answer",[source],[step],"model");
  await saveArtifact({key:"artifact",session_id,kind:"research",data:{steps:[{...step,args:{api_key:"secret-chat-key",query:"water"}}],sources:[source],access_token:"secret-token"}});
  const model="@cf/baai/bge-small-en-v1.5",row={key:JSON.stringify([session_id,model,"doc"]),session_id,model,doc_key:"doc",text_hash:"hash",chunks:[{text:"water policy",vector:new Float32Array(384).fill(0.25),doc_key:"doc",source_url:"https://example.gov/rule"}]};
  await localTransaction("documents","readwrite",tx=>{tx.objectStore("documents").put(row);});
  const backup=await exportLocalData();expect(backup).not.toContain("secret-chat-key");expect(backup).not.toContain("secret-token");await clearLocalData();await importLocalData(backup);expect((await storageCounts())).toEqual({sessions:1,artifacts:1,documents:1});expect((await getLocalSession(session_id)).messages[1].sources[0].url).toBe(source.url);
  const restored=await localTransaction<typeof row>("documents","readonly",(tx,set)=>{const req=tx.objectStore("documents").get(row.key);req.onsuccess=()=>set(req.result);});expect(restored.chunks[0].vector).toBeInstanceOf(Float32Array);expect(restored.chunks[0].vector[0]).toBe(0.25);
});
it("preserves conflicting conversations during simultaneous imports",async()=>{
  const {session_id}=await createLocalSession();await beginInquiry(session_id,"original","keep me");const raw=JSON.parse(await exportLocalData());raw.sessions[0].messages[0].content="different imported text";
  await Promise.all([importLocalData(JSON.stringify(raw)),importLocalData(JSON.stringify(raw))]);expect((await getLocalSession(session_id)).messages[0].content).toBe("keep me");expect((await storageCounts()).sessions).toBe(3);
});
it("rejects malformed or unsafe backups before changing existing data",async()=>{
  const {session_id}=await createLocalSession();await beginInquiry(session_id,"original","keep me");const raw=JSON.parse(await exportLocalData());raw.sessions[0].messages[0].sources=[{...source,url:"javascript:alert(1)"}];await expect(importLocalData(JSON.stringify(raw))).rejects.toThrow();expect((await getLocalSession(session_id)).messages[0].content).toBe("keep me");expect((await storageCounts()).sessions).toBe(1);expect(()=>parseBackup(JSON.stringify({format:"other",version:1}))).toThrow();
});
it("deletes a conversation with its associated artifacts and vectors",async()=>{
  const {session_id}=await createLocalSession();await saveArtifact({key:"artifact",session_id,kind:"research",data:{steps:[],sources:[]}});await deleteLocalSession(session_id);expect(await storageCounts()).toEqual({sessions:0,artifacts:0,documents:0});
});
it("exports one conversation independently for large libraries",async()=>{
  const a=await createLocalSession(),b=await createLocalSession();await beginInquiry(a.session_id,"a-request","selected");await beginInquiry(b.session_id,"b-request","excluded");const backup=JSON.parse(await exportLocalData(a.session_id));expect(backup.sessions).toHaveLength(1);expect(JSON.stringify(backup)).not.toContain("excluded");
});
it("visibly reports denied and full storage, without a silent durable fallback",async()=>{
  const dispatch=vi.fn();vi.stubGlobal("window",{dispatchEvent:dispatch});vi.stubGlobal("indexedDB",undefined);await expect(createLocalSession()).rejects.toThrow("Browser storage is unavailable");expect(dispatch).toHaveBeenCalled();
  vi.stubGlobal("indexedDB",new IDBFactory());await expect(localTransaction("sessions","readwrite",()=>{throw new DOMException("quota","QuotaExceededError");})).rejects.toThrow("Browser storage is full");expect((await storageCounts()).sessions).toBe(0);vi.unstubAllGlobals();
});
it("routes browser session operations locally after config, with zero session HTTP calls",async()=>{
  vi.stubGlobal("window",{location:{origin:"https://policy.test"},dispatchEvent:vi.fn()});
  const fetch=vi.fn(async()=>Response.json({public_mode:true,execution_mode:"browser"}));vi.stubGlobal("fetch",fetch);
  const client=await import("../../frontend/src/api/client");const {session_id}=await client.createSession();await client.listSessions();await client.getSessionMessages(session_id);await client.stopChat("request-test");expect(fetch).toHaveBeenCalledTimes(1);expect(String(fetch.mock.calls[0][0])).toMatch(/\/api\/config$/);vi.unstubAllGlobals();
});
it("preserves HTTP session routing for the local Python app",async()=>{
  vi.resetModules();vi.stubGlobal("window",{location:{origin:"http://localhost:5173"},dispatchEvent:vi.fn()});
  const fetch=vi.fn(async(url:string)=>Response.json(url.endsWith("/api/config")?{public_mode:false}:{session_id:"python-session"}));vi.stubGlobal("fetch",fetch);
  const client=await import("../../frontend/src/api/client");expect(await client.createSession()).toEqual({session_id:"python-session"});expect(fetch.mock.calls.map(call=>String(call[0]).split("/api/")[1])).toEqual(["config","session"]);vi.unstubAllGlobals();
});
