import hashlib
import json
import os
from pathlib import Path
from typing import List, Dict, Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from llama_index.core import (
    Settings,
    SimpleDirectoryReader,
    StorageContext,
    VectorStoreIndex,
    load_index_from_storage,
)
from llama_index.core.node_parser import SentenceSplitter
from llama_index.embeddings.dashscope import DashScopeEmbedding
from llama_index.llms.dashscope import DashScope

# BM25 检索器：负责关键词检索
from llama_index.retrievers.bm25 import BM25Retriever

# Rerank：负责对召回结果做二次精排
from llama_index.postprocessor.sbert_rerank import SentenceTransformerRerank


# ===================== 基础路径与环境变量 =====================

BASE_DIR = Path(__file__).resolve().parent

# 先加载当前目录下 .env，再回退到父目录 .env
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR.parent / ".env")

# 索引持久化目录
PERSIST_DIR = Path(os.getenv("RAG_PERSIST_DIR", BASE_DIR / "storage_hybrid"))

# 原始文档目录
DATA_DIR = Path(os.getenv("RAG_DATA_DIR", BASE_DIR.parent / "localResource"))

# 用于记录知识库哈希的文件
HASH_FILE = Path(os.getenv("RAG_HASH_FILE", PERSIST_DIR / "data_hash.txt"))

# LLM 模型名
RAG_MODEL_NAME = os.getenv("RAG_MODEL_NAME", "qwen-plus")

# 向量检索召回数
RAG_VECTOR_TOP_K = int(os.getenv("RAG_VECTOR_TOP_K", "8"))

# BM25 检索召回数
RAG_BM25_TOP_K = int(os.getenv("RAG_BM25_TOP_K", "8"))

# 混合后最终保留多少个节点
RAG_FUSION_TOP_K = int(os.getenv("RAG_FUSION_TOP_K", "10"))

# Rerank 后最终保留多少个节点交给 LLM
RAG_RERANK_TOP_N = int(os.getenv("RAG_RERANK_TOP_N", "4"))

# 文档切块参数
RAG_CHUNK_SIZE = int(os.getenv("RAG_CHUNK_SIZE", "512"))
RAG_CHUNK_OVERLAP = int(os.getenv("RAG_CHUNK_OVERLAP", "50"))

# rerank 模型
RAG_RERANK_MODEL = os.getenv(
    "RAG_RERANK_MODEL",
    "cross-encoder/ms-marco-MiniLM-L-2-v2",
)

app = FastAPI()


# ===================== 请求体定义 =====================

class QueryRequest(BaseModel):
    # 用户问题
    query: str

    # 预留多轮对话历史，当前版本先不使用
    history: list = Field(default_factory=list)


# ===================== RAG 索引管理器 =====================

