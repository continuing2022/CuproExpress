# CuproExpress

CuproExpress 是 CuproAgent 的后端服务，提供用户认证、会话管理、AI 对话编排、私有知识库 RAG 检索和可选联网搜索能力。项目使用 Express + MySQL 承载业务接口，通过 LangChain 调用多模型服务，并可自动启动本地 FastAPI RAG 服务。

## 功能概览

- 账号体系：注册、登录、刷新令牌、退出、忘记密码、当前用户信息。
- 权限管理：普通用户与管理员角色，管理员可管理用户、批量删除和导出用户数据。
- 会话系统：创建会话、分页读取历史消息、重命名、删除会话。
- 流式对话：`/conversations` 使用 SSE 返回 AI 增量输出。
- 多模型支持：Qwen、Kimi、DeepSeek 等模型通过统一注册表接入。
- 私有知识库：本地 RAG 服务支持向量检索、BM25 召回、融合去重和 rerank。
- 联网搜索：启用后通过 Bocha Search 获取公开网页上下文。
- 长对话处理：基于 LangChain summarization middleware 做摘要压缩和上下文延续。

## 技术栈

- Node.js + Express
- MySQL + mysql2
- JWT + HttpOnly refresh token cookie
- LangChain / LangGraph
- OpenAI-compatible SDK
- Python FastAPI + LlamaIndex RAG 服务
- DashScope embedding / LLM

## 目录结构

```text
CuproExpress/
├─ index.js                    # Express 入口
├─ db/                         # MySQL 连接池与自动建表
├─ routes/                     # auth、conversations 路由
├─ repositories/               # 用户、会话、token 数据访问
├─ services/                   # AI 编排、RAG、SSE、模型注册
├─ rag_service/                # FastAPI + LlamaIndex 本地知识库服务
├─ scripts/startRag.js         # 单独启动 RAG 服务
├─ searchTool.js               # Bocha 联网搜索工具
└─ utils/                      # 鉴权、校验、响应封装
```

## 环境要求

- Node.js 18+，建议 20+
- MySQL 8+
- Python 3.10+
- 可用的大模型 API Key

## 快速开始

安装 Node 依赖：

```bash
npm install
```

创建 `.env`：

```env
PORT=3000
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
JSON_BODY_LIMIT=1mb

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=cupro_agent

JWT_SECRET=change_me_access_secret
REFRESH_SECRET=change_me_refresh_secret

DASHSCOPE_API_KEY=your_dashscope_api_key
KIMI_API_KEY=
DEEPSEEK_API_KEY=

BOCHA_API_KEY=
BOCHA_SEARCH_URL=https://api.bochaai.com/v1/web-search

RAG_SERVICE_URL=http://localhost:8001/rag/retrieve
RAG_AUTO_START=1
RAG_PYTHON_PATH=.venv/Scripts/python.exe
RAG_DATA_DIR=localResource
RAG_PERSIST_DIR=rag_service/storage_hybrid
```

启动服务：

```bash
npm run dev
```

生产方式启动：

```bash
npm start
```

服务默认监听 `http://localhost:3000`。启动时会自动创建数据库和所需表：`users`、`conversations`、`messages`、`conversation_states`、`refresh_tokens`。

## RAG 服务

后端默认会在本地 RAG URL 指向 `localhost` 或 `127.0.0.1` 时自动启动 RAG 服务。首次启动前需要安装 Python 依赖：

```bash
cd rag_service
python -m venv ../.venv
../.venv/Scripts/pip install -r requirements.txt
```

也可以手动启动：

```bash
npm run rag
```

RAG 服务会读取 `RAG_DATA_DIR` 指向的本地知识库目录，构建并复用持久化索引。默认接口：

- `POST /rag/retrieve`：只返回检索上下文。
- `POST /rag/stream`：RAG 服务内部流式生成回答。
- `POST /rag/rebuild`：强制重建索引。
- `GET /health`：健康检查。

## 核心接口

认证接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/auth/register` | 注册普通用户 |
| `POST` | `/auth/login` | 登录并写入 refresh token cookie |
| `POST` | `/auth/refresh` | 刷新 access token |
| `POST` | `/auth/logout` | 退出并吊销 refresh token |
| `POST` | `/auth/forgot-password` | 重置密码，生产环境默认只接受请求 |
| `GET` | `/auth/me` | 获取当前用户 |

管理员接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/auth/users` | 分页查询用户 |
| `GET` | `/auth/users/stats` | 用户统计 |
| `GET` | `/auth/users/:id` | 用户详情 |
| `POST` | `/auth/users` | 新增用户 |
| `PUT` | `/auth/users/:id` | 更新用户 |
| `DELETE` | `/auth/users/:id` | 删除用户 |
| `POST` | `/auth/users/bulk-delete` | 批量删除 |
| `POST` | `/auth/users/export` | 导出用户 |

会话接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/conversations` | 发起 AI 对话，SSE 流式返回 |
| `GET` | `/conversations` | 获取会话列表 |
| `GET` | `/conversations/:id/messages` | 分页获取会话消息 |
| `PUT` | `/conversations/:id` | 重命名会话 |
| `DELETE` | `/conversations/:id` | 删除会话 |

`POST /conversations` 请求示例：

```json
{
  "conversation_id": "optional-existing-id",
  "title": "铜合金选型",
  "content": "C17200 和 C17510 的主要差异是什么？",
  "model": "qwen-plus",
  "networkConfig": {
    "search": false
  }
}
```

SSE 事件包括 `started`、`retrieved`、`chunk`、`done` 和 `error`。

## 支持的模型

| 模型 | 服务商 | 环境变量 |
| --- | --- | --- |
| `qwen-plus` | DashScope | `DASHSCOPE_API_KEY` |
| `qwen-math-turbo` | DashScope | `DASHSCOPE_API_KEY` |
| `qwen-flash` | DashScope | `DASHSCOPE_API_KEY` |
| `qwen-max` | DashScope | `DASHSCOPE_API_KEY` |
| `kimi-k2.5` | Moonshot | `KIMI_API_KEY` |
| `deepseek-v4-pro` | DeepSeek | `DEEPSEEK_API_KEY` |

如需新增模型，在 `services/modelRegistry.js` 中注册模型名、base URL、API Key 环境变量和上下文窗口。

## 常用配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Express 监听端口 |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 允许跨域的前端地址 |
| `JSON_BODY_LIMIT` | `1mb` | JSON 请求体大小 |
| `SUMMARY_MODEL` | 当前对话模型 | 长对话摘要模型 |
| `LANGCHAIN_HISTORY_LIMIT` | `100` | 初始化 LangChain 状态时读取的历史消息数；手动配置时会限制在 5-20 |
| `LANGCHAIN_SUMMARY_TRIGGER_TOKENS` | `6000` | 触发摘要的 token 阈值 |
| `LANGCHAIN_SUMMARY_KEEP_MESSAGES` | `20` | 摘要后保留的最近消息数 |
| `OBSERVE_CHAT_METRICS` | `1` | 是否开启对话指标记录 |
| `OBSERVE_CHAT_VERBOSE` | `0` | 是否输出更详细观测信息 |
| `ALLOW_INSECURE_PASSWORD_RESET` | 空 | 生产环境是否允许直接改密，设置 `1` 才开启 |

## 前端联调

配套前端项目为 CuproAgent/CuproAI。前端默认请求当前主机的 `3000` 端口，也可以通过 `VITE_API_BASE_URL` 指定后端地址。

```env
VITE_API_BASE_URL=http://localhost:3000
```

开发时通常同时启动：

```bash
# 后端
npm run dev

# 前端项目
npm run dev
```
