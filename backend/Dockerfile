FROM node:24.19.0-bookworm-slim AS dogtags-web
WORKDIR /build
COPY dogtags-manager/frontend/package*.json ./
RUN npm ci --no-fund --no-audit
COPY dogtags-manager/frontend ./
RUN npm run build

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_ROOT_USER_ACTION=ignore

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY --from=dogtags-web /build/dist ./dogtags-web
COPY backend/app ./app
COPY backend/assets ./assets
COPY voice/backend ./carousel
COPY db/migrations ./migrations

RUN mkdir -p /data

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
