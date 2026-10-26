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

USER_API_KEY_ENCRYPTION_KEY=replace_with_64_hex_characters

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

服务默认监听 `http://localhost:3000`。启动时会自动创建数据库和所需表：`users`、`user_api_keys`、`conversations`、`messages`、`conversation_states`、`refresh_tokens`。

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

RAG 服务会读取 `RAG_DATA_DIR` 指向的本地知识库目录，启动时仅加载已有持久化索引；首次构建或重建需显式调用 `/rag/rebuild` 并提供本次使用的百炼 Key。默认接口：

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

| 模型 | 服务商 | 凭据来源 |
| --- | --- | --- |
| `qwen3-vl-plus`、`qwen-plus`、`qwen-math-turbo`、`qwen-flash`、`qwen-max` | 阿里云百炼 | 当前用户保存的百炼 Key |
| `deepseek-v4-pro` | DeepSeek | 当前用户保存的 DeepSeek Key |

仅支持以上两个服务商。旧的 `DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`、`KIMI_API_KEY` 环境变量不再用于模型调用。没有个人 Key 时会提示配置，不会回退到平台 Key；Key 失效或额度不足也不会回退。摘要限制为与主模型相同的服务商。

### 用户 API Key 与上线配置

1. 在后端 `.env` 设置 `USER_API_KEY_ENCRYPTION_KEY`，必须为 64 位十六进制字符串。用下面的命令生成一次，并妥善备份，后续部署保持一致：

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

2. 重启后端，首次数据库初始化会自动创建 `user_api_keys` 表，已有用户不需要迁移账号。
3. 用户登录后，通过个人菜单或聊天框下方的“模型服务设置”分别填写自己的百炼、DeepSeek Key。保存仅做格式检查，服务商的有效性、权限与余额在实际调用时判断。
4. 生产环境通过 HTTPS 提供前后端。Key 不保存到浏览器持久存储、不写入 JWT；AES-256-GCM 密文与用户 ID、服务商绑定，只有该账号可操作，管理员没有读取他人 Key 的接口。加密主密钥丢失或被替换后，用户必须重新填写 Key。

设置接口（均需登录，身份来自 JWT，不接受请求体中的用户 ID）：

- `GET /model-settings`：仅返回两种服务商的配置状态和 Key 尾号。
- `PUT /model-settings/:provider`：保存/更换 `{ "apiKey": "..." }`，provider 为 `dashscope` 或 `deepseek`。
- `DELETE /model-settings/:provider`：删除当前用户对应 Key。

### 知识库与其他服务费用

RAG 查询向量使用当前用户的百炼 Key，通过请求头传递给本机 Python 服务，不写入共享模型或环境变量。只有 DeepSeek Key 的用户可以聊天，检索会提示需要个人百炼 Key。用户密钥仅允许传到 loopback 地址的 RAG 服务，禁止重定向；配置远程 RAG 地址时检索会被跳过。Python 服务应只绑定本机地址，禁止对公网开放。

索引加载不调用付费模型。没有可用索引或知识库内容发生变化时，需要运维显式向本机 `POST /rag/rebuild`，使用 `X-Dashscope-Api-Key` 请求头提供用于本次构建的百炼 Key，构建费用由该 Key 对应账户承担。用户聊天不会自动触发全库向量化。Python `/rag/retrieve`、`/rag/stream` 也必须提供此请求头；未提供时不会使用任何平台 Key。

联网搜索仍由平台 `BOCHA_API_KEY` 提供，附件存储仍使用平台 OSS 配置；它们是独立基础服务，不属于本次两种模型 Key 设置。

验证用户凭据：运行 `npm test`；安装 Python RAG 依赖及 `httpx` 后，运行 `.venv/Scripts/python -B -m unittest discover -s tests -p test_rag_credentials.py`。测试使用模拟模型与临时索引，不调用付费 API。数据库接口在测试中模拟，部署时还需验证真实 MySQL 建表和实际服务商调用。

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
# 多模态附件（阿里云 OSS + 百炼）

聊天输入框可上传 PNG、JPEG、WebP、PDF、Markdown、TXT 和 Word `.docx`，每条最多 4 个、每个 5 MB。支持仅发送附件、上传状态、图片预览、私有下载、历史会话追问和发送失败恢复草稿。图片自动选择 `qwen3-vl-plus`，附件会话只允许使用阿里云 Qwen 模型；摘要模型也不会将附件切换到其他服务商。

将 [attachments.env.example](./attachments.env.example) 中的 OSS 配置填入后端 `.env`，百炼模型使用当前用户在“模型服务设置”中保存的 Key。创建私有 OSS Bucket，配置其 `OSS_REGION`（例如 `oss-cn-hangzhou`）、`OSS_BUCKET` 及后端 RAM 凭据 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`。RAM 仅需对该桶 `chat-attachments/*` 的 GetObject、PutObject、DeleteObject 权限。不要在前端 `VITE_*` 配置中放密钥。临时 STS 凭据还需配置 `OSS_STS_TOKEN`，到期前更新凭据并重启后端。

运行 `npm install` 并重启后端；初始化会自动创建 `attachments` 和 `attachment_cleanup` 表，不修改已有消息表。文件经鉴权后由后端上传到 OSS，原文件不写入数据库；数据库保存文件元信息、关联及提取文字。图片由后端读取为模型输入，浏览器通过鉴权接口预览和下载，无需公开 Bucket 或配置浏览器直传 CORS。

PDF、DOCX 在独立进程中提取文字（15 秒超时、256 MB JS 堆限制）；MD、TXT 要求 UTF-8。文档最多 40000 字符，每条消息文档合计约 12000 tokens，超过限制会提示拆分。扫描版 PDF、文档内嵌图片和旧版 `.doc` 不做 OCR 或转换：请先 OCR、将页面作为图片上传，或另存为 `.docx`。

删除会话会在同一数据库事务中登记 OSS 清理任务；删除失败的对象保留队列重试。后端启动、删除会话及每小时执行清理，超过一天未发送的附件会过期。每轮最多处理 100 个过期附件和 100 个删除任务。移除尚未发送的附件也会删除 OSS 原文件。

验证：`npm test`，覆盖真实 PDF/DOCX 解析、扫描 PDF/损坏文件拒绝、大小与格式限制、上传/下载权限、附件输入和历史元信息；云存储与模型调用使用模拟接口，部署后仍需使用实际 OSS 和百炼配置联调。
