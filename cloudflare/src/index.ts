import { body, HttpError, json, owner, ownsSession, text } from "./http";
import { config } from "./config";
import { embeddings } from "./embeddings";
import { sessions } from "./sessions";
import { provider } from "./providers";
import { documentResponse, tool } from "./government";
import { reserve } from "./budget";
import spec from "./research-spec.json";

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
    const url=new URL(request.url),path=url.pathname;
    if(!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    const origin=request.headers.get("Origin");
    const localDev=["127.0.0.1","localhost"].includes(url.hostname);
    const allowedOrigin=origin===url.origin||(localDev&&origin&&/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin));
    const headers=new Headers({"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    if(origin&&allowedOrigin) {
      headers.set("Access-Control-Allow-Origin",origin);headers.set("Vary","Origin");
      headers.set("Access-Control-Allow-Headers","Content-Type,X-Session-Token");
      headers.set("Access-Control-Allow-Methods","GET,POST,PATCH,DELETE,OPTIONS");
    }
    if(request.method==="OPTIONS") return new Response(null,{status:allowedOrigin?204:403,headers});
    try {
      if(origin&&!allowedOrigin) throw new HttpError(403,"Request origin is not allowed.");
      let response:Response;
      if(path==="/api/config"&&request.method==="GET") response=json(config());
      else if(path==="/api/health") response=json({status:"ok",hosting:"workers",embeddings_enabled:String(env.EMBEDDINGS_ENABLED)==="true"});
      else {
        const ownerHash=await owner(request);
        try {await reserve(env,`visitor:${ownerHash}:${Math.floor(Date.now()/60000)}`,1,80);}
        catch(error){if(error instanceof HttpError)throw new HttpError(429,"Please wait a minute before making more API requests.","visitor_rate_limited");throw error;}
        const sessionResponse=await sessions(request,env,ownerHash,path);
        if(sessionResponse) response=sessionResponse;
        else if(path==="/api/research-spec"&&request.method==="GET") response=json(spec);
        else if(path==="/api/embeddings"&&request.method==="POST") response=await embeddings(request,env,ownerHash);
        else if(path==="/api/provider/stream"&&request.method==="POST") response=await provider(request,env,ownerHash);
        else if(path==="/api/validate-model"&&request.method==="POST") response=await provider(request,env,ownerHash,true);
        else if(path==="/api/tools"&&request.method==="POST") {
          const input=await body(request),name=text(input.name,100);
          await ownsSession(env,ownerHash,text(input.session_id,100));
          if(!spec.TOOLS.some(t=>t.name===name)) throw new HttpError(400,"Unknown research tool.");
          const args=input.args&&typeof input.args==="object"&&!Array.isArray(input.args)?input.args as Record<string,unknown>:{};
          const output=await tool(env,name,args);response=json({...output.result,sources:output.sources});
        } else if(path==="/api/content/raw"&&request.method==="POST") {
          const input=await body(request);response=await documentResponse(text(input.url,4000),env);
        } else throw new HttpError(404,"API endpoint not found.");
      }
      headers.forEach((value,key)=>response.headers.set(key,value));
      return response;
    } catch(error) {
      const known=error instanceof HttpError;
      if(!known) console.error(JSON.stringify({event:"request_failed",path,error_type:error instanceof Error?error.name:"unknown"}));
      const response=json({detail:known?error.message:"The request failed. Please try again.",code:known?error.code:"request_failed"},known?error.status:500);
      headers.forEach((value,key)=>response.headers.set(key,value));return response;
    }
  },
  async scheduled(_event:ScheduledController,env:Env):Promise<void> {
    const now=Math.floor(Date.now()/1000);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM upstream_cache WHERE expires_at<?").bind(now),
      env.DB.prepare("DELETE FROM budgets WHERE expires_at<?").bind(now),
      env.DB.prepare("DELETE FROM requests WHERE created_at<?").bind(new Date(Date.now()-2*86400_000).toISOString()),
    ]);
  },
} satisfies ExportedHandler<Env>;
