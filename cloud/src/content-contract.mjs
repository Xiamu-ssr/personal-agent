import { z } from 'zod';

// File readers, publishing tools and generated workspace instructions share this contract.
export const LIBRARY_PATHS = { sites:'data/library/sites', documents:'data/library/documents', media:'data/library/media' };
export const GOAL_STATUSES = ['未开始','进行中','等待条件','待用户反馈','已完成','暂停','取消'];
export const goalFields = {
 name:z.string().min(1).max(180).refine(s=>!/[\\/\x00-\x1f]/.test(s)&&s!=='.'&&s!=='..','目标名不正确'),
 title:z.string().min(1).max(300),status:z.enum(GOAL_STATUSES),progress:z.number().min(0).max(100),
 body:z.string().max(40000),domain:z.string().optional(),cadence:z.string().optional(),
 due:z.string().refine(s=>!s||/^\d{4}-\d{2}-\d{2}$/.test(s),'日期要 YYYY-MM-DD').optional(),
};
export const goalSchema=z.object(goalFields);
export function contentInstructions() {
 return `# 内容约定\n- Feed 是持续关注的信息与事实更新；“关注一下”通常更新 data/feed/动态说明.md，不自动变成 Goal。Idea 是尚未采纳的个性建议；采纳后才成为 Goal。Goal 是已交办且需要持续推进的事情。\n- 可交互站点、看板放 ${LIBRARY_PATHS.sites}/<名称>/index.html，样式、脚本和图片放同目录。文档、报告放 ${LIBRARY_PATHS.documents}/；HTML 报告也属于文档。独立图片、视频、音频放 ${LIBRARY_PATHS.media}/。草稿放 workspace/，已有成果原地更新。\n- 动态放 data/feed/YYYY-MM-DD/HHMM-名称.md，frontmatter 至少含 title，可含 source、url、published、image；image 是同目录相对路径。正文使用 Markdown。\n- Idea 放 data/ideas/点子.md。每组用 ## 标题，每条用“- 图标 **标题**：说明”，下一行缩进“> 采用这条时发送的具体请求”。允许没有新点子，不为更新而凑数。\n- Goal 放 data/goals/<名称>.md，frontmatter 的 status 为 ${GOAL_STATUSES.join('/')}，progress 为 0–100，可含 domain、cadence（cron）、due（YYYY-MM-DD）。正文写进展、下一步、等待条件、结果和来源；优先用 goals 工具维护。\n- 写好动态、点子、目标或资源文件后，用 content.publish(path) 校验并发布；工具和 App 读取同一个文件，不复制内容到第二份存储。报错时修正原文件再发布。\n`;
}
