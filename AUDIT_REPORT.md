# vm2api 深度代码审计报告

日期：2026-10-25  
范围：仓库当前 `main`（`1b892e47`）。覆盖 Node 控制面、面板前端会话、Go `kin-slot-gate` / `kin-api-kernel`、KVM 客户机中继、Docker / 安装脚本，以及 `npm audit`。没有改业务代码。

阅读方式：安全相关路径逐段对照源码。能在本机跑的用 Node 22.23.4 做了小复现，见每条的「验证」。没有起完整控制面，也没有连真实上游。

仓库里已有 `SECURITY_AUDIT.md`（2026-10-24，只覆盖控制面）。本报告是另一次全库审计。那份清单里已经落地的修复，在文末「已核对」里标明，不再当成未修复问题。

## 总体结论

这是一个把宿主机 Docker 和槽位网络握在手里的订阅转 API 网关。面板登录、托管密钥哈希、请求日志脱敏、代理 DNS 钉死、槽位容器降权，这几处现在是站得住的。剩下的问题集中在三件事：

1. **默认的 Claude 路径会让控制面自己去拉用户消息里的图片 URL。** 不拦内网，还跟随重定向。控制面又是 host 网络，这张网卡就是宿主机。
2. **默认部署把管理台、主密钥和 Docker 套接字放在同一台机器的同一张网上。** 面板或主密钥一旦失陷，影响面是宿主机上的容器权限，而不只是一个槽。
3. **计费和流式收尾在失败路径上不一致。** Claude 池在已经选中账号后，失败也会扣托管密钥的请求次数；美元窗口是读出来再整段写回，并发会丢增量。Codex / Grok 流一旦发出字节，上游失败就直接 `res.end()`，客户端看不到错误事件。

没有发现未授权就能直接拿到宿主机 shell 的路径。下面没有标「严重」的条目。最高的是「持有合法 API 密钥的租户」或「拿到面板会话 / 误配反代的人」能碰到的问题。

## 问题数量

| 严重级别 | 数量 |
| --- | ---: |
| 严重 | 0 |
| 高 | 6 |
| 中 | 10 |
| 低 | 7 |
| 建议 | 5 |
| 合计 | 28 |

## 最优先修复的前 5 项

1. **H1** 默认 Claude（`inference.engine=rust` → cli-hop）在控制面进程里拉取消息中的任意 `http(s)` 图片，并跟随重定向。已用本机服务复现。
2. **H2** 容器入口把管理台密码和主 API 密钥写入 `.env` 并导出到进程环境；一键安装脚本会把明文密码打到终端。
3. **H3** `docker-compose.yml` 默认 host 网络、`0.0.0.0:8787`、`NET_ADMIN`/`NET_RAW`，并挂载宿主机 `docker.sock`。
4. **H4 / H5** Claude 池只要结果带了 `accountId` 就给托管密钥记一次请求。美元窗口不是原子加，并发下后写的那次会盖掉前一次。请求次数的 `+ 1` 和窗口丢失都已用脚本对照。
5. **H6** Codex / Grok 在 SSE 已经写出之后如果上游失败，只 `res.end()`，不写协议错误事件。客户端会把截断当成正常结束。

## 验证记录

| 项 | 结果 |
| --- | --- |
| `npm audit --package-lock-only` | 1 个 moderate，见 L5。无 high / critical |
| `materializeRemoteImageSources` 对本机 HTTP 服务 | 直接请求 `127.0.0.1` 成功；公网样式 URL 302 到另一个 `127.0.0.1` 路径后，响应体被收成 base64。两次都打中了内部服务 |
| `createRateLimiter({ capacity: 2, maxKeys: 2 })` | 已耗尽的键不会被挤掉；仍有余量的键会被删，下一次调用重新拿到满桶 |
| `SessionLimitRegistry`，`max: 1`，两个新会话 `Promise.all` | 两个都 `canAccept` 成功，`snapshot.active === 2` |
| 对照 `api_keys` 的窗口写回语句 | 两次各加 1.5 和 2.5，`requests` 变成 2，`usage_5h` 只剩 2.5 |
| `presentedApiKeyForLog` | 70 字符的 `sk-vm-` 密钥变成 13 字符的前 8 + 后 4 |
| `maybeEncrypt` 在没有 DB 密钥时 | 原样返回明文。正式入口会先 `ensureDbSecretFile`，见「已核对」 |
| 入口脚本的 `sed` 双引号展开 | 变量里的 `$(...)` **不会**再被执行（bash 不会对展开结果做二次解析）。`|`、`&`、换行仍会破坏这一行 |
| `writeHead` 之后再 `writeHead` | 抛 `ERR_HTTP_HEADERS_SENT`。Codex 里对应分支目前很难走到，见 L6 |

