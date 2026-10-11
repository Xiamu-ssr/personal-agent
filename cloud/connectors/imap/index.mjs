import { createImapConnector } from "../_shared/imap.mjs";

export default createImapConnector({
  name: "imap", title: "其他邮箱", icon: "icon.svg",
  help: "在邮箱服务商设置中开启 IMAP，使用授权码或客户端专用密码",
});
