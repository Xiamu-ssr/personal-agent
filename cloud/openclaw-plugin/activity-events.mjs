// Telemetry never participates in tool admission. A stalled body process must
// not turn a harmless read/exec into a failed before_tool_call hook.
export function recordActivity(bridge,phase,event,ctx){
 if(String(event.toolName).startsWith('doudou_'))return;
 void Promise.resolve().then(()=>bridge('event',{phase,tool:event.toolName,error:!!event.error},ctx.sessionKey,2000)).catch(()=>{});
}
