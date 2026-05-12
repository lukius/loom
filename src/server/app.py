import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .events import EventBus
from .routes import sim as sim_routes
from .routes import topology as topology_routes
from .state import SimState


def create_app() -> FastAPI:
    app = FastAPI(title="netrouting")

    source = Path(
        os.environ.get("NETROUTING_TOPOLOGY", "samples/sample.yaml")
    ).resolve()
    app.state.sim_state = SimState(source)
    app.state.event_bus = EventBus()

    app.include_router(sim_routes.router)
    app.include_router(topology_routes.router)

    web_dir = Path(__file__).parent.parent.parent / "web"
    if web_dir.exists():
        app.mount("/web", StaticFiles(directory=str(web_dir), html=True), name="web")
    # Note: SPA served at /web during dev; final mount-at-root in Task 16.
    return app
