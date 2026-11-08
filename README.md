# CuproExpress

后续优化与验收依据见 [CuproAgent 优化计划](../docs/optimization-plan.md)，包含认证安全、会话与流式状态、前端性能及 RAG 优化的优先级和进度。

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
| `POST` | `/auth/forgot-password` | 用邮箱申请重置邮件，统一返回 202 |
| `POST` | `/auth/reset-password` | 用一次性 Token 和新密码完成重置 |
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

SSE 事件包括 `started`、`retrieved`、`chunk`、`done`、`error` 和 `cancelled`。成功、失败和取消均为终态，后续事件被忽略；未收到终态即 EOF 时，前端报告连接中断并释放输入框。

### 流式回答的取消、超时与持久化

`started` 事件包含用户及助手消息 ID。服务端先创建状态为 `streaming` 的助手消息，最终只更新该行：成功为 `done`，断连为 `aborted`，超时为 `timeout`，生成失败为 `error`。中断时保留已生成的部分文本，即使没有正文也保留终态记录；不会把半截回答当作正常完成。历史接口返回 `status`，前端显示未完成标识。模型已完成且已持久化后发生的终止事件投递失败，不回退数据库中的 `done`。

数据库初始化为 `messages` 新增 `status VARCHAR(16) NOT NULL DEFAULT 'done'`，历史消息保持兼容；部署需要 ALTER 权限。进程崩溃或数据库写入失败可能留下 `streaming` 记录，界面会标识为未完成，自动修复和运行恢复归入 OPT-05。异常 Agent checkpoint 会丢弃，重建上下文时跳过未完成的助手消息；长会话恢复边界仍按 OPT-04 继续优化。

认证后的请求默认总时限 120 秒，可用 `CHAT_DEADLINE_MS` 调整；前端传输总时限为 180 秒。断连、手动停止或时限到达会向 LangGraph、摘要模型、搜索 Axios 和 RAG fetch 传播取消信号。RAG 的独立超时包含响应体读取，取消后不重试，重试等待也可取消。前端等待共享认证刷新时仍可立即停止，不取消其他请求共用的刷新。

SSE 写入经过单一队列：`res.write()` 返回 false 时等待 `drain`，Agent 的输出回调会等待写入完成；排队帧限制 1 MiB，等待 drain 默认最多 15 秒，心跳在有待发数据时跳过。关闭时清理监听器和定时器；终态投递单独限时 1 秒，仍失败时销毁连接。LangGraph/模型 SDK 可能有内部预取；提供商是否停止已开始的服务端计算由其取消实现决定。关闭本机 RAG HTTP 请求也不能强制中断 Python 中已经执行的同步检索线程。

验证：`npm test` 包含断连、超时、终态唯一性、部分回答保存、背压/队列限制，以及 Agent、搜索和 RAG 取消测试；`node tests/ssePersistence.mysql.cjs` 使用随机 `cupro_sse_test_*` 本机测试库验证新增列、默认值、终态更新和历史读取，完成后自动清理，不操作业务数据库。

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
3. 用户登录后，通过个人菜单或聊天框下方的“模型服务设置”分别填写自己的百炼、DeepSeek 或博查 Key。保存仅做格式检查，服务商的有效性、权限与余额在实际调用时判断。
4. 生产环境通过 HTTPS 提供前后端。Key 不保存到浏览器持久存储、不写入 JWT；AES-256-GCM 密文与用户 ID、服务商绑定，只有该账号可操作，管理员没有读取他人 Key 的接口。加密主密钥丢失或被替换后，用户必须重新填写 Key。

设置接口（均需登录，身份来自 JWT，不接受请求体中的用户 ID）：

- `GET /model-settings`：仅返回三个服务的配置状态和 Key 尾号。
- `PUT /model-settings/:provider`：保存/更换 `{ "apiKey": "..." }`，provider 为 `dashscope`、`deepseek` 或 `bocha`。
- `DELETE /model-settings/:provider`：删除当前用户对应 Key。

### 知识库与其他服务费用

RAG 查询向量使用当前用户的百炼 Key，通过请求头传递给本机 Python 服务，不写入共享模型或环境变量。只有 DeepSeek Key 的用户可以聊天，检索会提示需要个人百炼 Key。用户密钥仅允许传到 loopback 地址的 RAG 服务，禁止重定向；配置远程 RAG 地址时检索会被跳过。Python 服务应只绑定本机地址，禁止对公网开放。

索引加载不调用付费模型。没有可用索引或知识库内容发生变化时，需要运维显式向本机 `POST /rag/rebuild`，使用 `X-Dashscope-Api-Key` 请求头提供用于本次构建的百炼 Key，构建费用由该 Key 对应账户承担。用户聊天不会自动触发全库向量化。Python `/rag/retrieve`、`/rag/stream` 也必须提供此请求头；未提供时不会使用任何平台 Key。

联网搜索使用当前用户的博查 Key。未配置时提示用户前往模型服务设置，旧的 `BOCHA_API_KEY` 环境变量不再用于联网搜索。附件存储使用平台 OSS 配置。

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
| `MAIL_TRANSPORT` | `smtp` | `smtp` 发送邮件；非生产环境可显式设置 `json` 生成模拟邮件 |
| `PASSWORD_RESET_URL` | 开发环境 `http://localhost:5173/login` | 前端重置入口；生产必须显式配置 HTTPS URL |
| `MAIL_FROM` | 无 | SMTP 发件人，使用 SMTP 时必填 |
| `SMTP_HOST` | 无 | SMTP 服务器，使用 SMTP 时必填 |
| `SMTP_PORT` / `SMTP_SECURE` | `587` / `false` | 587 使用 STARTTLS；465 配置 `true` 使用隐式 TLS |
| `SMTP_USER` / `SMTP_PASSWORD` | 无 | SMTP 登录凭据，依服务商要求配置 |

