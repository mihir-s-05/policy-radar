import { env,createExecutionContext } from "cloudflare:test";
import { fetchMock } from "./outboundMock";
import { beforeEach,describe,it,expect,vi } from "vitest";
import worker from "../src/index";
import { reserve,embeddingBucket } from "../src/budget";
import { sha256 } from "../src/http";
import { EMBEDDING_MODEL } from "../src/embeddings";
import { officialURL } from "../src/government";

const token="a".repeat(64),other="b".repeat(64);
const ai=vi.fn(async()=>({data:[[1,0,0]]}));
const testEnv={...env,EMBEDDINGS_ENABLED:"true",AI:{run:ai}} as unknown as Env;
async function call(path:string,input?:unknown,method=input?"POST":"GET",ownerToken=token,bindings=testEnv) {
  return worker.fetch(new Request(`https://policy.test${path}`,{method,headers:{"X-Session-Token":ownerToken,"Content-Type":"application/json"},body:input?JSON.stringify(input):undefined}),bindings,createExecutionContext());
}
async function session(){return (await (await call("/api/session",{},"POST")).json() as {session_id:string}).session_id;}
beforeEach(async()=>{
  await env.DB.batch(["messages","requests","sessions","budgets","upstream_cache"].map(name=>env.DB.prepare(`DELETE FROM ${name}`)));
  ai.mockClear();ai.mockResolvedValue({data:[[1,0,0]]});
});
describe("owner separation and visitor chat keys",()=>{
  it("hides another browser's sessions, messages, and delete endpoint",async()=>{
    const id=await session();expect((await call(`/api/sessions/${id}/messages`,undefined,"GET",other)).status).toBe(404);
    expect((await call(`/api/sessions/${id}`,undefined,"DELETE",other)).status).toBe(404);
    expect(await (await call("/api/sessions",undefined,"GET",other)).json()).toEqual({sessions:[]});
    expect((await call(`/api/sessions/${id}/messages`)).status).toBe(200);
  });
  it("requires a visitor key before persisting or calling a provider",async()=>{
    const id=await session();expect((await call("/api/chat/start",{session_id:id,request_id:crypto.randomUUID(),message:"test"})).status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM messages").first()).count).toBe(0);
    expect((await call("/api/provider/stream",{provider:"openai",model:"example"})).status).toBe(400);
  });
  it.each(["openai","anthropic","gemini"])("relays %s only with the supplied key",async(provider)=>{
    const id=await session(),request_id=crypto.randomUUID();await call("/api/chat/start",{session_id:id,request_id,message:"hello",api_key:"visitor-key"});
    const endpoints={openai:["https://api.openai.com","/v1/responses","authorization","Bearer visitor-key"],anthropic:["https://api.anthropic.com","/v1/messages","x-api-key","visitor-key"],gemini:["https://generativelanguage.googleapis.com","/v1beta/models/example:streamGenerateContent?alt=sse","x-goog-api-key","visitor-key"]};
    const [origin,path,header,value]=endpoints[provider];
    fetchMock.get(origin).intercept({path,method:"POST",headers:{[header]:value}}).reply(200,'data: {"ok":true}\n\n',{headers:{"Content-Type":"text/event-stream"}});
    const response=await call("/api/provider/stream",{session_id:id,request_id,provider,model:"example",api_key:"visitor-key",payload:{messages:[],contents:[],input:[]}});
    expect(response.status).toBe(200);expect(await response.text()).toContain('"ok":true');
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM messages").all()).results)).not.toContain("visitor-key");
    await call("/api/chat/stop",{request_id});expect((await call("/api/provider/stream",{session_id:id,request_id,provider,model:"example",api_key:"visitor-key",payload:{}})).status).toBe(409);
  });
  it("idempotently saves history and work-log data without a key",async()=>{
    const id=await session(),request_id=crypto.randomUUID();const input={session_id:id,request_id,api_key:"private",message:"hello"};await call("/api/chat/start",input);await call("/api/chat/start",input);
    const finish={session_id:id,request_id,answer_text:"answer",sources:[],steps:[{label:"search",status:"done"}],model:"test"};await call("/api/chat/finish",finish);await call("/api/chat/finish",finish);
    const output=await (await call(`/api/sessions/${id}/messages`)).json() as {messages:unknown[]};expect(output.messages).toHaveLength(2);expect(JSON.stringify(output)).toContain("search");expect(JSON.stringify(output)).not.toContain("private");
  });
});
describe("embedding hard stop",()=>{
  it("keeps a visitor minute limit distinct from the daily embedding stop",async()=>{
    const hash=await sha256(token);await reserve(testEnv,`visitor:${hash}:${Math.floor(Date.now()/60000)}`,80,80);
    const response=await call("/api/sessions");expect(response.status).toBe(429);expect((await response.json()).code).toBe("visitor_rate_limited");expect(ai).not.toHaveBeenCalled();
  });
  it("does not invoke AI while disabled",async()=>{
    const id=await session();expect((await call("/api/embeddings",{session_id:id,texts:["text"]},"POST",token,{...testEnv,EMBEDDINGS_ENABLED:"false"} as unknown as Env)).status).toBe(503);expect(ai).not.toHaveBeenCalled();
  });
  it("atomically reserves concurrent calls without exceeding a shared budget",async()=>{
    const calls=await Promise.allSettled(Array.from({length:30},()=>reserve(testEnv,"concurrent",7,100)));
    expect(calls.filter(x=>x.status==="fulfilled")).toHaveLength(14);
    expect((await env.DB.prepare("SELECT used FROM budgets WHERE bucket='concurrent'").first()).used).toBe(98);
  });
  it("rejects the first request beyond the budget across browser owners",async()=>{
    const id=await session();await reserve(testEnv,embeddingBucket(),8000,8000);
    const result=await call("/api/embeddings",{session_id:id,texts:["text"]});expect(result.status).toBe(429);expect((await result.json()).code).toBe("free_quota_exhausted");expect(ai).not.toHaveBeenCalled();
  });
  it("blocks the rest of the UTC day after an upstream error and never retries",async()=>{
    const id=await session();ai.mockRejectedValueOnce(new Error("quota"));
    expect((await call("/api/embeddings",{session_id:id,texts:["text"]})).status).toBe(429);
    expect((await call("/api/embeddings",{session_id:id,texts:["text"]})).status).toBe(429);expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toBe(EMBEDDING_MODEL);
    await env.DB.prepare("UPDATE budgets SET bucket='embeddings:2000-01-01' WHERE bucket=?").bind(embeddingBucket()).run();
    expect((await call("/api/embeddings",{session_id:id,texts:["text"]})).status).toBe(200);
  });
  it("rejects oversized batches and ownership mismatches before AI",async()=>{
    const id=await session();expect((await call("/api/embeddings",{session_id:id,texts:Array(17).fill("text")})).status).toBe(400);
    expect((await call("/api/embeddings",{session_id:id,texts:["text"]},"POST",other)).status).toBe(404);expect(ai).not.toHaveBeenCalled();
  });
});
it("caches government results and keeps its shared key out of returned data",async()=>{
  const id=await session();fetchMock.get("https://www.federalregister.gov").intercept({path:/\/api\/v1\/documents.json/}).reply(200,{results:[{document_number:"test",title:"Rule",html_url:"https://www.federalregister.gov/test",internal_link:"https://example.gov/?api_key=test-government-key"}]});
  const input={session_id:id,name:"federal_register_search",args:{query:"test"}};
  const first=await call("/api/tools",input),second=await call("/api/tools",input);expect(first.status).toBe(200);
  const returned=await first.text();expect(JSON.parse(returned)).toEqual(await second.json());expect(returned).not.toContain("test-government-key");
  expect(JSON.stringify((await env.DB.prepare("SELECT payload FROM upstream_cache").all()).results)).not.toContain("test-government-key");
  expect((await env.DB.prepare("SELECT SUM(used) used FROM budgets WHERE bucket LIKE 'gov:%'").first()).used).toBe(1);
});
it("rejects non-government document URLs and key-exfiltration redirects",async()=>{
  for(const url of ["http://example.gov/a","https://example.gov.evil.com/a","https://user:pass@example.gov/a","https://example.com/a"])expect(()=>officialURL(url)).toThrow();
  fetchMock.get("https://example.gov").intercept({path:"/document"}).reply(302,"",{headers:{Location:"https://evil.com"}});
  expect((await call("/api/content/raw",{url:"https://example.gov/document"})).status).toBe(400);
});
it("does not advertise owner credentials",async()=>{
  const config=await (await call("/api/config")).json();expect(config.public_mode).toBe(true);expect(config.embedding_provider).toBe("cloudflare");expect(config.providers.openai.api_key_detected).toBe(false);
  expect(await sha256(token)).not.toBe(token);
});
