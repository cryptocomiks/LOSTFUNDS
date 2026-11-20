# FundsCheckers film (15 s)

The film on the homepage is generated entirely from code, in English and in French:

- `reel.html`: the animation, a Canvas 2D scene rendered as a pure function of time (1920×1080, 60 fps).
  `reel.html?lang=fr` is the French version; every text is in `TXT` at the top of the script, with the
  number of checks (`CHECKS`) and the find shown at the end (`FOUND_USD`).
- `synth.mjs`: the sound design, synthesized from scratch (pad, soft whooshes, UI clicks, chime) → `reel.wav`.
  It follows the scenes' timings, which are the same in both languages.
- `render.mjs`: renders every frame in headless Chromium and muxes it with the audio through ffmpeg.
- `sheet.mjs`: still frames, to check a change before rendering everything.

```bash
cd film
npm i --no-save @fontsource/inter@5 playwright   # the font files reel.html loads, and a browser
node sheet.mjs fr                                # → sheet-fr.png, one frame per second
node sheet.mjs en 10.5,12.7                      # → frame-en-10.5.png, frame-en-12.7.png

node synth.mjs                                   # → reel.wav
for l in en fr; do
  node render.mjs reel-$l.mp4 $l                 # → master (≈19 MB, CRF 20), about 10 minutes
  # the version the site serves (≈2.5 MB), and its poster (the result card)
  ffmpeg -y -i reel-$l.mp4 -c:v libx264 -preset veryslow -crf 26 -tune grain -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart ../public/video/fundscheckers-film-$l.mp4
  ffmpeg -y -ss 12.7 -i reel-$l.mp4 -frames:v 1 -vf scale=1280:-1 -q:v 4 ../public/video/fundscheckers-film-$l.jpg
done
```

`render.mjs` and `sheet.mjs` use the system's ffmpeg (or `ffmpeg-static` when it is installed here), and
the Chromium at `CHROMIUM_PATH` when that variable is set.

The site caches `/video/*` for a day: give the files a new name when the film changes, so that
returning visitors don't keep the old one (`src/components/ShowReel.tsx` holds the names).
