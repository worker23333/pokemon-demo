FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY release/pokemon-demo/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
    && groupadd --gid 10001 demo \
    && useradd --uid 10001 --gid demo --no-create-home demo

# Explicit runtime allowlist: no account database, models, credentials,
# development server, unrelated source, or extracted game archive is copied.
COPY server/__init__.py server/combat.py server/content.py server/personality.py /app/server/
COPY demos/gamma-battle/server.py demos/gamma-battle/field.py /app/demos/gamma-battle/
COPY packages/content/species.json packages/content/regions.json packages/content/moves.json packages/content/type-chart.json packages/content/move-mechanics.json /app/packages/content/
COPY release/pokemon-demo/app.py release/pokemon-demo/web_bundle.py /app/release/pokemon-demo/
COPY web/ /app/web/
RUN python /app/release/pokemon-demo/web_bundle.py /app/web

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/gamma/health',timeout=3).read()" || exit 1
CMD ["python", "-m", "uvicorn", "app:create_app", "--factory", "--app-dir", "release/pokemon-demo", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log"]
