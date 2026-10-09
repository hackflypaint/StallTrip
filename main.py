#!/usr/bin/env python3
"""Print the current local time with timezone and UTC."""

from datetime import datetime, timezone


def main() -> None:
    now_local = datetime.now().astimezone()
    now_utc = datetime.now(timezone.utc)

    tz_name = now_local.tzname() or "local"
    offset = now_local.strftime("%z")
    offset_fmt = f"{offset[:3]}:{offset[3:]}" if offset else ""

    print(f"Local time: {now_local.strftime('%Y-%m-%d %H:%M:%S')} {tz_name} (UTC{offset_fmt})")
    print(f"UTC:        {now_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC")


if __name__ == "__main__":
    main()
