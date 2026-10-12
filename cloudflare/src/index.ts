import { body, HttpError, json, owner, text } from "./http";
import { config } from "./config";
import { embeddings } from "./embeddings";
import { legacySessions } from "./sessions";
import { provider } from "./providers";
import { documentResponse, tool } from "./government";
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
      else if(path==="/api/health") response=json({status:"ok",hosting:"workers",storage:"indexeddb",embedding_daily_reservations:Number(env.EMBEDDING_DAILY_BUDGET),embeddings_enabled:String(env.EMBEDDINGS_ENABLED)==="true"});
      else {
        // Cloudflare sets this header at ingress. Changing a browser token or
        // session ID cannot rotate these burst keys. Shared IPs share a limit.
        // These counters are per-location and approximate, NOT global budgets.
        const ip=request.headers.get("CF-Connecting-IP")||"local-development";
        if(!(await env.BURST_LIMIT.limit({key:`policy:${ip}`})).success||!(await env.SHARED_BURST_LIMIT.limit({key:"policy-radar"})).success)
          throw new HttpError(429,"Please wait a minute before making more API requests.","visitor_rate_limited");
        if(path.startsWith("/api/legacy/")) {
          const legacy=await legacySessions(request,env,await owner(request),path);
          if(!legacy)throw new HttpError(404,"Migration endpoint not found.");
          response=legacy;
        }
        else if(path==="/api/session"||path==="/api/sessions"||path.startsWith("/api/sessions/")||path.startsWith("/api/chat/"))throw new HttpError(410,"Reload the app to save conversations in this browser. Existing server copies remain available under Configuration → Saved data.","browser_storage_required");
        else if(path==="/api/research-spec"&&request.method==="GET") response=json(spec);
        else if(path==="/api/embeddings"&&request.method==="POST") {
          if(!(await env.EMBEDDING_BURST_LIMIT.limit({key:`policy:${ip}`})).success)throw new HttpError(429,"Please wait a minute before embedding more documents.","visitor_rate_limited");
          response=await embeddings(request,env);
        }
        else if(path==="/api/provider/stream"&&request.method==="POST") response=await provider(request);
        else if(path==="/api/validate-model"&&request.method==="POST") response=await provider(request,true);
        else if(path==="/api/tools"&&request.method==="POST") {
          const input=await body(request),name=text(input.name,100);
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
      env.DB.prepare("DELETE FROM budgets WHERE bucket LIKE 'visitor:%' OR (bucket LIKE 'gov:%' AND CAST(SUBSTR(bucket,5) AS INTEGER)<?)").bind(Math.floor(Date.now()/60000)-120),
    ]);
  },
} satisfies ExportedHandler<Env>;
