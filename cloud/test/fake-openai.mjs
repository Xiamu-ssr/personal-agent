import http from 'node:http';

// Text-only synthetic OpenAI wire endpoint for native model/compaction tests.
export async function fakeOpenAI(respond) {
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(!req.url.endsWith('/chat/completions')){res.writeHead(404);res.end();return;}
  const body=JSON.parse(raw);requests.push(body);
  const reply=await respond(body,requests.length-1,{headers:req.headers,url:req.url});
  if(reply.error){res.writeHead(reply.status||400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:reply.error}}));return;}
  const text=(reply.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const usage={prompt_tokens:reply.usage?.input_tokens??10,completion_tokens:8,total_tokens:(reply.usage?.input_tokens??10)+8};
  const id='chatcmpl_fixture_'+requests.length,created=Math.floor(Date.now()/1000);
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,object:'chat.completion',created,model:body.model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const chunk=(choices,extra={})=>res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:body.model,choices,...extra})+'\n\n');
  chunk([{index:0,delta:{role:'assistant',content:text},finish_reason:null}]);
  chunk([{index:0,delta:{},finish_reason:'stop'}]);chunk([],{usage});
  res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {requests,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
