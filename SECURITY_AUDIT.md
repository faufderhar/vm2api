# vm2api 控制面安全审计

日期：2026-10-24  
范围：当前工作区。人工阅读，没有跑扫描器，也没有改代码。

这次只审控制面里和安全直接相关的路径：登录和会话、面板权限、API 密钥、请求日志、代理出口、集群 SSH、槽位终端、静态文件、落盘加密。协议转换和 Go worker 没有逐行读完，下面的结论不覆盖那两块。

## 结论

| 严重性 | 数量 | 含义 |
| --- | --- | --- |
| 高 | 2 | 能拿走别人的密钥，或拿走管理员会话 |
| 中 | 3 | 能绕过网络边界，或把一次失陷扩得更大 |
| 低 | 3 | 利用条件苛刻，或只是把门槛放低 |
| 已核对、目前站得住 | 8 | 见文末 |

优先修 F1。超级管理员本来不能调用推理，也进不了租户的槽。只要某把有效密钥撞上限流或额度，日志里就有原文。超级管理员打开用量日志或导出 CSV 即可取走。主密钥还可以带 `x-kin-vm` 指定任意槽，租户隔离随之失效。

已经落盘的历史日志要当成泄露处理：轮换主密钥，以及所有曾经返回 403 或 429 的托管密钥。

## F1 高：有效密钥被原文写入请求日志

当前代码已按上面的要求改过：`presentedApiKeyForLog` 只留前 8 位和后 4 位；认出的主密钥或托管密钥只记类型和 key id。迁移 `044_mask_presented_api_keys.sql` 会改掉库里的旧原文。密钥轮换仍要运维做，磁盘上的历史 JSONL 不在这次迁移里。

位置：

- `src/lib/protocol/handle-protocol.mjs`
- `src/lib/admin/request-log.mjs` 的 `presentedApiKeyForLog`
- `src/lib/db/repos/usage-logs-view.mjs`

谁能利用：超级管理员，或能读数据库、JSONL 的人。

`requireAuth` 先比对主密钥或托管密钥。比对成功之后，额度用尽、密钥停用、过期、每分钟次数或网关令牌桶，都会返回失败。推理、搜索、出图三条入口在这个失败上调用 `presentedApiKeyForLog`，最多保留 240 个字符。`sk-vm-` 加 64 位十六进制大约 70 个字符，整把密钥都在里面。

这一步发生在写入 `req.apiKeyRecord` 之前，所以日志行的 `user_id` 是空的。租户的属主过滤看不到这些行。超级管理员的用量日志、请求日志和导出都在允许列表里，字段 `apiKeyPresented` / `api_key_presented` 原样返回。打开 `KIN_REQUEST_LOG_JSONL=1` 时，同一行还追加到 `data/request-logs/*.jsonl`。

错误密钥也会被存下来。更严重的是有效密钥：停用或额度打满之后，密钥材料仍然有效，重新启用或下个窗口就能用。主密钥再带上 `x-kin-vm`（跨域允许这个头），属主范围变成任意，可以打到任意租户的槽。

应改：

- 鉴权失败只记密钥前缀和后四位，或只记已经入库的 key id。
- 不要把客户端送来的原文写进 `usage_logs`、内存环形缓冲和 JSONL。
- 导出列删掉 `api_key_presented`。
- 轮换主密钥和所有曾返回 403/429 的托管密钥。

## F2 高：面板会话放在 localStorage，不放 HttpOnly Cookie

位置：

- `web/src/lib/session.ts` 的 `setSession`
- `src/lib/admin/panel-routes.mjs` 的登录响应

谁能利用：能在面板页面执行脚本的人。

服务端会发 `HttpOnly`、`SameSite=Lax` 的 `kin_panel_token`，滑动 7 天，绝对上限 30 天。前端 `setSession` 却把同一枚令牌放进 `localStorage` 的 `kin_console_token`，之后每个请求用 `Authorization: Bearer` 发送。脚本清不掉 HttpOnly Cookie，所以磁盘上有两份。

面板内容安全策略的 `script-src` 是 `'self'`，没有 `unsafe-inline`，跨站脚本面比常见后台小。但令牌一旦进 `localStorage`，任何同域脚本都不必绕 Cookie。自建面板还可以把 `kin_api_base` 指到别的源，后续请求会把 Bearer 发到那个源。

远程主密钥不能开面板，这点是对的。失陷的是面板会话，不是推理密钥。管理员会话加上本机 `docker.sock`，影响就是宿主机上的容器权限。

应改：面板只使用 HttpOnly Cookie，登录响应不要再把令牌放进 JSON，前端删掉 `localStorage` 里的 `kin_console_token`。

## F3 中：代理拦截只看字面地址，域名解析可绕过

位置：`src/lib/vm/proxy-policy.mjs`，以及 Codex / Grok 内核启动和 `egress.mjs`。

谁能利用：能给自己的槽绑定出口的租户。

