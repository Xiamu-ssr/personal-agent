import { createImapConnector } from "../_shared/imap.mjs";

export default createImapConnector({
  name: "exmail", title: "腾讯企业邮", icon: "icon.ico",
  host: "imap.exmail.qq.com", needsID: false,
  help: "腾讯企业邮 → 设置 → 客户端设置 → 开启 IMAP 并生成客户端专用密码",
});
