import type { Transport } from "./browserTransport";
import pdfWorkerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export interface BrowserDocument { title:string; full_text:string; images:string[]; truncated:boolean }
export async function readDocument(url:string,transport:Transport,signal?:AbortSignal,maxLength=500_000):Promise<BrowserDocument> {
  const response=await transport("/api/content/raw",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url}),signal});
  if(!response.ok){const error=await response.json();throw new Error(error.detail||"Document fetch failed.");}
  const bytes=new Uint8Array(await response.arrayBuffer());signal?.throwIfAborted();
  const pdf=response.headers.get("Content-Type")?.includes("pdf")||new TextDecoder().decode(bytes.slice(0,5))==="%PDF-";
  if(pdf) {
    const {getDocument,GlobalWorkerOptions}=await import("pdfjs-dist");GlobalWorkerOptions.workerSrc=pdfWorkerURL;
    const task=getDocument({data:bytes}),abort=()=>{void task.destroy();};
    signal?.addEventListener("abort",abort,{once:true});
    try {
      const document=await task.promise;let full_text="";const images:string[]=[];let pages=0;
      for(let number=1;number<=Math.min(document.numPages,200)&&full_text.length<maxLength;number++) {
        signal?.throwIfAborted();const page=await document.getPage(number),content=await page.getTextContent();
        const pageText=content.items.map(item=>"str" in item?item.str:"").join(" ");
        full_text+=`\n[Page ${number}]\n${pageText}`;pages++;
        // Preserve the existing image-reading path for scanned government PDFs.
        if(pageText.trim().length<80&&images.length<2) {
          const canvas=window.document.createElement("canvas"),viewport=page.getViewport({scale:0.8});
          canvas.width=viewport.width;canvas.height=viewport.height;
          await page.render({canvas,viewport}).promise;
          const encoded=canvas.toDataURL("image/jpeg",0.55);if(encoded.length<260_000)images.push(encoded);
          canvas.width=0;canvas.height=0;
        }
        page.cleanup();
      }
      return {title:decodeURIComponent(new URL(url).pathname.split("/").pop()||"Government PDF"),full_text:full_text.slice(0,maxLength),images,truncated:pages<document.numPages||full_text.length>maxLength};
    } finally {signal?.removeEventListener("abort",abort);await task.destroy();}
  }
  const raw=new TextDecoder().decode(bytes);
  if(response.headers.get("Content-Type")?.includes("html")||/^\s*<!doctype html|^\s*<html/i.test(raw)) {
    const document=new DOMParser().parseFromString(raw,"text/html");
    document.querySelectorAll("script,style,nav,header,footer,noscript").forEach(node=>node.remove());
    const value=(document.querySelector("main,article")||document.body).textContent?.replace(/\s+/g," ").trim()||"";
    return {title:document.title||"Government document",full_text:value.slice(0,maxLength),images:[],truncated:value.length>maxLength};
  }
  return {title:"Government document",full_text:raw.slice(0,maxLength),images:[],truncated:raw.length>maxLength};
}
