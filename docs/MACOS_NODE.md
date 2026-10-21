# 实验性 macOS 原生节点（Apple Silicon）

把一台常开的 Apple Silicon Mac（例如 Mac mini）作为集群节点接入，用它的算力和本机网络出口承载槽位。
账号、调度和用量仍由现有 Linux 控制面管理。节点上不需要 Docker、OrbStack 或 Linux 虚拟机：每个槽位是
SSH 用户的两个 launchd 服务（kernel 和 telemetry 边车）。

> 前提：槽位里的 `kin-kernel`、`cli-node`、`cc-node` 需要 **darwin/arm64** 构建。目前发布物只有 linux/amd64，
> 这三个文件要由维护者另外提供；`kin-worker` 可直接从本仓库交叉编译。产物不全时预检会报出缺哪个文件，槽位不会启动。

## 准备 Mac

1. 打开「远程登录」（系统设置 → 通用 → 共享），给要用的用户配好 SSH 公钥，控制面能用这个用户登录即可，不需要 sudo。
2. 让这个用户**保持图形界面登录**：非 root 用户只能把 launchd 服务放进自己的 `gui/<uid>` 域，没人登录时这个域不存在。
   无人值守的 Mac mini 请开启该用户的自动登录，重启后也会自动回来。
3. 关闭系统休眠：`sudo pmset -a sleep 0`（预检会提示）。Mac 休眠时节点离线，它上面的槽位不接请求。

## 准备控制面

把 darwin/arm64 产物放到控制面的 `payload/darwin-arm64/`，或用 `KIN_DARWIN_PAYLOAD_DIR` 指向别的目录：

```
payload/darwin-arm64/
  kin-kernel   # 维护者提供
  cli-node     # 维护者提供
  cc-node      # 维护者提供
  kin-worker   # cd worker && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o ../payload/darwin-arm64/kin-worker ./cmd/kin-worker
```

每个文件都必须是 arm64 Mach-O（单架构或含 arm64 的通用二进制），否则预检报 `native_payload_invalid`。

## 接入与创建槽位

在面板「集群」里像 Linux 节点一样探测、核对指纹、接入。连上后按 `uname -s` 自动识别为 macOS，节点详情显示
「macOS 原生」，Docker 页签、安装 Docker 和直连通道对这类节点不可用。

创建槽位时选这个节点，预检检查：

| 项 | 要求 |
| --- | --- |
| 架构 | `arm64` |
| launchd | 存在 `gui/<uid>` 域（用户已登录） |
| 槽位目录 | `~/.vm2api/vms` 可写（0700） |
| 套接字 | `~/.vm2api/vms/<id>/run/kernel.sock` 不超过 macOS 的 103 字节上限 |
| 产物 | darwin/arm64 四个文件齐全 |
| 磁盘、内存、休眠 | 只提示 |

不需要构建镜像。

## 节点上的布局

```
~/.vm2api/native/<digest>/        kin-kernel、cli-node、cc-node、kin-worker（按内容哈希，多个槽共用）
~/.vm2api/vms/<id>/cli-home       槽位进程的 HOME
~/.vm2api/vms/<id>/claude         CLAUDE_CONFIG_DIR（凭证、设置）
~/.vm2api/vms/<id>/run            kernel.json、worker.json、令牌、kernel/worker 套接字
~/.vm2api/vms/<id>/logs           kernel.log、telemetry.log（超过 8 MiB 时启动截留最后 1 MiB）
~/.vm2api/vms/<id>/tmp            TMPDIR
~/.vm2api/vms/<id>/launchd        com.vm2api.slot.<id>.kernel.plist / .telemetry.plist
```

plist 放在槽位目录里，不放 `~/Library/LaunchAgents`，避免登录时 launchd 自己再加载一份。kernel.json 里的套接字、
凭证和 CLI 路径写的是节点上的真实路径（Linux 节点仍是容器内路径）。

## 运行与恢复

- **启动**：上传产物（同一哈希只传一次）、推送配置与凭证、写 plist、`launchctl bootstrap`。已在运行且 plist 未变时不打扰。
- **崩溃**：kernel 服务 `KeepAlive`，退出后 launchd 最快 10 秒重启；telemetry 只在非零退出时重启。
- **重启 / 重载**：`launchctl kickstart -k`，旧进程收到 SIGTERM，10 秒（telemetry 5 秒）后 SIGKILL。
- **服务丢失**（Mac 重启、被人 bootout）：看门狗看到服务不存在，经 supervisor 重新加载整套服务，不需要人工处理。
- **断网 / 休眠**：节点 SSH 断开期间调度器跳过它的槽位（`node_offline`，Linux 节点同样适用）；重连后恢复调度，
  槽位进程在 Mac 上一直跑着，不受影响。
- **遥测开关**：关闭时卸载 telemetry 服务，打开时加载。
- **停止 / 删除**：bootout 两个服务；删除时再清掉节点上的槽位目录和本机中继。
- **更新产物**：换了 darwin 产物（哈希变化）后，面板「更新槽位程序」会把运行中的槽重新加载到新产物上。

## 首版限制

- 只支持 Claude 槽，出口只能是节点本机网络（`px-local`）；绑定 SOCKS5、Codex 槽、crag 数据面、KVM 会明确拒绝。
- 隔离边界是 SSH 用户：同一节点的槽位共用这个用户、它的网络和硬件，launchd 不限制内存。需要更强隔离时，
  每个账号用单独的 macOS 用户分别接入。
- 不支持面板终端、槽内官方登录（`claude auth login` / setup-token）、直连通道、在线调整内存，这些接口对 macOS 槽返回
  `native_node_unsupported`。凭证请用导入。
- 无人登录的 Mac 需要自动登录；用 sudo 写 LaunchDaemon（系统域、`UserName` 指定用户）可以去掉这个要求，留作后续。
