# Windows Server 部署指南

## 一、使用 ToDesk 连接到云服务器

1. 打开 ToDesk 客户端
2. 输入云服务器的设备代码和密码
3. 连接到远程桌面

## 二、安装 Node.js

### 方法一：使用浏览器下载安装（推荐）

1. 在远程桌面打开浏览器
2. 访问 https://nodejs.org/
3. 下载 LTS 版本（推荐 v18 或 v20）
4. 双击安装包，一路 Next
5. 安装完成后重启命令提示符

### 方法二：使用 Chocolatey 包管理器

```powershell
# 以管理员身份打开 PowerShell
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# 安装 Node.js
choco install nodejs-lts -y
```

## 三、上传项目文件

### 方法一：直接复制粘贴（最简单）

1. 在本地电脑打开项目文件夹
2. 全选所有文件（Ctrl+A）
3. 复制（Ctrl+C）
4. 在 ToDesk 远程桌面中，在合适位置（如 `C:\projects\xiapi`）粘贴（Ctrl+V）

### 方法二：使用 Git

```bash
# 在远程桌面打开命令提示符
cd C:\projects
git clone <你的仓库地址>
cd xiapi
```

### 方法三：使用文件传输

ToDesk 支持文件传输功能，可以直接拖拽文件到远程桌面

## 四、部署服务

### 1. 配置环境变量

1. 在项目目录找到 `.env.example` 文件
2. 复制一份并重命名为 `.env`
3. 用记事本打开 `.env` 文件
4. 修改以下必要配置：
   ```
   UPSTREAM_TOKEN=你的上游token
   TOKEGE_TOKEN=你的tokege token
   PORT=3000
   ```
5. 保存文件

### 2. 运行部署脚本

1. 在项目目录右键，选择"在终端中打开"（或打开 CMD 并 cd 到项目目录）
2. 运行部署脚本：
   ```bash
   deploy.bat
   ```
3. 脚本会自动：
   - 检查 Node.js
   - 安装 PM2
   - 安装项目依赖
   - 启动服务

### 3. 验证服务

打开浏览器访问：`http://localhost:3000`

## 五、配置防火墙

### Windows 防火墙设置

1. 打开"Windows Defender 防火墙"
2. 点击"高级设置"
3. 选择"入站规则" → "新建规则"
4. 选择"端口" → 下一步
5. 选择"TCP"，输入端口号 `3000` → 下一步
6. 选择"允许连接" → 下一步
7. 全选（域、专用、公用）→ 下一步
8. 输入名称"xiapi服务" → 完成

### 云服务商安全组

在云服务商控制台（如阿里云、腾讯云）添加安全组规则：
- 协议：TCP
- 端口：3000
- 授权对象：0.0.0.0/0

## 六、常用管理命令

在项目目录打开命令提示符（CMD）：

```bash
# 查看服务状态
pm2 status

# 查看实时日志
pm2 logs xiapi

# 重启服务
pm2 restart xiapi

# 停止服务
pm2 stop xiapi

# 删除服务
pm2 delete xiapi

# 查看详细信息
pm2 show xiapi
```

## 七、设置开机自启

PM2 已通过 `pm2-windows-startup` 配置开机自启，服务器重启后会自动启动服务。

如需手动配置：
```bash
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

## 八、更新部署

当代码有更新时：

1. 复制新代码覆盖旧文件（或 `git pull`）
2. 运行 `deploy.bat`

## 九、故障排查

### 服务无法启动

```bash
# 查看错误日志
pm2 logs xiapi --err

# 手动测试启动
node src/index.js
```

### 端口被占用

```bash
# 查看端口占用
netstat -ano | findstr :3000

# 结束占用进程（PID 从上面命令获取）
taskkill /PID <进程ID> /F
```

### PM2 命令不可用

重启命令提示符或重新打开一个新的 CMD 窗口

## 十、日志查看

### 应用日志
位置：`项目目录\logs\`

### PM2 日志
位置：`C:\Users\<用户名>\.pm2\logs\`

可以用记事本或其他文本编辑器打开查看

## 十一、使用 IIS 反向代理（可选）

如果需要使用 80 端口或配置域名：

1. 安装 IIS
2. 安装 URL Rewrite 和 Application Request Routing
3. 配置反向代理到 `http://localhost:3000`

详细配置可参考 IIS 反向代理文档

## 十二、安全建议

1. 不要将 `.env` 文件分享给他人
2. 定期更新 Node.js 和依赖包
3. 配置强密码和防火墙规则
4. 定期备份项目文件和配置
5. 使用 HTTPS（配置 SSL 证书）

## 十三、ToDesk 使用技巧

1. **文件传输**：ToDesk 工具栏有文件传输按钮，可以快速传输文件
2. **剪贴板共享**：可以在本地和远程之间复制粘贴文本
3. **快捷键**：Ctrl+Alt+Del 等快捷键可以通过 ToDesk 工具栏发送
4. **性能优化**：降低画质可以提高连接流畅度
