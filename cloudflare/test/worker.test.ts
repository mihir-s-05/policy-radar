import { env,createExecutionContext } from "cloudflare:test";
import { fetchMock } from "./outboundMock";
import { beforeEach,describe,it,expect,vi } from "vitest";
import worker from "../src/index";
import { reserve,embeddingBucket } from "../src/budget";
import { sha256 } from "../src/http";
import { EMBEDDING_MODEL,reservationFor } from "../src/embeddings";
import { officialURL } from "../src/government";

const token="a".repeat(64),other="b".repeat(64);
const ai=vi.fn(async(_model:string,input:{text:string[]})=>({data:input.text.map(()=>Array(384).fill(0))}));
const burst=vi.fn(async(_input:{key:string})=>({success:true}));
const testEnv={...env,EMBEDDINGS_ENABLED:"true",EMBEDDING_DAILY_BUDGET:"4000",GOV_HOURLY_BUDGET:"800",GOV_DAILY_BUDGET:"4000",AI:{run:ai},BURST_LIMIT:{limit:burst},SHARED_BURST_LIMIT:{limit:async()=>({success:true})},EMBEDDING_BURST_LIMIT:{limit:async()=>({success:true})}} as unknown as Env;
async function call(path:string,input?:unknown,method=input?"POST":"GET",ownerToken=token,bindings=testEnv) {
  return worker.fetch(new Request(`https://policy.test${path}`,{method,headers:{"X-Session-Token":ownerToken,"CF-Connecting-IP":"192.0.2.1","Content-Type":"application/json"},body:input?JSON.stringify(input):undefined}),bindings,createExecutionContext());
}
async function legacy(){const id=crypto.randomUUID();await env.DB.prepare("INSERT INTO sessions VALUES(?,?,?)").bind(id,await sha256(token),new Date().toISOString()).run();return id;}
beforeEach(async()=>{
  await env.DB.batch(["messages","requests","sessions","budgets","upstream_cache"].map(name=>env.DB.prepare(`DELETE FROM ${name}`)));
  ai.mockReset();ai.mockImplementation(async(_model,input)=>({data:input.text.map(()=>Array(384).fill(0))}));burst.mockReset();burst.mockResolvedValue({success:true});
});
describe("stateless browser protocol and legacy migration",()=>{
  it("retires server persistence without creating or deleting conversations",async()=>{
    const id=await legacy();
    for(const [path,input] of [["/api/session",{}],["/api/chat/start",{message:"hello",api_key:"secret"}],["/api/chat/finish",{answer_text:"answer"}] ] as const)expect((await call(path,input)).status).toBe(410);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM sessions").first()).count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM messages").first()).count).toBe(0);
    expect((await call(`/api/legacy/sessions/${id}/messages`)).status).toBe(200);
  });
  it("protects legacy imports and explicit deletion by original ownership",async()=>{
    const id=await legacy();expect((await call(`/api/legacy/sessions/${id}/messages`,undefined,"GET",other)).status).toBe(404);
    expect((await call("/api/legacy/delete-imported",{session_ids:[id],confirm_imported:true},"POST",other)).status).toBe(404);
    expect((await call("/api/legacy/delete-imported",{session_ids:[id]})).status).toBe(400);
    expect((await call("/api/legacy/delete-imported",{session_ids:[id],confirm_imported:true})).status).toBe(200);
  });
  it("performs ordinary browsing without any D1 access",async()=>{
    const bindings={...testEnv,DB:undefined} as unknown as Env;
    for(const path of ["/api/config","/api/health","/api/research-spec"])expect((await call(path,undefined,"GET",token,bindings)).status).toBe(200);
  });
  it("requires a visitor key and rejects invalid/native prototype providers",async()=>{
    expect((await call("/api/provider/stream",{provider:"openai",model:"example"})).status).toBe(400);
    expect((await call("/api/provider/stream",{provider:"toString",model:"example",api_key:"private"})).status).toBe(400);
    expect(ai).not.toHaveBeenCalled();
  });
  it.each(["openai","anthropic","gemini"])("relays bounded %s state with only the visitor key and no D1",async(provider)=>{
    const endpoints={openai:["https://api.openai.com","/v1/responses","authorization","Bearer visitor-key"],anthropic:["https://api.anthropic.com","/v1/messages","x-api-key","visitor-key"],gemini:["https://generativelanguage.googleapis.com","/v1beta/models/example:streamGenerateContent?alt=sse","x-goog-api-key","visitor-key"]};
    const [origin,path,header,value]=endpoints[provider];fetchMock.get(origin).intercept({path,method:"POST",headers:{[header]:value}}).reply(200,'data: {"ok":true}\n\n',{headers:{"Content-Type":"text/event-stream"}});
    const response=await call("/api/provider/stream",{provider,model:"example",api_key:"visitor-key",payload:{messages:[],contents:[],input:[]}},"POST",token,{...testEnv,DB:undefined} as unknown as Env);
    expect(response.status).toBe(200);expect(await response.text()).toContain('"ok":true');
  });
  it("rejects oversized browser conversation state before relay",async()=>{
    expect((await call("/api/provider/stream",{provider:"openai",model:"example",api_key:"visitor-key",payload:{input:"x".repeat(700_000)}})).status).toBe(413);
  });
});
describe("trusted burst limits",()=>{
  it("cannot reset an IP burst limit by rotating browser tokens or sessions",async()=>{
    burst.mockResolvedValue({success:false});
    for(const ownerToken of [token,other]){const response=await call("/api/embeddings",{session_id:crypto.randomUUID(),texts:["text"]},"POST",ownerToken);expect(response.status).toBe(429);expect((await response.json()).code).toBe("visitor_rate_limited");}
    expect(burst.mock.calls.map(call=>call[0])).toEqual([{key:"policy:192.0.2.1"},{key:"policy:192.0.2.1"}]);expect(ai).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM budgets").first()).count).toBe(0);
  });
});
describe("embedding hard stop",()=>{
  it("does not invoke AI while disabled",async()=>{expect((await call("/api/embeddings",{texts:["text"]},"POST",token,{...testEnv,EMBEDDINGS_ENABLED:"false"} as unknown as Env)).status).toBe(503);expect(ai).not.toHaveBeenCalled();});
  it("atomically reserves concurrent operations without exceeding a global budget",async()=>{
    const calls=await Promise.allSettled(Array.from({length:30},()=>reserve(testEnv,"concurrent",7,100)));expect(calls.filter(x=>x.status==="fulfilled")).toHaveLength(14);expect((await env.DB.prepare("SELECT used FROM budgets WHERE bucket='concurrent'").first()).used).toBe(98);
  });
  it("atomically limits simultaneous embeddings across rotated browser identities",async()=>{
    const amount=reservationFor(["text"]),bindings={...testEnv,EMBEDDING_DAILY_BUDGET:String(amount*5)} as unknown as Env;
    const results=await Promise.all(Array.from({length:30},(_,i)=>call("/api/embeddings",{texts:["text"],budget:0,session_id:crypto.randomUUID()},"POST",i%2?token:other,bindings)));
    expect(results.filter(response=>response.ok)).toHaveLength(5);expect(ai).toHaveBeenCalledTimes(5);expect((await env.DB.prepare("SELECT used FROM budgets WHERE bucket=?").bind(embeddingBucket()).first()).used).toBe(amount*5);
  });
  it("retains reservations and stops after another project's account quota/upstream failure",async()=>{
    ai.mockRejectedValueOnce(new Error("account quota exhausted elsewhere"));
    expect((await call("/api/embeddings",{texts:["text"]})).status).toBe(429);expect((await call("/api/embeddings",{texts:["text"]})).status).toBe(429);expect(ai).toHaveBeenCalledTimes(1);
    const row=await env.DB.prepare("SELECT used,blocked FROM budgets WHERE bucket=?").bind(embeddingBucket()).first();expect(row.used).toBe(reservationFor(["text"]));expect(row.blocked).toBe(1);
    await env.DB.prepare("UPDATE budgets SET bucket='embeddings:2000-01-01' WHERE bucket=?").bind(embeddingBucket()).run();expect((await call("/api/embeddings",{texts:["text"]})).status).toBe(200);
  });
  it("clamps the configured cap and ignores all client budget overrides",async()=>{
    await reserve(testEnv,embeddingBucket(),4000,4000);expect((await call("/api/embeddings",{texts:["text"],maximum:1e9,budget:0},"POST",other,{...testEnv,EMBEDDING_DAILY_BUDGET:"1000000"} as unknown as Env)).status).toBe(429);expect(ai).not.toHaveBeenCalled();
  });
  it("bounds UTF-8, per-text length, batch/body sizes, and the selected model",async()=>{
    expect(reservationFor(["界".repeat(100)])).toBeGreaterThan(reservationFor(["a".repeat(100)]));
    for(const input of [{texts:[]},{texts:Array(17).fill("text")},{texts:["x".repeat(1601)]},{texts:[null]},{texts:[" "]},{texts:["text"],model:"@cf/paid/model"}])expect((await call("/api/embeddings",input)).status).toBe(400);
    expect((await call("/api/embeddings",{texts:Array(16).fill("界".repeat(1600))})).status).toBe(413);expect(ai).not.toHaveBeenCalled();
  });
  it("rejects invalid reservations and cannot refund or reduce usage",async()=>{for(const amount of [0,-10,NaN,1.5])await expect(reserve(testEnv,"invalid",amount,100)).rejects.toThrow();expect((await env.DB.prepare("SELECT COUNT(*) count FROM budgets").first()).count).toBe(0);});
  it("fails closed on invalid output and labels reservations honestly",async()=>{
    const valid=await (await call("/api/embeddings",{texts:["text"]})).json();expect(valid.budget.account_usage_known).toBe(false);expect(valid.budget.units).toBe("conservative_reservations");expect(valid.data[0]).toHaveLength(384);
    ai.mockResolvedValueOnce({data:[[1]]});expect((await call("/api/embeddings",{texts:["text"]})).status).toBe(429);expect((await call("/api/embeddings",{texts:["text"]})).status).toBe(429);expect(ai).toHaveBeenCalledTimes(2);expect(ai.mock.calls[0][0]).toBe(EMBEDDING_MODEL);
  });
});
it("reuses public cached government results without new writes or exposed keys",async()=>{
  fetchMock.get("https://www.federalregister.gov").intercept({path:/\/api\/v1\/documents.json/}).reply(200,{results:[{document_number:"test",title:"Rule",html_url:"https://www.federalregister.gov/test",internal_link:"https://example.gov/?api_key=test-government-key"}]});
  const input={name:"federal_register_search",args:{query:"test"}},first=await call("/api/tools",input);expect(first.status).toBe(200);
  const before=await env.DB.prepare("SELECT * FROM budgets ORDER BY bucket").all(),returned=await first.text(),second=await call("/api/tools",input);expect(JSON.parse(returned)).toEqual(await second.json());expect(returned).not.toContain("test-government-key");expect((await env.DB.prepare("SELECT * FROM budgets ORDER BY bucket").all()).results).toEqual(before.results);
  expect(JSON.stringify((await env.DB.prepare("SELECT payload FROM upstream_cache").all()).results)).not.toContain("test-government-key");
});
it("rejects non-government document URLs and key-exfiltration redirects",async()=>{
  for(const url of ["http://example.gov/a","https://example.gov.evil.com/a","https://user:pass@example.gov/a","https://example.com/a"])expect(()=>officialURL(url)).toThrow();
  fetchMock.get("https://example.gov").intercept({path:"/document"}).reply(302,"",{headers:{Location:"https://evil.com"}});expect((await call("/api/content/raw",{url:"https://example.gov/document"})).status).toBe(400);
});
