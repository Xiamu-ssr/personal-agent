import path from 'node:path';
import { readJson } from './store.mjs';
import { writePrivateJson } from './private-json.mjs';

// A receipt means the cloud has saved the input. Model admission and completion
// are separate: a slow gateway must not hold the user's composer hostage.
export class MessageInbox {
 constructor(root){this.file=path.join(root,'system/message-inbox.json');this.records=new Map(Object.entries(readJson(this.file,{})));}
 save(){writePrivateJson(this.file,Object.fromEntries(this.records));}
 put(record){this.records.set(record.entry.id,record);this.save();}
 received(id){if(this.records.delete(id))this.save();}
}
