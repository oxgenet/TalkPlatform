import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

from talk_agent.config import Config
from talk_agent.main import TalkAgent, parse_meta
from talk_agent.worker_client import WorkerClient


def cfg() -> Config:
    return Config(
        worker_url="", agent_secret="", llm_model="grok-4-fast", tts_voice="ara", language="ja",
        system_prompt="sys", opening_text="open", allow_lab_rooms=False,
        mcp_url="", mcp_token="", mcp_tools=[],
    )


def test_parse_meta_requires_talk_flag():
    assert parse_meta(None) is None
    assert parse_meta("not json") is None
    assert parse_meta(json.dumps({"mode": "ai"})) is None
    m = parse_meta(json.dumps({"talk": True, "mode": "human", "booking_id": "b1"}))
    assert m and m["mode"] == "human"


def test_agent_instructions_include_call_context():
    a = TalkAgent(cfg(), {"talk": True, "mode": "ai", "customer_name": "山田", "menu_name": "相談", "staff_name": "佐藤"}, WorkerClient("", "", "r"))
    assert "山田" in a.instructions and "相談" in a.instructions and "佐藤" in a.instructions
    assert a.mode == "ai"


def test_apply_mode_transitions():
    a = TalkAgent(cfg(), {"talk": True, "mode": "ai"}, WorkerClient("", "", "r"))
    session = MagicMock()
    session.say = AsyncMock()
    session.interrupt = MagicMock()
    session.output.set_audio_enabled = MagicMock()

    asyncio.run(a.apply_mode("human_requested", session))
    session.say.assert_awaited()  # 案内
    asyncio.run(a.apply_mode("human", session))
    session.interrupt.assert_called_once()
    session.output.set_audio_enabled.assert_called_with(False)
    asyncio.run(a.apply_mode("ai", session))
    session.output.set_audio_enabled.assert_called_with(True)
    assert a.mode == "ai"


def test_transcript_buffer_sequence():
    w = WorkerClient("", "", "r")
    w.add_transcript("customer", "a")
    w.add_transcript("assistant", "")  # 空は捨てる
    w.add_transcript("assistant", "b")
    assert [x["seq"] for x in w._buf] == [1, 2]
    assert w.enabled is False