---

## 高

### H1 控制面按用户提供的图片 URL 出站，默认 Claude 路径就会走到

- 级别：高
- 位置：`src/lib/protocol/images.mjs` 93–131、149–174；调用点 `src/lib/protocol/handle-protocol.mjs` 1474、1503；默认引擎 `src/config/routing.json` 94；`src/lib/vm/slot-engine.mjs` 184–189
- 验证：已复现

`fetchImageAsBase64` 对任意 `http:` / `https:` URL 调用 `fetch`，`redirect: 'follow'`，超时 20 秒，响应最大 8 MiB。不解析域名，不拒绝环回、RFC1918、链路本地和云元数据地址。内容类型不是图片时也会按 `image/png` 收成 base64。

cli-hop 在组好上游请求体之后调用 `materializeRemoteImageSources`。`resolveOfficialCcInference` 在推理引擎为 `rust` 时固定返回 `cli-hop`。仓库自带的 `routing.json` 就是 `"engine": "rust"`。因此默认 Claude 槽会走这条路径。拉图片的是控制面进程，不是槽位里的 egress。

本机复现：一个只监听 `127.0.0.1` 的服务返回正文 `secret-metadata-token`；另一个服务 302 到它的另一个路径。两个 `image.source.url` 都被控制面取回，并变成 base64 放进即将发给上游的消息。

影响：持有有效 API 密钥的调用方可以让控制面向宿主机环回、内网和元数据地址发 GET。Compose 使用 host 网络时，这个进程的 `127.0.0.1` 就是宿主机。响应体不会直接回给客户端，而是塞进上游请求；模型若能读这张图，内容会从模型回答里回来。失败则保留原 URL。单次响应最多吃 8 MiB 内存，消息里有多少张图就拉多少次。

建议：复用 `proxy-policy.mjs` 的字面量检查和 DNS 检查；每一跳重定向都重新检查；禁止把环回和元数据地址当图片源；拉图片改走该槽的出口，不要走控制面直连。取不到就留原 URL 或直接 400，不要为了凑 base64 去访问内网。

### H2 管理台密码和主 API 密钥写入 `.env`，并出现在进程环境里

- 级别：高
- 位置：`scripts/docker-entrypoint.sh` 185–221；`deploy/install.sh` 328、336–347；`docker-compose.yml` 15–16
- 验证：已阅读。`sed` 二次解析已用 bash 复现，确认 `$(...)` 不会执行

入口在密码或 `VM2API_API_KEY` 为空时生成随机值，写入 `secrets/`（0600），同时 `export`，并用 `env_set` 写进 `$ROOT/.env`。Compose 用 `env_file: .env` 把这两个值注进容器环境。`docker inspect`、`/proc/1/environ`、能读 `.env` 的人都能看到管理台密码和主密钥。

`install.sh` 在首次写入密码时执行：

```bash
echo "  本次写入的管理台账密: ${DEFAULT_ADMIN_USER} / ${DEFAULT_ADMIN_PASSWORD}"
```

以及 `print_login_banner` 里的「本次密码」。终端回卷、CI 日志、录屏都会留下明文。入口脚本自己已经不打印密码，安装脚本还在打印。`install.sh` 会把 `.env` `chmod 600`，这一点是对的；密钥仍然在环境变量里。

影响：主密钥可以调用推理；从本机环回还可以当面板管理员（见 M3）。密码可以登录面板。谁能看容器环境或安装日志，谁就拿到这两样。

建议：运行中的进程只读 `secrets/admin.password` 和 `secrets/api.key`，不要把它们写回 `.env`，也不要长期放在环境变量里。安装脚本只打印文件路径。已有部署应轮换主密钥和管理台密码，并清理 shell 历史。

