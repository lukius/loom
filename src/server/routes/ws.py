import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["ws"])


@router.websocket("/ws/events")
async def events(ws: WebSocket):
    await ws.accept()
    bus = ws.app.state.event_bus
    if bus._loop is None:
        bus.attach_loop(asyncio.get_running_loop())
    q = bus.subscribe()
    try:
        while True:
            event = await q.get()
            await ws.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(q)
