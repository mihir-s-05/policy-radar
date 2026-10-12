import { HttpError, integer, readBounded, sha256, text } from "./http";
import { reserve } from "./budget";

type Obj = Record<string, unknown>;
export const obj = (x:unknown):Obj => x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {};
export const list = (x:unknown):Obj[] => Array.isArray(x) ? x.map(obj) : [];
export const str = (x:unknown):string => typeof x === "string" ? x : typeof x === "number" ? String(x) : "";
export interface Source {
  source_type:string;id:string;title:string;url:string;agency?:string;date?:string;
  excerpt?:string;pdf_url?:string;content_type?:string;
}
function withoutGovernmentKeys(value:string,env:Env):string {
  for(const key of [env.GOV_API_KEY,env.SEARCHGOV_ACCESS_KEY])if(key) {
    value=value.replaceAll(key,"[redacted]").replaceAll(encodeURIComponent(key),"[redacted]");
  }
  return value;
}
const daysAgo = (days:number) => new Date(Date.now()-days*86400_000).toISOString().slice(0,10);

async function govBudget(env:Env) {
  // The daily bound limits cache growth and D1 work even under rotating clients.
  // Keep a reservation when the hourly limit/upstream fails: no blind refunds.
  await reserve(env,`gov-day:${new Date().toISOString().slice(0,10)}`,1,integer(Number(env.GOV_DAILY_BUDGET),4000,4000));
  const minute=Math.floor(Date.now()/60000), bucket=`gov:${minute}`;
  const maximum=integer(Number(env.GOV_HOURLY_BUDGET),800,800);
  const row=await env.DB.prepare(`INSERT INTO budgets(bucket,used)
    SELECT ?,1 WHERE (SELECT COALESCE(SUM(used),0) FROM budgets
      WHERE bucket>=? AND bucket<=?)<?
    ON CONFLICT(bucket) DO UPDATE SET used=used+1 RETURNING used`)
    .bind(bucket,`gov:${minute-60}`,bucket,maximum).first();
  if (!row) throw new HttpError(429,"The shared government request budget is temporarily exhausted.");
}
export async function governmentJSON(env:Env, url:URL, payload?:Obj):Promise<Obj> {
  const cacheKey=await sha256(`${url}:${JSON.stringify(payload||null)}`);
  const now=Math.floor(Date.now()/1000);
  const cached=await env.DB.prepare("SELECT payload FROM upstream_cache WHERE cache_key=? AND expires_at>?").bind(cacheKey,now).first<{payload:string}>();
  if (cached) return obj(JSON.parse(withoutGovernmentKeys(cached.payload,env)));
  await govBudget(env);
  const headers=new Headers({"Accept":"application/json"});
  if (["api.regulations.gov","api.govinfo.gov","api.congress.gov"].includes(url.hostname)) {
    if (!env.GOV_API_KEY) throw new HttpError(503,"The government data key has not been configured.");
    headers.set("X-Api-Key",env.GOV_API_KEY);
  }
  if (url.hostname==="api.gsa.gov") {
    if (!env.SEARCHGOV_ACCESS_KEY || !env.SEARCHGOV_AFFILIATE) throw new HttpError(503,"Search.gov access has not been configured.");
    url.searchParams.set("access_key",env.SEARCHGOV_ACCESS_KEY);
    url.searchParams.set("affiliate",env.SEARCHGOV_AFFILIATE);
  }
  if (payload) headers.set("Content-Type","application/json");
  const response=await fetch(url.href,{method:payload?"POST":"GET",headers,body:payload?JSON.stringify(payload):undefined,redirect:"manual",signal:AbortSignal.timeout(30_000)});
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status===429?429:502,`Government source returned HTTP ${response.status}.`); }
  const data=withoutGovernmentKeys(await readBounded(response,600_000),env);
  const parsed=JSON.parse(data);
  const normalized=Array.isArray(parsed)?{results:parsed}:obj(parsed);
  const serialized=JSON.stringify(normalized);
  // Cache only bounded public JSON; large results still reach the browser.
  // At 800 cache misses/hour, a ten-minute TTL + hourly cleanup stays small.
  if(new TextEncoder().encode(serialized).length<=64_000)await env.DB.prepare("INSERT INTO upstream_cache VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at")
    .bind(cacheKey,serialized,now+600).run();
  return normalized;
}
const withParams=(base:string,params:Obj) => {
  const url=new URL(base); for(const [key,value] of Object.entries(params)) if(value!==undefined&&value!==null&&value!=="") url.searchParams.set(key,str(value));
  return url;
};
const source=(type:string,id:unknown,title:unknown,url:string,extra:Partial<Source>={}):Source => ({source_type:type,id:str(id),title:str(title)||"Untitled",url,...extra});
function regs(row:Obj,docket=false) {
  const a=obj(row.attributes),id=str(row.id);
  return source(docket?"regulations_docket":"regulations_document",id,a.title,`https://www.regulations.gov/${docket?"docket":"document"}/${encodeURIComponent(id)}`,
    {agency:str(a.agencyId),date:str(a.postedDate||a.lastModifiedDate),excerpt:str(a.summary||a.abstract).slice(0,1000)});
}
function govinfo(row:Obj,packageSummary=false) {
  const id=str(row.packageId);
  return source(packageSummary?"govinfo_package":"govinfo_result",id,row.title,`https://www.govinfo.gov/app/details/${encodeURIComponent(id)}`,
    {agency:str(row.publisher||row.governmentAuthor),date:str(row.dateIssued||row.lastModified),excerpt:str(row.abstract||row.description).slice(0,1000)});
}
export async function tool(env:Env,name:string,args:Obj):Promise<{result:Obj;sources:Source[]}> {
  const limit=integer(args.limit||args.page_size||args.per_page||args.rows,10,20),days=integer(args.days,30,90,7);
  const query=text(args.query||args.search_term||args.keywords,2000);
  let rows:Obj[]=[],sources:Source[]=[],result:Obj={};
  if(name==="regs_search_documents"||name==="regs_search_dockets") {
    const docket=name.endsWith("dockets");
    const data=await governmentJSON(env,withParams(`https://api.regulations.gov/v4/${docket?"dockets":"documents"}`,{
      "filter[searchTerm]":query,"page[size]":Math.max(5,limit),"sort":docket?"-lastModifiedDate":"-postedDate",
      ...(!docket?{"filter[postedDate][ge]":daysAgo(days)}:{}),
    })); rows=list(data.data).slice(0,limit);sources=rows.map(r=>regs(r,docket));
  } else if(name==="regs_get_document"||name==="regs_read_document_content") {
    const id=text(args.document_id,150),data=await governmentJSON(env,withParams(`https://api.regulations.gov/v4/documents/${encodeURIComponent(id)}`,{"include":"attachments"}));
    const row=obj(data.data),attrs=obj(row.attributes);sources=[regs(row)];
    const files=[...list(attrs.fileFormats),...list(data.included).flatMap(x=>list(obj(x.attributes).fileFormats))];
    result={document_id:id,...attrs,content_url:str(files.find(x=>str(x.format).toLowerCase()==="pdf")?.fileUrl||files[0]?.fileUrl||attrs.fileUrl)};
  } else if(name==="govinfo_search") {
    const collection=text(args.collection,50), parts=[];
    if(collection&&!query.toLowerCase().includes("collection:")) parts.push(`collection:${collection}`);
    parts.push(query);
    if(!query.toLowerCase().includes("publishdate:range")&&!query.toLowerCase().includes("dateissued:range")) parts.push(`publishdate:range(${daysAgo(days)},)`);
    const data=await governmentJSON(env,new URL("https://api.govinfo.gov/search"),{query:parts.join(" AND "),pageSize:String(limit),offsetMark:"*",sorts:[{field:"lastModified",sortOrder:"DESC"}]});
    rows=list(data.results);sources=rows.map(r=>govinfo(r));
  } else if(name==="govinfo_package_summary"||name==="govinfo_read_package_content") {
    const id=text(args.package_id,150),data=await governmentJSON(env,new URL(`https://api.govinfo.gov/packages/${encodeURIComponent(id)}/summary`));
    sources=[govinfo(data,true)];result={...data,package_id:id,content_url:`https://www.govinfo.gov/content/pkg/${encodeURIComponent(id)}/html/${encodeURIComponent(id)}.htm`,pdf_url:`https://www.govinfo.gov/content/pkg/${encodeURIComponent(id)}/pdf/${encodeURIComponent(id)}.pdf`};
    sources[0].pdf_url=str(result.pdf_url);
  } else if(name==="federal_register_search") {
    const data=await governmentJSON(env,withParams("https://www.federalregister.gov/api/v1/documents.json",{
      "conditions[term]":query,"conditions[type][]":args.document_type,"conditions[agencies][]":args.agency,
      "conditions[publication_date][gte]":daysAgo(days),"per_page":limit,"order":"newest",
    }));rows=list(data.results);sources=rows.map(r=>source("federal_register",r.document_number,r.title,str(r.html_url),{
      agency:list(r.agencies).map(a=>str(a.name)).join(", "),date:str(r.publication_date),excerpt:str(r.abstract),pdf_url:str(r.pdf_url),
    }));
  } else if(name==="congress_search_bills"||name==="congress_search_votes") {
    const congress=integer(args.congress,119,999),votes=name.endsWith("votes"),chamber=args.chamber==="senate"?"senate":"house";
    const url=withParams(`https://api.congress.gov/v3/${votes?`${chamber}/rollCall/${congress}`:`bill/${congress}`}`,{format:"json",limit,offset:integer(args.offset,0,10000,0)});
    const data=await governmentJSON(env,url);rows=list(votes?(data.roll_calls||data.rollCalls):(data.bills));
    if(!votes&&query) rows=rows.filter(r=>str(r.title).toLowerCase().includes(query.toLowerCase())||str(r.number).includes(query));
    sources=rows.map(r=>votes?source("congress_vote",r.rollNumber||r.rollCallNumber,r.question||"Roll call vote",`https://www.congress.gov/roll-call-vote/${congress}th-congress-${str(r.session)}/${chamber}/${str(r.rollNumber||r.rollCallNumber)}`,{date:str(r.date||r.updateDate),excerpt:str(r.result)}):
      source("congress_bill",`${congress}-${str(r.type)}-${str(r.number)}`,r.title,`https://www.congress.gov/bill/${congress}th-congress/${str(r.type).toLowerCase()}/${str(r.number)}`,{date:str(r.updateDate),excerpt:str(obj(r.latestAction).text)}));
  } else if(name==="usaspending_search") {
    const codes:{[key:string]:string[]}={contracts:["A","B","C","D"],grants:["02","03","04","05"],loans:["07","08"],direct_payments:["06","10"]};
    const filters:Obj={award_type_codes:codes[text(args.award_type)]||codes.contracts,time_period:[{start_date:daysAgo(days),end_date:new Date().toISOString().slice(0,10)}]};
    if(Array.isArray(args.keywords)) filters.keywords=args.keywords;
    if(args.agency) filters.agencies=[{type:"awarding",tier:"toptier",name:text(args.agency)}];
    if(args.recipient) filters.recipient_search_text=[text(args.recipient)];
    const data=await governmentJSON(env,new URL("https://api.usaspending.gov/api/v2/search/spending_by_award/"),{filters,fields:["Award ID","Recipient Name","Award Amount","Start Date","Awarding Agency","Award Description"],limit,page:1,sort:"Award Amount",order:"desc"});
    rows=list(data.results);sources=rows.map(r=>source("usaspending",r.generated_internal_id||r["Award ID"],r["Recipient Name"],`https://www.usaspending.gov/award/${encodeURIComponent(str(r.generated_internal_id||r["Award ID"]))}`,{agency:str(r["Awarding Agency"]),date:str(r["Start Date"]),excerpt:`Amount: ${str(r["Award Amount"])}. ${str(r["Award Description"])}`}));
  } else if(name==="fiscal_data_query") {
    const paths:{[key:string]:string}={debt_to_penny:"/v2/accounting/od/debt_to_penny",debt_outstanding:"/v1/debt/mspd/mspd_table_1",treasury_offset:"/v1/debt/top/top_state",interest_rates:"/v1/accounting/od/avg_interest_rates",monthly_receipts:"/v1/accounting/mts/mts_table_4",monthly_outlays:"/v1/accounting/mts/mts_table_5",federal_surplus_deficit:"/v2/accounting/od/statement_net_cost"};
    const dataset=text(args.dataset);if(!paths[dataset]) throw new HttpError(400,"Unknown fiscal dataset.");
    const filters=obj(args.filters);
    const data=await governmentJSON(env,withParams("https://api.fiscaldata.treasury.gov/services/api/fiscal_service"+paths[dataset],{
      "page[size]":limit,"sort":text(args.sort)||"-record_date","fields":Array.isArray(args.fields)?args.fields.map(str).join(","):undefined,
      "filter":Object.entries(filters).map(([k,v])=>`${k}:${str(v)}`).join(","),
    }));rows=list(data.data);sources=rows.map(r=>source("fiscal_data",`${dataset}-${str(r.record_date)}`,`Treasury ${dataset}: ${str(r.record_date)}`,`https://fiscaldata.treasury.gov/datasets/${dataset.replaceAll("_","-")}`,{agency:"U.S. Treasury",date:str(r.record_date),excerpt:JSON.stringify(r)}));
  } else if(name==="datagov_search") {
    const fq=[];if(args.organization) fq.push(`organization:"${text(args.organization)}"`);if(args.format||args.res_format) fq.push(`res_format:"${text(args.format||args.res_format)}"`);
    if(Array.isArray(args.groups)) fq.push(...args.groups.map(x=>`groups:"${str(x)}"`));
    const data=await governmentJSON(env,withParams("https://catalog.data.gov/api/3/action/package_search",{q:query,rows:limit,start:0,fq:fq.join(" AND ")}));
    rows=list(obj(data.result).results);sources=rows.map(r=>source("datagov",r.id||r.name,r.title,`https://catalog.data.gov/dataset/${encodeURIComponent(str(r.name||r.id))}`,{agency:str(obj(r.organization).title),date:str(r.metadata_modified),excerpt:str(r.notes).slice(0,1000),pdf_url:str(list(r.resources).find(x=>str(x.format).toLowerCase()==="pdf")?.url)}));
  } else if(name==="doj_search") {
    const data=await governmentJSON(env,withParams("https://www.justice.gov/api/v1/press_releases.json",{keyword:query,component:args.component,pagesize:limit,page:0,sort:"date",direction:"DESC"}));
    rows=list(data.results||data.data);sources=rows.map(r=>source("doj_press_release",r.uuid||r.nid,r.title,str(r.url)||`https://www.justice.gov${str(r.path)}`,{agency:"Department of Justice",date:r.created?new Date(Number(r.created)*1000).toISOString().slice(0,10):undefined,excerpt:str(obj(r.body).summary||r.teaser)}));
  } else if(name==="searchgov_search") {
    const data=await governmentJSON(env,withParams("https://api.gsa.gov/technology/searchgov/v2/results/i14y",{query,limit,enable_highlighting:"false"}));
    rows=list(obj(data.web).results);sources=rows.map(r=>source("searchgov",r.link,r.title,str(r.link),{excerpt:str(r.snippet),date:str(r.publication_date)}));
  } else if(name==="fetch_url_content") {
    result={content_url:text(args.url,4000)};
  } else throw new HttpError(400,"Unknown government tool.");
  return {result: Object.keys(result).length?result:{count:rows.length,documents:sources,records:rows},sources};
}