### H3 默认 Compose 把控制面放在宿主机网络上，并挂上 Docker 套接字

- 级别：高
- 位置：`docker-compose.yml` 11–14、31–34；`Dockerfile` 63–65；`docker-compose.arm64.yml` 11
- 验证：静态阅读

默认是 `network_mode: host`、`HOST=0.0.0.0`、`PORT=8787`，加上 `NET_ADMIN` 和 `NET_RAW`，卷里有 `/var/run/docker.sock`。镜像没有 `USER`，进程以 root 运行。arm64 override 把端口绑到 `127.0.0.1`，amd64 这份 compose 没有。

这是产品要管槽位容器所需要的能力，不是偶然多开的一个端口。默认形态下，控制面进程或面板会话失陷，影响面包括宿主机 Docker API 和 iptables。服务同时听在所有网卡上，防火墙没单独收口时，管理台和推理 API 对局域网是开放的。

建议：生产安装把 8787 限制到反代来源；文档把「docker.sock 等于这台机器上的容器权限」写在部署第一章，而不是散落在注释里。能不用 host 网络的组件不要和套接字放在同一个进程里。amd64 与 arm64 的默认绑定地址应该一致，并在 `docs/DEPLOY.md` 里写明。

### H4 失败的 Claude 请求仍扣托管密钥的请求次数

- 级别：高
- 位置：`src/lib/protocol/handle-protocol.mjs` 236–247、1795–1830；对照同文件 255–286 的 `withManagedKey`；`src/lib/db/repos/api-keys-repo.mjs` 106–109
- 验证：静态推断。没有跑完整推理。SQL 里的 `+ 1` 已阅读

Claude 池在 `result.accountId` 存在时调用 `attachPricing(..., { bill: !!managedKey })`，不看 `result.ok`。`recordUsage` 无条件执行 `requests = requests + 1` 和 `quota_requests_used = quota_requests_used + 1`。Codex、Grok、图像和搜索走 `withManagedKey`：只有真正答完，或已经有 usage，才记账。

影响：上游失败但调度已经选中账号时，租户的请求配额被消耗。用会失败的请求可以把一把有次数上限的密钥打满。

建议：与 `withManagedKey` 使用同一条记账条件。失败且没有 usage 时不要增加 `quota_requests_used`。

### H5 托管密钥的美元窗口和账号配额是读改写，并发会丢增量

- 级别：高
- 位置：`src/lib/db/repos/api-keys-repo.mjs` 162–177；`src/lib/pool/account-quota.mjs` 167–265
- 验证：已用与仓库相同的 SQL 形状复现。账号整行保存是静态阅读

5h / 1d / 7d 美元窗口先 `SELECT` 再算出绝对值，然后 `usage_5h = ?` 写回，不是 `usage_5h = usage_5h + ?`。两次各加 1.5 和 2.5 的复现结果是 `requests = 2`（次数那一列用了 `+ 1`，没丢），`usage_5h = 2.5`（少了 1.5）。`ingestHeaders` 同样是读出整行、在内存里改计数、再 `save` 整行。

影响：并发成功请求的美元配额偏小，超额停用会比真实花费更晚触发。账号侧 5h/7d 水位丢更新后，调度可能继续把流量打到已经很满的账号上。

建议：窗口列改成单条 `UPDATE ... SET usage_5h = usage_5h + ?`，或按密钥和账号串行化。账号计数不要整行覆盖。

### H6 Codex / Grok 流在已经输出之后失败，客户端看不到错误

- 级别：高
- 位置：`src/lib/protocol/handle-codex.mjs` 1002–1006；`src/lib/protocol/handle-grok.mjs` 889–895
- 验证：静态阅读。Claude 路径有对照实现

两条路径在 `res.headersSent || hopEmitted` 时只记日志并 `res.end()`。没有 `[DONE]`，没有 Anthropic `event: error`。Claude 池在同样情况下会写 `buildAnthropicSseError`（`handle-protocol.mjs` 1843–1858）。API 后端有 `writeCommittedStreamError`。

影响：SDK 把截断的 SSE 当成完整回答，或一直等到自己的空闲超时。用户看到半截工具参数，重试层不会按 5xx 切换。计费侧 Codex 已把「200 且带了 usage」视为已交付，截断和成功的边界更容易糊在一起。

