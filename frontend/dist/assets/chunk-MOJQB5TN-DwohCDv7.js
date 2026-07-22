import{m as e}from"./src-Bv2VRg4z.js";import{n as t}from"./chunk-Y2CYZVJY-DsF7k-Jl.js";import{D as n,a as r,b as i,c as a,x as o,z as s}from"./chunk-WYO6CB5R-BNfIql0O.js";import{f as c}from"./index-ChzndERt.js";var l,u,d=``,f=``,p=``,m=[],h=new Map,g=t(e=>s(e,o()),`sanitizeText`),_=t(e=>{switch(e.type){case`terminal`:return{...e,value:g(e.value)};case`nonterminal`:return{...e,name:g(e.name)};case`sequence`:return{...e,elements:e.elements.map(_)};case`choice`:return{...e,alternatives:e.alternatives.map(_)};case`optional`:return{...e,element:_(e.element)};case`repetition`:return{...e,element:_(e.element),separator:e.separator?_(e.separator):void 0};case`special`:return{...e,text:g(e.text)}}},`sanitizeAstNode`),v=t(()=>{d=``,f=``,p=``,m.length=0,h.clear(),r(),e.debug(`[Railroad] Database cleared`)},`clear`),y=t(t=>{d=g(t),e.debug(`[Railroad] Title set:`,t)},`setTitle`),b=t(()=>d,`getTitle`),x={clear:v,setTitle:y,getTitle:b,addRule:t(t=>{let n={...t,name:g(t.name),definition:_(t.definition),comment:t.comment?g(t.comment):void 0};e.debug(`[Railroad] Adding rule:`,n.name),h.has(n.name)&&e.warn(`[Railroad] Rule '${n.name}' is already defined. Overwriting.`),m.push(n),h.set(n.name,n)},`addRule`),getRules:t(()=>m,`getRules`),getRule:t(e=>h.get(e),`getRule`),setAccTitle:t(t=>{f=g(t).replace(/^\s+/g,``),e.debug(`[Railroad] Accessibility title set:`,t)},`setAccTitle`),getAccTitle:t(()=>f,`getAccTitle`),setAccDescription:t(t=>{p=g(t).replace(/\n\s+/g,`
`),e.debug(`[Railroad] Accessibility description set:`,t)},`setAccDescription`),getAccDescription:t(()=>p,`getAccDescription`),setDiagramTitle:y,getDiagramTitle:b},S={compactMode:!1,padding:10,verticalSeparation:8,horizontalSeparation:10,arcRadius:10,fontSize:14,fontFamily:`monospace`,terminalFill:`#FFFFC0`,terminalStroke:`#000000`,terminalTextColor:`#000000`,nonTerminalFill:`#FFFFFF`,nonTerminalStroke:`#000000`,nonTerminalTextColor:`#000000`,lineColor:`#000000`,strokeWidth:2,markerFill:`#000000`,commentFill:`#E8E8E8`,commentStroke:`#888888`,commentTextColor:`#666666`,specialFill:`#F0E0FF`,specialStroke:`#8800CC`,ruleNameColor:`#000066`,showMarkers:!0,markerRadius:5},C=/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$|^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([\d\s%+,./-]+\)$|^[a-z]+$/i,w=/^[\w "',.-]+$/,T=new Set([`compactMode`,`padding`,`verticalSeparation`,`horizontalSeparation`,`arcRadius`,`fontSize`,`fontFamily`,`terminalFill`,`terminalStroke`,`terminalTextColor`,`nonTerminalFill`,`nonTerminalStroke`,`nonTerminalTextColor`,`lineColor`,`strokeWidth`,`markerFill`,`commentFill`,`commentStroke`,`commentTextColor`,`specialFill`,`specialStroke`,`ruleNameColor`,`showMarkers`,`markerRadius`]),E=t(e=>e?Object.keys(e).every(e=>e===`railroad`||T.has(e)):!1,`isRailroadStyleOptions`),D=t(e=>e?`railroad`in e&&e.railroad?e.railroad:E(e)?e:{}:{},`extractRailroadOverrides`),O=t(e=>{if(!e||E(e))return{};let{railroad:t,svgId:n,theme:r,look:i,...a}=e;return a},`extractThemeOverrides`),k=t((e,t)=>{if(typeof e!=`string`)return t;let n=e.trim();return C.test(n)?n:t},`sanitizeColorValue`),A=t((e,t)=>{if(typeof e!=`string`)return t;let n=e.trim();return w.test(n)?n:t},`sanitizeFontFamilyValue`),j=t((e,t)=>{let n=typeof e==`number`?e:typeof e==`string`?Number.parseFloat(e):NaN;return Number.isFinite(n)&&n>=0?n:t},`sanitizeNumberValue`),M=t(e=>{let t=typeof e==`number`?e:typeof e==`string`?Number.parseFloat(e):NaN;return Number.isFinite(t)&&t>0?t:void 0},`parseThemeFontSize`),N=t(e=>{var t,n,r,i,a,o,s,c,l,u,d,f,p;let m=A(e.fontFamily,S.fontFamily),h=(t=M(e.fontSize))==null?S.fontSize:t;return{...S,fontFamily:m,fontSize:h,terminalFill:k((n=e.secondBkg)==null?e.secondaryColor:n,S.terminalFill),terminalStroke:k((r=e.secondaryBorderColor)==null?e.lineColor:r,S.terminalStroke),terminalTextColor:k((i=e.secondaryTextColor)==null?e.textColor:i,S.terminalTextColor),nonTerminalFill:k((a=e.mainBkg)==null?e.background:a,S.nonTerminalFill),nonTerminalStroke:k((o=e.primaryBorderColor)==null?e.lineColor:o,S.nonTerminalStroke),nonTerminalTextColor:k((s=e.primaryTextColor)==null?e.textColor:s,S.nonTerminalTextColor),lineColor:k(e.lineColor,S.lineColor),markerFill:k(e.lineColor,S.markerFill),commentFill:k((c=e.labelBackground)==null?e.tertiaryColor:c,S.commentFill),commentStroke:k((l=e.tertiaryBorderColor)==null?e.lineColor:l,S.commentStroke),commentTextColor:k((u=e.tertiaryTextColor)==null?e.textColor:u,S.commentTextColor),specialFill:k((d=e.tertiaryColor)==null?e.secondaryColor:d,S.specialFill),specialStroke:k((f=e.tertiaryBorderColor)==null?e.secondaryBorderColor:f,S.specialStroke),ruleNameColor:k((p=e.titleColor)==null?e.textColor:p,S.ruleNameColor)}},`buildThemeDefaults`),P=t(e=>{var t,r,a,o;let s=i(),c=N({...n(),...(t=s.themeVariables)==null?{}:t,...O(e)}),l={...(r=s.railroad)==null?{}:r,...D(e)};return{compactMode:(a=l.compactMode)==null?c.compactMode:a,padding:j(l.padding,c.padding),verticalSeparation:j(l.verticalSeparation,c.verticalSeparation),horizontalSeparation:j(l.horizontalSeparation,c.horizontalSeparation),arcRadius:j(l.arcRadius,c.arcRadius),fontSize:j(l.fontSize,c.fontSize),fontFamily:A(l.fontFamily,c.fontFamily),terminalFill:k(l.terminalFill,c.terminalFill),terminalStroke:k(l.terminalStroke,c.terminalStroke),terminalTextColor:k(l.terminalTextColor,c.terminalTextColor),nonTerminalFill:k(l.nonTerminalFill,c.nonTerminalFill),nonTerminalStroke:k(l.nonTerminalStroke,c.nonTerminalStroke),nonTerminalTextColor:k(l.nonTerminalTextColor,c.nonTerminalTextColor),lineColor:k(l.lineColor,c.lineColor),strokeWidth:j(l.strokeWidth,c.strokeWidth),markerFill:k(l.markerFill,c.markerFill),commentFill:k(l.commentFill,c.commentFill),commentStroke:k(l.commentStroke,c.commentStroke),commentTextColor:k(l.commentTextColor,c.commentTextColor),specialFill:k(l.specialFill,c.specialFill),specialStroke:k(l.specialStroke,c.specialStroke),ruleNameColor:k(l.ruleNameColor,c.ruleNameColor),showMarkers:(o=l.showMarkers)==null?c.showMarkers:o,markerRadius:j(l.markerRadius,c.markerRadius)}},`buildRailroadStyleOptions`),F=t(e=>{let{fontFamily:t,fontSize:n,terminalFill:r,terminalStroke:i,terminalTextColor:a,nonTerminalFill:o,nonTerminalStroke:s,nonTerminalTextColor:c,lineColor:l,strokeWidth:u,markerFill:d,commentFill:f,commentStroke:p,commentTextColor:m,specialFill:h,specialStroke:g,ruleNameColor:_}=P(e);return`
  .railroad-diagram {
    font-family: ${t};
    font-size: ${n}px;
  }

  .railroad-terminal rect {
    fill: ${r};
    stroke: ${i};
    stroke-width: ${u}px;
  }

  .railroad-terminal text {
    fill: ${a};
    font-family: ${t};
    font-size: ${n}px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .railroad-nonterminal rect {
    fill: ${o};
    stroke: ${s};
    stroke-width: ${u}px;
  }

  .railroad-nonterminal text {
    fill: ${c};
    font-family: ${t};
    font-size: ${n}px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .railroad-line {
    stroke: ${l};
    stroke-width: ${u}px;
    fill: none;
  }

  .railroad-start circle,
  .railroad-end circle {
    fill: ${d};
  }

  .railroad-comment ellipse {
    fill: ${f};
    stroke: ${p};
    stroke-width: ${u}px;
  }

  .railroad-comment text {
    fill: ${m};
    font-style: italic;
    font-family: ${t};
    font-size: ${n}px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .railroad-special rect {
    fill: ${h};
    stroke: ${g};
    stroke-width: ${u}px;
    stroke-dasharray: 5,3;
  }

  .railroad-special text {
    fill: ${c};
    font-family: ${t};
    font-size: ${n}px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .railroad-rule-name {
    font-weight: bold;
    fill: ${_};
    font-family: ${t};
    font-size: ${n}px;
  }

  .railroad-group {
    /* Grouping container, no specific styles */
  }
`},`getStyles`),I=(l=class{constructor(){this.d=``}moveTo(e,t){return this.d+=`M ${e} ${t} `,this}lineTo(e,t){return this.d+=`L ${e} ${t} `,this}horizontalTo(e){return this.d+=`H ${e} `,this}verticalTo(e){return this.d+=`V ${e} `,this}arcTo(e,t,n,r,i,a,o){return this.d+=`A ${e} ${t} ${n} ${+!!r} ${+!!i} ${a} ${o} `,this}build(){return this.d.trim()}},t(l,`PathBuilder`),l),L=(u=class{constructor(e,t=P()){this.textCache=new Map,this.svg=e,this.config=t}measureText(e){if(this.textCache.has(e))return this.textCache.get(e);let t=this.svg.append(`text`).attr(`font-family`,this.config.fontFamily).attr(`font-size`,this.config.fontSize).text(e),n=t.node().getBBox(),r={width:n.width,height:n.height};return t.remove(),this.textCache.set(e,r),r}renderTerminal(e,t){let n=this.measureText(t),r=n.width+this.config.padding*2,i=n.height+this.config.padding*2,a=e.append(`g`).attr(`class`,`railroad-terminal`);return a.append(`rect`).attr(`x`,0).attr(`y`,0).attr(`width`,r).attr(`height`,i).attr(`rx`,10).attr(`ry`,10),a.append(`text`).attr(`x`,r/2).attr(`y`,i/2).text(t),{element:a.node(),dimensions:{width:r,height:i,up:i/2,down:i/2}}}renderNonTerminal(e,t){let n=this.measureText(t),r=n.width+this.config.padding*2,i=n.height+this.config.padding*2,a=e.append(`g`).attr(`class`,`railroad-nonterminal`);return a.append(`rect`).attr(`x`,0).attr(`y`,0).attr(`width`,r).attr(`height`,i),a.append(`text`).attr(`x`,r/2).attr(`y`,i/2).text(t),{element:a.node(),dimensions:{width:r,height:i,up:i/2,down:i/2}}}renderSequence(e,t){let n=t.map(t=>this.renderExpression(e,t)),r=0,i=0,a=0;for(let e of n)r+=e.dimensions.width,i=Math.max(i,e.dimensions.up),a=Math.max(a,e.dimensions.down);r+=(n.length-1)*this.config.horizontalSeparation;let o=e.append(`g`).attr(`class`,`railroad-sequence`),s=0;for(let e=0;e<n.length;e++){let t=n[e],r=i-t.dimensions.up;if(o.node().appendChild(t.element).setAttribute(`transform`,`translate(${s}, ${r})`),e<n.length-1){let e=s+t.dimensions.width,n=e+this.config.horizontalSeparation,r=i;o.append(`path`).attr(`class`,`railroad-line`).attr(`d`,new I().moveTo(e,r).lineTo(n,r).build())}s+=t.dimensions.width+this.config.horizontalSeparation}return{element:o.node(),dimensions:{width:r,height:i+a,up:i,down:a}}}renderChoice(e,t){let n=t.map(t=>this.renderExpression(e,t)),r=0,i=0;for(let e of n)r=Math.max(r,e.dimensions.width),i+=e.dimensions.height;i+=(n.length-1)*this.config.verticalSeparation;let a=this.config.arcRadius,o=a*4,s=r+o,c=e.append(`g`).attr(`class`,`railroad-choice`),l=0,u=i/2;for(let e of n){let t=l,n=t+e.dimensions.up,i=a*2+(r-e.dimensions.width)/2;c.node().appendChild(e.element).setAttribute(`transform`,`translate(${i}, ${t})`);let o=new I,d=n>u;n===u?o.moveTo(0,u).lineTo(i,n):o.moveTo(0,u).arcTo(a,a,0,!1,d,a,u+(d?a:-a)).lineTo(a,n-(d?a:-a)).arcTo(a,a,0,!1,!d,a*2,n).lineTo(i,n),c.append(`path`).attr(`class`,`railroad-line`).attr(`d`,o.build());let f=new I,p=i+e.dimensions.width,m=s-a*2;n===u?f.moveTo(p,n).lineTo(s,u):f.moveTo(p,n).lineTo(m,n).arcTo(a,a,0,!1,!d,s-a,n+(d?-a:a)).lineTo(s-a,u+(d?a:-a)).arcTo(a,a,0,!1,d,s,u),c.append(`path`).attr(`class`,`railroad-line`).attr(`d`,f.build()),l+=e.dimensions.height+this.config.verticalSeparation}return{element:c.node(),dimensions:{width:s,height:i,up:u,down:i-u}}}renderOptional(e,t){let n=this.renderExpression(e,t),r=this.config.arcRadius,i=r*2,a=n.dimensions.width+r*4,o=n.dimensions.height+i,s=e.append(`g`).attr(`class`,`railroad-optional`),c=r*2,l=i;s.node().appendChild(n.element).setAttribute(`transform`,`translate(${c}, ${l})`);let u=l+n.dimensions.up,d=new I().moveTo(0,u).lineTo(r*2,u);s.append(`path`).attr(`class`,`railroad-line`).attr(`d`,d.build());let f=new I().moveTo(c+n.dimensions.width,u).lineTo(a,u);s.append(`path`).attr(`class`,`railroad-line`).attr(`d`,f.build());let p=new I().moveTo(0,u).arcTo(r,r,0,!1,!1,r,u-r).lineTo(r,r).arcTo(r,r,0,!1,!0,r*2,0).lineTo(a-r*2,0).arcTo(r,r,0,!1,!0,a-r,r).lineTo(a-r,u-r).arcTo(r,r,0,!1,!1,a,u);return s.append(`path`).attr(`class`,`railroad-line`).attr(`d`,p.build()),{element:s.node(),dimensions:{width:a,height:o,up:u,down:o-u}}}renderRepetition(e,t,n){let r=this.renderExpression(e,t),i=this.config.arcRadius,a=i*2,o=r.dimensions.width+i*4,s=n===0,c=r.dimensions.height+a+(s?a:0),l=e.append(`g`).attr(`class`,`railroad-repetition`),u=i*2,d=s?a:0;l.node().appendChild(r.element).setAttribute(`transform`,`translate(${u}, ${d})`);let f=d+r.dimensions.up;l.append(`path`).attr(`class`,`railroad-line`).attr(`d`,new I().moveTo(0,f).lineTo(i*2,f).build()),l.append(`path`).attr(`class`,`railroad-line`).attr(`d`,new I().moveTo(u+r.dimensions.width,f).lineTo(o,f).build());let p=d+r.dimensions.height+i,m=new I().moveTo(u+r.dimensions.width,f).arcTo(i,i,0,!1,!0,u+r.dimensions.width+i,f+i).lineTo(u+r.dimensions.width+i,p).arcTo(i,i,0,!1,!0,u+r.dimensions.width,p+i).lineTo(i*2,p+i).arcTo(i,i,0,!1,!0,i,p).lineTo(i,f+i).arcTo(i,i,0,!1,!0,i*2,f);if(l.append(`path`).attr(`class`,`railroad-line`).attr(`d`,m.build()),s){let e=new I().moveTo(0,f).arcTo(i,i,0,!1,!1,i,f-i).lineTo(i,i).arcTo(i,i,0,!1,!0,i*2,0).lineTo(o-i*2,0).arcTo(i,i,0,!1,!0,o-i,i).lineTo(o-i,f-i).arcTo(i,i,0,!1,!1,o,f);l.append(`path`).attr(`class`,`railroad-line`).attr(`d`,e.build())}return{element:l.node(),dimensions:{width:o,height:c,up:f,down:c-f}}}renderSpecial(e,t){let n=this.measureText(`? `+t+` ?`),r=n.width+this.config.padding*2,i=n.height+this.config.padding*2,a=e.append(`g`).attr(`class`,`railroad-special`);return a.append(`rect`).attr(`x`,0).attr(`y`,0).attr(`width`,r).attr(`height`,i),a.append(`text`).attr(`x`,r/2).attr(`y`,i/2).text(`? `+t+` ?`),{element:a.node(),dimensions:{width:r,height:i,up:i/2,down:i/2}}}renderExpression(e,t){switch(t.type){case`terminal`:return this.renderTerminal(e,t.value);case`nonterminal`:return this.renderNonTerminal(e,t.name);case`sequence`:return this.renderSequence(e,t.elements);case`choice`:return this.renderChoice(e,t.alternatives);case`optional`:return this.renderOptional(e,t.element);case`repetition`:return this.renderRepetition(e,t.element,t.min);case`special`:return this.renderSpecial(e,t.text);default:throw Error(`Unknown node type: ${t.type}`)}}renderRule(e,t){let n=this.svg.append(`g`).attr(`class`,`railroad-rule`).attr(`transform`,`translate(0, ${t})`),r=e.name+` =`,i=this.measureText(r).width+20,a=i+20,o=n.append(`g`),s=this.renderExpression(o,e.definition),c=Math.max(20,s.dimensions.up),l=c-s.dimensions.up;return o.attr(`transform`,`translate(${a}, ${l})`),n.append(`g`).attr(`class`,`railroad-rule-name-group`).append(`text`).attr(`class`,`railroad-rule-name`).attr(`x`,0).attr(`y`,c).text(r),n.append(`g`).attr(`class`,`railroad-start`).append(`circle`).attr(`cx`,i).attr(`cy`,c).attr(`r`,this.config.markerRadius),n.append(`g`).attr(`class`,`railroad-end`).append(`circle`).attr(`cx`,a+s.dimensions.width+10).attr(`cy`,c).attr(`r`,this.config.markerRadius),n.append(`path`).attr(`class`,`railroad-line`).attr(`d`,new I().moveTo(i+this.config.markerRadius,c).lineTo(a,c).build()),n.append(`path`).attr(`class`,`railroad-line`).attr(`d`,new I().moveTo(a+s.dimensions.width,c).lineTo(a+s.dimensions.width+10-this.config.markerRadius,c).build()),{height:Math.max(40,l+s.dimensions.height+this.config.padding*2),width:a+s.dimensions.width+10+this.config.markerRadius}}renderDiagram(e){let t=this.config.padding,n=0;for(let r of e){let e=this.renderRule(r,t);t+=e.height+this.config.verticalSeparation,n=Math.max(n,e.width)}return{width:n+this.config.padding*2,height:t+this.config.padding}}},t(u,`RailroadRenderer`),u),R=t((e,t,n)=>{a(e,t.height,t.width,n),e.attr(`viewBox`,`0 0 ${t.width} ${t.height}`)},`configureRailroadSvgSize`),z={draw:t((t,n,r)=>{e.debug(`[Railroad] Rendering diagram
`+t);try{var a;let t=c(n);t.attr(`class`,`railroad-diagram`);let r=i().railroad,o=(a=r==null?void 0:r.useMaxWidth)==null?!0:a,s=x.getRules();if(e.debug(`[Railroad] Rendering ${s.length} rules`),s.length===0){e.warn(`[Railroad] No rules to render`),R(t,{height:100,width:200},o);return}R(t,new L(t,P()).renderDiagram(s),o),e.debug(`[Railroad] Render complete`)}catch(t){throw e.error(`[Railroad] Render error:`,t),t}},`draw`)};export{F as n,z as r,x as t};