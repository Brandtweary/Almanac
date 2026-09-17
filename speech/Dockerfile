FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
WORKDIR /app
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.lock
COPY server.py prepare.py assets.json ./
ENV HF_HUB_OFFLINE=1 CUDA_VISIBLE_DEVICES=""
EXPOSE 8793
ENTRYPOINT ["python", "server.py", "--assets", "/assets", "--host", "0.0.0.0"]