建议：提交之后禁止再 `json()` / `writeHead`。用与协议匹配的终止事件收尾，然后 `end()`。与 Claude 池共用一个 helper。

---

## 中

### M1 网关限流表满了之后，会把还有余量的桶扔掉

- 级别：中
- 位置：`src/lib/core/security.mjs` 44–81
- 验证：已复现

容量用尽的桶会留着，这点比旧审计里「扔掉最老的桶」好。满 10000 个键时，新键会删掉**剩余令牌最多**的那一个，并给自己一个满桶。复现：`legit` 已被打空，之后仍是拒绝；`other` 还剩令牌，被挤掉后下一次调用又是允许。

影响：攻击者用不断变化的键，可以在仍有正常流量时一直拿到新桶。已经耗尽的键不会因此复活。主密钥也走这个限流器（`server.mjs` 里对 token 调用 `allowRate`）。

建议：未知键不要新建桶，或只淘汰长时间没人用的桶。不要淘汰还有令牌的桶。

### M2 `max_sessions` 的检查和占用不在同一次调用里

- 级别：中
- 位置：`src/lib/pool/session-limit.mjs` 82–109；占用点 `src/lib/protocol/handle-codex.mjs` 734–738
- 验证：已复现

`canAccept` 只读窗口里有多少个会话。`touch` 才把新会话放进去。两者中间隔着 `await`。对 `SessionLimitRegistry` 设 `max: 1`，两个不同的新会话一起 `admit`，结果都成功，`active` 为 2。

影响：同一账号的会话窗口可以被并发的新会话冲破。席位租约（`tryAcquireOpenAISlot`）是另一把锁，挡的是并发请求数，不是这个会话上限。

建议：提供一次完成的 `admit(accountId, sessionKey, cap)`，检查和插入在同一个同步调用里。

### M3 `TRUST_PROXY=1` 且反代没有改写 X-Forwarded-For 时，远程主密钥可以当本机管理员

- 级别：中
- 位置：`src/lib/core/security.mjs` 148–168；`.env.example` 8–12
- 验证：静态阅读

`isLoopbackRequest` 要求 TCP 对端已经是环回。信任代理时，再看 `X-Forwarded-For` 最右边一跳是不是环回。最右边一跳是「代理自己追加的那一跳」时，远程客户端当不成本机。若反代原样转发客户端送来的这个头（没有追加真实对端），而 Node 又只看到 `127.0.0.1`，客户端可以写 `127.0.0.1`，`masterMayAdminister` 为真。主密钥随即具备面板管理员能力。

登录限流在同一开关下按这个地址计数，伪造不同的最后一跳也可以把失败次数拆开。

建议：只信任固定跳数，或只接受来自反代网段的连接。文档给出 nginx 应使用的 `proxy_set_header`，并说明「不要把客户端原始 XFF 原样传进来」。

### M4 面板会话可以还原 API 密钥和代理密码，没有二次确认

- 级别：中
- 位置：`src/lib/admin/panel-routes.mjs` 1866–1877、6154–6166；对照同文件里升级和 shell ticket 使用的 `authorizePanelStepUp`
- 验证：静态阅读

`POST /api/panel/api-keys/:id/reveal` 和 `POST /api/panel/proxies/:id/reveal` 在面板鉴权通过后返回完整 `sk-vm-` 或带密码的 SOCKS URI。注释写明故意不做确认。槽位终端、恢复备份、一键升级会要求 step-up。

影响：偷到的面板 Cookie（或同站脚本）不必再过一次密码，就能把租户密钥和出口凭据拿走。Cookie 现在是 HttpOnly，这比放在 `localStorage` 里窄，但不是第二因素。

建议：reveal、rotate 与 shell ticket 使用同一套 step-up。

### M5 KVM 客户机里的内核中继没有鉴权，而且听在所有网卡上

- 级别：中
- 位置：`docker/kin-kvm/guest/kin-kernel-relay.py` 7–8、58–66；宿主机转发 `docker/kin-kvm/kin-kvm-entry` 295、363–364
- 验证：静态阅读

