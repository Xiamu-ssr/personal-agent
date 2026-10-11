import { createImapConnector } from "../_shared/imap.mjs";

export default createImapConnector({
  name: "aliyun-mail", title: "阿里企业邮", icon: "icon.ico",
  host: "imap.qiye.aliyun.com", needsID: false,
  help: "阿里企业邮 → 设置 → 邮箱安全 → 三方客户端安全密码，并开启 IMAP",
});
