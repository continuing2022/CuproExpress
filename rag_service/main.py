from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from llama_index.core import (
    VectorStoreIndex, 
    SimpleDirectoryReader,
    StorageContext,
    load_index_from_storage,
    Settings
)
from llama_index.llms.dashscope import DashScope
from llama_index.embeddings.dashscope import DashScopeEmbedding
from llama_index.core.node_parser import SentenceSplitter
import json
import os
import hashlib

app = FastAPI()
DASHSCOPE_API_KEY = "sk-603a4b09de73429c9c0f18c677622d83"
Settings.llm = DashScope(
    model_name="qwen-plus",
    api_key=DASHSCOPE_API_KEY
)
Settings.embed_model = DashScopeEmbedding(
    api_key=DASHSCOPE_API_KEY
)
# 中文友好的分块策略
Settings.text_splitter = SentenceSplitter(
    chunk_size=512,
    chunk_overlap=50,
    separator="。",          # 按中文句号切分
)

PERSIST_DIR = "./storage"    # 向量持久化目录
DATA_DIR    = "../localResource"
HASH_FILE   = "./storage/data_hash.txt"

def get_data_hash():
    """计算 localResource 文件夹的内容哈希，用于判断是否需要重建索引"""
    h = hashlib.md5()
    for root, _, files in os.walk(DATA_DIR):
        for f in sorted(files):
            path = os.path.join(root, f)
            h.update(f.encode())
            h.update(str(os.path.getmtime(path)).encode())
    return h.hexdigest()

def load_or_build_index():
    current_hash = get_data_hash()
    
    # 检查是否已有持久化索引且数据未变化
    if os.path.exists(PERSIST_DIR) and os.path.exists(HASH_FILE):
        with open(HASH_FILE, "r") as f:
            saved_hash = f.read().strip()
        
        if saved_hash == current_hash:
            print("✅ 加载已有向量索引...")
            storage_context = StorageContext.from_defaults(persist_dir=PERSIST_DIR)
            return load_index_from_storage(storage_context)
    
    # 重新构建索引
    print("📚 检测到数据变化，重新构建向量索引...")
    documents = SimpleDirectoryReader(
        DATA_DIR,
        recursive=True,
        # 中文PDF解析配置
        file_extractor={
            ".pdf": "default",
            ".txt": "default",
        }
    ).load_data()
    
    print(f"📄 共加载 {len(documents)} 个文档块")
    
    index = VectorStoreIndex.from_documents(
        documents,
        show_progress=True,
    )
    
    # 持久化保存
    os.makedirs(PERSIST_DIR, exist_ok=True)
    index.storage_context.persist(persist_dir=PERSIST_DIR)
    with open(HASH_FILE, "w") as f:
        f.write(current_hash)
    
    print("💾 向量索引已持久化保存")
    return index

# 启动时加载索引
index = load_or_build_index()
query_engine = index.as_query_engine(
    streaming=True,
    similarity_top_k=3,
    response_mode="compact",
)

class QueryRequest(BaseModel):
    query: str
    history: list = []

@app.post("/rag/stream")
async def rag_stream(req: QueryRequest):
    async def generate():
        try:
            response = query_engine.query(req.query)
            for chunk in response.response_gen:
                if chunk:
                    yield f"data: {json.dumps({'chunk': chunk}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")

# 手动触发重建索引（新增文件后调用）
@app.post("/rag/rebuild")
async def rebuild_index():
    global index, query_engine
    index = load_or_build_index()
    query_engine = index.as_query_engine(streaming=True, similarity_top_k=3)
    return {"status": "rebuilt"}

@app.get("/health")
async def health():
    return {"status": "ok"}