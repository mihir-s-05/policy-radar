export type Transport = (path:string,options?:RequestInit)=>Promise<Response>;
export async function requestJSON<T>(transport:Transport,path:string,input:unknown,signal?:AbortSignal):Promise<T> {
  const response=await transport(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input),signal});
  const data=await response.json();
  if(!response.ok) throw new Error(data.detail||`Request failed (${response.status}).`);
  return data as T;
}
export async function* parseSSE(response:Response,signal?:AbortSignal):AsyncGenerator<{event:string;data:Record<string,unknown>}> {
  const reader=response.body?.getReader();if(!reader) throw new Error("No provider response body.");
  const decoder=new TextDecoder();let buffer="";
  const cancel=()=>{void reader.cancel().catch(()=>undefined);};signal?.addEventListener("abort",cancel,{once:true});
  try {
    while(true) {
      signal?.throwIfAborted();const chunk=await reader.read();if(chunk.done) break;
      buffer=(buffer+decoder.decode(chunk.value,{stream:true})).replace(/\r\n/g,"\n");
      let end:number;
      while((end=buffer.indexOf("\n\n"))>=0) {
        const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
        const lines=frame.split("\n"),event=lines.find(x=>x.startsWith("event:"))?.slice(6).trim()||"message";
        const data=lines.filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trim()).join("\n");
        if(!data||data==="[DONE]") continue;
        yield {event,data:JSON.parse(data) as Record<string,unknown>};
      }
    }
    signal?.throwIfAborted();
  } finally {signal?.removeEventListener("abort",cancel);await reader.cancel();reader.releaseLock();}
}
