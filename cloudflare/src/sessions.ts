import { body, HttpError, json, ownsSession, text } from "./http";

export async function sessions(request: Request, env: Env, ownerHash: string, path: string): Promise<Response | null> {
  if (path === "/api/session" && request.method === "POST") {
    const session_id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO sessions VALUES(?,?,?)").bind(session_id,ownerHash,new Date().toISOString()).run();
    return json({session_id});
  }
  if (path === "/api/sessions" && request.method === "GET") {
    const result = await env.DB.prepare(`SELECT s.session_id,s.created_at,
      (SELECT content FROM messages m WHERE m.session_id=s.session_id ORDER BY id DESC LIMIT 1) last_message,
      (SELECT created_at FROM messages m WHERE m.session_id=s.session_id ORDER BY id DESC LIMIT 1) last_message_at,
      (SELECT content FROM messages m WHERE m.session_id=s.session_id AND role='user' ORDER BY id LIMIT 1) title
      FROM sessions s WHERE owner_hash=? ORDER BY COALESCE(last_message_at,s.created_at) DESC LIMIT 50`)
      .bind(ownerHash).all();
    return json({sessions:result.results});
  }
  const match = path.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/messages(?:\/(\d+))?)?$/);
  if (match) {
    const id = match[1]; await ownsSession(env,ownerHash,id);
    if (request.method === "DELETE" && !path.includes("messages")) {
      await env.DB.prepare("DELETE FROM sessions WHERE session_id=? AND owner_hash=?").bind(id,ownerHash).run();
      return json({session_id:id,deleted:true});
    }
    if (request.method === "GET" && path.endsWith("/messages")) {
      const rows = await env.DB.prepare("SELECT id,role,content,created_at,sources_json,steps_json,model FROM messages WHERE session_id=? ORDER BY id LIMIT 200")
        .bind(id).all<{id:number;role:string;content:string;created_at:string;sources_json:string|null;steps_json:string|null;model:string|null}>();
      return json({session_id:id,messages:rows.results.map(({sources_json,steps_json,...row}) => ({...row,sources:sources_json?JSON.parse(sources_json):[],steps:steps_json?JSON.parse(steps_json):[]}))});
    }
    if (request.method === "PATCH" && match[2]) {
      const input=await body(request,100_000), content=text(input.content,80_000);
      const update=await env.DB.prepare("UPDATE messages SET content=? WHERE id=? AND session_id=?").bind(content,Number(match[2]),id).run();
      return json({updated:update.meta.changes>0});
    }
  }
  if (path === "/api/chat/start" && request.method === "POST") {
    const input=await body(request,30_000), id=text(input.session_id,100), requestId=text(input.request_id,100);
    if (!text(input.api_key,500).trim()) throw new HttpError(400,"Enter your own provider API key in Configuration before sending an inquiry.");
    if (!/^[a-zA-Z0-9-]{10,100}$/.test(requestId)) throw new HttpError(400,"Invalid inquiry identifier.");
    await ownsSession(env,ownerHash,id);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO requests(request_id,owner_hash,session_id,created_at) VALUES(?,?,?,?)").bind(requestId,ownerHash,id,new Date().toISOString()),
      env.DB.prepare("INSERT OR IGNORE INTO messages(session_id,role,content,request_id,created_at) VALUES(?,'user',?,?,?)").bind(id,text(input.message,20_000),requestId,new Date().toISOString()),
    ]);
    const messages=await env.DB.prepare("SELECT role,content FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 30").bind(id).all();
    return json({messages:messages.results.reverse()});
  }
  if (path === "/api/chat/finish" && request.method === "POST") {
    const input=await body(request,700_000), id=text(input.session_id,100), requestId=text(input.request_id,100);
    await ownsSession(env,ownerHash,id);
    const active=await env.DB.prepare("SELECT cancelled FROM requests WHERE owner_hash=? AND request_id=? AND session_id=?")
      .bind(ownerHash,requestId,id).first<{cancelled:number}>();
    if (!active || active.cancelled) throw new HttpError(409,"Inquiry has stopped.");
    await env.DB.prepare("INSERT OR IGNORE INTO messages(session_id,role,content,sources_json,steps_json,model,request_id,created_at) VALUES(?,'assistant',?,?,?,?,?,?)")
      .bind(id,text(input.answer_text,80_000),JSON.stringify(input.sources||[]),JSON.stringify(input.steps||[]),text(input.model,100),requestId,new Date().toISOString()).run();
    return json({saved:true});
  }
  if (path === "/api/chat/stop" && request.method === "POST") {
    const input=await body(request);
    await env.DB.prepare("UPDATE requests SET cancelled=1 WHERE owner_hash=? AND request_id=?").bind(ownerHash,text(input.request_id,100)).run();
    return json({request_id:input.request_id,stopped:true});
  }
  return null;
}
