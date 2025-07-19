# 百家乐 Telegram Bot

一个部署在 Cloudflare Workers 上的 Telegram 百家乐游戏机器人，使用 Hono 和 Grammy 框架实现。支持群组游戏、自动化流程、完整百家乐规则以及自动游戏模式。

## 功能特性

### 🎲 游戏功能
- **完整百家乐规则**：支持庄家、闲家、和局三种下注类型。
- **真实补牌规则**：严格遵循百家乐标准补牌规则。
- **自动游戏流程**：30秒下注时间，自动开牌，结果公布。
- **自动游戏模式**：支持连续自动进行游戏，每局间隔10秒。
- **多群组支持**：每个群组通过 Durable Objects 维护独立游戏状态。
- **数据持久化**：使用 Cloudflare KV 存储游戏记录，结合内存缓存。

### 🤖 Bot 命令
- `/start` - 启动 Bot 并显示完整游戏说明。
- `/id` - 获取群组和用户 ID 信息。
- `/newgame` - 开始新的百家乐游戏。
- `/bet <类型> <金额>` - 下注（banker/player/tie，例如 `/bet banker 100`）。
- `/process` - 手动触发游戏处理（开牌）。
- `/status` - 查看当前游戏状态和下注汇总。
- `/stopgame` - 停止当前游戏并关闭自动模式。
- `/autogame` - 开启自动游戏模式。
- `/stopauto` - 关闭自动游戏模式。
- `/history` - 查看最近10局游戏记录。
- `/gameinfo <游戏编号>` - 查看指定游戏的详细信息。
- `/help` - 显示帮助信息。

### 🎯 游戏规则
- **下注类型**：
  - `banker` - 庄家胜（1:1赔率）。
  - `player` - 闲家胜（1:1赔率）。
  - `tie` - 和局（8:1赔率）。
- **补牌规则**：严格按照百家乐标准规则（闲家0-5点补牌，庄家根据规则判断）。
- **点数计算**：使用 Telegram 骰子（1-6点）模拟牌值，总和取个位数。
- **天牌规则**：庄家或闲家前两张牌总和为8或9点，直接结束游戏。

### 🔧 HTTP API 接口
- `GET /` - 返回服务状态。
- `GET /health` - 健康检查。
- `POST /webhook` - 处理 Telegram Webhook 请求。
- `POST /auto-game/:chatId` - 为指定群组自动开始游戏。
- `POST /enable-auto/:chatId` - 启用自动游戏模式。
- `POST /disable-auto/:chatId` - 禁用自动游戏模式。
- `POST /process-game/:chatId` - 处理超时或手动触发的游戏。
- `GET /game-status/:chatId` - 获取指定群组的游戏状态。
- `GET /game-history/:chatId` - 获取指定群组的最近游戏记录（最多100局）。
- `GET /game-detail/:gameNumber` - 获取指定游戏编号的详细信息。
- `POST /send-message` - 向指定群组发送消息。
- `POST /set-webhook` - 设置 Telegram Webhook。

## 快速开始

### 1. 准备工作

```bash
# 克隆项目
git clone <your-repo-url>
cd baccarat-telegram-bot

# 安装依赖
npm install

# 安装 Wrangler CLI
npm install -g wrangler

# 登录 Cloudflare
wrangler login
```

### 2. 创建 Telegram Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/botfather)。
2. 发送 `/newbot` 创建新 Bot。
3. 设置 Bot 名称和用户名。
4. 获取 Bot Token。
5. 设置 Bot 命令菜单：
   ```
   /setcommands
   选择你的 Bot
   发送以下命令列表：
   start - 启动 Bot
   id - 获取群组ID
   newgame - 开始新游戏
   bet - 下注 (格式: /bet banker 100)
   process - 处理游戏
   status - 查看游戏状态
   stopgame - 停止游戏
   autogame - 开启自动游戏模式
   stopauto - 关闭自动游戏模式
   history - 查看最近10局记录
   gameinfo - 查看游戏详情
   help - 查看帮助
   ```

### 3. 配置环境变量

```bash
# 设置 Bot Token（必需）
wrangler secret put BOT_TOKEN

# 设置 Webhook 密钥（可选）
wrangler secret put WEBHOOK_SECRET

# 设置允许的群组 ID（可选，用逗号分隔）
wrangler secret put ALLOWED_CHAT_IDS
```

### 4. 创建 KV 存储

```bash
# 创建 KV namespace
wrangler kv:namespace create "BC_GAME_KV"

# 更新 wrangler.toml 文件
# 添加返回的 namespace ID 到配置中
```

