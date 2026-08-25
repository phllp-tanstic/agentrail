const M=(1n<<64n)-1n;
const RC=[0x1n,0x8082n,0x800000000000808An,0x8000000080008000n,0x808bn,0x80000001n,
0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,
0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,
0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,
0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const ROT=[[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
const rol=(x,n)=>{n=BigInt(n%64);return n===0n?x:((x<<n)|(x>>(64n-n)))&M;};
function f(A){
 for(let r=0;r<24;r++){
  const C=[],D=[];
  for(let x=0;x<5;x++)C[x]=A[x][0]^A[x][1]^A[x][2]^A[x][3]^A[x][4];
  for(let x=0;x<5;x++)D[x]=C[(x+4)%5]^rol(C[(x+1)%5],1);
  for(let x=0;x<5;x++)for(let y=0;y<5;y++)A[x][y]^=D[x];
  const B=[[],[],[],[],[]];
  for(let x=0;x<5;x++)for(let y=0;y<5;y++)B[y][(2*x+3*y)%5]=rol(A[x][y],ROT[x][y]);
  for(let x=0;x<5;x++)for(let y=0;y<5;y++)A[x][y]=B[x][y]^((~B[(x+1)%5][y])&M&B[(x+2)%5][y]);
  A[0][0]^=RC[r];
 }
 return A;
}
export function keccak256(data){
 const rate=136;const p=[...data];p.push(0x01);
 while(p.length%rate!==0)p.push(0x00);
 p[p.length-1]^=0x80;
 const A=[[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n]];
 for(let off=0;off<p.length;off+=rate){
  for(let i=0;i<rate/8;i++){
   let lane=0n;
   for(let b=7;b>=0;b--)lane=(lane<<8n)|BigInt(p[off+i*8+b]);
   A[i%5][Math.floor(i/5)]^=lane;
  }
  f(A);
 }
 const out=[];
 for(let i=0;i<4;i++){let v=A[i%5][Math.floor(i/5)];for(let b=0;b<8;b++){out.push(Number(v&0xffn));v>>=8n;}}
 return Buffer.from(out.slice(0,32));
}
export const sel=s=>'0x'+keccak256(Buffer.from(s,'utf8')).toString('hex').slice(0,8);
const empty=keccak256(Buffer.alloc(0)).toString('hex');
if(empty!=='c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')throw new Error('empty vector FAIL '+empty);
if(sel('transfer(address,uint256)')!=='0xa9059cbb')throw new Error('transfer FAIL '+sel('transfer(address,uint256)'));
if(sel('balanceOf(address)')!=='0x70a08231')throw new Error('balanceOf FAIL');
console.log('keccak256 self-test: PASS (empty vector, transfer, balanceOf)');
for(const s of ['getMaxBuilderFeeBpsTimes1k()','isRegistered(address)','registered(address)',
 'isPoolRegistered(address)','poolRegistry()','spotPoolRegistry()','getBuilderApproval(address,address)',
 'outcomeToken()','collateral()','marketExpiryNs()'])console.log('  '+sel(s)+'  '+s);
