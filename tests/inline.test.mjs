import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import fs from "node:fs";
import vm from "node:vm";
const target = new URL("../plugins/GPL/js/inline.ts",import.meta.url).pathname.slice(1);
const outputFiles = [{text:ts.transpileModule(fs.readFileSync(target,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText}];
function fixture(nativeStyle=false){
 const module={exports:{}};
 const queue=[];
 const hooks=new Map();
 const store=new Map();
 function add(id,content="Original"){store.set(id,{id,channel_id:"c",content,state:"SENT",flags:0});}
 const dispatcher={dispatch(e){
  for(const fn of hooks.get(e.type)||[])e=fn(e);
  if(!e)return Promise.resolve();
  queue.push(e);
  if(e.type==="MESSAGE_DELETE")store.delete(e.id);
  if(e.type==="MESSAGE_DELETE_BULK")e.ids.forEach(id=>store.delete(id));
  return Promise.resolve();
 }};
 class RowManager {
  generate({message}) {
   if (message.author) message.author.getTagProperties();
   return {type:1,message:{id:message.id,content:[{type:"text",content:message.content}]}};
  }
 }
 const requires={
  "react-native":{Platform:{OS:"android"},processColor:value=>parseInt(value.slice(1),16)},
  "@valenced/modules/native":{callNativeMethodSync:()=>nativeStyle},
  "@valenced/discord/common/flux":{Dispatcher:dispatcher},
  "@valenced/discord/flux":{Stores:{MessageStore:{getMessage:(_,id)=>store.get(id)}},onFluxEventDispatched(type,fn){
   let set=hooks.get(type);if(!set)hooks.set(type,set=new Set());set.add(fn);return()=>set.delete(fn);
  }},
  "@valenced/modules/finders":{getModules(_,fn){fn(RowManager);return()=>{};}},
  "@valenced/modules/finders/filters":{withName:()=>({})},
  "@valenced/patcher":{instead(target,key,hook){const original=target[key];target[key]=function(...args){return hook.call(this,args,original);};return()=>{target[key]=original;};}},
 };
 const ctx=vm.createContext({module,exports:module.exports,require:n=>requires[n]});
 vm.runInContext(outputFiles[0].text,ctx);
 const errors=[];
 return { ...module.exports, add, store, queue, hooks, dispatcher, errors, row(id){return new RowManager().generate({message:store.get(id)});}, start(mode,options,logs){return module.exports.installInline(mode,()=>options,()=>logs.current,error=>errors.push(error));} };
}
function entry(id,kind="deleted"){
 return {kind,at:Date.now(),before:{id,channelId:"c",content:"Original"}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test("channel history restores a deleted row once with both loggers active",async()=>{
 const f=fixture();
 const id="1300000000000000000";
 const logs={current:[{kind:"deleted",at:Date.now(),before:{id,channelId:"c",authorId:"u",author:"Sender",content:"Deleted text",mentions:[],roles:[],everyone:false}}]};
 const aml=f.start("aml",{},logs),gpl=f.start("gpl",{},logs);
 await f.dispatcher.dispatch({type:"LOAD_MESSAGES_SUCCESS",channelId:"c",messages:[],hasMoreBefore:false,hasMoreAfter:false});
 const loaded=f.queue.at(-1);
 assert.equal(loaded.messages.length,1);
 assert.equal(loaded.messages[0].id,id);
 assert.equal(loaded.messages[0].content,"Deleted text");
 f.store.set(id,{...loaded.messages[0],author:{...loaded.messages[0].author,getTagProperties:()=>({})}});
 assert.equal(f.row(id).message.textColor,0xed4245);
 aml.stop();gpl.stop();
});
test("retains an existing deleted row, applies colors/timestamp and removes it when cleared",async()=>{
 const f=fixture();f.add("1");
 const logs={current:[entry("1")]};
 const plugin=f.start("aml",{showDeletedTime:true,deletedMessageColor:"#abcdef",deletedNameColor:"#ffeeff"},logs);
 await f.dispatcher.dispatch({type:"MESSAGE_DELETE",id:"1",channelId:"c"});
 const row=f.row("1");
 assert.equal(row.changeType,2);
 assert.equal(row.message.textColor,0xabcdef);
 assert.equal(row.message.usernameColor,0xffeeff);
 assert.match(row.message.edited,/deleted/);
 logs.current=[];plugin.refresh();await tick();
 assert.equal(f.store.has("1"),false);
 assert.equal(f.isInlineEvent(f.queue.at(-1)),true);
 plugin.stop();assert.equal(f.errors.length,0);
});
test("GPL owns ghost ping styling and AML owns ordinary deletions",async()=>{
 const f=fixture();f.add("1");f.add("2");
 const logs={current:[entry("1")]};
 const gpl=f.start("gpl",{redName:true},logs);
 const aml=f.start("aml",{colorDeletedUsername:false,deletedMessageColor:"#abcdef"},logs);
 await f.dispatcher.dispatch({type:"MESSAGE_DELETE_BULK",ids:["1","2"],channelId:"c"});
 assert.equal(f.store.has("2"),false);
 assert.equal(f.row("1").message.textColor,0xed4245);
 assert.equal(f.row("1").message.usernameColor,0xed4245);
 aml.stop();
 assert.equal(f.row("1").message.usernameColor,0xed4245);
 gpl.stop();assert.equal(f.store.has("1"),false);assert.equal(f.errors.length,0);
});
test("previous edits render above live text and are not duplicated on re-render",()=>{
 const f=fixture();f.add("1","Latest");
 const plugin=f.start("aml",{showEditTime:true,editedMessageColor:"#123456"},{current:[entry("1","edited")]});
 const row=f.row("1");const next=f.row("1");
 assert.equal(row.message.content[0].content,"Original");
 assert.match(row.message.content[1].content,/edited/);
 assert.equal(row.message.content[3].content,"Latest");
 assert.equal(next.message.content.length,4);
 assert.equal(row.message.editedColor,0x123456);
 plugin.stop();assert.equal(f.row("1").message.content.length,1);
});
test("rendering edit history keeps the native author instance",()=>{
 const f=fixture();
 const author={getTagProperties:()=>({})};
 class Record {
  constructor(){this.id="1";this.channel_id="c";this.content="Latest";this.author=author;}
  merge(patch){return Object.assign(new Record(),this,patch);}
 }
 f.store.set("1",new Record());
 const old=entry("1","edited");old.before.original={content:"Old formatted text",author:{id:"u"}};
 const plugin=f.start("aml",{}, {current:[old]});
 const row=f.row("1");
 assert.equal(row.message.content[0].content,"Old formatted text (edited)");
 assert.equal(f.store.get("1").author,author);
 assert.equal(f.errors.length,0);
 plugin.stop();
});
test("Android styling scopes configured color and compact labels to each previous edit",()=>{
 const f=fixture(true);f.add("1","Latest");
 const first={...entry("1","edited"),at:100000,before:{...entry("1").before,content:"First"}};
 const second={...entry("1","edited"),at:200000,before:{...entry("1").before,content:"Second"}};
 const plugin=f.start("aml",{showEditTime:true,editedMessageColor:"#123456"},{current:[second,first]});
 const content=f.row("1").message.content;
 assert.match(content[0].content,/\ue1001193046;First\ue101 \ue1021193046;\(edited .+\)\ue103/);
 assert.match(content[2].content,/\ue1001193046;Second\ue101 \ue1021193046;\(edited .+\)\ue103/);
 assert.equal(content.at(-1).content,"Latest");
 plugin.stop();
});
test("every previous version has its own edit time and latest content stays last",()=>{
 const f=fixture();f.add("1","Latest");
 const first={...entry("1","edited"),at:100000,before:{...entry("1").before,content:"First"}};
 const second={...entry("1","edited"),at:200000,before:{...entry("1").before,content:"Second"}};
 const plugin=f.start("aml",{showEditTime:true},{current:[second,first]});
 const content=f.row("1").message.content.map(node=>node.content);
 assert.equal(content[0],"First");assert.equal(content[3],"Second");
 assert.match(content[1],/edited .+/);assert.match(content[4],/edited .+/);
 assert.equal(content.at(-1),"Latest");
 plugin.stop();
});
test("ordinary deleted messages use AML colors with GPL also active",async()=>{
 const f=fixture();f.add("1");
 const aml=f.start("aml",{deletedMessageColor:"#abcdef"},{current:[entry("1")]});
 const gpl=f.start("gpl",{deletedMessageColor:"#123456"},{current:[]});
 await f.dispatcher.dispatch({type:"MESSAGE_DELETE",id:"1",channelId:"c"});
 assert.equal(f.row("1").message.textColor,0xabcdef);
 gpl.stop();aml.stop();
});