中继把 TCP `0.0.0.0:7070` 原样接到客户机里的 `/run/kin-guest/kernel.sock`，没有 token。QEMU 用户态网络把容器内的 `127.0.0.1:7070` 转到客户机的 7070，所以它不会直接出现在宿主机的公网地址上。客户机里的任意进程，以及这个 KVM 容器网络命名空间里能访问 `127.0.0.1:7070` 的进程，都可以绕过 Unix 套接字的文件权限。

影响：客户机里的其它进程（或能在客户机里开连接的代码）可以驱动该槽的内核协议。不是从互联网直接打到 7070，除非另有端口发布。

建议：客户机内改为 `127.0.0.1:7070`。中继要求与控制面相同的 preface 或 token。不要在客户机的所有地址上监听。

### M6 集群直连网关默认听在节点的所有地址上

- 级别：中
- 位置：`src/lib/cluster/direct-link.mjs` 219–220；`worker/internal/slotgate/slotgate.go` 88–90、174–190
- 验证：静态阅读

`gate.json` 写成 `listen: 0.0.0.0:<port>`，容器是 host 网络。连接在拼到槽位 `kernel.sock` / `worker.sock` 之前要过 token，比较是常量时间，VM id 有正则。token 是唯一边界，没有来源地址限制。

影响：节点的公网地址上有一个 TLS 服务。token 泄露后，远程可以接到该节点上槽位的内核套接字。

建议：默认绑 `127.0.0.1`，控制面走已有的 SSH。若必须直连，在配置里写允许的控制面地址，而不是 `0.0.0.0`。

### M7 自定义 DoH 上游不拒绝内网和元数据地址

- 级别：中
- 位置：`src/lib/vm/egress.mjs` 404–422
- 验证：静态阅读

`validDnsPrimary` 要求 `https:` 和合法主机名，不调用 `isUnsafeProxyHost`。出口进程随后会向这个 URL 发 DNS-over-HTTPS。配置入口在代理池，能改它的是面板管理员。

影响：一条指向 `127.0.0.1`、内网或元数据地址的 DoH URL 会被 egress 访问。租户 SOCKS 本身已经做了字面量和 DNS 检查，这条配置没有对齐。

建议：对 DoH 主机做与代理相同的检查，解析失败视为拒绝。

### M8 迁移旧容器时会把 `Privileged` 原样抄过去

- 级别：中
- 位置：`src/lib/cluster/remote-slot.mjs` 115–121、186–189
- 验证：静态阅读

`MIGRATION_HOST_CONFIG_KEYS` 含 `Privileged`。`legacyServiceContainerBody` 用 `structuredClone` 抄进新容器。新建槽位的 `slotContainerBody` 不设特权，还是 `CapDrop: ALL` 和只读根文件系统。

影响：节点上如果留着历史特权容器，替换或迁移会把特权继续带上。需要能操作集群的管理员。

建议：迁移时强制 `Privileged: false`，能力列表用白名单，不要从 inspect 结果整包复制。

### M9 备份下载不要求二次确认，包里是整库和槽位 JSON

- 级别：中
- 位置：`src/lib/admin/backup-core.mjs` 的打包（全库 `VACUUM INTO` 加 `vms/*.json`）；下载 `src/lib/admin/panel-routes.mjs` 2316 起
- 验证：静态阅读

下载接口在面板管理员权限内直接 `createReadStream`。恢复路径有 step-up，下载没有。库里是 API 密钥的 HMAC、可选的 AES 密文、代理密码和集群 SSH 材料。没有 `KIN_DB_SECRET` 的旧库是明文（见 L7）。密文备份还要配 `secrets/db.secret` 才能解开。

影响：面板会话可以一次把平台上的凭据打包带走。磁盘上的 `data/backups/*.tar.gz` 同等敏感。

建议：下载与恢复使用同一套 step-up。备份再用一把独立密钥加密。备份目录权限与数据目录分开。

### M10 文档推荐的安装方式是 `curl | bash`，镜像标签默认为 `latest`

- 级别：中
- 位置：`README.md` 195–198；`docker-compose.yml` 7；`deploy/install.sh` 314
- 验证：静态阅读

