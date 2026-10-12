import type { SSEEvent } from "./client";
import { parseSSE } from "./browserTransport";

export type ObjectValue=Record<string,unknown>;
export const object=(value:unknown):ObjectValue=>value&&typeof value==="object"&&!Array.isArray(value)?value as ObjectValue:{};
export const array=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
export const string=(value:unknown):string=>typeof value==="string"?value:"";
export interface ToolSpec {type:string;name:string;description:string;parameters:ObjectValue}
export interface ToolCall {id:string;name:string;arguments:string;nativeId?:string}
export interface ProviderTurn {text:string;calls:ToolCall[];native:unknown[]}
export function providerPayload(provider:string,mode:string,model:string,system:string,conversation:unknown[],tools:ToolSpec[]) {
  if(provider==="openai"&&mode==="responses")return {model,instructions:system,input:conversation,tools,max_output_tokens:6000,store:false,include:["reasoning.encrypted_content"]};
  if(provider==="openai")return {model,messages:[{role:"system",content:system},...conversation],tools:tools.map(({name,description,parameters})=>({type:"function",function:{name,description,parameters}})),max_completion_tokens:6000,store:false};
  if(provider==="anthropic")return {model,system,messages:conversation,max_tokens:6000,tools:tools.map(({name,description,parameters})=>({name,description,input_schema:parameters}))};
  return {systemInstruction:{parts:[{text:system}]},contents:conversation,tools:[{functionDeclarations:tools.map(({name,description,parameters})=>({name,description,parametersJsonSchema:parameters}))}],generationConfig:{maxOutputTokens:6000}};
}
export async function* providerTurn(response:Response,provider:string,mode:string,signal?:AbortSignal):AsyncGenerator<SSEEvent,ProviderTurn> {
  let text="",complete=false,native:unknown[]=[];const calls=new Map<number,ToolCall>();
  for await(const {event,data} of parseSSE(response,signal)) {
    if(event==="error"||data.error||data.type==="response.failed"||data.type==="response.incomplete")throw new Error("The chat provider could not complete this request. Check its quota and model access.");
    let delta="",reasoning="";
    if(provider==="openai"&&mode==="responses") {
      const type=string(data.type)||event;
      if(type==="response.output_text.delta")delta=string(data.delta);
      if(type==="response.reasoning_summary_text.delta")reasoning=string(data.delta);
      if(type==="response.completed") {
        complete=true;native=array(object(data.response).output);
        for(const item of native) {const value=object(item);if(value.type==="function_call")calls.set(calls.size,{id:string(value.call_id),name:string(value.name),arguments:string(value.arguments)});}
      }
    } else if(provider==="openai") {
      const choice=object(array(data.choices)[0]),part=object(choice.delta);delta=string(part.content);
      for(const item of array(part.tool_calls)) {
        const value=object(item),index=Number(value.index),fn=object(value.function),call=calls.get(index)||{id:"",name:"",arguments:""};
        call.id+=string(value.id);call.name+=string(fn.name);call.arguments+=string(fn.arguments);calls.set(index,call);
      }
      if(choice.finish_reason){if(choice.finish_reason==="length"||choice.finish_reason==="content_filter")throw new Error("The provider ended this response before it was complete.");complete=true;}
    } else if(provider==="anthropic") {
      const index=Number(data.index),block=object(data.content_block),part=object(data.delta);
      if(data.type==="content_block_start"&&block.type==="tool_use")calls.set(index,{id:string(block.id),name:string(block.name),arguments:""});
      if(part.type==="text_delta")delta=string(part.text);
      if(part.type==="input_json_delta"){const call=calls.get(index);if(call)call.arguments+=string(part.partial_json);}
      if(data.type==="message_delta"&&part.stop_reason==="max_tokens")throw new Error("The provider ended this response at its output limit.");
      if(data.type==="message_stop")complete=true;
    } else {
      const candidate=object(array(data.candidates)[0]);
      for(const item of array(object(candidate.content).parts)) {
        const part=object(item);native.push(part);
        if(part.functionCall){const fn=object(part.functionCall);calls.set(calls.size,{id:string(fn.id)||crypto.randomUUID(),nativeId:string(fn.id)||undefined,name:string(fn.name),arguments:JSON.stringify(fn.args||{})});}
        else if(part.thought)reasoning+=string(part.text);else delta+=string(part.text);
      }
      if(candidate.finishReason){if(candidate.finishReason!=="STOP")throw new Error(`Gemini stopped the request: ${string(candidate.finishReason)}.`);complete=true;}
      if(data.promptFeedback&&object(data.promptFeedback).blockReason)throw new Error("Gemini declined this request.");
    }
    text+=delta;if(delta)yield {type:"assistant_delta",data:{delta}};
    if(reasoning)yield {type:"reasoning_summary",data:{text:reasoning}};
  }
  if(!complete)throw new Error("The provider stream ended before completion. Send a new inquiry to retry.");
  return {text,calls:[...calls.values()],native};
}
export function appendAssistant(conversation:unknown[],turn:ProviderTurn,provider:string,mode:string) {
  if(provider==="openai"&&mode==="responses")conversation.push(...turn.native);
  else if(provider==="openai")conversation.push({role:"assistant",content:turn.text||null,tool_calls:turn.calls.map(call=>({id:call.id,type:"function",function:{name:call.name,arguments:call.arguments}}))});
  else if(provider==="anthropic")conversation.push({role:"assistant",content:[...(turn.text?[{type:"text",text:turn.text}]:[]),...turn.calls.map(call=>({type:"tool_use",id:call.id,name:call.name,input:JSON.parse(call.arguments||"{}")}))]});
  else conversation.push({role:"model",parts:turn.native});
}
export function appendToolResults(conversation:unknown[],results:{call:ToolCall;result:ObjectValue;images:string[]}[],provider:string,mode:string) {
  if(provider==="openai")for(const {call,result,images} of results) {
    if(mode==="responses")conversation.push({type:"function_call_output",call_id:call.id,output:JSON.stringify(result)});
    else conversation.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(result)});
    if(images.length)conversation.push({role:"user",content:images.map(url=>mode==="responses"?{type:"input_image",image_url:url}:{type:"image_url",image_url:{url}})});
  }
  else if(provider==="anthropic")conversation.push({role:"user",content:results.map(({call,result,images})=>({type:"tool_result",tool_use_id:call.id,content:[{type:"text",text:JSON.stringify(result)},...images.map(url=>({type:"image",source:{type:"base64",media_type:"image/jpeg",data:url.split(",")[1]}}))]}))});
  else conversation.push({role:"user",parts:results.flatMap(({call,result,images})=>[{functionResponse:{...(call.nativeId?{id:call.nativeId}:{}),name:call.name,response:result}},...images.map(url=>({inlineData:{mimeType:"image/jpeg",data:url.split(",")[1]}}))])});
}
