import { readFileSync, statSync } from 'node:fs';
import { verifyBundle } from './evidence-protocol.mjs';
try {
  const path=process.argv[2];
  if(!path)throw new Error('Usage: node src/verify-evidence.mjs /path/to/pact-evidence.json');
  if(statSync(path).size>20*1024*1024)throw new Error('Bundle exceeds the 20 MiB offline verifier limit.');
  const result=verifyBundle(JSON.parse(readFileSync(path,'utf8')));
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.verdict==='TAMPERED_OR_INVALID'?1:result.verdict==='INCOMPLETE'?2:0;
}catch(error){console.error(error.message);process.exitCode=1;}
