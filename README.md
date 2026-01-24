# Orange Express Sample

简单的 Node.js + Express 示例后端。

快速开始：

1. 安装依赖：

```bash
npm install
```

2. 启动服务器：

```bash
npm start
# 或开发模式：
npm run dev
```

示例接口：

- `GET /` → 返回欢迎文本
- `GET /api/items` → 列表
- `POST /api/items` → 创建新 item，Body: `{ "name": "xxx" }`
