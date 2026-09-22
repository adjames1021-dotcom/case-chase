# Custom item images

The game ships with generated vector art for every item. If you'd rather use
your own images, drop them in here and create an `images.js` file in this
folder:

```js
window.CASE_SIM_IMAGES = {
  "KR-74 | Solar Flare": "assets/kr74-solar-flare.png",
  "Karambit | Apex Predator": "assets/karambit-apex.png"
};
```

The key is the item's exact name as it appears in the game. Any item you
don't list keeps its built-in art, so you can convert as few or as many as
you like. Paths are relative to `site/index.html`, and absolute URLs
work too.

Transparent PNGs at roughly 2.5:1 (for example 640x256) match the layout
best; images are scaled to fit and letterboxed, so other ratios still work.

If `images.js` doesn't exist the browser logs a harmless 404 and the game
runs exactly as before.

Only add artwork you have the right to use. The built-in art is original to
this project; the bundled fallback stays in place for anything you don't
override.
