import { createImapConnector } from "../_shared/imap.mjs";

export default createImapConnector({
  name: "qq-mail", title: "QQ 邮箱", icon: "icon.png",
  host: "imap.qq.com", needsID: false,
  help: "QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP → 生成授权码",
});
