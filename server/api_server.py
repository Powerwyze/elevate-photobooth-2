"""api_server.py — FastAPI backend for the Elevate Women's Conference photo booth.

Runs on port 8000 inside the sandbox.

Endpoints:
- POST /api/photo      — upload guest photo, generate AI caricature, store in Supabase, return {photo_id, public_url}
- POST /api/generate   — (legacy) upload guest photo, return AI caricature image bytes
- POST /api/send-sms   — send the generated portrait via ClickSend MMS (legacy)
- GET  /api/health     — quick liveness check
"""
import base64
import io
import os
import re
from pathlib import Path
from typing import Optional

# Load .env if present (server-local secrets) before reading os.environ
_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from PIL import Image

from generate_image import generate_image

app = FastAPI()


@app.on_event("startup")
async def warmup_assets():
    """On first boot, generate any missing static visual assets."""
    import asyncio
    asyncio.create_task(_generate_missing_assets())


async def _generate_missing_assets():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "assets")
    os.makedirs(out_dir, exist_ok=True)
    assets = [
        ("capri-bg.jpg", "9:16",
         "Soft watercolor illustration of Capri Italy coastline at golden hour. Pastel cream and soft yellow sky, turquoise Mediterranean sea, white-and-pastel cliffside villas climbing the rocks, Faraglioni sea stacks visible in the distance. Hanging lemon branches with green leaves frame the upper edges. Light, airy, very pale and washed out, meant to be a faint background. Painterly, hand-drawn aesthetic, no text, no logos."),
        ("conf-1.jpg", "16:9",
         "Watercolor illustration: an intimate evening reception in a Capri lemon grove, string lights between trees, women in summer dresses gathering around tables with white linens and lemons. Warm golden light. No text. Painterly."),
        ("conf-2.jpg", "16:9",
         "Watercolor illustration: a sunlit conference space in a Capri villa, women on stage speaking, audience seated, large windows opening to the Mediterranean sea. Cream walls, blue-and-white Italian tile floor accents. Painterly, no text."),
        ("conf-3.jpg", "16:9",
         "Watercolor illustration: cocktail hour on a cliffside terrace in Capri overlooking the Faraglioni sea stacks. Limoncello glasses on a marble bar, hanging lemons, blue-and-white tile detail, golden hour light. Painterly, no text."),
        ("conf-4.jpg", "16:9",
         "Watercolor illustration: long-table brunch by the Mediterranean sea in Capri, white linen, bowls of fresh lemons, espresso cups, cream pastries. Bright morning light on turquoise water. Painterly, no text."),
        ("conf-5.jpg", "16:9",
         "Watercolor illustration: closing sunset in Capri over Anacapri, women raising champagne glasses on a cliffside terrace, sun dropping into Mediterranean sea, warm pink and gold sky, hanging lemon branch in foreground. Painterly, no text."),
    ]
    for name, ratio, prompt in assets:
        path = os.path.join(out_dir, name)
        if os.path.exists(path):
            continue
        try:
            print(f"[warmup] generating {name} …")
            data = await generate_image(prompt, aspect_ratio=ratio)
            with open(path, "wb") as f:
                f.write(data)
            print(f"[warmup] wrote {name} ({len(data)} bytes)")
        except Exception as e:
            print(f"[warmup] FAILED {name}: {e}")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Caricature prompt ---------------------------------------------------------

CARICATURE_PROMPT = """Transform this photo into a stylized illustrated caricature scene
in a warm, vibrant painterly aesthetic — NOT photorealistic. The output is a souvenir
portrait for the Elevate Women's Conference 2026 in Capri, Italy.

SCENE: Place this person as the SOLE DRIVER (behind the steering wheel) of a light blue
vintage convertible — a 1960s-era Italian roadster, robin's-egg blue, chrome trim, top
down — cruising along a coastal road in Capri, Italy. Preserve the person's actual face,
hair, skin tone, and identity faithfully — just stylize them as a charming caricature
with slightly exaggerated, friendly features. They should look joyful, hands on the
wheel, hair gently moving in the wind, wearing chic Italian summer attire (sundress or
linen shirt, oversized sunglasses, maybe a light scarf).

BACKGROUND: The Mediterranean Sea sparkling turquoise on one side, dramatic Capri
cliffside architecture and pastel villas climbing the rocks on the other. Warm
late-afternoon golden-hour light. Mediterranean cypress trees in the distance.

FRAME DECORATIONS: Hanging lemons and lemon branches with green leaves draping into
the upper corners of the image. Blue-and-white hand-painted Italian Majolica tile
patterns as decorative accent borders along the edges. The overall palette is warm
ochre, terracotta, light blue, lemon yellow, and crisp white.

STYLE: Illustrated caricature / watercolor-painterly, hand-drawn feel, warm and
vibrant, like a high-end travel magazine illustration. Soft brushwork, visible
painterly texture. Joyful, celebratory, feminine, sophisticated.

Important: The person must remain clearly recognizable. Do not change their ethnicity,
fundamental face shape, or eye/hair color. Keep their face the focal point of the
composition. No text, no watermark, no logos in the image — those will be added later
in the frame.
"""


