import secrets
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


def now() -> datetime:
    return datetime.utcnow()


def new_token(prefix: str = "app_") -> str:
    """Device bearer token. `app_` prefix mirrors the original app's token format."""
    return prefix + secrets.token_urlsafe(24)


def new_ext_token() -> str:
    """Chrome-extension token. `ext_` prefix mirrors the original capture extension."""
    return "ext_" + secrets.token_urlsafe(24)


class Device(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    token: str = Field(index=True, unique=True)
    active: bool = True
    member_id: int = 0
    created_at: datetime = Field(default_factory=now)
    last_seen: Optional[datetime] = None
    last_label: Optional[str] = None


class Dataset(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    active: bool = True
    created_at: datetime = Field(default_factory=now)


class Item(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    dataset_id: int = Field(index=True)
    product_id: int = Field(index=True)
    title: str = ""
    price: str = ""
    product_url: str = ""
    review_summary: str = ""  # text fed to the AI captioner
    media_json: str = "[]"  # JSON list of {url, type}  (filled by the scraper/ingest)
    status: str = "pending"  # pending | done  (done = consumed, won't be re-picked)
    locked_by: Optional[int] = None  # device id holding the lock
    locked_at: Optional[datetime] = None
    done_by: Optional[int] = None
    done_at: Optional[datetime] = None
    # Honest post-state — fixes the original's "assume success when the Post
    # button disappears". The device must report whether the post was actually
    # verified live, not just that it tapped Publish.
    post_state: str = "pending"  # pending | rendered | posted | failed
    posted_verified: bool = False  # device confirmed the post really went live
    post_message: str = ""
    post_ref: str = ""  # Shopee post id / url if the device captured it
    posted_at: Optional[datetime] = None


class Command(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    device_id: int = Field(index=True)
    action: str  # start | stop | pause | resume | set_config
    params_json: str = "{}"
    status: str = "pending"  # pending | applied | rejected
    created_at: datetime = Field(default_factory=now)
    delivered_at: Optional[datetime] = None
    acked_at: Optional[datetime] = None
    ack_message: Optional[str] = None


class ExtToken(SQLModel, table=True):
    """Auth token for a Chrome capture extension (separate from device tokens)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    token: str = Field(index=True, unique=True)
    active: bool = True
    created_at: datetime = Field(default_factory=now)
    last_seen: Optional[datetime] = None


class StatusReport(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    device_id: int = Field(index=True)
    run_state: str = "idle"
    stage: str = "-"
    produced: int = 0
    target: int = 0
    dataset_id: int = 0
    product_id: int = 0
    last_message: str = ""
    ts: datetime = Field(default_factory=now)


class ScrapeJob(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    dataset_name: str = "Shopee Scrape"
    product_url: str = ""
    shopid: str = ""
    itemid: str = Field(index=True)
    filter: int = 0
    status: str = "pending"  # pending | running | done | failed
    message: str = ""
    title: str = ""
    price: str = ""
    reviews_count: int = 0
    media_count: int = 0
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)
