import { createHash } from "node:crypto";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const revision="751bff37182d3f1213fa05d7196b954e230abad9";
const root=new URL("../public/models/all-MiniLM-L6-v2/",import.meta.url);
const manifest=[
  {name:"config.json",bytes:650,git:"72147e4ff4426ebedbfa2146c4a0999def51a313"},
  {name:"tokenizer.json",bytes:711661,git:"c17ed520ed8438736732a54957a69306b8822215"},
  {name:"tokenizer_config.json",bytes:366,git:"37fca74771bc76a8e01178ce3a6055a0995f8093"},
  {name:"special_tokens_map.json",bytes:125,git:"a8b3208c2884c4efb86e49300fdd3dc877220cdf"},
  {name:"onnx/model_quantized.onnx",bytes:22972370,sha256:"afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"},
];
function valid(data,item){
  if(data.length!==item.bytes)return false;
  return item.sha256?createHash("sha256").update(data).digest("hex")===item.sha256:
    createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex")===item.git;
}
await Promise.all(manifest.map(async item=>{
  const target=fileURLToPath(new URL(item.name,root));
  try{if(valid(await readFile(target),item))return;}catch{/* Download an absent or mismatched public asset. */}
  const response=await fetch(`https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${revision}/${item.name}`,{signal:AbortSignal.timeout(120_000)});
  if(!response.ok)throw new Error(`Model asset ${item.name} returned HTTP ${response.status}.`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!valid(bytes,item))throw new Error(`Model asset ${item.name} failed its pinned integrity check.`);
  await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);
  console.log(`Prepared ${item.name} (${bytes.length} bytes).`);
}));
const notice=`Model: Xenova/all-MiniLM-L6-v2, ONNX q8 conversion of sentence-transformers/all-MiniLM-L6-v2.\nSource: https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/${revision}\nRevision: ${revision}\nLicense: Apache-2.0, https://www.apache.org/licenses/LICENSE-2.0\nThese public model files are downloaded at build time and served as static assets.\n`;
await writeFile(new URL("SOURCE.txt",root),notice);
const licenseFile=new URL("LICENSE.txt",root);
try{await readFile(licenseFile);}catch{
  const response=await fetch("https://www.apache.org/licenses/LICENSE-2.0.txt");if(!response.ok)throw new Error("Model license download failed.");await writeFile(licenseFile,await response.text());
}
console.log("Local model assets verified.");
