"""Seed a demo device + dataset so you can test the loop immediately.

Run:  python seed.py
Prints a DEVICE_TOKEN you use as `Authorization: Bearer <token>`.
"""
from sqlmodel import Session, select

from app.db import engine, init_db
from app.models import Dataset, Device, Item, new_token


def main() -> None:
    init_db()
    with Session(engine) as s:
        dev = s.exec(select(Device)).first()
        if not dev:
            dev = Device(name="test-phone-01", token=new_token())
            s.add(dev)
            s.commit()
            s.refresh(dev)

        ds = s.exec(select(Dataset)).first()
        if not ds:
            ds = Dataset(name="Demo Shopee Reviews")
            s.add(ds)
            s.commit()
            s.refresh(ds)
            demo = [
                (1001, "เสื้อยืดโอเวอร์ไซส์สีขาว"),
                (1002, "หูฟังบลูทูธไร้สาย"),
                (1003, "กระบอกน้ำเก็บความเย็น"),
            ]
            for i, (pid, title) in enumerate(demo):
                s.add(
                    Item(
                        dataset_id=ds.id,
                        product_id=pid,
                        title=title,
                        price=str(199 + i * 100),
                        product_url=f"https://shopee.co.th/product/1/{pid}",
                        review_summary=f"{title} ใช้ดีมาก คุ้มราคา รีวิวจากผู้ซื้อจริง",
                    )
                )
            s.commit()

        print("DEVICE_TOKEN:", dev.token)
        print("DEVICE_ID:", dev.id)
        print("DATASET_ID:", ds.id)


if __name__ == "__main__":
    main()
