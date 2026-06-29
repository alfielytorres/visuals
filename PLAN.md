# Visuals — web camera-driven live visualiser

A browser-based, webcam-driven live-visuals tool for DJs. It is **not** a
replacement for an existing VJ rig — it's an extra, self-contained visual
source you can point a camera at, react to the music, and throw on a screen.

This document is the design/plan. **Status: a working v1 is now built** —
`index.html` + `src/main.js` cover milestones 1–5 below (camera pipeline,
effect rack, audio sync, one-tap Looks, presets, clean output window). See
`README.md` for usage. The sections below remain the reference for the
architecture and what's still open.

## Goals & non-goals

**Goals**
- Runs entirely in a browser, no install, no backend.
- Webcam in → live effects → fullscreen output, with low latency.
- Effects pulse with the music so it feels alive without constant fiddling.
- Easy to operate live: presets, blackout, keyboard shortcuts, big controls.

**Non-goals**
- Not a node-graph / TouchDesigner clone. Wiring nodes is the wrong UX for
  live mixing under pressure.
- Not trying to replace Resolume / TD / whatever the DJ already runs.
- No cloud, accounts, or persistence beyond the local machine.

## Mental model

A fixed image pipeline, like a guitar pedalboard rather than a patch bay:

```
camera (getUserMedia)
   → [ effect rack: ordered, toggleable shader passes ]
   → fullscreen canvas (WebGL2)

audio (Web Audio AnalyserNode) → bass/mid/treble/level uniforms → every pass
```

The rack is a fixed ordered list of effects. Each effect is one WebGL2
fragment-shader pass rendered into a ping-pong framebuffer, so passes compose
in order. This keeps the data flow obvious and the UI simple: a stack of
cards, each with a toggle and a few sliders.

## Tech choices

- **Raw WebGL2** for rendering. Dependency-light, no build step, full control
  over the shader chain and feedback buffers. (A library like regl/three is
  overkill for a fixed fullscreen-quad pipeline.)
- **getUserMedia** for the camera source, with a device picker (laptops often
  have several cameras / capture devices).
- **Web Audio `AnalyserNode`** on a chosen input (mic / line-in / loopback)
  to derive `level`, `bass`, `mid`, `treble` uniforms each frame. These drive
  the "audio-react" amount on any effect.
- **Web MIDI** — optional, later. Map sliders/toggles to a controller so it's
  hands-on. Not in the first cut.
- **No framework.** Single static page; vanilla JS modules.

## Effect rack (first set)

Each is a shader card: an on/off toggle, 1–3 sliders, and an "audio-react"
switch that routes an audio band into the effect's main parameter.

- **Feedback / trails** — sample previous frame, decay + offset/zoom. The
  single most "VJ" effect; needs the ping-pong buffer anyway.
- **Kaleidoscope** — mirror N segments around center.
- **RGB split** — chromatic offset, great on beats.
- **Posterize** — quantise colour levels.
- **Pixelate** — block down-sample.
- **Hue cycle** — rotate hue over time / on audio.
- **Displace** — warp UVs by noise or by luminance.

Order is fixed but each can be toggled; that covers the vast majority of live
looks without a wiring UI.

## Live-operation essentials

- **Presets** — named, saved to `localStorage`, plus JSON export/import so a
  set can be carried between machines. A preset is just the full effect-rack
  state.
- **Blackout / fade-to-black** — instant kill and smooth fade. Non-negotiable
  for live use.
- **Keyboard shortcuts** — toggle effects, cycle presets, blackout, fullscreen.
- **Device pickers** — camera and audio input selectors.
- **Fullscreen / second-display output** — send the canvas to the projector
  while keeping controls on the laptop screen (separate output window or
  fullscreen on the external display).

## Suggested file layout

A single static page, no bundler:

```
index.html        # output canvas + control panel
src/
  gl.js           # WebGL2 setup, fullscreen quad, ping-pong FBOs
  pipeline.js     # ordered effect rack, render loop
  effects/*.js    # one module per effect (shader + params)
  audio.js        # AnalyserNode → bands
  camera.js       # getUserMedia + device picker
  presets.js      # localStorage + JSON export/import
  ui.js           # control panel, shortcuts, blackout
```

Serve with any static host (or `python -m http.server` locally). `getUserMedia`
requires `https://` or `localhost`.

## Build order (milestones)

1. **Spike** — camera → fullscreen canvas via one passthrough shader. Proves
   getUserMedia + WebGL2 + the render loop.
2. **Pipeline** — ping-pong FBOs + the ordered rack; add feedback/trails first
   (it exercises the buffers).
3. **Effects** — add the remaining passes as cards with sliders.
4. **Audio** — AnalyserNode → bands → per-effect audio-react amount.
5. **Live UX** — presets, blackout/fade, shortcuts, device pickers, output
   window.
6. **Later** — Web MIDI mapping, more effects, recording the output.

## Open questions

- Audio capture: mic is easy and portable, but loopback/line-in sounds better
  with the actual mix. Decide whether to document a loopback setup or rely on
  the room mic.
- Output: separate `window.open` canvas vs. fullscreen-on-external-display —
  pick based on how the DJ's machines are wired to projectors.
