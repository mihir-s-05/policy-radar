import { it,expect,vi } from "vitest";
vi.mock("../../frontend/src/lib/browserEmbeddings",()=>({indexDocument:vi.fn(),queryDocuments:vi.fn(),LOCAL_MODEL:"sentence-transformers/all-MiniLM-L6-v2",CLOUDFLARE_MODEL:"@cf/baai/bge-small-en-v1.5"}));
vi.mock("../../frontend/src/api/browserDocuments",()=>({readDocument:vi.fn()}));
import { browserChat } from "../../frontend/src/api/browserChat";
import type { SourceSelection } from "../../frontend/src/types";
it.each([false,true])("honors Auto's allowed-source mask, including all-empty fallback (%s)",async(empty)=>{
  const sourceFlags={auto:true,regulations:false,govinfo:false,congress:!empty,federal_register:false,usaspending:false,fiscal_data:false,datagov:false,doj:false,searchgov:false} satisfies SourceSelection;
  let selected:unknown[]=[];
  const transport=async(path:string,options?:RequestInit)=>{
    if(path==="/api/chat/start")return Response.json({messages:[{role:"user",content:"test"}]});
    if(path==="/api/research-spec")return Response.json({SYSTEM_INSTRUCTIONS:"test",TOOL_TO_SOURCE:{federal_register_search:"federal_register"},TOOLS:[{type:"function",name:"federal_register_search",parameters:{type:"object",properties:{}}}]});
    if(path==="/api/provider/stream"){selected=JSON.parse(String(options.body)).payload.tools;return new Response('data: {"type":"response.output_text.delta","delta":"Answer"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');}
    if(path==="/api/chat/finish")return Response.json({saved:true});
    throw new Error("Disabled source should not be called.");
  };
  for await(const event of browserChat({session_id:"test",api_key:"visitor",message:"test",provider:"openai",days:30,sources:sourceFlags},transport)){expect(event.type).not.toBe("error");}
  expect(selected).toHaveLength(empty?1:0);
});
