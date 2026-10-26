"""Exercise real LlamaIndex index/retriever boundaries without paid API calls."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from llama_index.core.embeddings import MockEmbedding
from rag_service import main as rag


class RagCredentialTests(unittest.TestCase):
    def test_index_ingestion_is_explicit_and_queries_use_request_credentials(self):
        calls = []

        class RequestEmbedding(MockEmbedding):
            def _get_query_embedding(self, query):
                calls.append(self.model_name)
                return super()._get_query_embedding(query)

        class NoRerank:
            def __init__(self, **kwargs):
                pass

            def postprocess_nodes(self, nodes, **kwargs):
                return nodes

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            (data / "copper.txt").write_text("Copper C11000 is a copper grade.", encoding="utf-8")
            storage = root / "storage"
            with (
                patch.object(rag, "DATA_DIR", data),
                patch.object(rag, "PERSIST_DIR", storage),
                patch.object(rag, "HASH_FILE", storage / "data_hash.txt"),
                patch.object(rag, "DashScopeEmbedding", side_effect=lambda api_key: RequestEmbedding(embed_dim=1536, model_name=api_key)),
                patch.object(rag, "SentenceTransformerRerank", NoRerank),
                patch.object(rag.BM25Retriever, "from_defaults") as bm25,
                patch.dict(os.environ, {"DASHSCOPE_API_KEY": "platform-key-must-not-be-used"}),
            ):
                bm25.return_value.retrieve.return_value = []
                manager = rag.RagIndexManager()
                with self.assertRaisesRegex(RuntimeError, "显式构建"):
                    manager.load_or_build_index()
                manager.load_or_build_index(force_rebuild=True, api_key="sk-ingestion-owner")
                self.assertNotEqual(manager.index._embed_model.model_name, "sk-ingestion-owner")
                for key in ("sk-query-user-one", "sk-query-user-two"):
                    self.assertIn("C11000", manager.retrieve("copper", key)["contextText"])
                self.assertEqual(calls, ["sk-query-user-one", "sk-query-user-two"])
                for file in storage.iterdir():
                    self.assertNotIn(b"sk-ingestion-owner", file.read_bytes())
                loaded = rag.RagIndexManager()
                loaded.load_or_build_index()
                self.assertIsNotNone(loaded.index)

    def test_retrieval_header_is_required_and_upstream_errors_are_sanitized(self):
        client = TestClient(rag.app)
        self.assertEqual(client.post("/rag/retrieve", json={"query": "copper"}).status_code, 422)
        with patch.object(rag.manager, "retrieve", return_value={"contextText": "C11000"}) as retrieve:
            response = client.post("/rag/retrieve", json={"query": "copper"}, headers={"X-Dashscope-Api-Key": "sk-current-user"})
            self.assertEqual(response.status_code, 200)
            retrieve.assert_called_once_with("copper", "sk-current-user")
        with patch.object(rag.manager, "retrieve", side_effect=RuntimeError("sk-secret-echo")):
            response = client.post("/rag/retrieve", json={"query": "copper"}, headers={"X-Dashscope-Api-Key": "sk-current-user"})
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("sk-secret-echo", response.text)


if __name__ == "__main__":
    unittest.main()
