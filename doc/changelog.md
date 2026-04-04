# AI Image Studio - 修改记录

## 2026-03-28

### 1. Nginx 缓存修复

**问题**：手机浏览器访问时，页面显示"服务器未启动"，即使后端已恢复。原因是手机缓存了后端宕机时的页面（304 Not Modified）。

**修改文件**：`C:\nginx\conf\nginx.conf`

**改动**：为 `index.html` 添加禁止缓存头，防止 SPA 页面被浏览器缓存导致状态卡死。

```nginx
location = /index.html {
    root   C:/NginxData;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    add_header Pragma "no-cache";
    add_header Expires "0";
}
```

---

### 2. 后台管理界面（新增）

**功能**：独立的管理页面，管理员登录后可为用户充值金币。

#### 新增文件

| 文件 | 说明 |
|------|------|
| `adminMager.html` | 管理页面（登录 + 充值），深色主题，响应式 |
| `doc/changelog.md` | 本文档 |

#### 后端改动（`server/server.js`）

**新增配置项**（存入 MongoDB `config` 集合）：

| key | 默认值 | 说明 |
|-----|--------|------|
| `adminUser` | `admin` | 管理员用户名 |
| `adminPassword` | `1111` | 管理员密码 |

**新增内存状态**：

- `adminSessions` — Map，管理管理员 session token
- `adminLastAttempt` — 时间戳，记录上次登录尝试时间

**新增 API 路由**：

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/api/admin-login` | 管理员登录，每次尝试有 5 秒服务端冷却 | 无 |
| GET | `/api/admin-check` | 验证管理员 session 是否有效 | Bearer token |
| POST | `/api/admin-recharge` | 为指定用户充值金币 | Bearer token |

**冷却机制**：服务端记录 `adminLastAttempt` 时间戳，5 秒内再次请求返回 `429` + 剩余秒数，前端据此显示倒计时按钮。

**充值请求体**：
```json
{ "username": "sky", "amount": 10 }
```

**充值响应**：
```json
{ "success": true, "username": "sky", "amount": 10, "balance": 22 }
```

#### 前端功能（`adminMager.html`）

- 访问地址：`http://服务器IP/adminMager.html`
- 登录区：用户名 + 密码，登录按钮 5 秒冷却倒计时
- 充值区：输入用户名和数量，点击充值，显示结果和最新余额
- Session 持久化：token 存 localStorage，刷新免登录
- 支持回车快捷操作

#### 修改密码

在 MongoDB `config` 集合中修改 `adminPassword` 的 value，每次登录实时读取数据库验证。

```javascript
// MongoDB shell 示例
db.config.updateOne({ key: "adminPassword" }, { $set: { value: "新密码", updatedAt: Date.now() } })
```

---

### 3. 项目文档（新增）

**新增文件**：`CLAUDE.md` — 为 Claude Code 提供项目上下文，包含架构概览、启动命令、API 测试方法等。

---

## 2026-03-29

### 4. 充值记录写入数据库

**修改文件**：`server/server.js`

**改动**：充值成功后自动写入 `recharge_log` 集合，记录每次充值操作。

**新增集合**：`recharge_log`

```javascript
// 记录结构
{
    username: "sky",         // 被充值的用户
    amount: 10,              // 充值金额
    balanceAfter: 1084,      // 充值后余额
    operator: "admin",       // 操作者
    createdAt: 1743103960000 // 时间戳
}
```

**索引**：`username`（正序）、`createdAt`（倒序）

---

### 5. 生成按钮状态优化

**修改文件**：`index.html`

**问题**：用户点击生成后，按钮短暂禁用后立即恢复，可以重复提交。

**改动**：

- 点击生成 → 按钮显示"生成中..."并持续禁用
- 前端轮询 `fetchQueueStatus`（每 3 秒）时检查用户是否还有 `queued` 或 `processing` 状态的任务
- **有活跃任务** → 按钮保持禁用
- **全部完成** → 按钮恢复"✦ 开始生成"
- 提交失败/网络错误时立即恢复按钮

---

### 6. 后台管理后端代码恢复

**问题**：`server.js` 被外部编辑器格式化后，管理员相关的 `adminSessions`、`DEFAULT_CONFIG` 中的 `adminUser`/`adminPassword`、三个管理员路由处理函数及路由注册被移除。

**改动**：将以下内容重新写入 `server/server.js`：
- `adminSessions = new Map()` 内存状态
- `DEFAULT_CONFIG` 中的 `adminUser: 'admin'`、`adminPassword: '1111'`
- `handleAdminLogin`（含服务端 5 秒冷却）、`handleAdminCheck`、`handleAdminRecharge`（含充值记录写入）
- 路由链中注册三个 `/api/admin-*` 路由
