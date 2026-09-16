import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    worker_url: str
    agent_secret: str
    llm_model: str
    tts_voice: str
    language: str
    system_prompt: str
    opening_text: str
    allow_lab_rooms: bool
    mcp_url: str          # 占い MCP (spiritualMCP 等) の SSE URL。空 = 無効
    mcp_token: str        # 組織別 Bearer キー (SPIRITUAL_MCP_ORG_KEYS に対応)
    mcp_tools: list[str]  # 許可ツール名。空 = 全許可

    @staticmethod
    def load() -> "Config":
        prompt_file = os.environ.get("TALK_SYSTEM_PROMPT_FILE", "./prompts/system.ja.md")
        p = Path(prompt_file)
        system_prompt = p.read_text(encoding="utf-8") if p.exists() else "あなたは電話相談の AI アシスタントです。日本語で簡潔に応対してください。"
        return Config(
            worker_url=os.environ.get("TALK_WORKER_URL", "").rstrip("/"),
            agent_secret=os.environ.get("CALL_AGENT_SECRET", ""),
            llm_model=os.environ.get("TALK_LLM_MODEL", "grok-4-fast-non-reasoning"),
            tts_voice=os.environ.get("TALK_TTS_VOICE", "ara"),
            language=os.environ.get("TALK_LANGUAGE", "ja"),
            system_prompt=system_prompt,
            opening_text=os.environ.get(
                "TALK_OPENING_TEXT",
                "お電話ありがとうございます。こちらは AI アシスタントです。通話は品質向上のため録音されます。"
                "担当者におつなぎすることもできますので、お気軽にお申し付けください。ご用件をどうぞ。",
            ),
            allow_lab_rooms=os.environ.get("TALK_ALLOW_LAB_ROOMS", "false").lower() in ("1", "true", "yes"),
            mcp_url=os.environ.get("TALK_MCP_URL", "").strip(),
            mcp_token=os.environ.get("TALK_MCP_TOKEN", "").strip(),
            mcp_tools=[t.strip() for t in os.environ.get("TALK_MCP_TOOLS", "").split(",") if t.strip()],
        )
