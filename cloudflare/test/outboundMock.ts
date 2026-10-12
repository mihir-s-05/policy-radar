import { vi } from "vitest";
type Route={origin:string;path:string|RegExp;method?:string;headers?:Record<string,string>;response:Response};
const routes:Route[]=[];
export const fetchMock={
  activate(){vi.stubGlobal("fetch",vi.fn(async(url:string|URL,init:RequestInit={})=>{
    if(init.redirect==="error")throw new Error("Workers supports only manual or follow redirects.");
    const parsed=new URL(String(url)),headers=new Headers(init.headers);
    const index=routes.findIndex(route=>route.origin===parsed.origin&&(typeof route.path==="string"?route.path===parsed.pathname+parsed.search:route.path.test(parsed.pathname+parsed.search))&&(route.method||"GET")===(init.method||"GET")&&Object.entries(route.headers||{}).every(([key,value])=>headers.get(key)===value));
    if(index<0)throw new Error(`Unexpected outbound request: ${parsed.origin}${parsed.pathname}`);
    return routes.splice(index,1)[0].response;
  }));},
  disableNetConnect(){},
  assertNoPendingInterceptors(){if(routes.length)throw new Error(`${routes.length} outbound mock(s) unused.`);},
  get(origin:string){return {intercept(options:Omit<Route,"origin"|"response">){return {reply(status:number,value:unknown,optionsResponse:{headers?:Record<string,string>}={}){routes.push({origin,...options,response:new Response(typeof value==="string"?value:JSON.stringify(value),{status,headers:optionsResponse.headers})});}};}};},
};
