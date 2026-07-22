import{m as e}from"./src-Bv2VRg4z.js";import{n as t}from"./chunk-Y2CYZVJY-DsF7k-Jl.js";import{D as n,H as r,K as i,U as a,a as o,b as s,c,f as l,v as u,w as d,y as f}from"./chunk-WYO6CB5R-BNfIql0O.js";import{i as p}from"./chunk-ICXQ74PX-UsgVJ8MQ.js";import{f as m}from"./index-ChzndERt.js";import{n as h}from"./mermaid-parser.core-BsMcyh5Q.js";import{t as g}from"./chunk-JWPE2WC7-CEzeTtJC.js";var _={showLegend:!0,ticks:5,max:null,min:0,graticule:`circle`},v={axes:[],curves:[],options:_},y=structuredClone(v),b=l.radar,x=t(()=>p({...b,...s().radar}),`getConfig`),S=t(()=>y.axes,`getAxes`),C=t(()=>y.curves,`getCurves`),w=t(()=>y.options,`getOptions`),T=t(e=>{y.axes=e.map(e=>{var t;return{name:e.name,label:(t=e.label)==null?e.name:t}})},`setAxes`),E=t(e=>{y.curves=e.map(e=>{var t;return{name:e.name,label:(t=e.label)==null?e.name:t,entries:D(e.entries)}})},`setCurves`),D=t(e=>{if(e[0].axis==null)return e.map(e=>e.value);let t=S();if(t.length===0)throw Error(`Axes must be populated before curves for reference entries`);return t.map(t=>{let n=e.find(e=>{var n;return((n=e.axis)==null?void 0:n.$refText)===t.name});if(n===void 0)throw Error(`Missing entry for axis `+t.label);return n.value})},`computeCurveEntries`),O={getAxes:S,getCurves:C,getOptions:w,setAxes:T,setCurves:E,setOptions:t(e=>{var t,n,r,i,a,o,s,c,l,u;let d=e.reduce((e,t)=>(e[t.name]=t,e),{});y.options={showLegend:(t=(n=d.showLegend)==null?void 0:n.value)==null?_.showLegend:t,ticks:(r=(i=d.ticks)==null?void 0:i.value)==null?_.ticks:r,max:(a=(o=d.max)==null?void 0:o.value)==null?_.max:a,min:(s=(c=d.min)==null?void 0:c.value)==null?_.min:s,graticule:(l=(u=d.graticule)==null?void 0:u.value)==null?_.graticule:l}},`setOptions`),getConfig:x,clear:t(()=>{o(),y=structuredClone(v)},`clear`),setAccTitle:a,getAccTitle:f,setDiagramTitle:i,getDiagramTitle:d,getAccDescription:u,setAccDescription:r},k=t(e=>{g(e,O);let{axes:t,curves:n,options:r}=e;O.setAxes(t),O.setCurves(n),O.setOptions(r)},`populate`),A={parse:t(async t=>{let n=await h(`radar`,t);e.debug(n),k(n)},`parse`)},j=t((e,t,n,r)=>{var i;let a=r.db,o=a.getAxes(),s=a.getCurves(),c=a.getOptions(),l=a.getConfig(),u=a.getDiagramTitle(),d=M(m(t),l),f=(i=c.max)==null?Math.max(...s.map(e=>Math.max(...e.entries))):i,p=c.min,h=Math.min(l.width,l.height)/2;N(d,o,h,c.ticks,c.graticule),P(d,o,h,l),F(d,o,s,p,f,c.graticule,l),R(d,s,c.showLegend,l),d.append(`text`).attr(`class`,`radarTitle`).text(u).attr(`x`,0).attr(`y`,-l.height/2-l.marginTop)},`draw`),M=t((e,t)=>{var n;let r=t.width+t.marginLeft+t.marginRight,i=t.height+t.marginTop+t.marginBottom,a={x:t.marginLeft+t.width/2,y:t.marginTop+t.height/2};return c(e,i,r,(n=t.useMaxWidth)==null?!0:n),e.attr(`viewBox`,`0 0 ${r} ${i}`).attr(`overflow`,`visible`),e.append(`g`).attr(`transform`,`translate(${a.x}, ${a.y})`)},`drawFrame`),N=t((e,t,n,r,i)=>{if(i===`circle`)for(let t=0;t<r;t++){let i=n*(t+1)/r;e.append(`circle`).attr(`r`,i).attr(`class`,`radarGraticule`)}else if(i===`polygon`){let i=t.length;for(let a=0;a<r;a++){let o=n*(a+1)/r,s=t.map((e,t)=>{let n=2*t*Math.PI/i-Math.PI/2;return`${o*Math.cos(n)},${o*Math.sin(n)}`}).join(` `);e.append(`polygon`).attr(`points`,s).attr(`class`,`radarGraticule`)}}},`drawGraticule`),P=t((e,t,n,r)=>{let i=t.length;for(let a=0;a<i;a++){let o=t[a].label,s=2*a*Math.PI/i-Math.PI/2,c=Math.cos(s),l=Math.sin(s);e.append(`line`).attr(`x1`,0).attr(`y1`,0).attr(`x2`,n*r.axisScaleFactor*c).attr(`y2`,n*r.axisScaleFactor*l).attr(`class`,`radarAxisLine`);let u=c>.01?`start`:c<-.01?`end`:`middle`,d=l>.01?`hanging`:l<-.01?`auto`:`central`;e.append(`text`).text(o).attr(`x`,n*r.axisLabelFactor*c+4*c).attr(`y`,n*r.axisLabelFactor*l+4*l).attr(`text-anchor`,u).attr(`dominant-baseline`,d).attr(`class`,`radarAxisLabel`)}},`drawAxes`);function F(e,t,n,r,i,a,o){let s=t.length,c=Math.min(o.width,o.height)/2;n.forEach((t,n)=>{if(t.entries.length!==s)return;let l=t.entries.map((e,t)=>{let n=2*Math.PI*t/s-Math.PI/2,a=I(e,r,i,c);return{x:a*Math.cos(n),y:a*Math.sin(n)}});a===`circle`?e.append(`path`).attr(`d`,L(l,o.curveTension)).attr(`class`,`radarCurve-${n}`):a===`polygon`&&e.append(`polygon`).attr(`points`,l.map(e=>`${e.x},${e.y}`).join(` `)).attr(`class`,`radarCurve-${n}`)})}t(F,`drawCurves`);function I(e,t,n,r){return r*(Math.min(Math.max(e,t),n)-t)/(n-t)}t(I,`relativeRadius`);function L(e,t){let n=e.length,r=`M${e[0].x},${e[0].y}`;for(let i=0;i<n;i++){let a=e[(i-1+n)%n],o=e[i],s=e[(i+1)%n],c=e[(i+2)%n],l={x:o.x+(s.x-a.x)*t,y:o.y+(s.y-a.y)*t},u={x:s.x-(c.x-o.x)*t,y:s.y-(c.y-o.y)*t};r+=` C${l.x},${l.y} ${u.x},${u.y} ${s.x},${s.y}`}return`${r} Z`}t(L,`closedRoundCurve`);function R(e,t,n,r){if(!n)return;let i=(r.width/2+r.marginRight)*3/4,a=-(r.height/2+r.marginTop)*3/4;t.forEach((t,n)=>{let r=e.append(`g`).attr(`transform`,`translate(${i}, ${a+n*20})`);r.append(`rect`).attr(`width`,12).attr(`height`,12).attr(`class`,`radarLegendBox-${n}`),r.append(`text`).attr(`x`,16).attr(`y`,0).attr(`class`,`radarLegendText`).text(t.label)})}t(R,`drawLegend`);var z={draw:j},B=t((e,t)=>{let n=``;for(let r=0;r<e.THEME_COLOR_LIMIT;r++){let i=e[`cScale${r}`];n+=`
		.radarCurve-${r} {
			color: ${i};
			fill: ${i};
			fill-opacity: ${t.curveOpacity};
			stroke: ${i};
			stroke-width: ${t.curveStrokeWidth};
		}
		.radarLegendBox-${r} {
			fill: ${i};
			fill-opacity: ${t.curveOpacity};
			stroke: ${i};
		}
		`}return n},`genIndexStyles`),V=t(e=>{let t=p(n(),s().themeVariables);return{themeVariables:t,radarOptions:p(t.radar,e)}},`buildRadarStyleOptions`),H={parser:A,db:O,renderer:z,styles:t(({radar:e}={})=>{let{themeVariables:t,radarOptions:n}=V(e);return`
	.radarTitle {
		font-size: ${t.fontSize};
		color: ${t.titleColor};
		dominant-baseline: hanging;
		text-anchor: middle;
	}
	.radarAxisLine {
		stroke: ${n.axisColor};
		stroke-width: ${n.axisStrokeWidth};
	}
	.radarAxisLabel {
		font-size: ${n.axisLabelFontSize}px;
		color: ${n.axisColor};
	}
	.radarGraticule {
		fill: ${n.graticuleColor};
		fill-opacity: ${n.graticuleOpacity};
		stroke: ${n.graticuleColor};
		stroke-width: ${n.graticuleStrokeWidth};
	}
	.radarLegendText {
		text-anchor: start;
		font-size: ${n.legendFontSize}px;
		dominant-baseline: hanging;
	}
	${B(t,n)}
	`},`styles`)};export{H as diagram};