README 和安装脚本的排错段落都建议：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash
```

`main` 上的脚本被改，下一次安装就会执行新内容，并且是 root。Compose 默认标签是 `latest`，除非安装脚本另行写入 `VM2API_IMAGE_TAG`。

建议：文档改为固定 tag 或 commit，并校验校验和。生产 compose 不要默认 `latest`。

---

## 低

### L1 反代在本机、又没声明 HTTPS 时，登录 Cookie 不带 Secure

- 级别：低
- 位置：`src/lib/core/security.mjs` 549–572、662–667
- 验证：静态阅读

对端不是环回时，Cookie 默认带 Secure。对端是 `127.0.0.1`（本机反代）时，要有 `PUBLIC_BASE_URL=https://...`、`PUBLIC_SCHEME=https`，或 `TRUST_PROXY=1` 且 `X-Forwarded-Proto: https`。三个都没有时，Cookie 可以走明文 HTTP。启动时会 `warnPanelCookieScheme`。

建议：生产拒绝在未声明 HTTPS 的情况下对外提供面板。

### L2 没配 `PUBLIC_HOST` 时，槽位展示 IP 固定成 `166.88.96.199`

- 级别：低
- 位置：`src/lib/vm/vm-runtime.mjs` 48、161、286
- 验证：静态阅读

`PUBLIC_IP` 在环境变量缺失时使用这个字面地址，并写入 `runtime.ip`。host 网络的容器 inspect 也会显示它。它不是这台机器探测出来的地址。

影响：面板和状态接口把所有未配置的部署显示成同一台第三方主机。运维会按错误的地址去对防火墙或出口。

建议：未配置时留空，不要写死一个公网地址。

### L3 托管密钥的 HMAC 秘密可以回退到主密钥；旧 pepper 仍是公开常量

- 级别：低
- 位置：`src/lib/admin/api-keys.mjs` 31、182–191、245–252
- 验证：静态阅读

`hashSecret` 的顺序里，在独立 pepper 之前会用到 `VM2API_API_KEY`。主密钥和托管密钥的索引秘密因此可能是同一个。`LEGACY_HASH_PEPPER` 是源码里的固定字符串，只接受截止时间之前创建的行，用过会改写成新哈希。新装的库会在第一次使用时写下截止时间。

影响：主密钥泄露会让离线验证旧哈希更容易。仍停在旧 pepper 上的行，拿到数据库就能对密钥做离线尝试。

建议：禁止回退到主密钥。迁移完成后拒绝旧 pepper。

### L4 没有 `user_id` 的托管密钥按平台范围调度

- 级别：低
- 位置：`src/lib/admin/api-keys.mjs` 200–201；`src/lib/admin/resource-owner.mjs` 中无属主即平台范围的分支
- 验证：静态阅读

`_ownerActive` 对空 `user_id` 直接返回 true，注释写的是兼容旧数据。这类密钥可以调度没有属主的平台槽。

建议：新密钥强制属主。无属主的旧密钥默认停用，而不是继续当平台钥匙。

### L5 `npm audit`：传递依赖 `ip-address` 有 1 个 moderate

- 级别：低
- 位置：`package-lock.json` 中 `ip-address@10.5.0`，由 `socks` 引入，再被 `socks-proxy-agent` 使用
- 验证：`npm audit --package-lock-only`，退出码 1。统计为 moderate 1，high 0，critical 0。Node v22.23.4，npm 10.9.9

公告内容是 `ip-address` 对 IPv6 链路本地、NAT64 和跨族子网判断有误，以及超长 zone id 可以拖慢进程。本仓库自己的代理拦截在 `proxy-policy.mjs` 里用 `node:net`，不调用这个包。是否构成可利用的绕过，取决于 `socks` 有没有用这些函数做安全判断；这次没有把 `socks` 的调用点逐行证明成绕过，所以不升到中。

建议：把 `socks` / `ip-address` 升到审计说的修复版本（`ip-address` 需大于 10.7.3），再跑一次 `npm audit`。

### L6 WebSocket 终端票可以放在 URL 查询串里

- 级别：低
- 位置：`src/lib/http/ws-ticket.mjs` 5–7；`src/lib/vm/slot-shell.mjs` 430–455
- 验证：静态阅读

票 30 秒、一次有效。升级请求优先看子协议，查询串 `ticket` 仍然接受。反代访问日志和 Referer 会留下它。票不匹配时也会被烧掉，知道票但猜错 VM 的人可以让合法连接失败。