`assertProxyAllowed` 不解析域名。Codex / Grok 内核启动只走这道检查。解析失败时 `proxyResolvedBlockReason` 直接放行。出口进程自己再解析，检查和使用之间地址可以变。

字面上的回环、内网、链路本地和云主机元数据地址是拦住的。绕过的是“域名先解析成公网、连的时候变成内网”，以及“解析失败就当通过”。

## F4 中：Anthropic 控制台可让网关去访问任意 http(s) 地址

位置：`src/lib/admin/anthropic-console.mjs`。

谁能利用：管理员，或偷到管理员会话的人。

管理员填写的 base URL 只检查是不是 http 或 https，不拦回环、内网和云主机元数据。没有 Docker 的安装上，这是一条从面板进内网的路。

企业微信通知没有这个问题：webhook 锁死 `qyapi.weixin.qq.com`。

## F5 中：管理员会话过长，危险操作没有二次确认

位置：`src/lib/core/security.mjs`、槽位终端、`src/lib/admin/release.mjs`、备份恢复。

谁能利用：管理员，或偷到管理员会话的人。

会话滑动 7 天、绝对上限 30 天。槽位终端、备份恢复、在集群节点上建容器，拿到会话就能做。一键升级只要求 `confirm: true`。控制面挂着宿主机 `docker.sock`，等于宿主机根权限。

槽位终端票本身是收紧的：30 秒、一次性、24 字节，租户角色拿不到。缺的是“已经是管理员之后，做破坏性操作还要再确认一次”。

## F6 低：环境变量里的管理员密码没有最短长度

位置：`src/server.mjs`、`src/lib/admin/panel-users.mjs`。

只拒绝默认口令 `123456`。数据库里新建的用户至少 8 位，但 `VM2API_ADMIN_PASSWORD` 可以是 1 位，第一次登录还会原样写进 scrypt 哈希。

## F7 低：网关限流表可以被换名冲掉

位置：`src/lib/core/security.mjs` 的 `createRateLimiter`。

每个键一个令牌桶，满 1 万个就删掉最老的。攻击者用不断变化的键可以把别人的桶挤掉，限流重新从满开始。登录限流没有这个毛病。

## F8 低：HTTPS 反向代理没声明时，会话 Cookie 不带 Secure

位置：`src/lib/core/security.mjs` 的 `panelCookieSecure`。

只有 `PUBLIC_SCHEME=https`，或 `TRUST_PROXY=1` 且 `X-Forwarded-Proto` 为 https，才加 `Secure`。TLS 终结在代理上、又忘了这两个变量时，Cookie 可以走明文。前端目前主要靠 localStorage，所以这是第二份凭证，见 F2。

## 读过并且站得住的部分

| 控制 | 结论 |
| --- | --- |
| 面板入口 | 托管密钥和远程主密钥进不了 `/api/panel`。主密钥只有回环地址才被当成管理员。 |
| 租户隔离 | 推理用属主范围。租户密钥只能选自己的槽；平台范围只选没有属主的槽。`x-kin-vm` 只对主密钥生效。 |
| 角色 | user / super 是允许列表，不是拒绝列表。终端、集群写操作、备份、升级、用户管理只给管理员。 |
| 登录 | 数据库口令是 scrypt，参数被写死，不能被改成极慢的成本。失败次数按客户端计，不能靠撞 admin 把所有人锁在外面。 |
| 回环判断 | 不信客户端自己写的 `X-Forwarded-For`，除非 `TRUST_PROXY=1`。信任时只取最右边一跳，也就是代理追加的那一跳。 |
| 密钥落盘 | 启动时会生成 `secrets/db.secret`，AES-256-GCM。API 密钥用 HMAC 比对。企业微信 webhook 锁死 `qyapi.weixin.qq.com`。 |
| SSH 与终端 | 对上主机指纹之后才送密码或私钥。槽位终端票 30 秒、一次性、24 字节，权限列表不给租户。 |
| 注入 | 抽查的 SQL 都是预编译。槽位 id 限制为字母数字和 `_`、`-`。静态文件拒绝 `..`。删除虚拟机前会先校验 id。 |

主要来源：`src/lib/core/security.mjs`、`src/lib/admin/panel-acl.mjs`、`src/lib/admin/panel-routes.mjs` 鉴权段、`src/lib/admin/api-keys.mjs`、`src/lib/admin/resource-owner.mjs`、`src/lib/protocol/handle-protocol.mjs` 调度段、`src/lib/vm/proxy-policy.mjs`、`src/lib/cluster/ssh-link.mjs`、`src/lib/vm/slot-shell.mjs`、`src/lib/db/secure.mjs`、`web/src/lib/session.ts`。

## 没覆盖的部分

协议转换、计费、Go worker、内核和预编译 CLI 没有逐行审完。根目录已有的 `AUDIT_FIX_TASKS.md` 是另一次审计的修复任务，和本文件不是同一份清单。
