import{m as e}from"./src-Bv2VRg4z.js";import{n as t}from"./chunk-Y2CYZVJY-DsF7k-Jl.js";import{H as n,K as r,U as i,a,c as o,f as s,v as c,w as l,x as u,y as d}from"./chunk-WYO6CB5R-BNfIql0O.js";import{t as f}from"./ordinal-hYBb2elL.js";import{n as p}from"./path-BWPyau1x.js";import{m}from"./dist-PN9mCvB7.js";import{t as h}from"./arc-G7BLPvBA.js";import{t as g}from"./array-BifhSqXX.js";import{i as _,p as v}from"./chunk-ICXQ74PX-UsgVJ8MQ.js";import{f as y}from"./index-ChzndERt.js";import{n as b}from"./mermaid-parser.core-BsMcyh5Q.js";import{t as x}from"./chunk-JWPE2WC7-CEzeTtJC.js";function S(e,t){return t<e?-1:t>e?1:t>=e?0:NaN}function C(e){return e}function w(){var e=C,t=S,n=null,r=p(0),i=p(m),a=p(0);function o(o){var s,c=(o=g(o)).length,l,u,d=0,f=Array(c),p=Array(c),h=+r.apply(this,arguments),_=Math.min(m,Math.max(-m,i.apply(this,arguments)-h)),v,y=Math.min(Math.abs(_)/c,a.apply(this,arguments)),b=y*(_<0?-1:1),x;for(s=0;s<c;++s)(x=p[f[s]=s]=+e(o[s],s,o))>0&&(d+=x);for(t==null?n!=null&&f.sort(function(e,t){return n(o[e],o[t])}):f.sort(function(e,n){return t(p[e],p[n])}),s=0,u=d?(_-c*b)/d:0;s<c;++s,h=v)l=f[s],x=p[l],v=h+(x>0?x*u:0)+b,p[l]={data:o[l],index:s,value:x,startAngle:h,endAngle:v,padAngle:y};return p}return o.value=function(t){return arguments.length?(e=typeof t==`function`?t:p(+t),o):e},o.sortValues=function(e){return arguments.length?(t=e,n=null,o):t},o.sort=function(e){return arguments.length?(n=e,t=null,o):n},o.startAngle=function(e){return arguments.length?(r=typeof e==`function`?e:p(+e),o):r},o.endAngle=function(e){return arguments.length?(i=typeof e==`function`?e:p(+e),o):i},o.padAngle=function(e){return arguments.length?(a=typeof e==`function`?e:p(+e),o):a},o}var T=s.pie,E={sections:new Map,showData:!1,config:T},D=E.sections,O=E.showData,k=structuredClone(T),A={getConfig:t(()=>structuredClone(k),`getConfig`),clear:t(()=>{D=new Map,O=E.showData,a()},`clear`),setDiagramTitle:r,getDiagramTitle:l,setAccTitle:i,getAccTitle:d,setAccDescription:n,getAccDescription:c,addSection:t(({label:t,value:n})=>{if(n<0)throw Error(`"${t}" has invalid value: ${n}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);D.has(t)||(D.set(t,n),e.debug(`added new section: ${t}, with value: ${n}`))},`addSection`),getSections:t(()=>D,`getSections`),setShowData:t(e=>{O=e},`setShowData`),getShowData:t(()=>O,`getShowData`)},j=t((e,t)=>{x(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},`populateDb`),M={parse:t(async t=>{let n=await b(`pie`,t);e.debug(n),j(n,A)},`parse`)},N=t(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieCircle.highlighted{
    scale: 1.05;
    opacity: 1;
  }
  .pieCircle.highlightedOnHover:hover{
    transition-duration: 250ms;
    scale: 1.05;
    opacity: 1;
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,`getStyles`),P=t(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return w().value(e=>e.value).sort(null)(n)},`createPieArcs`),F={parser:M,db:A,renderer:{draw:t((t,n,r,i)=>{var a,s;e.debug(`rendering pie chart
`+t);let c=i.db,l=u(),d=_(c.getConfig(),l.pie),p=y(n),m=p.append(`g`);m.attr(`transform`,`translate(225,225)`);let{themeVariables:g}=l,[b]=v(g.pieOuterStrokeWidth);b!=null||(b=2);let x=d.legendPosition,S=d.textPosition,C=d.donutHole>0&&d.donutHole<=.9?d.donutHole:0,w=h().innerRadius(C*185).outerRadius(185),T=h().innerRadius(185*S).outerRadius(185*S),E=m.append(`g`);E.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+b/2).attr(`class`,`pieOuterCircle`);let D=c.getSections(),O=P(D),k=[g.pie1,g.pie2,g.pie3,g.pie4,g.pie5,g.pie6,g.pie7,g.pie8,g.pie9,g.pie10,g.pie11,g.pie12],A=0;D.forEach(e=>{A+=e});let j=O.filter(e=>(e.data.value/A*100).toFixed(0)!==`0`),M=f(k).domain([...D.keys()]);E.selectAll(`mySlices`).data(j).enter().append(`path`).attr(`d`,w).attr(`fill`,e=>M(e.data.label)).attr(`class`,e=>{let t=`pieCircle`;return d.highlightSlice===`hover`?t+=` highlightedOnHover`:d.highlightSlice===e.data.label&&(t+=` highlighted`),t}),E.selectAll(`mySlices`).data(j).enter().append(`text`).text(e=>(e.data.value/A*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+T.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let N=m.append(`text`).text(c.getDiagramTitle()).attr(`x`,0).attr(`y`,-400/2).attr(`class`,`pieTitleText`),F=[...D.entries()].map(([e,t])=>({label:e,value:t})),I=m.selectAll(`.legend`).data(F).enter().append(`g`).attr(`class`,`legend`);I.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>M(e.label)).style(`stroke`,e=>M(e.label)),I.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>c.getShowData()?`${e.label} [${e.value}]`:e.label);let L=Math.max(...I.selectAll(`text`).nodes().map(e=>{var t;return(t=e==null?void 0:e.getBoundingClientRect().width)==null?0:t})),R=450,z=490,B=F.length*22;switch(x){case`center`:I.attr(`transform`,(e,t)=>{let n=22*F.length/2,r=-L/2-22,i=t*22-n;return`translate(`+r+`,`+i+`)`});break;case`top`:R+=B,I.attr(`transform`,(e,t)=>`translate(${-L/2-22}, ${t*22-185})`),E.attr(`transform`,()=>`translate(0, ${B+22})`);break;case`bottom`:R+=B,I.attr(`transform`,(e,t)=>{let n=-L/2-22,r=t*22- -207;return`translate(`+n+`,`+r+`)`});break;case`left`:z+=22+L,I.attr(`transform`,(e,t)=>{let n=22*F.length/2;return`translate(-207,`+(t*22-n)+`)`}),E.attr(`transform`,()=>`translate(${L+18+4}, 0)`);break;default:z+=22+L,I.attr(`transform`,(e,t)=>{let n=22*F.length/2;return`translate(216,`+(t*22-n)+`)`});break}let V=(a=(s=N.node())==null?void 0:s.getBoundingClientRect().width)==null?0:a,H=450/2-V/2,U=450/2+V/2,W=Math.min(0,H),G=Math.max(z,U)-W;p.attr(`viewBox`,`${W} 0 ${G} ${R}`),o(p,R,G,d.useMaxWidth)},`draw`)},styles:N};export{F as diagram};