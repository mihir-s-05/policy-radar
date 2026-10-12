import { useEffect, useRef, useState } from "react";
import { apiTransport } from "../api/client";
import { clearLocalData,exportLocalData,importLocalData,listLocalSessions,MAX_BACKUP_BYTES,storageCounts } from "../lib/browserStore";
import type { LocalSession } from "../lib/browserStore";
import type { MessageItem, SessionInfo } from "../types";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

export function BrowserDataPanel() {
  const [status,setStatus]=useState(""),[busy,setBusy]=useState(false),[counts,setCounts]=useState<Record<string,number>>({});
  const [recovery,setRecovery]=useState(""),[imported,setImported]=useState<string[]>([]),[exported,setExported]=useState(false);
  const [scope,setScope]=useState(""),[sessions,setSessions]=useState<SessionInfo[]>([]);
  const [confirmation,setConfirmation]=useState<"clear"|"server"|null>(null);
  const file=useRef<HTMLInputElement>(null);
  const refresh=async()=>{setCounts(await storageCounts());setSessions((await listLocalSessions()).sessions);};
  useEffect(()=>{void Promise.all([storageCounts(),listLocalSessions()]).then(([counts,result])=>{setCounts(counts);setSessions(result.sessions);}).catch(error=>setStatus(error.message));},[]);
  async function run(operation:()=>Promise<string>) {
    setBusy(true);setStatus("");try{setStatus(await operation());await refresh();}catch(error){setStatus(error instanceof Error?error.message:"Saved-data operation failed.");}finally{setBusy(false);}
  }
  async function importServer() {
    const headers=recovery.trim()?{"X-Session-Token":recovery.trim()}:undefined;
    if(recovery.trim()&&!/^[a-f0-9]{64}$/.test(recovery.trim()))throw new Error("Use the 64-character migration code from the original browser.");
    const sessions:LocalSession[]=[];let offset=0,more=true;
    while(more){
      const response=await apiTransport(`/api/legacy/sessions?offset=${offset}`,{headers});if(!response.ok)throw new Error("Server import failed. Check your migration code and retry.");
      const page=await response.json() as {sessions:{session_id:string;created_at:string}[];has_more:boolean;next_offset:number};
      for(const row of page.sessions){let after=0,moreMessages=true;const messages:MessageItem[]=[];
        while(moreMessages){const response=await apiTransport(`/api/legacy/sessions/${row.session_id}/messages?after_id=${after}`,{headers});if(!response.ok)throw new Error("A server conversation could not be imported. Server copies remain unchanged.");const data=await response.json();messages.push(...data.messages);after=data.next_after_id;moreMessages=data.has_more;if(messages.length>2000)throw new Error("A conversation exceeds the import limit. Server copies are preserved; export it in smaller parts.");}
        sessions.push({...row,messages});if(sessions.length>500)throw new Error("Server history exceeds the import limit. Server copies are preserved; export it in smaller parts.");
      }
      more=page.has_more;offset=page.next_offset;
    }
    if(!sessions.length)return "No server conversations belong to this browser or migration code.";
    await importLocalData(JSON.stringify({format:"policy-radar-local",version:1,sessions,documents:[],artifacts:[]}));
    setImported(sessions.map(row=>row.session_id));setExported(false);
    return `Imported ${sessions.length} conversations. Server copies remain intact. Export a backup before deleting them.`;
  }
  return <section className="browser-data-panel flex flex-col gap-4 text-sm ink-text" style={{fontFamily:"'Spectral', serif"}}>
    <p>Saved on this browser. Backups include conversations, documents and vectors; they exclude API keys.</p>
    <p className="text-xs ink-faded">{counts.sessions??0} conversations · {counts.documents??0} document indexes · {counts.artifacts??0} research artifacts. Export to keep a copy or move devices.</p>
    <label className="flex flex-col gap-1 text-xs">Backup scope<select aria-label="Backup scope" className="btn-parchment rounded border border-sepia-light/50 p-2" value={scope} onChange={event=>setScope(event.target.value)}><option value="">All conversations</option>{sessions.map(row=><option key={row.session_id} value={row.session_id}>{row.title?.slice(0,60)||"New chat"}</option>)}</select></label>
    <div className="flex flex-wrap gap-2">
      <Button className="btn-parchment" variant="outline" size="sm" disabled={busy} onClick={()=>void run(async()=>{const backup=await exportLocalData(scope||undefined),url=URL.createObjectURL(new Blob([backup],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download=`policy-radar-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10_000);setExported(!scope);return "Backup downloaded. Keep it somewhere safe; it contains your saved research.";})}>Export saved data</Button>
      <Button className="btn-parchment" variant="outline" size="sm" disabled={busy} onClick={()=>file.current?.click()}>Import saved data</Button>
      <input ref={file} type="file" accept="application/json,.json" className="hidden" aria-label="Saved-data backup" onChange={event=>{const selected=event.target.files?.[0];event.target.value="";if(selected)void run(async()=>{if(selected.size>MAX_BACKUP_BYTES)throw new Error("Backups must be smaller than 50 MB.");const result=await importLocalData(await selected.text());setExported(false);return `Imported ${result.sessions} conversations. Existing local conversations were preserved.`;});}}/>
      <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={()=>setConfirmation("clear")}>Clear saved data</Button>
    </div>
    <details className="border-t border-sepia-light/30 pt-3">
      <summary className="cursor-pointer">Import previous server conversations</summary>
      <div className="flex flex-col gap-2 pt-3">
        <p className="text-xs ink-faded">Use the original browser, or its migration code when moving from the old URL. Existing server conversations are retained until you import, export, and explicitly delete their copies. The old URL and this domain have separate browser storage; a backup transfers documents and vectors between them.</p>
        <Input type="password" aria-label="Migration code" placeholder="Migration code (optional in the original browser)" value={recovery} onChange={event=>setRecovery(event.target.value)} className="btn-parchment"/>
        <Button variant="outline" size="sm" disabled={busy} onClick={()=>void run(importServer)}>Import server conversations</Button>
        <Button variant="ghost" size="sm" className="text-destructive" disabled={busy||!imported.length||!exported} onClick={()=>setConfirmation("server")}>Delete imported server copies</Button>
      </div>
    </details>
    {confirmation&&<div className="rounded border border-sepia-light/50 p-3" role="group" aria-label="Confirm saved-data removal">
      <p className="text-xs">{confirmation==="clear"?"Clear saved conversations, documents, and indexes on this device? Export a backup first. A backup is required to restore them.":"Delete only the server copies you imported and exported? Your local copies and backup remain."}</p>
      <div className="mt-2 flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={()=>setConfirmation(null)}>Cancel</Button><Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={()=>{const action=confirmation;setConfirmation(null);void run(async()=>{
        if(action==="clear"){await clearLocalData();window.dispatchEvent(new Event("policy-data-changed"));setImported([]);setExported(false);setScope("");return "Saved data cleared on this device. Your tab's API keys are unchanged.";}
        for(let i=0;i<imported.length;i+=50){const response=await apiTransport("/api/legacy/delete-imported",{method:"POST",headers:{"Content-Type":"application/json",...(recovery.trim()?{"X-Session-Token":recovery.trim()}:{})},body:JSON.stringify({session_ids:imported.slice(i,i+50),confirm_imported:true})});if(!response.ok)throw new Error("Deletion stopped. Local copies remain; some server copies may already have been deleted.");}
        setImported([]);return "Imported server copies deleted. The local copies remain.";
      });}}>Confirm removal</Button></div>
    </div>}
    {status&&<p role="status" className="text-xs">{status}</p>}
  </section>;
}
