"""TalkPlatform AI voice agent.

Room metadata (Worker が書く JSON) を真実源として動く:
  {"talk": true, "call_session_id": ..., "booking_id": ..., "mode": "ai"|"human_requested"|"human",
   "customer_name": ..., "staff_name": ..., "menu_name": ..., "language": "ja"}

モード:
  ai              STT → Grok → TTS で応対。ツール transfer_to_human で引き継ぎ要請。
  human_requested 「担当者におつなぎします」と案内し、以降は発話しない (聞き役)。
  human           オペレーターが応対。エージェントは顧客音声の文字起こしのみ継続し、発話しない。

切替は Worker が RoomMetadata を更新 → RoomMetadataChanged で追従する。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    ConversationItemAddedEvent,
    JobContext,
    JobProcess,
    RoomInputOptions,
    RunContext,
    StopResponse,
    TurnHandlingOptions,
    WorkerOptions,
    cli as lk_cli,
    function_tool,
    llm,
)
from livekit.agents.voice.turn import EndpointingOptions, InterruptionOptions
from livekit.agents import mcp as lk_mcp
from livekit.plugins import openai, silero, xai

from .config import Config
from .worker_client import WorkerClient

load_dotenv()
log = logging.getLogger("talk-agent")

AGENT_IDENTITY = "agent"
HANDOFF_ANNOUNCE = "かしこまりました。担当者におつなぎしますので、そのままお待ちください。"
RESUME_ANNOUNCE = "お待たせしました。引き続き AI アシスタントが承ります。"


def parse_meta(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        m = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return m if isinstance(m, dict) and m.get("talk") is True else None


class TalkAgent(Agent):
    """mode に応じて応答するかどうかを切り替える単一エージェント。"""

    def __init__(
        self,
        cfg: Config,
        meta: dict[str, Any],
        worker: WorkerClient,
        mcp_servers: "list[lk_mcp.MCPServer] | None" = None,
    ) -> None:
        ctx_lines = [cfg.system_prompt, "", "## この通話の情報"]
        if meta.get("customer_name"):
            ctx_lines.append(f"- お客様の名前: {meta['customer_name']}")
        if meta.get("menu_name"):
            ctx_lines.append(f"- 予約メニュー: {meta['menu_name']}")
        if meta.get("staff_name"):
            ctx_lines.append(f"- 担当者: {meta['staff_name']}")
        super().__init__(instructions="\n".join(ctx_lines), mcp_servers=mcp_servers or None)
        self.cfg = cfg
        self.worker = worker
        self.mode: str = meta.get("mode", "ai")

    # --- モード制御 ---------------------------------------------------------
    async def apply_mode(self, new_mode: str, session: AgentSession) -> None:
        old, self.mode = self.mode, new_mode
        if old == new_mode:
            return
        log.info("mode %s -> %s", old, new_mode)
        if new_mode == "human_requested":
            # AI が自分で要請したときは既に案内済み。オペレーター/顧客起点の場合のみ案内。
            if old == "ai" and not getattr(self, "_announced_handoff", False):
                await session.say(HANDOFF_ANNOUNCE, allow_interruptions=False)
            self._announced_handoff = False
        elif new_mode == "human":
            session.interrupt()
            session.output.set_audio_enabled(False)
        elif new_mode == "ai":
            session.output.set_audio_enabled(True)
            await session.say(RESUME_ANNOUNCE, allow_interruptions=True)

    async def on_user_turn_completed(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage) -> None:
        # 文字起こしは ConversationItemAdded で拾う。人間応対中は LLM を呼ばない。
        if self.mode != "ai":
            raise StopResponse()

    # --- ツール -------------------------------------------------------------
    @function_tool(description="お客様を人間の担当者に引き継ぐ。お客様が人との会話を求めた場合や、AI が対応すべきでない内容のときに必ず呼ぶ。")
    async def transfer_to_human(self, ctx: RunContext, reason: str) -> str:
        """reason: 引き継ぐ理由 (担当者に表示される短い日本語)。"""
        log.info("transfer_to_human: %s", reason)
        self._announced_handoff = True
        ok = await self.worker.handoff_request(reason, by="agent")
        # Worker が metadata を更新 → apply_mode が走る。Worker 不在 (Lab) でもローカルで遷移させる。
        if not ok:
            await self.apply_mode("human_requested", ctx.session)
        return "担当者へ引き継ぎを要請しました。お客様に「担当者におつなぎしますので、そのままお待ちください」と伝えて、それ以上の説明はしないでください。"


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext) -> None:
    cfg = Config.load()
    await ctx.connect()
    room = ctx.room

    meta = parse_meta(room.metadata)
    if meta is None:
        if cfg.allow_lab_rooms and room.name.startswith("lab-"):
            meta = {"talk": True, "mode": "ai", "customer_name": None, "staff_name": "担当者", "menu_name": "検証"}
        else:
            log.info("room %s has no talk metadata; leaving", room.name)
            ctx.shutdown(reason="not a talk room")
            return

    worker = WorkerClient(cfg.worker_url, cfg.agent_secret, room.name)
    await worker.start()

    # コンポーネント層: 占い AI (spiritualMCP) を別サービス・別組織として MCP 経由で使う。
    # 接続先とキーは環境変数 (組織 = TalkPlatform としての Bearer キー)。LLM はセッション中
    # に必要なツール (create_chart / get_reading 等) を自律的に呼ぶ。
    mcp_servers: list[lk_mcp.MCPServer] = []
    if cfg.mcp_url:
        mcp_servers.append(
            lk_mcp.MCPServerHTTP(
                cfg.mcp_url,
                headers={"Authorization": f"Bearer {cfg.mcp_token}"} if cfg.mcp_token else None,
                allowed_tools=cfg.mcp_tools or None,
                client_session_timeout_seconds=15,
            )
        )
        log.info("fortune MCP enabled: %s (tools=%s)", cfg.mcp_url, cfg.mcp_tools or "all")

    agent = TalkAgent(cfg, meta, worker, mcp_servers=mcp_servers)

    # セルフホスト方針: LiveKit Cloud の推論 (adaptive interruption / cloud turn detector) に
    # 接続しないよう、ターン検出・割り込み検知はローカル VAD に明示固定する。
    # (1.7 系は未指定だと agent-gateway.livekit.cloud へ接続を試みる)
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=xai.STT(language=cfg.language, enable_interim_results=True),
        llm=openai.LLM.with_x_ai(model=cfg.llm_model),
        tts=xai.TTS(voice=cfg.tts_voice, language=cfg.language),
        turn_handling=TurnHandlingOptions(
            turn_detection="vad",
            interruption=InterruptionOptions(enabled=True, mode="vad", min_duration=0.5, min_words=0),
            endpointing=EndpointingOptions(min_delay=0.4),
        ),
    )

    # ---- 文字起こし → Worker ----
    @session.on("conversation_item_added")
    def _on_item(ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        text = getattr(item, "text_content", None) or ""
        role = {"user": "customer", "assistant": "assistant"}.get(getattr(item, "role", ""), "system")
        worker.add_transcript(role, text)

    # ---- モード追従 (Worker が RoomMetadata を更新) ----
    @room.on("room_metadata_changed")
    def _on_meta(old: str, new: str) -> None:
        m = parse_meta(new)
        if m and m.get("mode"):
            asyncio.create_task(agent.apply_mode(m["mode"], session))

    # ---- 顧客が去ったら終了処理 (要約) ----
    async def finalize() -> None:
        try:
            history = session.history.items if hasattr(session, "history") else []
            lines = []
            for it in history:
                t = getattr(it, "text_content", None)
                r = getattr(it, "role", "")
                if t and r in ("user", "assistant"):
                    lines.append(f"{'お客様' if r == 'user' else 'AI'}: {t}")
            if lines:
                summ_llm = openai.LLM.with_x_ai(model=cfg.llm_model)
                chat = llm.ChatContext()
                chat.add_message(role="system", content="次の通話ログを、担当者向けに日本語で 3〜5 行に要約してください。用件・結論・未解決事項・次のアクションを含めること。")
                chat.add_message(role="user", content="\n".join(lines)[-12000:])
                out = []
                async with summ_llm.chat(chat_ctx=chat) as stream:
                    async for chunk in stream:
                        c = getattr(chunk, "delta", None)
                        if c and getattr(c, "content", None):
                            out.append(c.content)
                if out:
                    await worker.summary("".join(out))
        except Exception as e:  # noqa: BLE001
            log.warning("summary failed: %s", e)
        finally:
            await worker.close()

    ctx.add_shutdown_callback(finalize)

    @room.on("participant_disconnected")
    def _on_leave(p: rtc.RemoteParticipant) -> None:
        if p.identity.startswith("customer:"):
            log.info("customer left; shutting down")
            ctx.shutdown(reason="customer left")

    # 顧客の音声だけを入力にする (オペレーターの声に AI が反応しないように)。
    customer = next((p for p in room.remote_participants.values() if p.identity.startswith("customer:")), None)
    input_opts = RoomInputOptions(participant_identity=customer.identity if customer else None)

    await session.start(agent, room=room, room_input_options=input_opts)

    if agent.mode == "ai":
        await session.say(cfg.opening_text, allow_interruptions=True)
    elif agent.mode == "human":
        session.output.set_audio_enabled(False)


def cli() -> None:
    lk_cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            agent_name=os.environ.get("TALK_AGENT_NAME", ""),  # 空 = 全 room に自動ディスパッチ (metadata でゲート)
        )
    )


if __name__ == "__main__":
    cli()
