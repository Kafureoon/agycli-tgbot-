# agy-tg-bot

Antigravity CLI (`agy`) Telegram Bot 控制台，支持多 Google 账号独立 OAuth 凭据保管、共享会话目录无缝自动切号、模型额度与重置倒计时查询、提示词缓存命中率观测、Markdown 表格自动渲染 PNG 图片，以及 Mihomo（Clash Meta）订阅更新、测速与节点切换。

## 核心特性

- **共享运行目录 + 独立凭据库无缝切号**
  - 主会话统一运行在 `/root/.gemini/antigravity-cli/`，完整保留本地 SQLite 对话历史、MCP、插件与配置。
  - 各 Google 账号的 `antigravity-oauth-token` 保存在 `/var/lib/agy-profiles/<name>/`（`0600` 权限）；切号或遇限流/配额耗尽（`429`）时自动同步目标凭据并延续同一个 `conversation_id`。
  - 遇到 `403` / 权限风控时立即熔断停止轮询其余账号，防止连坐波及。
- **Telegram 控制指令**
  - `/account`、`/quota`：查看账号池、各模型剩余额度进度条与重置倒计时，支持一键切换与在线 `/login` 授权。
  - `/cache`：查看当前上下文窗口大小、会话累计缓存命中率、逐次模型请求冷热命中明细与全号统计。
  - `/proxy`、`/sub`：查看流量、全节点测速（超时自动红底禁用不可选）、切换节点（含 `DIRECT` / `AUTO`）与更新订阅。
  - `/model`、`/effort`、`/mode`、`/perm`、`/agent`、`/cd`、`/adddir`、`/new`、`/continue`、`/stop`、`/status`、`/mcp`、`/plugin`、`/settings`、`/update`、`/cleanup`。
- **移动端可读性优化**
  - 回复中包含 Markdown 表格时，自动转换为手机友好列表，并调用 `@resvg/resvg-js` 渲染暗色高清 PNG 表格配图一并发送。

## 新服务器部署步骤

### 1. 基础环境准备（Linux）
- Node.js >= 20
- Python 3 + `pyyaml`（供 `mihomo/update-sub.py` 使用）
- Antigravity CLI（`/root/.local/bin/agy`）
- 中文字体（用于渲染状态卡与表格 PNG）：
  ```bash
  apt-get update && apt-get install -y fonts-wqy-zenhei python3-yaml
  ```
- 若需要代理切换功能，需提前安装 `mihomo` 二进制到 `/usr/local/bin/mihomo`。

### 2. 部署项目文件
```bash
mkdir -p /opt/agy-tg-bot /opt/mihomo /etc/mihomo /root/workspace
cp bot.mjs package.json package-lock.json /opt/agy-tg-bot/
cd /opt/agy-tg-bot && npm ci --omit=dev

cp mihomo/update-sub.py /opt/mihomo/update-sub.py
chmod +x /opt/mihomo/update-sub.py
```

### 3. 创建配置文件（切勿提交到 Git）
```bash
cp config.example.json /opt/agy-tg-bot/config.json
chmod 600 /opt/agy-tg-bot/config.json
```
编辑 `/opt/agy-tg-bot/config.json`，填入：
- `botToken`：从 `@BotFather` 申请的 Telegram Bot Token
- `pairCode`：自定义管理员绑定配对码（首次在 Telegram 里发 `/pair <配对码>` 即可绑定 `allowedUserIds`）
- 如不使用代理，可将 `proxyEnabled` 设为 `false`；如使用订阅，将订阅链接写入 `/opt/mihomo/sub.url` 并先运行一次 `/opt/mihomo/update-sub.py`

### 4. 配置 systemd 服务并启动
```bash
cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload

# 如使用 mihomo 代理：
systemctl enable --now mihomo.service mihomo-sub-update.timer

# 启动 Telegram Bot：
systemctl enable --now agy-tg-bot.service
```

### 5. 在 Telegram 内初始化
1. 给你的 Bot 发送 `/pair <你的配对码>` 完成管理员绑定；
2. 发送 `/login acc1`（及 `/login acc2` 等）按提示在浏览器完成 Google OAuth 授权；
3. 如使用代理，发送 `/sub <订阅链接>` 拉取节点后，再通过 `/proxy` 测速选节点。

## 安全提醒
- `config.json`、`ledger.json`、`/opt/mihomo/sub.url`、`/opt/mihomo/sub_info.json` 与 `/var/lib/agy-profiles/` 均包含敏感凭据或对话记录，已被 `.gitignore` 排除，切勿提交到公开仓库。
