import assert from "node:assert/strict";
import test from "node:test";
import { createEngine, defaults } from "../plugins/GPL/js/events.ts";
const message={id:"1",channel_id:"room",author:{id:"sender",username:"Sender"},content:"hi <@me>",mentions:[{id:"me"}]};
const create={type:"MESSAGE_CREATE",message};
const edit={type:"MESSAGE_UPDATE",message:{id:"1",channel_id:"room",content:"hello",mentions:[]}};
const remove={type:"MESSAGE_DELETE",id:"1",channelId:"room"};
function fixture(mode){
 const rows=[], alerts=[];
 const engine=createEngine(mode,{settings:()=>({...defaults, alerts:true}),me:()=>({id:"me",roles:[]}),channel:()=>undefined,reference:()=>undefined,record:x=>rows.push(x),alert:(x,e)=>alerts.push([x,e])});
 return {engine,rows,alerts};
}
test("AML captures content changes and deletions without mutating Discord events",()=>{
 const {engine,rows}=fixture("aml");
 const before=structuredClone([create,edit,remove]);
 for(const event of [create,edit,remove]) engine.observe(event);
 assert.deepEqual(rows.map(x=>[x.kind,x.before.content]),[["edited","hi <@me>"],["deleted","hello"]]);
 assert.deepEqual([create,edit,remove],before);
});
test("GPL detects a removed ping and ignores an edit whose mention fields are absent",()=>{
 const {engine,rows}=fixture("gpl");
 engine.observe(create);
 engine.observe({type:"MESSAGE_UPDATE",message:{id:"1",channel_id:"room",flags:1}});
 assert.equal(rows.length,0);
 engine.observe(edit);engine.observe(remove);
 assert.deepEqual(rows.map(x=>x.kind),["edited"]);
});
test("GPL can use AML's pre-event snapshot in either order",()=>{
 for(const amlFirst of [true,false]){
  const a=fixture("aml"),g=fixture("gpl");
  a.engine.observe(create);
  const observe=()=>g.engine.observe(remove,a.engine.lookup);
  if(amlFirst){a.engine.observe(remove);observe()}else{observe();a.engine.observe(remove)}
  assert.equal(g.rows.length,1);
  assert.equal(g.engine.alerted(remove,"1"),true);
 }
});
test("GPL detects role and reply pings and ignores self and bots",()=>{
 const rows=[];
 const e=createEngine("gpl",{settings:()=>defaults,me:()=>({id:"me",roles:["role"]}),channel:()=>undefined,reference:()=>undefined,record:x=>rows.push(x),alert:()=>{}});
 for(const [id,delta] of [["role",{mention_roles:["role"]}],["reply",{message_reference:{message_id:"ref"},referenced_message:{author:{id:"me"}}}],["bot",{mentions:["me"],author:{id:"bot",bot:true}}],["self",{mentions:["me"],author:{id:"me"}}]]){
   e.observe({type:"MESSAGE_CREATE",message:{...message,id,mentions:[],...delta}});
 }
 e.observe({type:"MESSAGE_DELETE_BULK",channelId:"room",ids:["role","reply","bot","self","unknown"]});
 assert.deepEqual(rows.map(x=>x.before.id),["role","reply"]);
});

test("GPL recognizes a reply embedded in Discord's message record after its source is evicted",()=>{
 const {engine,rows}=fixture("gpl");
 engine.observe({type:"MESSAGE_CREATE",message:{...message,mentions:[],content:"reply",
   referencedMessage:{message:{author:{id:"me"}}},reference:{messageId:"evicted"}}});
 engine.observe(remove);
 assert.equal(rows.length,1);
 assert.equal(rows[0].before.replyTo,"me");
});
