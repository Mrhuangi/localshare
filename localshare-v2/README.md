# 📡 LocalShare — 局域网文件传送

Apple 风格的局域网文件传送工具，像 AirDrop 一样好用。

## 快速开始

```bash
npm install
npm start
```

打开后终端会显示：
```
╔════════════════════════════════════╗
║       LocalShare is running!       ║
╚════════════════════════════════════╝

📡 Open on this device:
   http://localhost:7070

📱 Open on other devices (same Wi-Fi):
   http://192.168.x.x:7070
```

## 使用方法

1. 在局域网内的所有设备上打开对应地址
2. 输入设备名称，选择一个 emoji 头像
3. 点击 **进入局域网**
4. 左侧会看到同网络内的其他设备
5. 选择目标设备 → 拖放文件或点击「选择文件」
6. 对方确认接收后，文件自动下载

## 技术说明

- **传输方式**：文件通过 WebSocket 二进制传输，经本地服务器中转
- **不需要**互联网连接（纯局域网）
- **服务器**：Node.js + Express + ws
- **前端**：原生 HTML/CSS/JS，Apple 设计风格

## 系统要求

- Node.js 16+
- 所有设备在同一 Wi-Fi / 局域网下