class RagIndexManager:
    def __init__(self):
        # 向量索引
        self.index = None

        # 混合查询引擎（手动拼装用）
        self.current_hash = ""

    # --------------------- 模型配置 ---------------------
    def configure_models(self):
        """
        配置 LlamaIndex 全局模型：
        1. LLM：负责最终回答生成
        2. Embedding：负责向量化
        3. Text Splitter：负责切块
        """
        dashscope_api_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
        if not dashscope_api_key:
            raise RuntimeError("missing env DASHSCOPE_API_KEY")

        # 配置大模型
        Settings.llm = DashScope(
            model_name=RAG_MODEL_NAME,
            api_key=dashscope_api_key,
            temperature=0.2,  # RAG 场景建议低温度，更稳
        )

        # 配置向量模型
        Settings.embed_model = DashScopeEmbedding(
            api_key=dashscope_api_key
        )

        # 配置文本切块器
        # 中文场景通常不建议强依赖 separator=" "
        # 这里直接用默认 SentenceSplitter 逻辑更稳一点
        Settings.text_splitter = SentenceSplitter(
            chunk_size=RAG_CHUNK_SIZE,
            chunk_overlap=RAG_CHUNK_OVERLAP,
        )

    # --------------------- 数据哈希 ---------------------
    def get_data_hash(self):
        """
        对知识库目录生成哈希。
        这里比你原版更稳一点：加入
        - 文件名
        - 文件大小
        - 修改时间
        用于判断是否需要重建索引
        """
        digest = hashlib.md5()

        if not DATA_DIR.exists():
            return ""

        for root, _, files in os.walk(DATA_DIR):
            for file_name in sorted(files):
                file_path = Path(root) / file_name

                try:
                    stat = file_path.stat()
                    digest.update(file_name.encode("utf-8"))
                    digest.update(str(stat.st_size).encode("utf-8"))
                    digest.update(str(stat.st_mtime).encode("utf-8"))
                except FileNotFoundError:
                    # 某些极端情况下文件正在被替换，跳过即可
                    continue

        return digest.hexdigest()

    # --------------------- 构建或加载索引 ---------------------
    def load_or_build_index(self, force_rebuild=False):
        """
        如果知识库没变化，则直接加载已有索引；
        如果变化了，重新读取文档并构建向量索引。
        """
        self.configure_models()
        self.current_hash = self.get_data_hash()

        # 快路径：哈希一致，直接复用本地索引
        if (
            not force_rebuild
            and PERSIST_DIR.exists()
            and HASH_FILE.exists()
            and HASH_FILE.read_text(encoding="utf-8").strip() == self.current_hash
        ):
            storage_context = StorageContext.from_defaults(
                persist_dir=str(PERSIST_DIR)
            )
            self.index = load_index_from_storage(storage_context)
            return self.index

        # 慢路径：重新构建索引
        documents = SimpleDirectoryReader(
            str(DATA_DIR),
            recursive=True,
            # 可按需继续扩展支持的文件类型
            file_extractor={
                ".pdf": "default",
                ".txt": "default",
                ".md": "default",
            },
        ).load_data()

        self.index = VectorStoreIndex.from_documents(
            documents,
            show_progress=True,
        )

        PERSIST_DIR.mkdir(parents=True, exist_ok=True)
        self.index.storage_context.persist(persist_dir=str(PERSIST_DIR))
        HASH_FILE.write_text(self.current_hash, encoding="utf-8")
        return self.index

    # --------------------- 懒初始化 ---------------------
    def ensure_ready(self):
        """
        确保索引可用。
        """
        if self.index is None:
            self.load_or_build_index()

    # --------------------- 构建混合检索器 ---------------------
    def build_hybrid_retrieval(self, query: str):
        """
        执行 hybrid retrieval：
        1. 向量检索
        2. BM25 检索
        3. 合并结果
        4. 去重
        5. rerank 精排

        返回排好序的节点列表。
        """
        self.ensure_ready()

        # 1) 向量检索器：适合语义相似匹配
        vector_retriever = self.index.as_retriever(
            similarity_top_k=RAG_VECTOR_TOP_K
        )
        vector_nodes = vector_retriever.retrieve(query)

        # 2) BM25 检索器：适合关键词精确命中
        # 从 docstore 里把所有 node 取出来构建 BM25
        all_nodes = list(self.index.docstore.docs.values())
        bm25_retriever = BM25Retriever.from_defaults(
            nodes=all_nodes,
            similarity_top_k=RAG_BM25_TOP_K,
        )
        bm25_nodes = bm25_retriever.retrieve(query)

        # 3) 合并结果
        merged_nodes = []
        merged_nodes.extend(vector_nodes)
        merged_nodes.extend(bm25_nodes)

        # 4) 去重
        # 不同检索器可能召回同一个 node，需要按 node_id 去重
        dedup_map = {}
        for node_with_score in merged_nodes:
            node_id = node_with_score.node.node_id

            # 如果重复，保留分数更高的那个
            if node_id not in dedup_map:
                dedup_map[node_id] = node_with_score
            else:
                old_score = dedup_map[node_id].score or 0
                new_score = node_with_score.score or 0
                if new_score > old_score:
                    dedup_map[node_id] = node_with_score

        dedup_nodes = list(dedup_map.values())

        # 先按原始分数做一次截断，避免 rerank 输入过多
        dedup_nodes.sort(key=lambda x: x.score or 0, reverse=True)
        fusion_nodes = dedup_nodes[:RAG_FUSION_TOP_K]

        # 5) rerank：让 cross-encoder 再做一次精排
        reranker = SentenceTransformerRerank(
            model=RAG_RERANK_MODEL,
            top_n=RAG_RERANK_TOP_N,
        )
        reranked_nodes = reranker.postprocess_nodes(
            fusion_nodes,
            query_str=query,
        )

        return reranked_nodes

    # --------------------- 仅检索接口 ---------------------
    def retrieve(self, query: str):
        """
        只返回检索结果和上下文，不直接让 LLM 生成。
        适合给 Node 层或别的服务做二次编排。
        """
        nodes = self.build_hybrid_retrieval(query)

        context_parts = []
        source_nodes = []

        for idx, node_with_score in enumerate(nodes, start=1):
            text = node_with_score.node.get_content().strip()
            if not text:
                continue

            metadata = node_with_score.node.metadata or {}
            file_name = metadata.get("file_name") or metadata.get("file_path") or "unknown"

            context_parts.append(f"{idx}. {text}")
            source_nodes.append(
                {
                    "rank": idx,
                    "score": node_with_score.score,
                    "fileName": file_name,
                    "textPreview": text[:200],
                }
            )

        return {
            "mode": "local_rag_hybrid",
            "contextText": "\n\n".join(context_parts),
            "meta": {
                "vectorTopK": RAG_VECTOR_TOP_K,
                "bm25TopK": RAG_BM25_TOP_K,
                "fusionTopK": RAG_FUSION_TOP_K,
                "rerankTopN": RAG_RERANK_TOP_N,
                "nodeCount": len(nodes),
            },
            "sources": source_nodes,
        }

    # --------------------- 生成 prompt ---------------------
    def build_prompt(self, query: str, context_text: str):
        """
        手动拼接 RAG prompt。
        由于这版用了自定义 hybrid + rerank，
        所以这里直接把检索后的上下文塞给 LLM 生成答案。
        """
        return f"""你是一个基于本地知识库回答问题的助手。
        请严格基于下面提供的上下文回答问题。
        如果上下文不足以回答，请明确说“我无法从提供的知识库中确认答案”，不要编造。

        【上下文】
        {context_text}

        【用户问题】
        {query}

        【回答要求】
        1. 优先依据上下文回答
        2. 语言简洁清晰
        3. 不要编造上下文中没有的信息
        """

    # --------------------- 流式回答 ---------------------
    def stream_answer(self, query: str):
        """
        执行：
        hybrid retrieval -> rerank -> prompt 拼接 -> LLM 流式生成
        """
        result = self.retrieve(query)
        context_text = result["contextText"]
        prompt = self.build_prompt(query, context_text)

        # 直接走 LLM 的流式补全
        return Settings.llm.stream_complete(prompt), result

    # --------------------- 健康信息 ---------------------
    def get_health(self):
        return {
            "status": "ok",
            "indexLoaded": self.index is not None,
            "dataDir": str(DATA_DIR),
            "persistDir": str(PERSIST_DIR),
            "hash": self.current_hash,
            "model": RAG_MODEL_NAME,
            "vectorTopK": RAG_VECTOR_TOP_K,
            "bm25TopK": RAG_BM25_TOP_K,
            "fusionTopK": RAG_FUSION_TOP_K,
            "rerankTopN": RAG_RERANK_TOP_N,
        }


