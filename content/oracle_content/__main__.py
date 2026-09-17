import os
import uvicorn

uvicorn.run("oracle_content.app:app", host=os.getenv("CONTENT_HOST", "127.0.0.1"),
            port=int(os.getenv("CONTENT_PORT", "8791")), access_log=False)
