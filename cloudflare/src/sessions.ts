import { body, HttpError, integer, json, ownsSession, text } from "./http";

// Frozen legacy data is readable only by its original capability. New hosted
// conversations never enter D1. Deletion is an explicit post-import action.
export async function legacySessions(request:Request,env:Env,ownerHash:string,path:string):Promise<Response|null> {
  if(path==="/api/legacy/sessions"&&request.method==="GET") {
    const offset=integer(Number(new URL(request.url).searchParams.get("offset")),0,100_000,0);
    const rows=await env.DB.prepare("SELECT session_id,created_at FROM sessions WHERE owner_hash=? ORDER BY created_at DESC,session_id LIMIT 50 OFFSET ?").bind(ownerHash,offset).all();
    return json({sessions:rows.results,has_more:rows.results.length===50,next_offset:offset+50});
  }
  const match=path.match(/^\/api\/legacy\/sessions\/([a-f0-9-]+)\/messages$/);
  if(match&&request.method==="GET") {
    await ownsSession(env,ownerHash,match[1]);
    const after=integer(Number(new URL(request.url).searchParams.get("after_id")),0,Number.MAX_SAFE_INTEGER,0);
    const rows=await env.DB.prepare("SELECT id,role,content,created_at,sources_json,steps_json,model FROM messages WHERE session_id=? AND id>? ORDER BY id LIMIT 200").bind(match[1],after).all<{id:number;role:string;content:string;created_at:string;sources_json:string|null;steps_json:string|null;model:string|null}>();
    return json({session_id:match[1],has_more:rows.results.length===200,next_after_id:rows.results.at(-1)?.id||after,messages:rows.results.map(({sources_json,steps_json,...row})=>({...row,sources:sources_json?JSON.parse(sources_json):[],steps:steps_json?JSON.parse(steps_json):[]}))});
  }
  if(path==="/api/legacy/delete-imported"&&request.method==="POST") {
    const input=await body(request,8000);
    if(!Array.isArray(input.session_ids)||input.session_ids.length>50||input.confirm_imported!==true)throw new HttpError(400,"Import and verify a local backup before deleting server copies.");
    const ids=input.session_ids.map(id=>text(id,100));
    for(const id of ids)await ownsSession(env,ownerHash,id);
    if(ids.length)await env.DB.batch(ids.map(id=>env.DB.prepare("DELETE FROM sessions WHERE session_id=? AND owner_hash=?").bind(id,ownerHash)));
    return json({deleted:ids.length});
  }
  return null;
}
