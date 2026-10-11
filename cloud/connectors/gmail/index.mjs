import { createImapConnector } from "../_shared/imap.mjs";

export default createImapConnector({
  name: "gmail", title: "Gmail", icon: "icon.png",
  host: "imap.gmail.com", needsID: false,
  help: "Google 账号 → 安全 → 开启两步验证 → 应用专用密码；云主机须能访问 Gmail（需要代理），部分管理员不允许密码方式 IMAP",
});
