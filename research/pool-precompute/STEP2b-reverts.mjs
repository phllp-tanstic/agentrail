import { rpc } from './rpc.mjs';
import fs from 'node:fs';
const s2 = JSON.parse(fs.readFileSync('STEP2-RESULT.json','utf8'));
const EOA='0xAAaA000000000000000000000000000000000001';
const out={};
for (const [name,info] of Object.entries(s2.multiSendCode)) {
  if(!name.startsWith('MultiSend 1.')) continue;
  try {
    const r = await rpc('eth_call',[{from:EOA,to:info.addr,data:s2.multiSendCalldata,gas:'0x2000000'},'latest']);
    out[name]={ok:true,result:r};
    console.log(name,'-> NO REVERT',r);
  } catch(e) {
    const m=String(e.message);
    out[name]={ok:false,error:m};
    console.log(name,'-> REVERT:',m);
    const hex=m.match(/0x[0-9a-fA-F]{8,}/);
    if(hex){
      const d=hex[0];
      if(d.slice(0,10)==='0x08c379a0'){
        const len=parseInt(d.slice(10+64,10+128),16);
        const str=Buffer.from(d.slice(10+128,10+128+len*2),'hex').toString();
        out[name].decodedString=str;
        console.log('   decoded Error(string):',JSON.stringify(str));
      }
    }
  }
}
fs.writeFileSync('STEP2-REVERTS.json',JSON.stringify(out,null,2));