# --- Image utilities -----------------------------------------------------------

def composite_logo_overlay(scene_bytes: bytes) -> bytes:
    """Place the Elevate logo as an embedded frame element on the generated scene."""
    logo_path = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "elevate-logo.png")
    if not os.path.exists(logo_path):
        return scene_bytes

    try:
        scene = Image.open(io.BytesIO(scene_bytes)).convert("RGBA")
        logo = Image.open(logo_path).convert("RGBA")

        # Logo width = 38% of scene width
        target_w = int(scene.width * 0.38)
        ratio = target_w / logo.width
        target_h = int(logo.height * ratio)
        logo = logo.resize((target_w, target_h), Image.LANCZOS)

        # Soft white pill behind logo for legibility
        pad_x = int(target_w * 0.08)
        pad_y = int(target_h * 0.10)
        pill_w = target_w + pad_x * 2
        pill_h = target_h + pad_y * 2
        pill = Image.new("RGBA", (pill_w, pill_h), (255, 255, 255, 230))

        # Round the pill corners
        from PIL import ImageDraw
        mask = Image.new("L", (pill_w, pill_h), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [(0, 0), (pill_w, pill_h)], radius=int(pill_h * 0.18), fill=255
        )
        pill.putalpha(mask)

        # Position pill near bottom-center of the scene
        margin_y = int(scene.height * 0.04)
        x = (scene.width - pill_w) // 2
        y = scene.height - pill_h - margin_y

        scene.alpha_composite(pill, (x, y))
        scene.alpha_composite(logo, (x + pad_x, y + pad_y))

        out = io.BytesIO()
        scene.convert("RGB").save(out, format="JPEG", quality=92)
        return out.getvalue()
    except Exception as e:
        print(f"[logo composite] failed: {e}")
        return scene_bytes


def normalize_phone_e164(raw: str, default_country: str = "+1") -> Optional[str]:
    digits = re.sub(r"\D", "", raw or "")
    if not digits:
        return None
    if raw.strip().startswith("+"):
        return "+" + digits
    if len(digits) == 10:
        return default_country + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return "+" + digits


# --- Endpoints -----------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"ok": True}


async def _generate_caricature(photo_bytes: bytes) -> bytes:
    """Run the captured photo through the AI image pipeline + logo overlay."""
    # Cap the input photo to keep prompt fast
    try:
        src = Image.open(io.BytesIO(photo_bytes)).convert("RGB")
        src.thumbnail((1024, 1024))
        buf = io.BytesIO()
        src.save(buf, format="JPEG", quality=88)
        photo_bytes = buf.getvalue()
    except Exception:
        pass

    scene_bytes = await generate_image(
        CARICATURE_PROMPT,
        image_bytes=photo_bytes,
        image_media_type="image/jpeg",
        aspect_ratio="3:4",
        model="nano_banana_2",
    )
    return composite_logo_overlay(scene_bytes)


@app.post("/api/photo")
async def photo(image: UploadFile = File(...)):
    """QR-first flow: generate AI portrait, store in Supabase, return photo_id + public_url.

    The kiosk renders a QR code linking to /claim?id=<photo_id> where the guest
    enters their name + phone and downloads the image on their phone.
    """
    import time
    try:
        photo_bytes = await image.read()
        if not photo_bytes:
            raise HTTPException(status_code=400, detail="empty image")

        final_bytes = await _generate_caricature(photo_bytes)

        # Upload to Supabase Storage
        filename = f"{int(time.time() * 1000)}.jpg"
        public_url = upload_to_supabase(final_bytes, filename)
        if not public_url:
            raise HTTPException(status_code=500, detail="image hosting not configured")

        # Insert row in elevate_photos via Supabase REST
        photo_id = _insert_elevate_photo(filename, public_url)
        if not photo_id:
            raise HTTPException(status_code=500, detail="could not record photo")

        return {"photo_id": photo_id, "public_url": public_url}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[photo] error: {e}")
        raise HTTPException(status_code=422, detail=f"photo failed: {e}")


def _insert_elevate_photo(storage_path: str, public_url: str) -> Optional[str]:
    """Insert a row into public.elevate_photos via Supabase REST and return its id."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_ANON_KEY")
    if not (url and key):
        return None
    try:
        from supabase import create_client
        client = create_client(url, key)
        result = client.table("elevate_photos").insert({
            "storage_path": storage_path,
            "public_url": public_url,
        }).execute()
        rows = getattr(result, "data", None) or []
        if rows:
            return rows[0].get("id")
        return None
    except Exception as e:
        print(f"[insert photo] failed: {e}")
        return None


@app.post("/api/generate")
async def generate(
    image: UploadFile = File(...),
    first_name: str = Form(""),
    last_name: str = Form(""),
    phone: str = Form(""),
):
    """Legacy: accepts a captured guest photo, returns the caricature image bytes."""
    try:
        photo_bytes = await image.read()
        if not photo_bytes:
            raise HTTPException(status_code=400, detail="empty image")
        final_bytes = await _generate_caricature(photo_bytes)
        return Response(content=final_bytes, media_type="image/jpeg")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[generate] error: {e}")
        raise HTTPException(status_code=422, detail=f"generation failed: {e}")


def upload_to_supabase(image_bytes: bytes, filename: str) -> Optional[str]:
    """Upload image to Supabase Storage and return the public URL."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_ANON_KEY")
    bucket = os.environ.get("SUPABASE_BUCKET", "elevate-photos")
    if not (url and key):
        return None
    try:
        from supabase import create_client
        client = create_client(url, key)
        client.storage.from_(bucket).upload(
            path=filename,
            file=image_bytes,
            file_options={"content-type": "image/jpeg", "upsert": "true"},
        )
        public = client.storage.from_(bucket).get_public_url(filename)
        # supabase-py returns URL with trailing ? sometimes — strip it
        return public.rstrip("?")
    except Exception as e:
        print(f"[supabase upload] failed: {e}")
        return None


