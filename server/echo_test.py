"""Phase 1 bridge verification — a dummy WebSocket server.

Stands in for the full MCP server so you can confirm the extension:
  1. connects to ws://localhost:8765,
  2. round-trips a command (we send `ping`, expect a `pong`),
  3. auto-reconnects (reload the extension and watch it re-attach).

Run:  python server/echo_test.py
Then load the unpacked extension and watch this console.
"""
import asyncio
import json
import uuid

import websockets


async def handler(ws):
    print("[echo] extension connected")
    pending: dict[str, asyncio.Future] = {}

    async def send_ping():
        while True:
            await asyncio.sleep(3)
            cmd_id = str(uuid.uuid4())
            fut = asyncio.get_event_loop().create_future()
            pending[cmd_id] = fut
            await ws.send(json.dumps({"id": cmd_id, "action": "ping", "params": {}}))
            try:
                resp = await asyncio.wait_for(fut, timeout=5)
                print(f"[echo] round-trip OK  ->  {resp.get('result')}")
            except asyncio.TimeoutError:
                print("[echo] ping timed out")

    pinger = asyncio.create_task(send_ping())
    try:
        async for msg in ws:
            data = json.loads(msg)
            fut = pending.pop(data.get("id"), None)
            if fut and not fut.done():
                fut.set_result(data)
    finally:
        pinger.cancel()
        print("[echo] extension disconnected")


async def main():
    async with websockets.serve(handler, "localhost", 8765):
        print("[echo] WebSocket listening on ws://localhost:8765")
        print("[echo] load the unpacked extension now; waiting for connect...")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
