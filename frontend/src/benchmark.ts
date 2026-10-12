import { apiTransport,createSession,deleteSession,getConfig } from "./api/client";
import { embedTexts,rank,disposeLocalRuntime,indexDocument,queryDocuments,LOCAL_MODEL,CLOUDFLARE_MODEL } from "./lib/browserEmbeddings";
import { readDocument } from "./api/browserDocuments";
const topics=[
  ["air", "The Environmental Protection Agency limits fine particulate pollution from industrial facilities. The rule uses monitoring stations to measure emissions and requires permits and corrective action when air quality standards are exceeded."],
  ["water", "Public drinking water systems must test for perfluoroalkyl chemicals and notify residents about contamination. Utilities install filtration equipment to remove PFAS compounds and submit drinking water compliance results to the environmental agency."],
  ["housing", "A housing program provides rental assistance to low income families. Eligible tenants receive vouchers to cover part of their rent. Local housing authorities review household income and inspect participating apartments for health and safety."],
  ["student", "Education regulations govern income driven repayment of federal student loans. Borrowers certify earnings and family size annually. Monthly payments depend on discretionary income and qualifying payments count toward eventual loan forgiveness."],
  ["privacy", "Federal agencies must minimize collection of personal information and protect sensitive records. Privacy assessments explain data retention, third party sharing, and access controls. Individuals may request corrections to inaccurate government records."],
  ["energy", "The Department of Energy offers grants to upgrade electric transmission infrastructure. Funding supports grid reliability, renewable energy connections, and resilience during extreme weather. Applicants describe construction schedules and community benefits."],
  ["health", "Medicare establishes reimbursement rates for hospital services and outpatient care. Health providers submit claims for eligible treatments. The payment rule updates quality reporting requirements and adjusts reimbursement based on geographic costs."],
  ["food", "Food safety standards require manufacturers to identify biological hazards and maintain preventive controls. Facilities document sanitation procedures, ingredient tracing, and recall plans. Inspectors review records and test products for contamination."],
  ["cyber", "Critical infrastructure operators must report major cybersecurity incidents and ransomware payments. Reports identify affected systems and mitigation measures. The security agency shares technical indicators to help other organizations detect attacks."],
  ["labor", "Overtime protections require employers to pay eligible workers extra compensation for work beyond forty hours each week. Salary thresholds determine exemptions for executive and professional employees. Enforcement addresses unpaid wages."],
  ["trade", "Customs rules determine tariffs and duties on imported goods. Importers classify merchandise and report country of origin. Trade enforcement reviews undervaluation, prohibited products, and compliance with import documentation requirements."],
  ["transport", "Vehicle safety standards establish crash protection requirements and testing procedures. Manufacturers report safety defects and issue recalls. The transportation agency evaluates braking performance, occupant restraints, and collision prevention technologies."],
] as const;
const queries=[
  {text:"How are forever chemicals removed from tap water?",topic:"water"},
  {text:"Help with rent payments for families with limited earnings",topic:"housing"},
  {text:"Repaying college debt according to wages and household size",topic:"student"},
  {text:"Rules for extra pay when employees work long weeks",topic:"labor"},
  {text:"Reporting computer intrusions and extortion attacks on essential services",topic:"cyber"},
  {text:"Financial support to strengthen power lines against storms",topic:"energy"},
];
const corpus=topics.flatMap(([topic,text])=>Array.from({length:4},(_,i)=>({topic,text:`${text} This policy summary describes provision ${i+1}, implementation timelines, reporting duties, and administrative review for covered organizations.`})));
const status=document.querySelector<HTMLElement>("#status")!,results=document.querySelector<HTMLElement>("#results")!,details=document.querySelector<HTMLElement>("#details")!;
const buttons=[...document.querySelectorAll<HTMLButtonElement>("button")];let report:unknown;
const ms=(value:number)=>Math.round(value*100)/100;
async function measure(provider:"local"|"cloudflare",sessionId:string) {
  status.textContent=`${provider}: initializing and embedding first passage…`;
  const started=performance.now();const [first]=await embedTexts([corpus[0].text],provider,sessionId,apiTransport);const initial_ms=ms(performance.now()-started);
  status.textContent=`${provider}: embedding 48 passages…`;const batchStart=performance.now();const vectors=await embedTexts(corpus.map(x=>x.text),provider,sessionId,apiTransport);const corpus_ms=ms(performance.now()-batchStart);
  const searches=[];
  for(const query of queries) {
    status.textContent=`${provider}: searching “${query.text}”…`;const start=performance.now();const [vector]=await embedTexts([query.text],provider,sessionId,apiTransport);const embedded=performance.now();const ranked=await rank(vector,vectors,3);const finished=performance.now();
    searches.push({query:query.text,expected:query.topic,embedding_ms:ms(embedded-start),ranking_ms:ms(finished-embedded),top1_correct:corpus[ranked[0].index].topic===query.topic,top3_correct:ranked.some(x=>corpus[x.index].topic===query.topic),results:ranked.map(x=>({topic:corpus[x.index].topic,score:ms(x.score)}))});
  }
  status.textContent=`${provider}: checking persistent document indexing…`;const startIndex=performance.now();await indexDocument(sessionId,"benchmark-water",corpus[4].text,"https://www.epa.gov/test",provider,apiTransport);const index_ms=ms(performance.now()-startIndex);
  const repeatIndex=performance.now();await indexDocument(sessionId,"benchmark-water",corpus[4].text,"https://www.epa.gov/test",provider,apiTransport);const cached_index_ms=ms(performance.now()-repeatIndex);
  const memory=await queryDocuments(sessionId,queries[0].text,provider,apiTransport,3);
  let cached_reinitialization_ms:number|undefined;
  if(provider==="local") {disposeLocalRuntime();const reinit=performance.now();await embedTexts([queries[0].text],provider,sessionId,apiTransport);cached_reinitialization_ms=ms(performance.now()-reinit);}
  return {provider,model:provider==="local"?LOCAL_MODEL:CLOUDFLARE_MODEL,dimensions:first.length,initial_ms,corpus_ms,passages_per_second:ms(corpus.length/(corpus_ms/1000)),warm_query_mean_ms:ms(searches.reduce((sum,x)=>sum+x.embedding_ms,0)/queries.length),ranking_mean_ms:ms(searches.reduce((sum,x)=>sum+x.ranking_ms,0)/queries.length),top1_correct:searches.filter(x=>x.top1_correct).length,top3_correct:searches.filter(x=>x.top3_correct).length,index_ms,cached_index_ms,persistent_index_matches:memory.count,cached_reinitialization_ms,searches};
}
async function run(both:boolean) {
  buttons.forEach(button=>button.disabled=true);results.textContent="";details.textContent="";let sessionId:string|undefined;
  try {
    await getConfig();sessionId=(await createSession()).session_id;
    const measured=[],errors:Record<string,string>={};
    for(const provider of both?["local","cloudflare"] as const:["local"] as const)try {measured.push(await measure(provider,sessionId));}catch(error){errors[provider]=error instanceof Error?error.message:String(error);}
    report={timestamp:new Date().toISOString(),user_agent:navigator.userAgent,hardware_concurrency:navigator.hardwareConcurrency,passages:corpus.length,queries:queries.length,measured,errors};
    const table=document.createElement("table");table.innerHTML="<thead><tr><th>Provider</th><th>First use</th><th>48 passages</th><th>Warm query</th><th>Rank</th><th>Top 1 / Top 3</th></tr></thead>";
    for(const value of measured){const row=table.insertRow();for(const text of [value.provider,`${value.initial_ms} ms`,`${value.corpus_ms} ms`,`${value.warm_query_mean_ms} ms`,`${value.ranking_mean_ms} ms`,`${value.top1_correct}/6 · ${value.top3_correct}/6`])row.insertCell().textContent=text;}
    results.append(table);details.textContent=JSON.stringify(report,null,2);status.textContent=Object.keys(errors).length?"Finished with provider errors; see details.":"Finished. Both model indexes remained separate. The temporary test session has been removed.";
  } catch(error){status.textContent=error instanceof Error?error.message:String(error);}
  finally {if(sessionId)await deleteSession(sessionId);buttons.forEach(button=>button.disabled=false);}
}
document.querySelector("#local")!.addEventListener("click",()=>{void run(false);});document.querySelector("#both")!.addEventListener("click",()=>{void run(true);});
document.querySelector("#download")!.addEventListener("click",()=>{if(!report)return;const link=document.createElement("a"),url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));link.href=url;link.download="policy-radar-embedding-comparison.json";link.click();URL.revokeObjectURL(url);});
document.querySelector("#document-test")!.addEventListener("click",async()=>{
  const output=document.querySelector<HTMLElement>("#document-result")!;buttons.forEach(button=>button.disabled=true);
  try {output.textContent="Fetching and extracting on this device…";const start=performance.now();const result=await readDocument(document.querySelector<HTMLInputElement>("#document-url")!.value,apiTransport);
    output.textContent=JSON.stringify({title:result.title,characters:result.full_text.length,images:result.images.length,truncated:result.truncated,total_ms:ms(performance.now()-start),excerpt:result.full_text.slice(0,600)},null,2);
  }catch(error){output.textContent=error instanceof Error?error.message:String(error);}finally{buttons.forEach(button=>button.disabled=false);}
});
