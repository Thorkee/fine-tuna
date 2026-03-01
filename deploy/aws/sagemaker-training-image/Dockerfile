FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip curl && \
    ln -sf /usr/bin/python3.11 /usr/local/bin/python && \
    ln -sf /usr/bin/python3.11 /usr/local/bin/python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/program

RUN pip install --no-cache-dir \
    torch>=2.2 --index-url https://download.pytorch.org/whl/cu124 && \
    pip install --no-cache-dir \
    wandb>=0.18 \
    transformers>=4.45 \
    accelerate>=0.34 \
    peft>=0.13 \
    bitsandbytes>=0.44 \
    datasets>=3.0 \
    huggingface_hub>=0.24 \
    sentencepiece>=0.2 \
    safetensors>=0.4 \
    scikit-learn>=1.5 \
    scipy>=1.14 \
    tokenizers>=0.20 \
    pandas \
    numpy

COPY train-entrypoint.py /opt/program/train-entrypoint.py

ENTRYPOINT ["python", "/opt/program/train-entrypoint.py"]
CMD ["train"]
