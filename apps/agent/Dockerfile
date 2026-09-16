FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
COPY talk_agent ./talk_agent
COPY prompts ./prompts
RUN pip install --no-cache-dir . && python -c "from livekit.plugins import silero; silero.VAD.load()"
ENV TALK_SYSTEM_PROMPT_FILE=/app/prompts/system.ja.md
CMD ["talk-agent", "start"]