@app.post("/api/send-sms")
async def send_sms(payload: dict):
    """Send the generated portrait to the guest via ClickSend MMS.

    Expected JSON: { phone, firstName, lastName, imageBase64 }
    Uploads image to Supabase Storage, then sends the public URL via ClickSend MMS.
    """
    import base64 as _b64
    import time
    import re as _re
    import json as _json
    import urllib.request
    import urllib.error

    phone_raw = payload.get("phone", "")
    first = payload.get("firstName", "there")
    last = payload.get("lastName", "")
    image_b64 = payload.get("imageBase64")

    phone = normalize_phone_e164(phone_raw)
    if not phone:
        raise HTTPException(status_code=400, detail="invalid phone number")

    cs_user = os.environ.get("CLICKSEND_USERNAME")
    cs_key = os.environ.get("CLICKSEND_API_KEY")

    if not (cs_user and cs_key):
        return JSONResponse(
            status_code=200,
            content={
                "ok": False,
                "scaffolded": True,
                "message": "ClickSend not configured. Set CLICKSEND_USERNAME and CLICKSEND_API_KEY.",
                "phone": phone,
            },
        )

    if not image_b64:
        raise HTTPException(status_code=400, detail="image missing")

    # Decode and shrink image to fit ClickSend MMS 250 KB limit
    try:
        image_bytes = _b64.b64decode(image_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64 image")

    # ClickSend max attachment size is 250 KB. Iteratively reduce quality+size
    # until the JPEG fits comfortably under the limit (target 220 KB).
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        max_dim = 1200
        if max(img.size) > max_dim:
            img.thumbnail((max_dim, max_dim))
        for quality in (88, 80, 72, 65, 58, 50, 42):
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=quality, optimize=True)
            data = buf.getvalue()
            if len(data) <= 220 * 1024:
                image_bytes = data
                break
        else:
            # Last resort: shrink the canvas further
            img.thumbnail((900, 900))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=70, optimize=True)
            image_bytes = buf.getvalue()
        print(f"[mms] resized payload to {len(image_bytes)} bytes")
    except Exception as e:
        print(f"[mms] resize warning: {e}")

    safe_first = _re.sub(r"[^a-z0-9]+", "-", first.lower())[:20] or "guest"
    filename = f"{int(time.time() * 1000)}-{safe_first}.jpg"
    media_url = upload_to_supabase(image_bytes, filename)

    if not media_url:
        return JSONResponse(
            status_code=200,
            content={
                "ok": False,
                "scaffolded": True,
                "message": "Image hosting not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.",
                "phone": phone,
            },
        )

    # ClickSend MMS requires a media_file_url field. We pass the public Supabase URL.
    body_text = (
        f"{first}, here's your Elevate Women's Conference souvenir — "
        f"Designed for More. \u2728 Reply STOP to opt out."
    )
    # ClickSend MMS: media_file is a TOP-LEVEL field (not nested in messages).
    # 'from' must be a valid sender id; we use the account billing mobile as a fallback.
    cs_from = os.environ.get("CLICKSEND_FROM_NUMBER", "+18577076043")
    cs_payload = {
        "media_file": media_url,
        "messages": [
            {
                "source": "elevate-photobooth",
                "from": cs_from,
                "to": phone,
                "subject": "Elevate WC 2026",
                "body": body_text,
                "country": "US",
            }
        ],
    }

    auth_token = _b64.b64encode(f"{cs_user}:{cs_key}".encode()).decode()
    req = urllib.request.Request(
        "https://rest.clicksend.com/v3/mms/send",
        data=_json.dumps(cs_payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Basic {auth_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = _json.loads(r.read().decode())
        # Extract message id if present
        msg_id = None
        try:
            msg_id = resp["data"]["messages"][0].get("message_id")
            cs_status = resp["data"]["messages"][0].get("status")
        except Exception:
            cs_status = resp.get("response_msg")
        return {
            "ok": True,
            "provider": "clicksend",
            "messageId": msg_id,
            "status": cs_status,
            "phone": phone,
            "mediaUrl": media_url,
        }
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise HTTPException(status_code=422, detail=f"clicksend rejected: {body}")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"sms failed: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
