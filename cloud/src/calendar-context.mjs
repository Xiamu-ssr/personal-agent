import chineseDays from "chinese-days";
import { dateIn } from "./store.mjs";

export const shiftDate = (date, days) => new Date(Date.parse(date+"T00:00:00Z")+days*86400_000).toISOString().slice(0,10);
const holidayName = (detail) => detail.name.includes(",") ? detail.name.split(",")[1] : null;
function dayKind(date) {
  const detail=chineseDays.getDayDetail(date), holiday=holidayName(detail);
  if (holiday) return detail.work ? `调休上班（${holiday}）` : `法定节假日（${holiday}）`;
  return detail.work ? "工作日" : "周末";
}
const dateLabel=(date)=>`${Number(date.slice(5,7))}月${Number(date.slice(8))}日`;
function rangeLabel(start,end) {
  if(start===end)return dateLabel(start);
  const last=start.slice(0,7)===end.slice(0,7)?`${Number(end.slice(8))}日`:dateLabel(end);
  return `${dateLabel(start)}–${last}`;
}
// Pass local calendar dates to the package, independent of the server's own timezone.
export function calendarContext({timezone="Asia/Shanghai",now=new Date()}={}) {
  const date=dateIn(timezone,now), lunar=chineseDays.getLunarDate(date);
  const term=chineseDays.getSolarTerms(date).find((t)=>t.date===date)?.name;
  const upcoming=[];
  for(let n=1;n<=7;n++) {
    const next=shiftDate(date,n), detail=chineseDays.getDayDetail(next);
    const holiday=holidayName(detail);
    if(!holiday)continue;
    const last=upcoming.at(-1);
    if(last&&last.holiday===holiday&&last.work===detail.work&&shiftDate(last.end,1)===next)last.end=next;
    else upcoming.push({start:next,end:next,holiday,work:detail.work});
  }
  const upcomingText=upcoming.map(({start,end,holiday,work})=>`${rangeLabel(start,end)} ${work?`调休上班（${holiday}）`:`${holiday}放假`}`).join("、")||"无节假日或调休";
  return `农历${lunar.isLeap?"闰":""}${lunar.lunarMonCN}${lunar.lunarDayCN}${term?` · ${term}`:""} · ${dayKind(date)}\n未来7天：${upcomingText}`;
}