manager = RagIndexManager()


# ===================== 应用启动 =====================

@app.on_event("startup")
async def startup_event():
    """
    服务启动时提前加载或构建索引，
    避免第一次请求特别慢。
    """
    manager.load_or_build_index()


# ===================== 接口：仅检索 =====================

@app.post("/rag/retrieve")
async def rag_retrieve(req: QueryRequest):
    """
    仅返回检索结果，不生成最终答案。
    """
    return manager.retrieve(req.query)


# ===================== 接口：流式回答 =====================

@app.post("/rag/stream")
async def rag_stream(req: QueryRequest):
    """
    SSE 流式输出回答。
    返回格式示例：
    data: {"chunk":"你好"}
    data: {"chunk":"世界"}
    data: {"done":true}
    """
    async def generate():
        try:
            stream_resp, retrieval_result = manager.stream_answer(req.query)

            # 先把 sources 发给前端，方便调试和展示
            yield f"data: {json.dumps({'sources': retrieval_result['sources']}, ensure_ascii=False)}\n\n"

            # 再持续发送回答 token / chunk
            for chunk in stream_resp:
                delta = getattr(chunk, "delta", None)
                text = delta or getattr(chunk, "text", None) or ""
                if text:
                    yield f"data: {json.dumps({'chunk': text}, ensure_ascii=False)}\n\n"

            yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"

        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ===================== 接口：强制重建索引 =====================

@app.post("/rag/rebuild")
async def rebuild_index():
    """
    强制重建索引。
    适合知识库更新后手动调用。
    """
    manager.load_or_build_index(force_rebuild=True)
    return {
        "status": "rebuilt",
        "hash": manager.current_hash,
        "dataDir": str(DATA_DIR),
    }


# ===================== 接口：健康检查 =====================

@app.get("/health")
async def health():
    """
    健康检查接口。
    """
    return manager.get_health()