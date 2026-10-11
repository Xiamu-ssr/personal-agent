import { createImapConnector } from "../_shared/imap.mjs";

export default createImapConnector({
  name: "netease-126", title: "126 邮箱", icon: "icon.png",
  host: "imap.126.com", needsID: true,
  help: "126 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP 并生成授权码；允许第三方客户端登录",
});