export function officialURL(value:string):URL {
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||url.port||!/(^|\.)(gov|mil)$/.test(url.hostname))
    throw new HttpError(400,"Only HTTPS government document URLs are supported.");
  return url;
}
export async function documentResponse(value:string,env:Env):Promise<Response> {
  let url=officialURL(value);
  for(let redirects=0;redirects<4;redirects++) {
    await govBudget(env);
    const headers=new Headers();
    if(url.hostname==="api.govinfo.gov"&&env.GOV_API_KEY) headers.set("X-Api-Key",env.GOV_API_KEY);
    const response=await fetch(url,{headers,redirect:"manual",signal:AbortSignal.timeout(30_000)});
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get("Location");await response.body?.cancel();
      if(!location) throw new HttpError(502,"Document redirect has no destination.");
      url=officialURL(new URL(location,url).href);continue;
    }
    if(!response.ok) {await response.body?.cancel();throw new HttpError(502,`Document source returned HTTP ${response.status}.`);}
    if(Number(response.headers.get("Content-Length"))>12_000_000) {await response.body?.cancel();throw new HttpError(413,"Document exceeds the 12 MB limit.");}
    const max=12_000_000;let total=0;
    return new Response(response.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){total+=chunk.byteLength;if(total>max)controller.error(new Error("Document exceeds the 12 MB limit."));else controller.enqueue(chunk);}})),{
      headers:{"Content-Type":response.headers.get("Content-Type")||"application/octet-stream","Cache-Control":"private, max-age=600","X-Content-Type-Options":"nosniff"},
    });
  }
  throw new HttpError(502,"Too many document redirects.");
}
