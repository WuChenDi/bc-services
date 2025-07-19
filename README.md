# 百家乐 Telegram Bot

一个部署在 Cloudflare Workers 上的 Telegram 百家乐游戏机器人，使用 Hono 和 Grammy 框架实现。支持群组游戏、自动化流程和完整的百家乐规则。

## 功能特性

### 🎲 游戏功能
- **完整百家乐规则**：庄家、闲家、和局三种下注类型
- **真实补牌规则**：严格按照百家乐官方规则执行补牌逻辑
- **自动游戏流程**：30秒下注 → 自动开牌 → 结果公布
- **多群组支持**：每个群组独立游戏状态
- **数据持久化**：支持 Cloudflare KV 存储，带内存缓存

### 🤖 Bot 命令
- `/start` - 启动 Bot 并显示完整游戏说明
- `/newgame` - 开始新的百家乐游戏
- `/bet <类型> <金额>` - 下注（banker/player/tie）
- `/process` - 手动处理游戏（开牌）
- `/status` - 查看当前游戏状态和下注汇总
- `/stopgame` - 停止当前游戏
- `/id` - 获取群组和用户 ID 信息

### 🎯 游戏规则
- **下注类型**：
  - `banker` - 庄家胜（1:1赔率）
  - `player` - 闲家胜（1:1赔率）
  - `tie` - 和局（8:1赔率）
- **补牌规则**：完全按照百家乐标准规则
- **点数计算**：A=1，2-9按面值，10/J/Q/K=0，总和取个位数

### 🔧 HTTP API 接口
- `GET /` - 服务状态和活跃游戏数
- `GET /health` - 健康检查
- `POST /webhook` - Telegram Webhook 处理
- `POST /auto-game/:chatId` - 自动开始游戏
- `POST /process-game/:chatId` - 自动处理超时游戏
- `GET /game-status/:chatId` - 获取游戏状态
- `POST /send-message` - 发送消息到指定群组
- `POST /send-dice` - 发送骰子动画
- `POST /set-webhook` - 设置 Telegram Webhook

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

1. 在 Telegram 中找到 [@BotFather](https://t.me/botfather)
2. 发送 `/newbot` 创建新 Bot
3. 设置 Bot 名称和用户名
4. 获取 Bot Token
5. 设置 Bot 命令菜单：
   ```
   /setcommands
   选择你的 Bot
   发送以下命令列表：
   start - 启动 Bot
   newgame - 开始新游戏
   bet - 下注 (格式: /bet banker 100)
   process - 处理游戏
   status - 查看游戏状态
   stopgame - 停止游戏
   id - 获取群组ID
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

### 4. 创建 KV 存储（可选）

```bash
# 创建 KV namespace
wrangler kv:namespace create "GAME_KV"

# 更新 wrangler.json 文件
# 添加返回的 namespace ID 到配置中
```

wrangler.json 配置示例：
```json
{
  "name": "baccarat-bot",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-15",
  "kv_namespaces": [
    {
      "binding": "GAME_KV",
      "id": "your-kv-namespace-id"
    }
  ]
}
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
```

### 2. 下注阶段
```
玩家A: /bet banker 100
Bot: ✅ 玩家A 下注成功！💰 庄家 100 点

玩家B: /bet player 50  
Bot: ✅ 玩家B 下注成功！💰 闲家 50 点

玩家C: /bet tie 25
Bot: ✅ 玩家C 下注成功！💰 和局 25 点
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
     🏦 庄家第1张牌: 7 点
     👤 闲家第1张牌: 5 点
     🏦 庄家第2张牌: 2 点  
     👤 闲家第2张牌: 4 点
     
     📊 前两张牌点数：
     🏦 庄家: 9 点
     👤 闲家: 9 点
     
     🎯 天牌！无需补牌！
     
     🎯 第 20250719143001 局开牌结果
     🏦 庄家最终点数: 9 点
     👤 闲家最终点数: 9 点
     🤝 和局！
     
     ✅ 获胜者：
     玩家C: +200 (和局8倍赔率)
     
     ❌ 失败者：
     玩家A: -100
     玩家B: -50
```

## API 使用示例

### 自动化游戏管理

```bash
# 为指定群组自动开始游戏
curl -X POST "https://your-worker.workers.dev/auto-game/-1001234567890" \
  -H "Content-Type: application/json"

# 检查游戏状态
curl "https://your-worker.workers.dev/game-status/-1001234567890"

# 自动处理超时游戏
curl -X POST "https://your-worker.workers.dev/process-game/-1001234567890"
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

# 发送骰子动画
curl -X POST "https://your-worker.workers.dev/send-dice" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "-1001234567890",
    "emoji": "🎲"
  }'
