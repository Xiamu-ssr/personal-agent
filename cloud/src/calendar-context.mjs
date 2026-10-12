import chineseDays from "chinese-days";
import { dateIn } from "./store.mjs";

export const shiftDate = (date, days) => new Date(Date.parse(date+"T00:00:00Z")+days*86400_000).toISOString().slice(0,10);
const holidayName = (detail) => detail.name.includes(",") ? detail.name.split(",")[1] : null;
function dayKind(date) {
  const detail=chineseDays.getDayDetail(date), holiday=holidayName(detail);
  if (holiday) return detail.work ? `调休上班（${holiday}）` : `法定节假日（${holiday}）`;
  return detail.work ? "工作日" : "周末";
}
// Pass local calendar dates to the package, independent of the server's own timezone.
export function calendarContext({timezone="Asia/Shanghai",now=new Date()}={}) {
  const date=dateIn(timezone,now), lunar=chineseDays.getLunarDate(date);
  const term=chineseDays.getSolarTerms(date).find((t)=>t.date===date)?.name;
  const upcoming=[];
  for(let n=1;n<=7;n++) {
    const next=shiftDate(date,n), detail=chineseDays.getDayDetail(next);
    if (holidayName(detail)) upcoming.push(`${Number(next.slice(5,7))}月${Number(next.slice(8))}日${dayKind(next)}`);
  }
  return `农历${lunar.isLeap?"闰":""}${lunar.lunarMonCN}${lunar.lunarDayCN}${term?` · ${term}`:""} · ${dayKind(date)}\n未来7天：${upcoming.join("、")||"无节假日或调休"}`;
}
