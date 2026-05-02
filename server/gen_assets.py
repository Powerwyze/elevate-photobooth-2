"""Generate the static visual assets for the photo booth.

Run once to populate public/assets/. Costs credits."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from generate_image import generate_image

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "assets")
os.makedirs(OUT, exist_ok=True)

ASSETS = [
    {
        "name": "capri-bg.jpg",
        "ratio": "9:16",
        "prompt": (
            "Soft watercolor illustration of Capri, Italy coastline at golden hour. "
            "Pastel cream and soft yellow sky, turquoise Mediterranean sea, white-and-pastel cliffside "
            "villas climbing the rocks, Faraglioni sea stacks visible in the distance. "
            "Hanging lemon branches with green leaves frame the upper edges. "
            "Light, airy, very pale and washed out — meant to be a faint background. "
            "Painterly, hand-drawn aesthetic, no text, no logos."
        ),
    },
    {
        "name": "conf-1.jpg",
        "ratio": "16:9",
        "prompt": (
            "Watercolor illustration: an intimate evening reception in a Capri lemon grove, "
            "string lights between trees, women in summer dresses gathering around tables with "
            "white linens and lemons. Warm golden light. No text. Painterly."
        ),
    },
    {
        "name": "conf-2.jpg",
        "ratio": "16:9",
        "prompt": (
            "Watercolor illustration: a sunlit conference space in a Capri villa, women on stage "
            "speaking, audience seated, large windows opening to the Mediterranean sea. "
            "Cream walls, blue-and-white Italian tile floor accents. Painterly, no text."
        ),
    },
    {
        "name": "conf-3.jpg",
        "ratio": "16:9",
        "prompt": (
            "Watercolor illustration: cocktail hour on a cliffside terrace in Capri overlooking "
            "the Faraglioni sea stacks. Limoncello glasses on a marble bar, hanging lemons, "
            "blue-and-white tile detail, golden hour light. Painterly, no text."
        ),
    },
    {
        "name": "conf-4.jpg",
        "ratio": "16:9",
        "prompt": (
            "Watercolor illustration: long-table brunch by the Mediterranean sea in Capri, "
            "white linen, bowls of fresh lemons, espresso cups, cream pastries. "
            "Bright morning light on turquoise water. Painterly, no text."
        ),
    },
    {
        "name": "conf-5.jpg",
        "ratio": "16:9",
        "prompt": (
            "Watercolor illustration: closing sunset in Capri over Anacapri, women raising "
            "champagne glasses on a cliffside terrace, sun dropping into Mediterranean sea, "
            "warm pink and gold sky, hanging lemon branch in foreground. Painterly, no text."
        ),
    },
]


async def main():
    for asset in ASSETS:
        path = os.path.join(OUT, asset["name"])
        if os.path.exists(path):
            print(f"skip (exists): {asset['name']}")
            continue
        print(f"generating: {asset['name']}…")
        try:
            data = await generate_image(asset["prompt"], aspect_ratio=asset["ratio"])
            with open(path, "wb") as f:
                f.write(data)
            print(f"   wrote {path} ({len(data)} bytes)")
        except Exception as e:
            print(f"   FAILED: {e}")


if __name__ == "__main__":
    asyncio.run(main())
