from fastapi import FastAPI
from pydantic import BaseModel
import ollama

MODEL_NAME = "jina-v3"

app = FastAPI()

class EmbedRequest(BaseModel):
    input: str | list[str]
    task: str = "retrieval.query"

@app.post("/v1/embeddings")
async def embeddings(req: EmbedRequest):
    try:
        texts = [req.input] if isinstance(req.input, str) else req.input
        
        results = []
        for text in texts:
            # We use ollama's embedding API
            # Note: Ollama's Jina v3 GGUF handles the task internally if correctly tagged,
            # but usually it's just a BERT-like embedding.
            res = ollama.embeddings(model=MODEL_NAME, prompt=text)
            results.append(res['embedding'])
            
        return {
            "data": [{"embedding": emb} for emb in results],
            "model": MODEL_NAME,
            "task": req.task
        }
    except Exception as e:
        print(f"Error during embedding: {e}")
        return {"error": str(e)}

if __name__ == "__main__":
    import uvicorn
    # Port 8000 matches what test.js and server.js expect
    uvicorn.run(app, host="0.0.0.0", port=8000)
