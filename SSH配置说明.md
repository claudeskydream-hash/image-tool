# Windows SSH 远程登录配置说明

**配置时间：** 2026-03-28  
**服务器IP：** 49.235.187.41  
**SSH端口：** 22

---

## 一、SSH 服务状态

| 项目 | 状态 |
|-----|------|
| OpenSSH 服务器 | ✅ 已安装 |
| SSH 服务 (sshd) | ✅ 运行中 |
| 开机自动启动 | ✅ 已启用 |
| 防火墙规则 | ✅ 已配置 |

---

## 二、登录信息

### 连接地址
```
主机: 49.235.187.41
端口: 22 (默认)
用户: Administrator
```

### 登录命令

**Linux/macOS:**
```bash
ssh Administrator@49.235.187.41
```

**Windows (PowerShell/CMD):**
```powershell
ssh Administrator@49.235.187.41
```

**使用 PuTTY:**
- Host Name: `49.235.187.41`
- Port: `22`
- Connection type: `SSH`

---

## 三、SSH 配置详情

### 已安装的组件
```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH*'
```

| 组件 | 状态 |
|-----|------|
| OpenSSH.Client | Installed |
| OpenSSH.Server | Installed |

### 服务状态
```powershell
Get-Service sshd
```

| 属性 | 值 |
|-----|---|
| Name | sshd |
| Status | Running |
| StartType | Automatic |

### 端口监听
```
TCP    0.0.0.0:22     LISTENING
TCP    [::]:22        LISTENING
```

### 防火墙规则
```powershell
Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP"
```

| 属性 | 值 |
|-----|---|
| Name | OpenSSH-Server-In-TCP |
| Enabled | True |
| Direction | Inbound |
| Action | Allow |

---

## 四、常用 SSH 管理命令

### 启动 SSH 服务
```powershell
Start-Service sshd
```

### 停止 SSH 服务
```powershell
Stop-Service sshd
```

### 重启 SSH 服务
```powershell
Restart-Service sshd
```

### 查看 SSH 服务状态
```powershell
Get-Service sshd
```

### 设置开机自动启动
```powershell
Set-Service -Name sshd -StartupType Automatic
```

---

## 五、SSH 配置文件

### 服务端配置
```
C:\ProgramData\ssh\sshd_config
```

### 客户端配置
```
C:\Users\Administrator\.ssh\config
```

### 已知主机
```
C:\Users\Administrator\.ssh\known_hosts
```

---

## 六、安全建议

### 1. 修改默认端口（可选）
编辑 `C:\ProgramData\ssh\sshd_config`:
```
Port 2222  # 修改为其他端口
```
然后重启 SSH 服务：
```powershell
Restart-Service sshd
```

### 2. 使用密钥认证（推荐）
在客户端生成密钥对：
```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

将公钥复制到服务器：
```bash
ssh-copy-id Administrator@49.235.187.41
```

### 3. 禁用密码认证（使用密钥后）
编辑 `C:\ProgramData\ssh\sshd_config`:
```
PasswordAuthentication no
PubkeyAuthentication yes
```

---

## 七、故障排查

### 无法连接 SSH

1. **检查服务状态**
   ```powershell
   Get-Service sshd
   ```

2. **检查端口监听**
   ```powershell
   netstat -an | findstr ":22"
   ```

3. **检查防火墙**
   ```powershell
   Get-NetFirewallRule -Name "OpenSSH*"
   ```

4. **查看系统日志**
   ```powershell
   Get-WinEvent -FilterHashtable @{LogName='OpenSSH/Operational'} -MaxEvents 10
   ```

### 连接被拒绝

- 确认防火墙允许端口 22
- 确认 SSH 服务正在运行
- 确认用户名和密码正确

### 认证失败

- 确认用户名存在且已启用
- 检查用户密码是否正确
- 查看认证日志：
  ```powershell
  Get-WinEvent -FilterHashtable @{LogName='Security'} | Where-Object { $_.Message -like "*ssh*" }
  ```

---

## 八、相关文档

- [OpenSSH for Windows](https://docs.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)
- [OpenSSH 服务器配置](https://docs.microsoft.com/en-us/windows-server/administration/openssh/openssh_server_configuration)

---

**配置完成时间：** 2026-03-28  
**SSH 版本：** OpenSSH_for_Windows_8.6p1