建议：只接受子协议。不匹配时不要删除票，改为计数限速。

### L7 数据库加密不是强制的；响应头在已发送后再 `json()` 会抛异常

- 级别：低
- 位置：`src/lib/db/secure.mjs` 146–150；`src/server.mjs` 165 会调用 `ensureDbSecretFile`；`src/lib/protocol/handle-codex.mjs` 802–808；`src/lib/http/respond.mjs` 的 `json()`
- 验证：无密钥时 `maybeEncrypt('super-secret-token')` 返回原文。`writeHead` 两次会抛 `ERR_HTTP_HEADERS_SENT`（本机 HTTP 服务已观察到这个错误码）

正式启动会生成 `secrets/db.secret`，默认不是明文库。若密钥文件丢失、环境变量被清空，或有代码路径不经过 `server.mjs` 就写库，代理密码和 `key_secret` 会以明文进入 SQLite。

Codex 在内核没就绪且 `headersSent` 时调用 `json()`。按现在的循环，字节已经写出的失败会先在 1002 行 `return res.end()`，不会再转回这次 `ensure`。所以这是一处写错了的分支，当前请求路径基本走不到。一旦以后在提交之后 `continue`，连接会以未捕获异常结束。

建议：`encryptionEnabled()` 为假时拒绝启动。`json()` 在 `headersSent` 时改为写流内错误或直接返回。

---

## 建议

### A1 `ip_whitelist` / `ip_blacklist` 列没有参与鉴权

- 位置：`src/lib/db/repos/api-keys-repo.mjs` 51–52。全库没有在 `requireAuth` 里读取它们。面板前端也没有这两个字段。
- 影响：以后若有人往列里写限制，会以为已经生效。
- 建议：实现校验，或删掉列，避免以后的界面把它当成已经存在的功能。

### A2 未列入白名单的 Origin 得到 `Access-Control-Allow-Origin: *`

- 位置：`src/lib/http/cors.mjs` 36–55
- 允许头里有 `authorization` 和 `x-api-key`。带凭据的面板请求只有 `PANEL_CORS_ORIGINS` 或 `PUBLIC_BASE_URL` 里的源才返回具体 Origin 和 `Allow-Credentials`。`*` 不会带上 Cookie。
- 影响：密钥如果出现在浏览器页面里，任意网站可以代它发请求并读响应。服务器到服务器的调用不受 CORS 影响。
- 建议：推理接口不要对任意 Origin 返回 `*`。文档写明密钥不要放进前端。

### A3 热路径上的同步 SQLite 和 `execFileSync`

- 位置：`src/lib/db/database.mjs` 使用 `node:sqlite` 的 `DatabaseSync`；`src/lib/vm/vm-runtime.mjs`、`src/lib/identity/slot-computer.mjs` 在槽位操作里调用 `execFileSync`。
- 影响：面板上的大查询、每次响应的账号整行写入、docker inspect，都会堵住这一个事件循环。推理延迟会跟着抖。
- 建议：计数器先记在内存里再刷盘。docker inspect 改成异步并缓存。`panel-routes.mjs` 已超过 6000 行，新路由很容易漏掉属主检查，按域拆开比继续加分支更不容易出回归。

### A4 README 与当前行为不一致

- 位置：`README.md` 219 附近，对照 `scripts/docker-entrypoint.sh` 189–192 和 `src/lib/http/web-dist.mjs`
- 入口不把密码打进容器日志，只提示去 `secrets/admin.password`。安装脚本反而会打印（H2）。面板入口是 `/cc#/login`，`/console` 仍被兼容。`/health` 无鉴权，只返回状态和服务名；`/v1/meta` 要鉴权。
- 建议：改 README，避免运维到日志里找一把根本没打印的密码。

### A5 前端仍可把面板 API 基址放进 `localStorage`

- 位置：`web/src/lib/session.ts` 17–32
- 面板令牌已经从 `localStorage` 去掉，`sessionToken()` 恒为空，请求靠 Cookie。`kin_api_base` 还在。自建域名的页面可以被脚本改成去另一个源拉数据。Cookie 是宿主专用的，不会自动带到那个源，但这会把操作员的后续操作指到错误的后端。
- 建议：只允许空基址（同源）或一份显式配置，不要从 `localStorage` 读。