wrangler.toml 配置示例：
```toml
name = "baccarat-bot"
main = "src/index.ts"
compatibility_date = "2024-01-15"

[[kv_namespaces]]
binding = "BC_GAME_KV"
id = "your-kv-namespace-id"

[[durable_objects.bindings]]
name = "GAME_ROOMS"
class_name = "BaccaratGameRoom"
```

### 5. 部署

```bash
# 开发环境测试
npm run dev

# 部署到生产环境
npm run deploy

# 设置 Webhook
curl -X POST "https://your-worker.workers.dev/set-webhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-worker.workers.dev/webhook"}'
```

## 游戏流程详解

### 1. 开始游戏
```
管理员或成员: /newgame
Bot: 🎲 第 20250719143001 局百家乐开始！
     💰 下注时间：30秒
     📝 下注格式：/bet banker 100
     ⏰ 系统将自动倒计时和开牌
     💡 或使用 /process 立即开牌
```

### 2. 下注阶段
```
玩家A: /bet banker 100
Bot: ✅ 玩家A 下注成功！💰 庄家 100 点
     👥 当前参与人数：1
     ⏰ 剩余时间：25 秒

玩家B: /bet player 50
Bot: ✅ 玩家B 下注成功！💰 闲家 50 点
     👥 当前参与人数：2
     ⏰ 剩余时间：20 秒

玩家C: /bet tie 25
Bot: ✅ 玩家C 下注成功！💰 和局 25 点
     👥 当前参与人数：3
     ⏰ 剩余时间：15 秒
```

### 3. 自动处理
30秒后或手动 `/process`：
```
Bot: ⛔️ 第 20250719143001 局停止下注！
     📊 下注汇总：
     🏦 庄家: 100 点
     👤 闲家: 50 点
     🤝 和局: 25 点
     
     🎲 开牌阶段开始！
     🏦 庄家第1张牌: 4 点
     👤 闲家第1张牌: 6 点
     🏦 庄家第2张牌: 3 点
     👤 闲家第2张牌: 2 点
     
     📊 前两张牌点数：
     🏦 庄家: 4 + 3 = 7 点
     👤 闲家: 6 + 2 = 8 点
     
     🎯 天牌！无需补牌！
     
     🎯 第 20250719143001 局开牌结果
     🏦 庄家最终点数: 7 点
     👤 闲家最终点数: 8 点
     👤 闲家胜！
     
     ✅ 获胜者：
     玩家B: +50
     
     ❌ 失败者：
     玩家A: -100
     玩家C: -25
     
     🔄 自动游戏模式：10秒后开始下一局
```

### 4. 自动游戏模式
```
管理员: /autogame
Bot: 🤖 自动游戏模式已开启！
     🔄 游戏将持续自动进行
     ⏰ 每局间隔10秒
     💡 即使无人下注也会继续发牌
     🛑 使用 /stopauto 关闭自动模式
```

## API 使用示例

### 自动化游戏管理
```bash
# 为指定群组自动开始游戏
curl -X POST "https://your-worker.workers.dev/auto-game/-1001234567890" \
  -H "Content-Type: application/json"

# 启用自动游戏模式
curl -X POST "https://your-worker.workers.dev/enable-auto/-1001234567890" \
  -H "Content-Type: application/json"

# 禁用自动游戏模式
curl -X POST "https://your-worker.workers.dev/disable-auto/-1001234567890" \
  -H "Content-Type: application/json"

# 检查游戏状态
curl "https://your-worker.workers.dev/game-status/-1001234567890"

# 获取最近游戏记录
curl "https://your-worker.workers.dev/game-history/-1001234567890"

# 获取指定游戏详情
curl "https://your-worker.workers.dev/game-detail/20250719143001"
```

### 消息发送
```bash
# 发送游戏通知
curl -X POST "https://your-worker.workers.dev/send-message" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "-1001234567890",
    "message": "🎮 **百家乐夜场即将开始！**\n\n准备好你的筹码了吗？",
    "parseMode": "Markdown"
  }'
```

## 项目结构

```
├── src/
│   ├── index.ts            # 主程序文件，包含 Bot 命令处理和 API 路由
│   ├── baccaratGameRoom.ts # 游戏房间逻辑，处理游戏状态和流程
│   ├── types.ts            # 类型定义
├── package.json            # 项目依赖
├── wrangler.toml           # Cloudflare Workers 配置
├── tsconfig.json           # TypeScript 配置
└── README.md               # 项目说明文档
```

## 核心技术特性

### 游戏状态管理
```typescript
enum GameState {
  Idle = 'idle',          // 空闲
  Betting = 'betting',    // 下注中
  Processing = 'processing', // 处理中
  Revealing = 'revealing',   // 开牌中
  Finished = 'finished'      // 已结束
}
```

