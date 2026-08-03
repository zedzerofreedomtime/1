from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./clipbot.db"
    admin_key: str = "dev-admin-key-change-me"
    # What /api/discover hands back to devices as their API base.
    server_url: str = "http://127.0.0.1:8000"
    # Server-side item lock TTL (fixes the original app's "lock never expires" gap).
    lock_ttl_sec: int = 900

    # ---- AI proxy: provider keys stay on the SERVER, never shipped to devices ----
    ai_provider: str = "stub"  # stub | openai | gemini
    openai_api_key: str = ""
    gemini_api_key: str = ""
    ai_model: str = "gpt-4o-mini"

    app_latest_code: int = 1
    app_latest_name: str = "0.1.0"

    def default_run_config(self) -> dict:
        """Sane run defaults — values observed in the Samurai VDO 1.12 demo."""
        return {
            "clip_count": 1,
            "clip_len_sec": 16,
            "pick_mode": "auto",
            "encoder_mode": "auto",
            "with_music": True,
            "ai_tag": True,
            "apply_overlay": True,
            "auto_post": True,
            "random_delay": True,
            "delay_min_sec": 5,
            "delay_max_sec": 8,
            "upload_wait_sec": 10,
            "platform": "shopee",
        }


settings = Settings()
