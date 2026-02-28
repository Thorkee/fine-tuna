FROM public.ecr.aws/docker/library/python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /opt/program

COPY train-entrypoint.py /opt/program/train-entrypoint.py

ENTRYPOINT ["python", "/opt/program/train-entrypoint.py"]
CMD ["train"]