### 数据存储策略
- **双重存储**：Durable Objects 维护当前游戏状态，Cloudflare KV 存储游戏记录。
- **历史记录**：最近100局游戏记录保存在 KV 中。
- **清理机制**：非自动模式下，游戏结束后30秒清理数据。
- **容错处理**：KV 故障时依赖内存缓存，异常情况自动恢复。

### 补牌规则实现
- **闲家规则**：0-5点补牌，6-7点停牌，8-9点天牌。
- **庄家规则**：根据自身点数和闲家第三张牌决定补牌。
- **天牌判断**：庄家或闲家前两张牌总和为8或9点，立即结束游戏。

### 骰子机制
- 使用 Telegram 的 `sendDice` API 生成1-6的随机点数模拟牌值。
- 每张牌通过发送骰子动画获得点数，确保随机性。
- 骰子动画完成后显示点数，增加游戏趣味性。

## 环境变量配置

| 变量名             | 必需 | 说明                           | 示例                          |
|--------------------|------|--------------------------------|-------------------------------|
| `BOT_TOKEN`        | ✅   | Telegram Bot Token             | `1234567890:ABC...`          |
| `WEBHOOK_SECRET`   | ❌   | Webhook 验证密钥               | `your-secret-key`            |
| `ALLOWED_CHAT_IDS` | ❌   | 允许的群组ID列表（逗号分隔）   | `-1001234567890,-1009876543210` |

## 监控和维护

### 日志查看
```bash
# 实时日志
wrangler tail

# 特定环境日志
wrangler tail --env production
```

### 性能监控
- 监控活跃游戏数量和 API 响应时间。
- 跟踪错误率和异常情况。
- 检查 KV 存储的读写性能。

### 数据清理
- 非自动模式下，游戏数据在游戏结束后30秒自动清理。
- KV 存储中的游戏记录保留最近100局，无显式TTL。
- 内存缓存通过 Durable Objects 管理，异常时自动恢复。

## 部署最佳实践

### 1. 安全配置
- 定期轮换 `BOT_TOKEN`。
- 配置 `ALLOWED_CHAT_IDS` 限制群组访问。
- 启用 `WEBHOOK_SECRET` 验证 Webhook 请求。

### 2. 性能优化
- 按需创建 Bot 实例，减少资源占用。
- 优化 KV 读写，优先使用内存缓存。
- 使用 Durable Objects 确保群组隔离和状态一致性。

### 3. 错误处理
- 网络请求失败时自动重试。
- 游戏状态异常时通过 `/stopgame` 清理。
- 用户输入验证，确保下注格式和金额有效。

## 故障排除

### 常见问题

1. **游戏无法开始**
   - 检查 Bot 是否有群组发送消息权限。
   - 确认 `BOT_TOKEN` 和 KV 配置正确。
   - 检查是否存在未结束的游戏（使用 `/status` 查看）。

2. **下注失败**
   - 确保下注在30秒时间内（`/status` 查看剩余时间）。
   - 验证下注格式（例如 `/bet banker 100`）。
   - 确认游戏状态为 `betting`。

3. **Webhook 问题**
   - 验证 Workers URL 是否可访问。
   - 检查 SSL 证书是否有效。
   - 确保防火墙未阻止 Telegram 的请求。

### 调试技巧
```bash
# 检查 Webhook 状态
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"

# 测试 API 连通性
curl "https://your-worker.workers.dev/health"

# 查看特定群组游戏状态
curl "https://your-worker.workers.dev/game-status/-1001234567890"

# 查看最近游戏记录
curl "https://your-worker.workers.dev/game-history/-1001234567890"
```

## 扩展功能建议

### 1. 高级功能
- [ ] 用户积分系统：记录玩家胜负和积分。
- [ ] 统计报表：生成每日/每周游戏统计。
- [ ] 定时游戏：按计划自动开启游戏。

### 2. 社交功能
- [ ] 排行榜：显示群组内玩家胜率和收益排名。
- [ ] 成就系统：解锁游戏里程碑奖励。
- [ ] 群组对战：支持多群组竞技模式。

### 3. 管理功能
- [ ] 管理员面板：通过 Bot 命令管理游戏参数。
- [ ] 用户权限：设置下注限制或管理员权限。
- [ ] 反作弊：检测异常下注行为。

## 许可证

MIT License - 详见 LICENSE 文件

## 贡献指南

1. Fork 本项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 支持

如果你觉得这个项目有用，请给它一个 ⭐️！

有问题或建议？欢迎提交 Issue 或 Pull Request。