```

## 项目结构

```
├── src/
│   └── index.ts          # 主程序文件
│       ├── Bot 命令处理
│       ├── 游戏状态管理
│       ├── 百家乐逻辑
│       ├── KV 存储操作
│       └── HTTP API 路由
├── package.json          # 项目依赖
├── wrangler.json         # Cloudflare Workers 配置
├── tsconfig.json         # TypeScript 配置
└── README.md            # 说明文档
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
- **双重存储**：KV + 内存缓存，确保数据不丢失
- **过期机制**：游戏数据1小时后自动清理
- **容错处理**：KV 故障时自动切换到内存存储

### 补牌规则实现
- **闲家规则**：0-5点补牌，6-7点停牌，8-9点天牌
- **庄家规则**：根据自身点数和闲家第三张牌决定
- **天牌判断**：任一方8-9点立即结束

## 环境变量配置

| 变量名 | 必需 | 说明 | 示例 |
|--------|------|------|------|
| `BOT_TOKEN` | ✅ | Telegram Bot Token | `1234567890:ABC...` |
| `WEBHOOK_SECRET` | ❌ | Webhook 验证密钥 | `your-secret-key` |
| `ALLOWED_CHAT_IDS` | ❌ | 允许的群组ID列表 | `-1001234567890,-1009876543210` |

## 监控和维护

### 日志查看
```bash
# 实时日志
wrangler tail

# 特定环境日志
wrangler tail --env production
```

### 性能监控
- 每个请求的游戏数量统计
- API 响应时间监控
- 错误率和异常追踪

### 数据清理
- 游戏数据30秒后自动清理
- KV 存储1小时TTL自动过期
- 内存缓存定期清理机制

## 部署最佳实践

### 1. 安全配置
```bash
# 定期轮换 Bot Token
# 设置群组白名单
# 启用 Webhook 验证
```

### 2. 性能优化
- Bot 实例按需创建，无状态设计
- KV 读写优化，减少延迟
- 内存缓存命中率优化

### 3. 错误处理
- 网络请求重试机制
- 游戏状态异常恢复
- 用户输入验证和容错

## 故障排除

### 常见问题

1. **游戏无法开始**
   - 检查群组权限，确保 Bot 可以发送消息
   - 验证 KV 存储配置是否正确
   - 查看是否有未结束的游戏

2. **下注失败**
   - 确认在30秒下注时间内
   - 检查下注格式是否正确
   - 验证游戏状态是否为 betting

3. **Webhook 问题**
   - 检查 Workers URL 是否正确
   - 验证 SSL 证书有效性
   - 确认防火墙没有阻止 Telegram 请求

### 调试技巧

```bash
# 检查 Webhook 状态
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"

# 测试 API 连通性
curl "https://your-worker.workers.dev/health"

# 查看特定群组游戏状态
curl "https://your-worker.workers.dev/game-status/-1001234567890"
```

## 扩展功能建议

### 1. 高级功能
- [ ] 用户积分系统
- [ ] 游戏历史记录
- [ ] 统计报表生成
- [ ] 自动定时游戏

### 2. 社交功能
- [ ] 排行榜系统
- [ ] 成就徽章
- [ ] 好友邀请
- [ ] 群组对战

### 3. 管理功能
- [ ] 管理员面板
- [ ] 游戏参数配置
- [ ] 用户权限管理
- [ ] 反作弊系统

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