## 密码找回与会话撤销

配置参考 [password-reset.env.example](./password-reset.env.example)。开发测试显式设置 `MAIL_TRANSPORT=json` 后，邮件写入后端 `.local-mail/`，打开 JSON 的 `text` 中的链接即可走完整前端流程；该目录已忽略，不应提交或通过静态服务器公开，测试后可删除。生产环境强制 SMTP 和 HTTPS 重置入口，缺少配置时所有有效邮箱请求均返回 503；旧的 `ALLOW_INSECURE_PASSWORD_RESET` 已移除，不再允许直接凭邮箱改密。

申请接口仅接受邮箱；已注册、未注册、发送冷却期内及邮件发送失败均采用相同的 202 响应。每个账户 60 秒内至多创建一次重置申请。SMTP 投递异步执行，失败删除本次凭据并记录不含敏感信息的日志；邮件任务目前未持久化，进程退出导致未投递时需重新申请。生产还应由网关按来源限制请求速率。

重置凭据使用 32 字节密码学随机数，数据库仅存 SHA-256 哈希，15 分钟有效。链接通过 URL fragment 传递 Token，前端读取后立即移除 URL 中的凭据。`POST /auth/reset-password` 接收 `{ token, password }`，在同一 MySQL 事务内锁定用户、消费凭据、改密、递增会话版本并撤销 Refresh Token；并发提交仅一次成功，过期及重复凭据统一拒绝。

首次执行数据库初始化会自动为已有 `users` 表添加 `session_version`（默认 0），并新建 `password_resets` 表，需具备相应建表和 ALTER 权限。所有鉴权读取用户当前角色及会话版本；旧 JWT 未携带版本时按 0 处理，密码重置或密码、邮箱、角色更新后旧凭据失效，删号后旧 Access Token 失效。

回退应先停用密码重置接口并使既有会话失效，再回退应用版本；仅回退代码会丢失会话版本校验，不应恢复旧的直接改密路径。新增表及列可保留，不需为了回退删除数据。

验证：`npm test` 包含 HTTP 边界、模拟邮件、一次性消费、并发、过期、回滚和旧会话失效测试；`node tests/passwordReset.mysql.cjs` 使用当前配置的本机 MySQL 凭据创建独立的随机测试库，验证真实事务与迁移并自动清理，不操作业务库。真实 SMTP 投递需部署配置后联调。SMTP 配置依据 [Nodemailer 官方说明](https://nodemailer.com/smtp)，模拟邮件使用其 [JSON transport](https://nodemailer.com/transports/stream)。

## Refresh Token 轮换与重放检测

Access Token 签发和服务端验证均限制为 15 分钟，旧的 8 小时 Token 也受此限制；Refresh Token 有效期仍为 7 天，每次签发带随机 UUID `jti`。轮换先锁定用户，再锁定旧 Token，在同一事务内检查会话版本和有效期、消费旧 Token、保存新 Token 哈希；插入失败时回滚。密码重置与轮换使用一致的锁顺序，改密或降权后不能通过并发刷新延续旧会话。

同一旧 Token 在轮换后 5 秒内重复提交，返回 `409` 和 `code: refresh_conflict`，不签发凭据也不清 Cookie。前端在支持 Web Locks 时跨同源标签页串行刷新；不支持时对该冲突有限重试，使用浏览器最新 Cookie，不向重复请求返回后继 Token。超过 5 秒仍重放已消费且未过期的 Token，服务端递增用户会话版本并撤销该用户所有 Refresh Token，要求各设备重新登录。该策略优先控制凭据泄露；无 Web Locks 的跨标签页请求若长时间延迟，仍可能需要重新登录。

`/auth/refresh` 的认证失败返回 401 并清理 Cookie；数据库等基础设施故障返回 503，回滚并保留 Cookie，前端不会因此主动清空会话。畸形 Cookie 值被忽略，不影响其他正常 Cookie。轮换保留登录时的 `rememberMe`，未勾选时仍使用会话 Cookie。

数据库初始化会为 `refresh_tokens` 增加 `rotated_at` 和 `remember_me`，不删除历史数据；已有 Token 支持原始值和哈希两种查询方式，历史同值重复行会一起消费。旧记录没有 `rememberMe` 信息，按历史持久 Cookie 行为默认 `true`。启动期间请求等待迁移完成；迁移失败会关闭连接池，允许后续重试。部署需同时更新前后端，以识别新的 409 冲突响应。回退旧后端会失去事务轮换和重放防护，不应仅以回退为由删除新字段。

验证：`npm test` 覆盖 Token 生命周期、随机 `jti`、Cookie 解析和既有功能；`node tests/authRefresh.mysql.cjs` 在随机创建的本机 `cupro_refresh_test_*` 测试库验证旧表迁移、HTTP 并发轮换、插入失败回滚、重放撤销、记住我、改密/降权/删号及旧 Token 兼容，结束后自动删除测试库。

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
