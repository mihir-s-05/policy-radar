import { it,expect,vi } from "vitest";
vi.mock("../../frontend/src/lib/browserEmbeddings",()=>({indexDocument:vi.fn(),queryDocuments:vi.fn(async()=>({count:0,matches:[]}))}));
vi.mock("../../frontend/src/api/browserDocuments",()=>({readDocument:vi.fn()}));
import { browserChat } from "../../frontend/src/api/browserChat";
import type { Transport } from "../../frontend/src/api/browserTransport";
const response=(value:unknown)=>new Response(JSON.stringify(value));
const stream=(events:unknown[])=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""));
it.each(["openai","anthropic","gemini"])("completes a %s browser research loop with sources and durable steps",async(provider)=>{
  let turns=0;const requests:{path:string;input:Record<string,unknown>}[]=[];
  const transport:Transport=async(path,options)=>{
    const input=options?.body?JSON.parse(String(options.body)):{};requests.push({path,input});
    if(path==="/api/chat/start")return response({messages:[{role:"user",content:"What changed?"}]});
    if(path==="/api/research-spec")return response({SYSTEM_INSTRUCTIONS:"Research policy",TOOL_TO_SOURCE:{federal_register_search:"federal_register"},TOOLS:[{type:"function",name:"federal_register_search",description:"Search",parameters:{type:"object",properties:{query:{type:"string"},days:{type:"number"}}}}]});
    if(path==="/api/tools")return response({count:1,sources:[{id:"rule",source_type:"federal_register",title:"A rule",url:"https://www.federalregister.gov/test"}]});
    if(path==="/api/chat/finish")return response({saved:true});
    if(path==="/api/provider/stream") {
      expect(input.api_key).toBe("visitor-key");turns++;
      if(turns===1) {
        if(provider==="openai")return stream([{type:"response.completed",response:{output:[{type:"function_call",call_id:"call",name:"federal_register_search",arguments:'{"query":"water","days":90}'}]}}]);
        if(provider==="anthropic")return stream([{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"call",name:"federal_register_search"}},{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"query":"water","days":90}'}},{type:"message_stop"}]);
        return stream([{candidates:[{content:{parts:[{functionCall:{name:"federal_register_search",args:{query:"water",days:90}},thoughtSignature:"signature"}]},finishReason:"STOP"}]}]);
      }
      expect(JSON.stringify(input.payload)).toContain("federalregister.gov/test");
      if(provider==="openai")return stream([{type:"response.output_text.delta",delta:"A new rule."},{type:"response.completed",response:{output:[]}}]);
      if(provider==="anthropic")return stream([{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"A new rule."}},{type:"message_stop"}]);
      return stream([{candidates:[{content:{parts:[{text:"A new rule."}]},finishReason:"STOP"}]}]);
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const events=[];for await(const event of browserChat({session_id:"test",request_id:"test-request-id",message:"What changed?",provider:provider as "openai"|"anthropic"|"gemini",model:"example",api_key:"visitor-key",days:30},transport))events.push(event);
  expect(events.at(-1)).toMatchObject({type:"done",data:{answer_text:"A new rule.",sources:[{id:"rule"}]}});
  expect(requests.find(request=>request.path==="/api/tools")?.input.args).toEqual({query:"water",days:30});
  const finish=requests.find(request=>request.path==="/api/chat/finish")?.input;
  expect(finish.steps).toHaveLength(1);expect(finish.steps[0].status).toBe("done");expect(JSON.stringify(finish)).not.toContain("visitor-key");expect(turns).toBe(2);
});
it("does not call any endpoint without a visitor chat key",async()=>{
  const transport=vi.fn();const generator=browserChat({session_id:"test",message:"hello",days:30},transport);
  await expect(generator.next()).rejects.toThrow("your own provider API key");expect(transport).not.toHaveBeenCalled();
});
