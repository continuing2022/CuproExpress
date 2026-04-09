import hashlib
import json
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
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
from pydantic import BaseModel
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
# 先加载 rag_service 本地 .env，再回退到后端目录 .env。
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR.parent / ".env")
PERSIST_DIR = Path(os.getenv("RAG_PERSIST_DIR", BASE_DIR / "storage"))
DATA_DIR = Path(os.getenv("RAG_DATA_DIR", BASE_DIR.parent / "localResource"))
HASH_FILE = Path(os.getenv("RAG_HASH_FILE", PERSIST_DIR / "data_hash.txt"))
RAG_MODEL_NAME = os.getenv("RAG_MODEL_NAME", "qwen-plus")
RAG_TOP_K = int(os.getenv("RAG_TOP_K", "3"))
RAG_CHUNK_SIZE = int(os.getenv("RAG_CHUNK_SIZE", "512"))
RAG_CHUNK_OVERLAP = int(os.getenv("RAG_CHUNK_OVERLAP", "50"))

app = FastAPI()


class QueryRequest(BaseModel):
    query: str
    history: list = []


class RagIndexManager:
    def __init__(self):
        self.index = None
        self.query_engine = None
        self.current_hash = ""

    def configure_models(self):
        dashscope_api_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
        if not dashscope_api_key:
            raise RuntimeError("missing env DASHSCOPE_API_KEY")

        Settings.llm = DashScope(model_name=RAG_MODEL_NAME, api_key=dashscope_api_key)
        Settings.embed_model = DashScopeEmbedding(api_key=dashscope_api_key)
        Settings.text_splitter = SentenceSplitter(
            chunk_size=RAG_CHUNK_SIZE,
            chunk_overlap=RAG_CHUNK_OVERLAP,
            separator=" ",
        )

    def get_data_hash(self):
        # 基于文件名 + mtime 生成哈希，用于判断是否需要重建索引。
        digest = hashlib.md5()
        if not DATA_DIR.exists():
            return ""

        for root, _, files in os.walk(DATA_DIR):
            for file_name in sorted(files):
                file_path = Path(root) / file_name
                digest.update(file_name.encode("utf-8"))
                digest.update(str(file_path.stat().st_mtime).encode("utf-8"))
        return digest.hexdigest()

    def load_or_build_index(self, force_rebuild=False):
        self.configure_models()
        self.current_hash = self.get_data_hash()

        # 快路径：源数据哈希未变化时，直接复用持久化索引。
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
        else:
            # 慢路径：从源文件重新构建向量索引。
            documents = SimpleDirectoryReader(
                str(DATA_DIR),
                recursive=True,
                file_extractor={".pdf": "default", ".txt": "default"},
            ).load_data()

            self.index = VectorStoreIndex.from_documents(documents, show_progress=True)
            PERSIST_DIR.mkdir(parents=True, exist_ok=True)
            self.index.storage_context.persist(persist_dir=str(PERSIST_DIR))
            HASH_FILE.write_text(self.current_hash, encoding="utf-8")

        self.query_engine = self.index.as_query_engine(
            streaming=True,
            similarity_top_k=RAG_TOP_K,
            response_mode="compact",
        )
        return self.index

    def ensure_ready(self):
        if self.index is None or self.query_engine is None:
            self.load_or_build_index()

    def retrieve(self, query: str):
        # 轻量检索接口：供 Node 编排层获取上下文。
        self.ensure_ready()
        retriever = self.index.as_retriever(similarity_top_k=RAG_TOP_K)
        nodes = retriever.retrieve(query)
        context_parts = []
        for idx, node in enumerate(nodes, start=1):
            text = node.text.strip()
            if not text:
                continue
            context_parts.append(f"{idx}. {text}")

        return {
            "mode": "local_rag",
            "contextText": "\n\n".join(context_parts),
            "meta": {
                "topK": RAG_TOP_K,
                "nodeCount": len(nodes),
            },
        }

    def stream_answer(self, query: str):
        # 流式生成接口：Python 侧直接负责生成时使用。
        self.ensure_ready()
        return self.query_engine.query(query)


manager = RagIndexManager()


@app.on_event("startup")
async def startup_event():
    manager.load_or_build_index()


@app.post("/rag/retrieve")
async def rag_retrieve(req: QueryRequest):
    return manager.retrieve(req.query)


@app.post("/rag/stream")
async def rag_stream(req: QueryRequest):
    async def generate():
        try:
            response = manager.stream_answer(req.query)
            for chunk in response.response_gen:
                if chunk:
                    yield f"data: {json.dumps({'chunk': chunk}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/rag/rebuild")
async def rebuild_index():
    manager.load_or_build_index(force_rebuild=True)
    return {
        "status": "rebuilt",
        "hash": manager.current_hash,
        "dataDir": str(DATA_DIR),
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "indexLoaded": manager.index is not None,
        "dataDir": str(DATA_DIR),
        "persistDir": str(PERSIST_DIR),
        "hash": manager.current_hash,
        "model": RAG_MODEL_NAME,
    }
