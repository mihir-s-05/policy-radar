import { it,expect } from "vitest";
import { parseSSE } from "../../frontend/src/api/browserTransport";
import { providerTurn,appendAssistant,appendToolResults } from "../../frontend/src/api/providerProtocol";
const sse=(events:unknown[])=>new Response(events.map(data=>`data: ${JSON.stringify(data)}\n\n`).join(""));
async function consume(response:Response,provider:string,mode="responses") {
  const generator=providerTurn(response,provider,mode);const events=[];let next=await generator.next();while(!next.done){events.push(next.value);next=await generator.next();}return {events,turn:next.value};
}
it("parses SSE event names and multibyte text across arbitrary chunk boundaries",async()=>{
  const bytes=new TextEncoder().encode('event: delta\r\ndata: {"text":"政策"}\r\n\r\n');
  const response=new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}}));
  const events=[];for await(const event of parseSSE(response))events.push(event);expect(events).toEqual([{event:"delta",data:{text:"政策"}}]);
});
it("keeps complete Responses output for the following tool turn",async()=>{
  const output=[{type:"function_call",call_id:"call1",name:"test",arguments:'{"query":"water"}'}];
  const {turn}=await consume(sse([{type:"response.completed",response:{output}}]),"openai");expect(turn.calls[0].name).toBe("test");
  const conversation:unknown[]=[];appendAssistant(conversation,turn,"openai","responses");appendToolResults(conversation,[{call:turn.calls[0],result:{count:1},images:[]}],"openai","responses");
  expect(conversation).toEqual([...output,{type:"function_call_output",call_id:"call1",output:'{"count":1}'}]);
});
it("assembles Chat Completions tool arguments across delta frames",async()=>{
  const {turn}=await consume(sse([{choices:[{delta:{tool_calls:[{index:0,id:"id",function:{name:"test",arguments:'{"query":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"water"}'}}]},finish_reason:"tool_calls"}]}]),"openai","chat_completions");
  expect(turn.calls).toEqual([{id:"id",name:"test",arguments:'{"query":"water"}'}]);
});
it("assembles Anthropic input_json_delta and returns native tool results",async()=>{
  const {turn}=await consume(sse([{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"id",name:"test",input:{}}},{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"query":"water"}'}},{type:"message_stop"}]),"anthropic");
  const conversation:unknown[]=[];appendAssistant(conversation,turn,"anthropic","native");appendToolResults(conversation,[{call:turn.calls[0],result:{count:1},images:[]}],"anthropic","native");
  expect(JSON.stringify(conversation)).toContain('"tool_use_id":"id"');expect(JSON.stringify(conversation)).toContain('"input":{"query":"water"}');
});
it("preserves Gemini thought signatures with native function call parts",async()=>{
  const part={functionCall:{name:"test",args:{query:"water"}},thoughtSignature:"signature"};
  const {turn}=await consume(sse([{candidates:[{content:{parts:[part]},finishReason:"STOP"}]}]),"gemini");
  const conversation:unknown[]=[];appendAssistant(conversation,turn,"gemini","native");expect(conversation).toEqual([{role:"model",parts:[part]}]);
});
it("fails on truncated provider streams and output limits",async()=>{
  await expect(consume(sse([{type:"response.output_text.delta",delta:"unfinished"}]),"openai")).rejects.toThrow("before completion");
  await expect(consume(sse([{choices:[{delta:{content:"truncated"},finish_reason:"length"}]}]),"openai","chat_completions")).rejects.toThrow("before it was complete");
});
