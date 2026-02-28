FROM public.ecr.aws/docker/library/python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /opt/program

RUN pip install --no-cache-dir \
    wandb>=0.18 \
    transformers>=4.45 \
    torch>=2.2 \
    accelerate>=0.34 \
    peft>=0.13 \
    bitsandbytes>=0.44 \
    datasets>=3.0 \
    huggingface_hub>=0.24 \
    sentencepiece>=0.2 \
    safetensors>=0.4 \
    scikit-learn>=1.5 \
    scipy>=1.14 \
    tokenizers>=0.20

COPY train-entrypoint.py /opt/program/train-entrypoint.py

ENTRYPOINT ["python", "/opt/program/train-entrypoint.py"]
CMD ["train"]
