FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_PROJECT_ENVIRONMENT=/opt/venv PATH=/opt/venv/bin:$PATH
RUN pip install --no-cache-dir uv==0.13.0
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/ ./
COPY contracts/ /app/contracts/
COPY bootstrap.py runtime_secrets.py ./
RUN useradd --uid 10001 --create-home dogtags && mkdir -p /data /scratch && chown dogtags:dogtags /data /scratch
USER dogtags
ENTRYPOINT ["python", "/app/backend/runtime_secrets.py", "run"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
