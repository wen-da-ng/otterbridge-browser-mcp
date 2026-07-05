"""Example MCP client: a LangGraph agent loop for OtterBridge.

NOTE: This is only ONE example client. The OtterBridge MCP server
(server/server.py) is a standard streamable-HTTP MCP endpoint, so any MCP
client can attach — Claude Code, Claude Cowork, MCP Inspector, or a
LangGraph/Ollama loop like this one. Building this out is deferred until the
extension + server are verified end-to-end.

Part of the Otter browser-agent project. Author: wen-da-ng (OtterBridge).

Model choice is intentionally left as a placeholder — pick any provider
(Anthropic, OpenAI, a local Ollama model, etc.) when wiring this up.
Set the relevant API key in the environment first.
"""
import asyncio

from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver

SYSTEM_PROMPT = """You are a browser automation agent controlling the
user's real Chrome browser through tools.

Workflow for each step:
1. Use read_page / read_elements to understand the current page.
2. Decide ONE next action (navigate, click, type_text, press_key, scroll).
3. To click something, first call read_elements, find the target element,
   then call click with its x/y coordinates. To type into a field, click it
   first to focus it, then call type_text.
4. After acting, re-read the page to verify the result before continuing.

Rules:
- Never submit forms, make purchases, send messages, or delete anything
  without explicit approval.
- If a page looks like a login wall or CAPTCHA, stop and report it.
- Prefer few, deliberate actions over many speculative ones.
- Pace yourself like a human: read before acting, don't fire actions
  back-to-back at machine speed.
"""

# Placeholder — replace with a valid model id for your chosen provider.
MODEL = "anthropic:claude-sonnet-5"


async def main():
    client = MultiServerMCPClient({
        "otterbridge": {
            "transport": "streamable_http",
            "url": "http://localhost:8000/mcp",
        }
    })
    tools = await client.get_tools()

    agent = create_react_agent(
        MODEL,
        tools,
        prompt=SYSTEM_PROMPT,
        checkpointer=MemorySaver(),   # enables interrupts / resumability
    )

    config = {"configurable": {"thread_id": "session-1"}}
    task = input("Task: ")
    result = await agent.ainvoke(
        {"messages": [("user", task)]},
        config=config,
    )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
