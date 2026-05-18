import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from entities.event import EventTracer

from .events import EventBus
from .routes import devices as device_routes
from .routes import sim as sim_routes
from .routes import topology as topology_routes
from .routes import ws as ws_routes
from .state import SimState


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        app.state.event_bus.attach_loop(asyncio.get_running_loop())
        EventTracer.subscribe(app.state.event_bus.emit)
        yield

    app = FastAPI(title="loom", lifespan=lifespan)

    _repo_root = Path(__file__).parent.parent.parent
    _default_topology = str(_repo_root / "samples" / "sample.yaml")
    source = Path(
        os.environ.get("LOOM_TOPOLOGY", _default_topology)
    ).resolve()
    app.state.sim_state = SimState(source)
    app.state.event_bus = EventBus()

    app.include_router(sim_routes.router)
    app.include_router(topology_routes.router)
    app.include_router(device_routes.router)
    app.include_router(ws_routes.router)

    web_dir = Path(__file__).parent.parent.parent / "web"
    if web_dir.exists():
        app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
    return app
