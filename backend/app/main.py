from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .db import init_db
from .dashboard import router as dashboard_router
from .routers import admin, ai, app_api, auth, ingest
from .routers import scrape


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="ClipBot Backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(StarletteHTTPException)
async def _http_exc(request, exc: StarletteHTTPException):
    # Return {error, message} at the top level so the device client can read
    # `error`/`message` directly (matching the app's error contract).
    if isinstance(exc.detail, dict):
        return JSONResponse(status_code=exc.status_code, content=exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": "http_error", "message": str(exc.detail)},
    )


app.include_router(dashboard_router)
app.include_router(auth.router)
app.include_router(app_api.router)
app.include_router(ai.router)
app.include_router(admin.router)
app.include_router(ingest.router)
app.include_router(scrape.router)
