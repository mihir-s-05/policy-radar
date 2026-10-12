/// <reference lib="webworker" />
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import wasmURL from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
import wasmModuleURL from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";

let extractor:FeatureExtractionPipeline|undefined;
let queue=Promise.resolve();
// Report the public asset that failed, and allow a fresh worker to retry after
// a failed WASM initialization. No chat or government credentials enter this worker.
const modelFetch=self.fetch.bind(self);
self.fetch=async(input,init)=>{
  try{return await modelFetch(input,init);}
  catch(error){const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);throw new Error(`Local model download failed at ${url.hostname}${url.pathname}: ${error instanceof Error?error.message:"network error"}`);}
};
self.onmessage=(event:MessageEvent<{id:string;type:string;texts?:string[];query?:number[];vectors?:(number[]|Float32Array)[];topK?:number}>)=>{
  queue=queue.then(async()=>{
    const {id,type}=event.data;
    try {
      if(type==="embed") {
        if(!extractor) {
          const {pipeline,env}=await import("@huggingface/transformers");
          env.allowLocalModels=true;env.allowRemoteModels=false;env.localModelPath="/models/";env.useBrowserCache=true;
          if(env.backends.onnx.wasm){env.backends.onnx.wasm.numThreads=1;env.backends.onnx.wasm.wasmPaths={wasm:new URL(wasmURL,self.location.href).href,mjs:new URL(wasmModuleURL,self.location.href).href};}
          const featurePipeline=pipeline as unknown as (task:"feature-extraction",model:string,options:Record<string,unknown>)=>Promise<FeatureExtractionPipeline>;
          extractor=await featurePipeline("feature-extraction","all-MiniLM-L6-v2",{
            dtype:"q8",device:"wasm",revision:"751bff37182d3f1213fa05d7196b954e230abad9",
            progress_callback:(progress:unknown)=>self.postMessage({id,progress}),
          });
        }
        const output=await extractor(event.data.texts||[],{pooling:"mean",normalize:true});
        self.postMessage({id,result:output.tolist()});
      } else if(type==="rank") {
        const query=event.data.query||[],vectors=event.data.vectors||[];
        const norm=Math.sqrt(query.reduce((sum,v)=>sum+v*v,0))||1;
        const scores=vectors.map((vector,index)=>{
          if(vector.length!==query.length) return {index,score:-1};
          let dot=0,length=0;for(let i=0;i<vector.length;i++){dot+=vector[i]*query[i];length+=vector[i]*vector[i];}
          return {index,score:dot/(norm*(Math.sqrt(length)||1))};
        });
        scores.sort((a,b)=>b.score-a.score);
        self.postMessage({id,result:scores.slice(0,event.data.topK||5)});
      }
    } catch(error){self.postMessage({id,error:error instanceof Error?error.message:"Local embedding failed."});}
  });
};
