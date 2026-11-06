// Minimal-DOM, damit app.js headless startet; geprüft wird die echte Export-Logik.
const noop=()=>{}; const els={};
const mk=(id)=>els[id]||(els[id]=new Proxy({id,style:{},dataset:{},classList:{toggle:noop,add:noop},checked:id==='optSnap',value:'',textContent:'',innerHTML:'',addEventListener:noop,getContext:()=>new Proxy({}, {get:()=>noop,set:()=>true}),getBoundingClientRect:()=>({width:1000,height:800,left:0,top:0}),focus:noop,click:noop,showModal:noop,close:noop,closest:()=>null},{get:(t,k)=>t[k],set:(t,k,v)=>{t[k]=v;return true}}));
var window=this; var document={getElementById:mk,querySelectorAll:()=>[],querySelector:()=>mk('q'),createElement:()=>mk('x'+Math.random()),head:{appendChild:noop},activeElement:null,body:{appendChild:noop}};
window.addEventListener=noop; var requestAnimationFrame=noop; var ResizeObserver=function(){this.observe=noop}; var setTimeout=()=>0; var clearTimeout=noop;
var location={protocol:'file:'}; window.PDFJS_SOURCES=[]; window.devicePixelRatio=1; var indexedDB={open:()=>({})}; var confirm=()=>true;
var Promise=this.Promise;
load('app.js');
const A=window.CAD2SV, S=A.S; let fails=0;
const ok=(c,m)=>{ if(!c){fails++;print('FAIL '+m)} else print('ok   '+m)};
// Rechteck 10x5 auf z=0
S.shapes.push({id:1,type:'poly',kind:'rect',label:'Audience',visible:true,flip:false,pts:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:5,z:0},{x:0,y:5,z:0}]});
let t=A.exportTriangles(); ok(t.length===2,'Rechteck = 2 Dreiecke');
const area=(tris)=>tris.reduce((s,tr)=>{const[a,b,c]=tr.v;const u=[b.x-a.x,b.y-a.y,b.z-a.z],w=[c.x-a.x,c.y-a.y,c.z-a.z];return s+0.5*Math.hypot(u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0])},0);
const nz=(tr)=>{const[a,b,c]=tr.v;return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)};
ok(Math.abs(area(t)-50)<1e-6,'Fläche Rechteck 50 m²'); ok(t.every(x=>nz(x)>0),'Normale zeigt nach oben');
// Tribüne: Rückseite 3 m hoch
S.shapes[0].pts[2].z=3;S.shapes[0].pts[3].z=3; t=A.exportTriangles(); ok(Math.abs(area(t)-10*Math.hypot(5,3))<1e-6,'Tribüne: geneigte Fläche korrekt'); ok(t.every(x=>nz(x)>0),'Tribüne Normale oben');
// Im Uhrzeigersinn gezeichnet
S.shapes[0].pts=[{x:0,y:0,z:0},{x:0,y:5,z:0},{x:10,y:5,z:0},{x:10,y:0,z:0}]; t=A.exportTriangles(); ok(t.every(x=>nz(x)>0),'CW gezeichnet wird nach oben gedreht');
// Konkaves L-Polygon
S.shapes[0].pts=[{x:0,y:0,z:1},{x:4,y:0,z:1},{x:4,y:2,z:1},{x:2,y:2,z:1},{x:2,y:4,z:1},{x:0,y:4,z:1}]; t=A.exportTriangles(); ok(t.length===4&&Math.abs(area(t)-12)<1e-6,'L-Polygon Fläche 12 m²');
// Kreis, Ring, Bogen
const PI=Math.PI;
S.shapes[0]={id:1,type:'round',label:'Ring',visible:true,flip:false,c:{x:0,y:0},r:10,ri:0,a0:0,a1:360,z:0,zo:0,seg:360}; t=A.exportTriangles(); ok(Math.abs(area(t)-PI*100)<0.1,'Kreis ≈ πr²');ok(t.every(x=>nz(x)>0),'Kreis Normale oben');
S.shapes[0].ri=5; t=A.exportTriangles(); ok(Math.abs(area(t)-PI*75)<0.1,'Ring ≈ π(R²-r²)');
S.shapes[0].a1=90; t=A.exportTriangles(); ok(Math.abs(area(t)-PI*75/4)<0.1,'Viertelring');ok(t.every(x=>nz(x)>0),'Bogen Normale oben');
// Wand senkrecht: Normalenreihenfolge bleibt, Flip dreht
S.shapes[0]={id:1,type:'poly',kind:'rect',label:'Wall',visible:true,flip:false,pts:[{x:0,y:0,z:0},{x:5,y:0,z:0},{x:5,y:0,z:3},{x:0,y:0,z:3}]}; t=A.exportTriangles(); ok(t.length===2&&Math.abs(area(t)-15)<1e-6,'Wand 15 m²');
// Drehung
S.shapes[0]={id:1,type:'poly',kind:'rect',label:'Bühne "A"',visible:true,flip:false,pts:[{x:1,y:0,z:0},{x:2,y:0,z:0},{x:2,y:1,z:0}]}; let s90=A.exportText(90); ok(s90.includes('0,1,0'),'Drehung 90°: (1,0)->(0,1)');
ok(s90.includes('"Label","Buehne  A"'),'Label bereinigt (Umlaut, Anführungszeichen)');
// Dateiformat exakt
S.shapes[0].label='Audience'; S.shapes[0].pts=[{x:0.1234,y:-2.5,z:1},{x:3,y:0,z:1},{x:3,y:4,z:1}];
print(A.exportText());
ok(/\n"; LengthUnit", "m"\n";"\n"Label","Audience"\n0\.123,-2\.5,1\n3,0,1\n3,4,1\n";"\n$/.test(A.exportText()),'Dateiformat wie Referenz-Exporter, Dezimalpunkt');
// Ausgeblendet
S.shapes[0].visible=false; ok(A.exportTriangles().length===0,'Ausgeblendete Flächen fehlen im Export');
print(fails? fails+' FEHLER':'ALLE TESTS OK');