---

## 已核对、目前站得住

这些是旧审计提过、或这次重点看过、当前代码对得上的控制。没有把它们再算进上面的 28 条。

| 控制 | 依据 |
| --- | --- |
| 失败鉴权不再把整把密钥写入日志 | `presentedApiKeyForLog` 只留前 8 后 4。本机对 70 字符密钥得到 `sk-vm-ab…abab`。认出的主密钥和托管密钥只记类型和 id |
| 面板令牌不进 `localStorage` | `web/src/lib/session.ts` 登录只靠 HttpOnly Cookie。`sessionToken()` 返回空串 |
| 环境变量管理员密码 | `assertEnvAdminPassword` 拒绝空密码、`123456` 和长度不在 8–128 的值 |
| 面板密码 | scrypt，比较使用 `timingSafeEqual`。登录失败文案不区分用户是否存在 |
| 托管密钥 | HMAC 索引。创建时要求长度和字符集 |
| 远程主密钥不能进面板 | `/api/panel` 要求面板会话，或环回上的主密钥。托管密钥被拒绝 |
| 租户边界 | 推理用属主范围。`x-kin-vm` 只对主密钥生效。面板用户角色访问别人的槽会 404 |
| 代理 SSRF | `resolvedProxyDial` 在解析失败或答案落到内网时拒绝，并把拨号地址钉成刚检查过的 IP。Codex / Grok 的请求路径和 egress 启动会走这层。旧审计里「只看字面地址」的主路径已经接上 |
| Anthropic 控制台自定义 URL | `anthropic-console.mjs` 在转发前做 `resolvedProxyDial` |
| 企业微信 | webhook 主机锁在 `qyapi.weixin.qq.com` |
| SQL | 抽查的日志、密钥、统计查询使用预编译参数。`VACUUM INTO` 对路径里的单引号做了转义，路径不来自 HTTP 参数 |
| 命令执行 | 本机 Docker 使用 `execFile`，参数是数组。远程脚本经 `shellQuote`（单引号包裹） |
| 静态文件 | `web-dist.mjs` 拒绝 `..` 和空字节，并用前缀检查落在 dist 目录内 |
| 槽位容器 | 新建槽 `CapDrop: ALL`、只读根、`no-new-privileges`。不挂载 `docker.sock` |
| SSH | 对上主机密钥指纹之后才送认证材料 |
| 槽位终端票 | 面板权限加 step-up，30 秒，一次使用 |
| 集群 gate 的 token | SHA-256 后常量时间比较，错误的 VM id 不会去打开套接字 |
| 启动时的库密钥 | `server.mjs` 调用 `ensureDbSecretFile`，会把新密钥写到 `secrets/db.secret` |

## 架构和性能（没有单独升级成缺陷的部分）

模块是按协议、池、槽位、面板拆开的，边界清楚。真正压在一个函数里的是 `panel-routes.mjs` 和 `handle-protocol.mjs`。测试目录很大，安全回归有 `test/unit/security.test.mjs`、`test/unit/cors.test.mjs`、`test/unit/db-secure.test.mjs` 这一类，说明之前的修复是有测试跟着的。

性能上没有看到无界的请求体：入口有 `max_body_bytes`，默认上限在配置里被夹到 8–128 MiB。流式保活有停止函数，工作器的空闲计时器在 `finally` 里清理。明显的热点是同步 SQLite 和槽位启动时的 `execFileSync`（A3），不是每 token 的循环。

failover 有次数、切换次数和总时限。这次没有发现无限重试。

## 建议的修复顺序

1. 图片拉取改走槽位出口，或在控制面上做与代理相同的地址检查，并关掉盲目跟随重定向（H1）。
2. 从环境变量和 `.env` 里拿掉密码和主密钥；安装脚本停止打印密码；轮换已经出现在日志里的那一对（H2）。
3. 收紧 8787 的来源，并把 docker.sock 的影响写进部署文档（H3）。
4. Claude 失败不要扣请求配额（H4）。美元窗口和账号计数改成原子更新（H5）。
5. Codex / Grok 在 SSE 已提交后写出协议错误事件（H6）。
6. 其余中低项按「租户能直接碰到的」优先：M1、M2、M5、M6，然后是面板二次确认（M4、M9）。
