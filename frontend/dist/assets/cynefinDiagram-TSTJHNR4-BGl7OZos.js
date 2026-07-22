import{m as e}from"./src-Bv2VRg4z.js";import{n as t}from"./chunk-Y2CYZVJY-DsF7k-Jl.js";import{D as n,H as r,K as i,U as a,a as o,b as s,c,f as l,v as u,w as d,y as f}from"./chunk-WYO6CB5R-BNfIql0O.js";import{i as p}from"./chunk-ICXQ74PX-UsgVJ8MQ.js";import{f as m}from"./index-ChzndERt.js";import{n as h}from"./mermaid-parser.core-BsMcyh5Q.js";import{t as g}from"./chunk-JWPE2WC7-CEzeTtJC.js";var _=t(()=>({domains:new Map,transitions:[]}),`createDefaultData`),v=_(),y={getDomains:t(()=>v.domains,`getDomains`),getTransitions:t(()=>v.transitions,`getTransitions`),setDomains:t(e=>{if(e)for(let n of e){var t;let e=n.domain,r=((t=n.items)==null?[]:t).map(e=>({label:e.label}));v.domains.set(e,{name:e,items:r})}},`setDomains`),setTransitions:t(t=>{t&&(v.transitions=t.filter(t=>t.from===t.to?(e.warn(`Cynefin: self-loop transition on domain "${t.from}" is not meaningful and will be skipped.`),!1):!0).map(e=>({from:e.from,to:e.to,label:e.label||void 0})))},`setTransitions`),getConfig:t(()=>p({...l.cynefin,...s().cynefin}),`getConfig`),clear:t(()=>{o(),v=_()},`clear`),setAccTitle:a,getAccTitle:f,setDiagramTitle:i,getDiagramTitle:d,getAccDescription:u,setAccDescription:r},b=t(e=>{g(e,y),y.setDomains(e.domains),y.setTransitions(e.transitions)},`populate`),x={parse:t(async t=>{let n=await h(`cynefin`,t);e.debug(n),b(n)},`parse`)};function S(e){let t=e+1831565813|0;return t=Math.imul(t^t>>>15,t|1),t^=t+Math.imul(t^t>>>7,t|61),((t^t>>>14)>>>0)/4294967296}t(S,`seededRandom`);function C(e){let t=0;for(let n=0;n<e.length;n++){let r=e.charCodeAt(n);t=(t<<5)-t+r,t|=0}return t}t(C,`hashString`);function w(e,t){return typeof e==`number`&&Number.isFinite(e)&&e!==0?e:C(t)}t(w,`resolveSeed`);function T(e,t,n,r){let i=e/2,a=r==null?e*.015:r,o=t/7,s=[];for(let e=0;e<=7;e++){let t=S(n+e*17)*a*2-a;s.push({x:i+t,y:e*o})}let c=`M${s[0].x},${s[0].y}`;for(let e=0;e<s.length-1;e++){let t=s[e],r=s[e+1],i=(t.y+r.y)/2,o=e%2==0?1:-1,l=a*1.5*o*S(n+e*31+7),u=t.x+l,d=i,f=r.x-l;c+=` C${u},${d} ${f},${i} ${r.x},${r.y}`}return c}t(T,`generateFoldPath`);function E(e,t,n,r){let i=t/2,a=r==null?t*.015:r,o=e/7,s=[];for(let e=0;e<=7;e++){let t=S(n+e*23)*a*2-a;s.push({x:e*o,y:i+t})}let c=`M${s[0].x},${s[0].y}`;for(let e=0;e<s.length-1;e++){let t=s[e],r=s[e+1],i=(t.x+r.x)/2,o=e%2==0?1:-1,l=a*1.5*o*S(n+e*37+11),u=i,d=t.y+l,f=i,p=r.y-l;c+=` C${u},${d} ${f},${p} ${r.x},${r.y}`}return c}t(E,`generateHorizontalBoundary`);function D(e,t){let n=e/2,r=t*.5,i=t,a=e*.03;return[`M${n},${r}`,`C${n+a},${r+(i-r)*.2}`,`${n-a*1.5},${r+(i-r)*.55}`,`${n+a*.5},${r+(i-r)*.75}`,`C${n-a},${r+(i-r)*.85}`,`${n+a*.3},${r+(i-r)*.95}`,`${n},${i}`].join(` `)}t(D,`generateCliffPath`);function O(e,t,n,r){return[`M${e-n},${t}`,`A${n},${r} 0 1,1 ${e+n},${t}`,`A${n},${r} 0 1,1 ${e-n},${t}`,`Z`].join(` `)}t(O,`generateConfusionPath`);var k={complex:{model:`Probe → Sense → Respond`,practice:`Emergent Practices`},complicated:{model:`Sense → Analyse → Respond`,practice:`Good Practices`},clear:{model:`Sense → Categorise → Respond`,practice:`Best Practices`},chaotic:{model:`Act → Sense → Respond`,practice:`Novel Practices`},confusion:{model:``,practice:`Disorder`}},A=t((e,t)=>{let n=e/2,r=t/2;return{complex:{cx:n/2,cy:r/2,x:0,y:0,w:n,h:r},complicated:{cx:n+n/2,cy:r/2,x:n,y:0,w:n,h:r},chaotic:{cx:n/2,cy:r+r/2,x:0,y:r,w:n,h:r},clear:{cx:n+n/2,cy:r+r/2,x:n,y:r,w:n,h:r},confusion:{cx:n,cy:r,x:n*.7,y:r*.7,w:n*.6,h:r*.6}}},`getDomainLayouts`),j=t(()=>p(n(),s().themeVariables).cynefin,`getCynefinDomainColors`),M=3,N={draw:t((t,n,r,i)=>{var a;let o=i.db,s=o.getDomains(),l=o.getTransitions(),u=o.getDiagramTitle(),d=o.getAccTitle(),f=o.getAccDescription(),p=o.getConfig(),h=j();e.debug(`Rendering Cynefin diagram`);let g=p.width,_=p.height,v=p.padding,y=p.showDomainDescriptions,b=p.boundaryAmplitude,x=g+v*2,S=_+v*2,C={complex:h.complexBg,complicated:h.complicatedBg,clear:h.clearBg,chaotic:h.chaoticBg,confusion:h.confusionBg},N=m(n);c(N,S,x,(a=p.useMaxWidth)==null?!0:a),N.attr(`viewBox`,`0 0 ${x} ${S}`),d&&N.append(`title`).text(d),f&&N.append(`desc`).text(f);let P=N.append(`g`).attr(`transform`,`translate(${v}, ${v})`),F=A(g,_),I=w(p.seed,n),L=P.append(`g`).attr(`class`,`cynefin-backgrounds`),R=[`complex`,`complicated`,`chaotic`,`clear`];for(let e of R){let t=F[e];L.append(`rect`).attr(`class`,`cynefinDomain`).attr(`x`,t.x).attr(`y`,t.y).attr(`width`,t.w).attr(`height`,t.h).attr(`fill`,C[e]).attr(`fill-opacity`,.4).attr(`stroke`,`none`)}let z=P.append(`g`).attr(`class`,`cynefin-boundaries`);z.append(`path`).attr(`class`,`cynefinBoundary`).attr(`d`,T(g,_,I,b)).attr(`fill`,`none`),z.append(`path`).attr(`class`,`cynefinBoundary`).attr(`d`,E(g,_,I+100,b)).attr(`fill`,`none`),z.append(`path`).attr(`class`,`cynefinCliff`).attr(`d`,D(g,_)).attr(`fill`,`none`);let B=g*.15,V=_*.15;P.append(`path`).attr(`class`,`cynefinConfusion`).attr(`d`,O(g/2,_/2,B,V)).attr(`fill`,C.confusion).attr(`fill-opacity`,.5);let H=P.append(`g`).attr(`class`,`cynefin-labels`);for(let e of R){let t=F[e];H.append(`text`).attr(`class`,`cynefinDomainLabel`).attr(`x`,t.cx).attr(`y`,y?t.cy-30:t.cy).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`middle`).text(e.charAt(0).toUpperCase()+e.slice(1))}if(H.append(`text`).attr(`class`,`cynefinDomainLabel`).attr(`x`,g/2).attr(`y`,y?_/2-10:_/2).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`middle`).text(`Confusion`),y){let e=P.append(`g`).attr(`class`,`cynefin-subtitles`);for(let t of R){let n=F[t],r=k[t];e.append(`text`).attr(`class`,`cynefinSubtitle`).attr(`x`,n.cx).attr(`y`,n.cy-10).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`middle`).text(r.model),e.append(`text`).attr(`class`,`cynefinSubtitle`).attr(`x`,n.cx).attr(`y`,n.cy+5).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`middle`).text(r.practice)}e.append(`text`).attr(`class`,`cynefinSubtitle`).attr(`x`,g/2).attr(`y`,_/2+8).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`middle`).text(k.confusion.practice)}let U=P.append(`g`).attr(`class`,`cynefin-items`);for(let e of[`complex`,`complicated`,`chaotic`,`clear`,`confusion`]){let t=s.get(e);if(!t||t.items.length===0)continue;let n=F[e],r=e===`confusion`,i=t.items,a=0;r&&t.items.length>M&&(a=t.items.length-M,i=t.items.slice(0,M));let o;if(r){let e=y?22:14;o=n.cy+e}else o=n.cy+(y?25:15);if([...i].forEach((t,r)=>{let i=o+r*30,a=U.append(`g`),s=a.append(`text`).attr(`class`,`cynefinItemText`).attr(`x`,0).attr(`y`,26/2).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`central`).text(t.label),c=t.label.length*7,l=s.node();if(l&&typeof l.getBBox==`function`){let e=l.getBBox();e.width>0&&(c=e.width)}let u=c+20,d=n.cx-u/2;a.attr(`transform`,`translate(${d}, ${i})`),a.insert(`rect`,`text`).attr(`class`,`cynefinItem`).attr(`x`,0).attr(`y`,0).attr(`width`,u).attr(`height`,26).attr(`rx`,4).attr(`ry`,4).attr(`fill`,C[e]).attr(`fill-opacity`,.95),s.attr(`x`,u/2).attr(`y`,26/2)}),a>0){let t=o+i.length*30,r=`+${a} more`,s=U.append(`g`),c=s.append(`text`).attr(`class`,`cynefinItemText`).attr(`x`,0).attr(`y`,26/2).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`central`).text(r),l=r.length*7,u=c.node();if(u&&typeof u.getBBox==`function`){let e=u.getBBox();e.width>0&&(l=e.width)}let d=l+20,f=n.cx-d/2;s.attr(`transform`,`translate(${f}, ${t})`),s.insert(`rect`,`text`).attr(`class`,`cynefinItemOverflow`).attr(`x`,0).attr(`y`,0).attr(`width`,d).attr(`height`,26).attr(`rx`,4).attr(`ry`,4).attr(`fill`,C[e]).attr(`fill-opacity`,.6),c.attr(`x`,d/2).attr(`y`,26/2)}}if(l.length>0){let t=N.select(`defs`).empty()?N.append(`defs`):N.select(`defs`),r=`cynefin-arrow-${n}`;t.append(`marker`).attr(`id`,r).attr(`viewBox`,`0 0 10 10`).attr(`refX`,9).attr(`refY`,5).attr(`markerWidth`,6).attr(`markerHeight`,6).attr(`orient`,`auto-start-reverse`).append(`path`).attr(`d`,`M 0 0 L 10 5 L 0 10 z`).attr(`class`,`cynefinArrowHead`);let i=P.append(`g`).attr(`class`,`cynefin-arrows`);l.forEach(t=>{let n=F[t.from],a=F[t.to];if(!n||!a)return;if(t.from===t.to){e.warn(`Cynefin renderer: skipping self-loop on domain "${t.from}"`);return}let o=n.cx,s=n.cy,c=a.cx,l=a.cy,u=(o+c)/2,d=(s+l)/2,f=c-o,p=l-s,m=Math.sqrt(f*f+p*p),h=m*.15,g=-p/m,_=f/m,v=u+g*h,y=d+_*h;i.append(`path`).attr(`class`,`cynefinArrowLine`).attr(`d`,`M${o},${s} Q${v},${y} ${c},${l}`).attr(`fill`,`none`).attr(`marker-end`,`url(#${r})`),t.label&&i.append(`text`).attr(`class`,`cynefinArrowLabel`).attr(`x`,v).attr(`y`,y-6).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`auto`).text(t.label)})}u&&P.append(`text`).attr(`class`,`cynefinTitle`).attr(`x`,g/2).attr(`y`,-v/2).attr(`text-anchor`,`middle`).attr(`dominant-baseline`,`middle`).text(u)},`draw`)},P=t(()=>p(n(),s().themeVariables).cynefin,`getCynefinTheme`),F={parser:x,db:y,renderer:N,styles:t(()=>{let e=P();return`
	.cynefinDomain {
		stroke: none;
	}
	.cynefinDomainLabel {
		font-size: ${e.domainFontSize}px;
		font-weight: bold;
		fill: ${e.labelColor};
	}
	.cynefinSubtitle {
		font-size: ${e.itemFontSize-1}px;
		fill: ${e.textColor};
		font-style: italic;
	}
	.cynefinItem {
		fill-opacity: 0.95;
		stroke: ${e.boundaryColor};
		stroke-width: 1;
	}
	.cynefinItemText {
		font-size: ${e.itemFontSize}px;
		fill: ${e.textColor};
	}
	.cynefinItemOverflow {
		fill-opacity: 0.6;
		stroke: ${e.boundaryColor};
		stroke-width: 1;
		stroke-dasharray: 3 2;
	}
	.cynefinBoundary {
		stroke: ${e.boundaryColor};
		stroke-width: ${e.boundaryWidth};
		stroke-dasharray: 6 3;
	}
	.cynefinCliff {
		stroke: ${e.cliffColor};
		stroke-width: ${e.cliffWidth};
	}
	.cynefinConfusion {
		stroke: ${e.boundaryColor};
		stroke-width: 1.5;
		stroke-dasharray: 4 2;
	}
	.cynefinArrowLine {
		stroke: ${e.arrowColor};
		stroke-width: ${e.arrowWidth};
		fill: none;
	}
	.cynefinArrowHead {
		fill: ${e.arrowColor};
		stroke: none;
	}
	.cynefinArrowLabel {
		font-size: ${e.itemFontSize-1}px;
		fill: ${e.textColor};
	}
	.cynefinTitle {
		font-size: ${e.domainFontSize+2}px;
		font-weight: bold;
		fill: ${e.labelColor};
	}
	`},`styles`)};export{F as diagram};