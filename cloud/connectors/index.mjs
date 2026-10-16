// Only released code belongs in the registry. Configuration is never imported as code.
import qq_mail from "./qq-mail/index.mjs";
import netease_163 from "./netease-163/index.mjs";
import netease_126 from "./netease-126/index.mjs";
import gmail from "./gmail/index.mjs";
import exmail from "./exmail/index.mjs";
import aliyun_mail from "./aliyun-mail/index.mjs";
import imap from "./imap/index.mjs";
import tavily from "./tavily/index.mjs";
import weread from "./weread/index.mjs";
import wind from "./wind/index.mjs";
import github from "./github/index.mjs";
import tencent_quotes from "./tencent-quotes/index.mjs";
import amap from "./amap/index.mjs";

export const connectors = [qq_mail, netease_163, netease_126, gmail, exmail, aliyun_mail, imap, tavily, weread, wind, github, tencent_quotes, amap];
export default connectors;
