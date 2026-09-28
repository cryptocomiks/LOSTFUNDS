# lostfunds film (15 s)

The film on the homepage is generated entirely from code:

- `reel.html`: the animation, a Canvas 2D scene rendered as a pure function of time (1920×1080, 60 fps)
- `synth.mjs`: the sound design, synthesized from scratch (pad, soft whooshes, UI clicks, chime) → `reel.wav`
- `render.mjs`: renders every frame in headless Chromium and muxes it with the audio through ffmpeg

```bash
cd film
npm i ffmpeg-static @fontsource/inter@5 playwright
node synth.mjs                 # → reel.wav
node render.mjs reel.mp4       # → master (≈19 MB, CRF 20)
# web version used on the site (≈3 MB):
npx ffmpeg -i reel.mp4 -c:v libx264 -preset veryslow -crf 26 -tune grain -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart ../public/video/lostfunds-film.mp4
```
