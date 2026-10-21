#!/usr/bin/env python3
"""
Скачивает фотографии глав с Wikimedia Commons в assets/photos/
и записывает assets/photos/manifest.js. После этого сайт берёт фото
с вашего компьютера, а не из интернета: так он работает быстрее
и не зависит от доступности Wikimedia.

Запуск из корня проекта (нужен только Python 3, без дополнительных пакетов):
    python3 tools/download_photos.py
    python3 tools/download_photos.py --width 1600   # другой размер

Лицензии фото (CC BY-SA и др.) требуют указывать автора и лицензию —
сайт делает это автоматически в подписях и в окне «О проекте».
"""
import argparse, hashlib, json, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content", "chapters.js")
PHOTOS = os.path.join(ROOT, "assets", "photos")
UA = "TyumenJourneyStudentProject/1.0 (educational; contact via repository)"


def load_content():
    with open(CONTENT, encoding="utf8") as f:
        text = f.read()
    start = text.index("window.JOURNEY_CONTENT")
    body = text[text.index("{", start): text.rindex("}") + 1]
    return json.loads(body)


def all_photos(content):
    for ch in content["chapters"]:
        yield ch["photo"]
        for p in ch.get("gallery", []):
            yield p
        tn = ch.get("thenNow")
        if tn:
            yield tn["then"]
            yield tn["now"]


def safe_name(file):
    base, ext = os.path.splitext(file)
    ext = ext.lower() if ext.lower() in (".jpg", ".jpeg", ".png") else ".jpg"
    slug = re.sub(r"[^0-9A-Za-z]+", "-", base).strip("-")[:40] or "photo"
    h = hashlib.sha1(file.encode("utf8")).hexdigest()[:8]
    return f"{slug}-{h}{ext}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=1920)
    args = ap.parse_args()
    os.makedirs(PHOTOS, exist_ok=True)
    manifest = {}
    photos = list({p["file"]: p for p in all_photos(load_content())}.values())
    print(f"Фотографий: {len(photos)}")
    for p in photos:
        name = safe_name(p["file"])
        dest = os.path.join(PHOTOS, name)
        rel = "assets/photos/" + name
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            manifest[p["file"]] = rel
            print("  уже есть:", p["file"])
            continue
        url = ("https://commons.wikimedia.org/wiki/Special:FilePath/"
               + urllib.parse.quote(p["file"].replace(" ", "_")) + f"?width={args.width}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as out:
                out.write(r.read())
            manifest[p["file"]] = rel
            print("  скачано:", p["file"])
            time.sleep(0.5)
        except Exception as e:  # noqa
            print("  НЕ УДАЛОСЬ:", p["file"], "-", e, file=sys.stderr)
    with open(os.path.join(PHOTOS, "manifest.js"), "w", encoding="utf8") as f:
        f.write("/* Создано tools/download_photos.py. Ключ — имя файла на Wikimedia Commons. */\n")
        f.write("window.JOURNEY_LOCAL_PHOTOS = " + json.dumps(manifest, ensure_ascii=False, indent=2) + ";\n")
    print(f"Готово: {len(manifest)} из {len(photos)}. Список — assets/photos/manifest.js")


if __name__ == "__main__":
    main()
